package mcp

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"strings"
	"sync"
	"sync/atomic"
	"time"
	"unicode/utf8"

	sdk "github.com/modelcontextprotocol/go-sdk/mcp"
	"github.com/rs/zerolog"

	"github.com/yanun0323/Team-Work/internal/model"
)

const (
	// connectTimeout bounds starting a server and listing its tools; npx and uvx may download it first.
	connectTimeout = 60 * time.Second
	// retryAfter is how long a server that could not be reached is left alone before it is tried again; a change to
	// its entry in mcp.json tries it at once.
	retryAfter = 5 * time.Minute
	// maxName keeps a tool's name within 64 characters once Claude Code puts mcp__mho__ before it.
	maxName = 54
	// maxText bounds what one call hands the model, as the other tools do.
	maxText = 50 << 10
	// maxImage is the largest image every provider takes, as base64 of at most 5MB.
	maxImage   = 5 << 20 / 4 * 3
	stderrTail = 2 << 10
)

// Tool is a tool of a connected server, as employees are offered it.
type Tool struct {
	// Name is what the model calls it: mcp__<server>__<tool>, cut short with a hash when too long or taken.
	Name   string
	Server string
	// Remote is its name on the server.
	Remote      string
	Description string
	Schema      json.RawMessage
	Exposure    string
	// ReadOnly is the server's word that the tool changes nothing, so a script's calls to it may run side by side.
	ReadOnly bool
}

// Listing is what the servers offer now.
type Listing struct {
	Tools []Tool
	// Servers are those connected, with what each offers in a sentence.
	Servers []ServerInfo
	// Problems are what keeps an entry or a server out, to show the user.
	Problems []string
}

// ServerInfo is a connected server: its name and what it offers, from mcp.json's description or its own instructions.
type ServerInfo struct {
	Name, About string
}

// Hub keeps one connection to each server mcp.json lists, shared by every run, and reads the file again each time
// tools are listed, so a change counts from the next run on. A nil Hub has no servers.
type Hub struct {
	path string
	log  zerolog.Logger

	mu     sync.Mutex
	conns  map[string]*conn
	closed bool
}

// NewHub keeps the servers listed in the mcp.json at path.
func NewHub(path string, log zerolog.Logger) *Hub {
	return &Hub{path: path, log: log, conns: map[string]*conn{}}
}

// Tools connects to the servers not connected yet, all at once, and lists every server's tools.
func (h *Hub) Tools(ctx context.Context) Listing {
	if h == nil {
		return Listing{}
	}
	servers, problems := Load(h.path)
	var out Listing
	for _, p := range problems {
		out.Problems = append(out.Problems, p.Error())
	}
	conns := h.sync(servers)
	type listed struct {
		tools []*sdk.Tool
		about string
		err   error
	}
	results := make([]listed, len(conns))
	var wg sync.WaitGroup
	for i, c := range conns {
		wg.Go(func() {
			tools, about, err := c.list(ctx)
			results[i] = listed{tools, about, err}
		})
	}
	wg.Wait()
	taken := map[string]bool{}
	for i, c := range conns {
		r := results[i]
		if r.err != nil {
			out.Problems = append(out.Problems, fmt.Sprintf("MCP server %q: %v", c.cfg.Name, r.err))
			continue
		}
		out.Servers = append(out.Servers, ServerInfo{Name: c.cfg.Name, About: r.about})
		for _, t := range r.tools {
			exposure := c.cfg.exposure(t.Name)
			if exposure == Hidden {
				continue
			}
			name := toolName(c.cfg.Name, t.Name, taken)
			taken[name] = true
			out.Tools = append(out.Tools, Tool{Name: name, Server: c.cfg.Name, Remote: t.Name, Description: describe(c.cfg.Name, t),
				Schema: schemaOf(t.InputSchema), Exposure: exposure, ReadOnly: t.Annotations != nil && t.Annotations.ReadOnlyHint})
		}
	}
	return out
}

// sync makes the connections match the servers listed: one changed or no longer listed is closed.
func (h *Hub) sync(servers []Server) []*conn {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.closed {
		return nil
	}
	keep := map[string]bool{}
	out := make([]*conn, 0, len(servers))
	for _, s := range servers {
		keep[s.Name] = true
		c := h.conns[s.Name]
		if c != nil && c.key != s.key() {
			go c.close()
			c = nil
		}
		if c == nil {
			c = &conn{cfg: s, key: s.key(), log: h.log}
			h.conns[s.Name] = c
		}
		out = append(out, c)
	}
	for name, c := range h.conns {
		if !keep[name] {
			go c.close()
			delete(h.conns, name)
		}
	}
	return out
}

// Call runs a tool on its server. What goes wrong comes back as an error result, for the model to read.
func (h *Hub) Call(ctx context.Context, t Tool, args json.RawMessage) model.ToolResult {
	fail := func(format string, a ...any) model.ToolResult {
		return model.ToolResult{Text: fmt.Sprintf(format, a...), IsError: true}
	}
	if h == nil {
		return fail("MCP server %q is not available", t.Server)
	}
	h.mu.Lock()
	c := h.conns[t.Server]
	h.mu.Unlock()
	if c == nil {
		return fail("MCP server %q is no longer listed in mcp.json", t.Server)
	}
	cs, err := c.session(ctx)
	if err != nil {
		return fail("MCP server %q: %v", t.Server, err)
	}
	if len(args) == 0 || string(args) == "null" {
		args = json.RawMessage(`{}`)
	}
	callCtx, cancel := context.WithTimeout(ctx, c.cfg.Timeout)
	defer cancel()
	r, err := cs.CallTool(callCtx, &sdk.CallToolParams{Name: t.Remote, Arguments: args})
	if err != nil {
		if errors.Is(err, sdk.ErrConnectionClosed) {
			c.drop(cs)
		}
		if callCtx.Err() != nil && ctx.Err() == nil {
			return fail("MCP server %q did not answer within %s", t.Server, c.cfg.Timeout)
		}
		return fail("MCP server %q: %v%s", t.Server, err, c.stderrNote())
	}
	return result(r)
}

// Close disconnects every server and stops those it started.
func (h *Hub) Close() {
	if h == nil {
		return
	}
	h.mu.Lock()
	h.closed = true
	conns := h.conns
	h.conns = map[string]*conn{}
	h.mu.Unlock()
	var wg sync.WaitGroup
	for _, c := range conns {
		wg.Go(c.close)
	}
	wg.Wait()
}

// conn is the connection to one server, made when first needed and made again after it drops.
type conn struct {
	cfg Server
	key string
	log zerolog.Logger

	mu    sync.Mutex
	cs    *sdk.ClientSession
	tools []*sdk.Tool
	about string
	// stale is set when the server says its tools changed, so they are listed again
	stale atomic.Bool
	// err and failedAt are the last failure to connect, which is not tried again for a while
	err      error
	failedAt time.Time
	stderr   *tail
	closed   bool
}

// list is the server's tools, connecting first when needed.
func (c *conn) list(ctx context.Context) ([]*sdk.Tool, string, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if err := c.connect(ctx); err != nil {
		return nil, "", err
	}
	if c.tools == nil || c.stale.Swap(false) {
		listCtx, cancel := context.WithTimeout(ctx, connectTimeout)
		defer cancel()
		tools := []*sdk.Tool{}
		for t, err := range c.cs.Tools(listCtx, nil) {
			if err != nil {
				if errors.Is(err, sdk.ErrConnectionClosed) {
					c.dropLocked(c.cs)
				}
				return nil, "", fmt.Errorf("listing its tools: %v", err)
			}
			tools = append(tools, t)
		}
		c.tools = tools
	}
	return c.tools, c.about, nil
}

// session is the connection, made when needed.
func (c *conn) session(ctx context.Context) (*sdk.ClientSession, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if err := c.connect(ctx); err != nil {
		return nil, err
	}
	return c.cs, nil
}

// connect connects when not connected. Hold mu.
func (c *conn) connect(ctx context.Context) error {
	if c.closed {
		return errors.New("disconnected")
	}
	if c.cs != nil {
		return nil
	}
	if c.err != nil && time.Since(c.failedAt) < retryAfter {
		return c.err
	}
	client := sdk.NewClient(&sdk.Implementation{Name: "team-work", Version: "1"}, &sdk.ClientOptions{
		Capabilities:           &sdk.ClientCapabilities{},
		ToolListChangedHandler: func(context.Context, *sdk.ToolListChangedRequest) { c.stale.Store(true) },
	})
	var transport sdk.Transport
	if c.cfg.Command != "" {
		cmd := exec.Command(c.cfg.Command, c.cfg.Args...)
		cmd.Env = os.Environ()
		for k, v := range c.cfg.Env {
			cmd.Env = append(cmd.Env, k+"="+v)
		}
		cmd.Dir = c.cfg.Cwd
		if cmd.Dir == "" {
			cmd.Dir, _ = os.UserHomeDir()
		}
		c.stderr = &tail{}
		cmd.Stderr = c.stderr
		transport = &sdk.CommandTransport{Command: cmd}
	} else {
		transport = &sdk.StreamableClientTransport{Endpoint: c.cfg.URL, MaxRetries: 2,
			HTTPClient: &http.Client{Transport: headers{base: http.DefaultTransport, set: c.cfg.Headers}}}
	}
	connectCtx, cancel := context.WithTimeout(ctx, connectTimeout)
	defer cancel()
	cs, err := client.Connect(connectCtx, transport, nil)
	if err != nil {
		if ctx.Err() != nil {
			return ctx.Err() // the run stopped: the server is not to blame
		}
		c.err, c.failedAt = fmt.Errorf("could not connect: %v%s", err, c.stderrNote()), time.Now()
		return c.err
	}
	c.cs, c.err, c.tools = cs, nil, nil
	c.about = c.cfg.Description
	if init := cs.InitializeResult(); c.about == "" && init != nil {
		c.about, _, _ = strings.Cut(strings.TrimSpace(init.Instructions), "\n")
	}
	// a server that exits or drops is connected again when next needed
	go func() {
		_ = cs.Wait()
		c.drop(cs)
	}()
	return nil
}

// drop forgets a connection that ended, unless it was already replaced.
func (c *conn) drop(cs *sdk.ClientSession) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.dropLocked(cs)
}

func (c *conn) dropLocked(cs *sdk.ClientSession) {
	if c.cs == cs && cs != nil {
		c.cs, c.tools = nil, nil
		go cs.Close()
	}
}

func (c *conn) close() {
	c.mu.Lock()
	cs := c.cs
	c.cs, c.closed = nil, true
	c.mu.Unlock()
	if cs != nil {
		if err := cs.Close(); err != nil {
			c.log.Debug().Err(err).Str("server", c.cfg.Name).Msg("close MCP server")
		}
	}
}

// stderrNote is the end of what a local server wrote to stderr, which often says why it failed.
func (c *conn) stderrNote() string {
	if c.stderr == nil {
		return ""
	}
	if s := strings.TrimSpace(c.stderr.String()); s != "" {
		return "\nIts stderr ended with:\n" + s
	}
	return ""
}

// headers adds the headers mcp.json gives to every request to a remote server.
type headers struct {
	base http.RoundTripper
	set  map[string]string
}

func (h headers) RoundTrip(r *http.Request) (*http.Response, error) {
	if len(h.set) > 0 {
		r = r.Clone(r.Context())
		for k, v := range h.set {
			r.Header.Set(k, v)
		}
	}
	return h.base.RoundTrip(r)
}

// tail keeps the last bytes written to it.
type tail struct {
	mu  sync.Mutex
	buf []byte
}

func (t *tail) Write(p []byte) (int, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.buf = append(t.buf, p...)
	if over := len(t.buf) - stderrTail; over > 0 {
		t.buf = append(t.buf[:0], t.buf[over:]...)
	}
	return len(p), nil
}

func (t *tail) String() string {
	t.mu.Lock()
	defer t.mu.Unlock()
	return strings.ToValidUTF8(string(t.buf), "")
}

// toolName is mcp__<server>__<tool> with what a provider refuses in a name turned to _, cut short with a hash of
// both when too long or taken.
func toolName(server, tool string, taken map[string]bool) string {
	name := "mcp__" + sanitize(server) + "__" + sanitize(tool)
	if len(name) <= maxName && !taken[name] {
		return name
	}
	sum := sha256.Sum256([]byte(server + "\x00" + tool))
	suffix := "_" + hex.EncodeToString(sum[:4])
	return name[:min(len(name), maxName-len(suffix))] + suffix
}

func sanitize(s string) string {
	return strings.Map(func(r rune) rune {
		if r == '_' || r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' {
			return r
		}
		return '_'
	}, s)
}

func describe(server string, t *sdk.Tool) string {
	d := strings.TrimSpace(t.Description)
	if d == "" && t.Annotations != nil {
		d = t.Annotations.Title
	}
	if d == "" {
		d = "Tool " + t.Name
	}
	return d + "\n\n(From MCP server " + server + ".)"
}

// schemaOf is a tool's input schema as every provider takes it: an object, with properties.
func schemaOf(raw any) json.RawMessage {
	var schema map[string]any
	if b, err := json.Marshal(raw); err == nil {
		_ = json.Unmarshal(b, &schema)
	}
	if schema == nil {
		schema = map[string]any{}
	}
	if schema["type"] != "object" {
		schema["type"] = "object"
	}
	if _, ok := schema["properties"]; !ok {
		schema["properties"] = map[string]any{}
	}
	out, _ := json.Marshal(schema)
	return out
}

var lookable = map[string]bool{"image/png": true, "image/jpeg": true, "image/gif": true, "image/webp": true}

// result is what a call gives the model: its text, the first image every provider can look at, and a line for the
// rest; structured content when there is nothing else.
func result(r *sdk.CallToolResult) model.ToolResult {
	var parts []string
	var image *sdk.ImageContent
	for _, c := range r.Content {
		switch c := c.(type) {
		case *sdk.TextContent:
			parts = append(parts, c.Text)
		case *sdk.ImageContent:
			if image == nil && lookable[c.MIMEType] && len(c.Data) <= maxImage {
				image = c
			} else {
				parts = append(parts, fmt.Sprintf("[an image, %s, %d bytes, not shown]", c.MIMEType, len(c.Data)))
			}
		case *sdk.AudioContent:
			parts = append(parts, fmt.Sprintf("[audio, %s, %d bytes, not played]", c.MIMEType, len(c.Data)))
		case *sdk.ResourceLink:
			parts = append(parts, fmt.Sprintf("[resource %s: %s]", c.Name, c.URI))
		case *sdk.EmbeddedResource:
			switch {
			case c.Resource == nil:
			case c.Resource.Text != "":
				parts = append(parts, c.Resource.Text)
			default:
				parts = append(parts, fmt.Sprintf("[resource %s, %s, %d bytes]", c.Resource.URI, c.Resource.MIMEType, len(c.Resource.Blob)))
			}
		}
	}
	if len(parts) == 0 && r.StructuredContent != nil {
		if b, err := json.Marshal(r.StructuredContent); err == nil {
			parts = append(parts, string(b))
		}
	}
	text := strings.Join(parts, "\n")
	if len(text) > maxText {
		cut := maxText
		for cut > 0 && !utf8.RuneStart(text[cut]) {
			cut--
		}
		text = fmt.Sprintf("%s\n[cut: %d more bytes not shown]", text[:cut], len(text)-cut)
	}
	if text == "" && image == nil {
		text = "(no output)"
	}
	out := model.ToolResult{Text: text, IsError: r.IsError}
	if image != nil {
		out.MimeType, out.Data = image.MIMEType, base64.StdEncoding.EncodeToString(image.Data)
	}
	return out
}
