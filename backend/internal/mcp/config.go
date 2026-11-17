// Package mcp connects to the MCP servers the user lists in mcp.json and offers their tools to employees.
//
// The file has the shape other MCP clients use (Claude Code, Cursor, Pi), so an entry can be copied from them:
//
//	{"mcpServers": {"name": {"command": "npx", "args": ["-y", "server"], "env": {"KEY": "${KEY}"}},
//	                "docs": {"url": "https://example.com/mcp", "headers": {"Authorization": "Bearer ${TOKEN}"}}}}
package mcp

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"time"
)

// Exposure is how a server's tools reach the model.
const (
	// Direct tools are offered to the model like any other.
	Direct = "direct"
	// Script tools are called only from exec scripts; a run offered one has the script tool on. The default.
	Script = "codemode"
	// Hidden tools are not offered at all.
	Hidden = "hidden"
)

const defaultTimeout = 60 * time.Second

// Server is one entry of mcp.json, its values already expanded.
type Server struct {
	Name string
	// Command and Args start a local server spoken to over stdin and stdout; URL names a remote one spoken to over
	// streamable HTTP.
	Command string
	Args    []string
	Env     map[string]string
	Cwd     string
	URL     string
	Headers map[string]string
	// Timeout bounds each request to the server.
	Timeout time.Duration
	// Exposure is the server's tools' default; ToolExposure sets it for single tools, by their name on the server.
	Exposure     string
	ToolExposure map[string]string
	Description  string
}

// key is what makes two configurations the same connection: a change to any of it connects again.
func (s Server) key() string {
	raw, _ := json.Marshal(s)
	return string(raw)
}

// exposure is how one of the server's tools reaches the model.
func (s Server) exposure(tool string) string {
	if e, ok := s.ToolExposure[tool]; ok {
		return e
	}
	return s.Exposure
}

type rawServer struct {
	Type         string            `json:"type"`
	Command      string            `json:"command"`
	Args         []string          `json:"args"`
	Env          map[string]string `json:"env"`
	Cwd          string            `json:"cwd"`
	URL          string            `json:"url"`
	Headers      map[string]string `json:"headers"`
	Timeout      float64           `json:"timeout"`
	Enabled      *bool             `json:"enabled"`
	Disabled     bool              `json:"disabled"`
	Exposure     string            `json:"exposure"`
	ToolExposure map[string]string `json:"toolExposure"`
	Description  string            `json:"description"`
}

var (
	serverName = regexp.MustCompile(`^[A-Za-z0-9_-]+$`)
	envRef     = regexp.MustCompile(`\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}`)
)

// Load reads mcp.json: the servers to connect to, in name order, and what is wrong with the entries left out. A file
// that does not exist lists none.
func Load(path string) ([]Server, []error) {
	raw, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, []error{fmt.Errorf("mcp.json: %v", err)}
	}
	var file struct {
		Servers map[string]json.RawMessage `json:"mcpServers"`
	}
	if err := json.Unmarshal(raw, &file); err != nil {
		return nil, []error{fmt.Errorf("mcp.json: %v", err)}
	}
	var out []Server
	var problems []error
	names := map[string]string{}
	for _, name := range sortedKeys(file.Servers) {
		s, on, err := parse(name, file.Servers[name])
		if err == nil {
			// the names tools are known by turn - into _, so two that differ only there would share them
			if other, taken := names[sanitize(name)]; taken {
				err = fmt.Errorf("its name names the same tools as %q", other)
			}
		}
		if err != nil {
			problems = append(problems, fmt.Errorf("MCP server %q: %v", name, err))
			continue
		}
		names[sanitize(name)] = name
		if on {
			out = append(out, s)
		}
	}
	return out, problems
}

func parse(name string, raw json.RawMessage) (Server, bool, error) {
	if !serverName.MatchString(name) {
		return Server{}, false, errors.New("names may have only letters, digits, _ and -")
	}
	var r rawServer
	dec := json.NewDecoder(bytes.NewReader(raw))
	if err := dec.Decode(&r); err != nil {
		return Server{}, false, err
	}
	on := !r.Disabled && (r.Enabled == nil || *r.Enabled)
	s := Server{Name: name, Command: home(expand(r.Command)), Cwd: home(expand(r.Cwd)), URL: expand(r.URL), Description: strings.TrimSpace(r.Description),
		Env: expandMap(r.Env), Headers: expandMap(r.Headers), Timeout: defaultTimeout, ToolExposure: r.ToolExposure}
	for _, a := range r.Args {
		s.Args = append(s.Args, home(expand(a)))
	}
	if r.Timeout > 0 {
		s.Timeout = time.Duration(r.Timeout * float64(time.Second))
	}
	switch r.Type {
	case "", "stdio", "http", "streamable-http":
	case "sse":
		return Server{}, false, errors.New("the SSE transport is not supported; servers that offer it often also take streamable HTTP, commonly at /mcp")
	default:
		return Server{}, false, fmt.Errorf("unknown type %q: use stdio or http", r.Type)
	}
	switch {
	case s.Command != "" && s.URL != "":
		return Server{}, false, errors.New("give command or url, not both")
	case s.Command == "" && s.URL == "":
		return Server{}, false, errors.New("command or url is required")
	case r.Type == "stdio" && s.Command == "":
		return Server{}, false, errors.New("type stdio needs command")
	case r.Type != "" && r.Type != "stdio" && s.URL == "":
		return Server{}, false, fmt.Errorf("type %s needs url", r.Type)
	}
	if s.Cwd != "" && !filepath.IsAbs(s.Cwd) {
		return Server{}, false, errors.New("cwd must be an absolute path or start with ~/")
	}
	s.Exposure = Script
	if r.Exposure != "" {
		e, ok := exposureOf(r.Exposure)
		if !ok {
			return Server{}, false, fmt.Errorf("unknown exposure %q: use direct, codemode or hidden", r.Exposure)
		}
		s.Exposure = e
	}
	for tool, value := range r.ToolExposure {
		e, ok := exposureOf(value)
		if !ok {
			return Server{}, false, fmt.Errorf("tool %q: unknown exposure %q: use direct, codemode or hidden", tool, value)
		}
		s.ToolExposure[tool] = e
	}
	return s, on, nil
}

// exposureOf reads an exposure; deferred, which Pi offers through a tool search, is reached from scripts here.
func exposureOf(value string) (string, bool) {
	switch value {
	case Direct, Script, Hidden:
		return value, true
	case "deferred":
		return Script, true
	}
	return "", false
}

// expand puts in the environment variables ${NAME} names, or ${NAME:-default}'s default when it is unset or empty.
func expand(s string) string {
	return envRef.ReplaceAllStringFunc(s, func(ref string) string {
		m := envRef.FindStringSubmatch(ref)
		if v := os.Getenv(m[1]); v != "" {
			return v
		}
		return m[2]
	})
}

func expandMap(m map[string]string) map[string]string {
	if len(m) == 0 {
		return nil
	}
	out := make(map[string]string, len(m))
	for k, v := range m {
		out[k] = expand(v)
	}
	return out
}

// home turns a leading ~/ into the home folder.
func home(s string) string {
	if rest, ok := strings.CutPrefix(s, "~/"); ok {
		if dir, err := os.UserHomeDir(); err == nil {
			return filepath.Join(dir, rest)
		}
	}
	return s
}

func sortedKeys[V any](m map[string]V) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	slices.Sort(keys)
	return keys
}
