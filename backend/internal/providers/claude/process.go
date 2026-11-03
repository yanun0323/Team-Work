package claude

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"os"
	"os/exec"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/yanun0323/Team-Work/internal/i18n"
)

// maxFrame fits a message with six images at the largest size, 5MB of base64 each.
const maxFrame = 64 << 20
const toolPrefix = "mcp__mho__"

type object = map[string]any

func rejected(message string) error {
	return &Error{Code: CodeInvalidRequest, Message: i18n.T(message)}
}

// signedOut is a missing or expired login; signing in again is the fix.
func signedOut(message string) error {
	return &Error{Code: CodeSignedOut, Message: i18n.T(message)}
}
func unavailable(message string) error {
	return &Error{Code: CodeUnavailable, Message: i18n.T(message)}
}

// Never expose raw CLI errors: they can contain prompts, paths or credentials.
func claudeError(text string) error {
	s := strings.ToLower(text)
	switch {
	case strings.Contains(s, "prompt is too long"), strings.Contains(s, "context window"), strings.Contains(s, "context length"):
		return &Error{Code: CodeContextOverflow, Message: "The conversation is longer than Claude can read."}
	case strings.Contains(s, "auth"), strings.Contains(s, "login"), strings.Contains(s, "credential"):
		return &authError{signedOut("Claude Code is not logged in. Run claude auth login, then /login and choose Claude Code.")}
	case strings.Contains(s, "rate_limit"), strings.Contains(s, "overloaded"), strings.Contains(s, "network"), strings.Contains(s, "fetch failed"), strings.Contains(s, "429"), strings.Contains(s, "503"):
		return unavailable("Claude is temporarily unavailable. Check your connection and try again.")
	case modelRefused(s):
		return modelUnavailable()
	default:
		return rejected("Claude Code could not complete the request. Check your installation, version and login.")
	}
}

type authError struct{ error }

func (e *authError) Unwrap() error { return e.error }

func childEnvironment() ([]string, error) {
	for _, key := range []string{"ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY"} {
		if os.Getenv(key) != "" {
			return nil, rejected(i18n.T("要使用 Claude 訂閱，請先移除環境變數 %s", key))
		}
	}
	env := []string{}
	for _, entry := range os.Environ() {
		key, _, _ := strings.Cut(entry, "=")
		switch key {
		case "DISABLE_AUTO_COMPACT", "ENABLE_CLAUDEAI_MCP_SERVERS", "ENABLE_TOOL_SEARCH", "NODE_OPTIONS", "DEBUG":
			continue
		}
		env = append(env, entry)
	}
	// Tool search defers Mho's tools behind Claude's own search tool, which emitCall rejects as outside Mho.
	return append(env, "DISABLE_AUTO_COMPACT=1", "ENABLE_CLAUDEAI_MCP_SERVERS=0", "ENABLE_TOOL_SEARCH=false"), nil
}

func launchArgs(p CompleteParams, resume string) []string {
	settings, _ := json.Marshal(object{"disableAllHooks": true, "autoMemoryEnabled": false, "claudeMdExcludes": []string{"**/CLAUDE.md", "**/AGENTS.md", "**/.claude/rules/**"}, "disableClaudeAiConnectors": true, "disableBundledSkills": true})
	args := []string{"--print", "--output-format", "stream-json", "--verbose", "--input-format", "stream-json", "--tools", "", "--setting-sources=", "--strict-mcp-config", "--permission-mode", "dontAsk", "--include-partial-messages", "--no-session-persistence", "--settings", string(settings)}
	if p.Model != "" {
		args = append(args, "--model", p.Model)
	}
	if p.Thinking != "" {
		args = append(args, "--effort", p.Thinking)
	}
	if resume != "" {
		args = append(args, "--resume="+resume)
	}
	if len(p.Tools) > 0 {
		names := make([]string, 0, len(p.Tools))
		for _, t := range p.Tools {
			names = append(names, toolPrefix+t.Name)
		}
		args = append(args, "--allowedTools", strings.Join(names, ","), "--mcp-config", `{"mcpServers":{"mho":{"type":"sdk","name":"mho"}}}`)
	}
	return args
}

type frame struct {
	Type      string          `json:"type"`
	Subtype   string          `json:"subtype"`
	RequestID string          `json:"request_id"`
	Request   json.RawMessage `json:"request"`
	Response  struct {
		Subtype   string          `json:"subtype"`
		RequestID string          `json:"request_id"`
		Response  json.RawMessage `json:"response"`
		Error     string          `json:"error"`
	} `json:"response"`
	Event           json.RawMessage  `json:"event"`
	Message         assistantMessage `json:"message"`
	UUID            string           `json:"uuid"`
	ParentToolUseID string           `json:"parent_tool_use_id"`
	Error           string           `json:"error"`
	IsError         bool             `json:"is_error"`
	Errors          []string         `json:"errors"`
	Result          string           `json:"result"`
	StopReason      string           `json:"stop_reason"`
	Usage           tokenUsage       `json:"usage"`
	ModelUsage      map[string]struct {
		ContextWindow int `json:"contextWindow"`
	} `json:"modelUsage"`
}
type incoming struct {
	frame frame
	err   error
}
type child struct {
	log      *slog.Logger
	cmd      *exec.Cmd
	stdin    *os.File
	stdout   *os.File
	events   chan incoming
	done     chan struct{}
	readDone chan struct{}
	stopRead chan struct{}
	once     sync.Once
}

func startChild(p CompleteParams, resume string, log *slog.Logger) (*child, error) {
	env, err := childEnvironment()
	if err != nil {
		return nil, err
	}
	path, _ := executable()
	cmd := exec.Command(path, launchArgs(p, resume)...)
	cmd.Dir = p.Cwd
	cmd.Env = env
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	stderr := &diagnosticStderr{}
	cmd.Stderr = stderr
	// A descendant retaining stderr must not keep shutdown waiting forever.
	cmd.WaitDelay = 300 * time.Millisecond
	inR, inW, err := os.Pipe()
	if err != nil {
		return nil, err
	}
	outR, outW, err := os.Pipe()
	if err != nil {
		inR.Close()
		inW.Close()
		return nil, err
	}
	cmd.Stdin = inR
	cmd.Stdout = outW
	if err = cmd.Start(); err != nil {
		inR.Close()
		inW.Close()
		outR.Close()
		outW.Close()
		return nil, rejected("找不到 Claude Code 或工作資料夾")
	}
	inR.Close()
	outW.Close()
	if log != nil {
		log = log.With("pid", cmd.Process.Pid)
	}
	record(log, "process_started", "resumed", resume != "")
	c := &child{log: log, cmd: cmd, stdin: inW, stdout: outR, events: make(chan incoming, 64), done: make(chan struct{}), readDone: make(chan struct{}), stopRead: make(chan struct{})}
	go func() {
		defer close(c.done)
		_ = cmd.Wait()
		closing := false
		select {
		case <-c.stopRead:
			closing = true
		default:
		}
		record(log, "process_exit", "closing", closing, "exit_code", cmd.ProcessState.ExitCode(), "stderr_bytes", stderr.bytes, "stderr_category", diagnosticCategory(string(stderr.prefix)), "stderr_truncated", stderr.bytes > int64(len(stderr.prefix)))
		stderr.prefix = nil
	}()
	go func() {
		defer close(c.readDone)
		defer close(c.events)
		send := func(v incoming) bool {
			select {
			case c.events <- v:
				return true
			case <-c.stopRead:
				return false
			}
		}
		scanner := bufio.NewScanner(outR)
		scanner.Buffer(make([]byte, 64<<10), maxFrame)
		for scanner.Scan() {
			if len(scanner.Bytes()) == 0 {
				continue
			}
			var f frame
			if json.Unmarshal(scanner.Bytes(), &f) != nil {
				record(log, "invalid_frame", "bytes", len(scanner.Bytes()))
				send(incoming{err: unavailable("Claude sent an invalid response.")})
				return
			}
			c.recordFrame(f)
			if !send(incoming{frame: f}) {
				return
			}
		}
		if scanner.Err() != nil {
			select {
			case <-c.stopRead:
				return
			default:
			}
			record(log, "read_failure")
			send(incoming{err: unavailable("Could not read Claude's response.")})
		}
	}()
	return c, nil
}
func (c *child) close() {
	c.once.Do(func() {
		close(c.stopRead)
		_ = c.stdin.Close()
		_ = c.stdout.Close()
		select {
		case <-c.done:
		default:
			_ = syscall.Kill(-c.cmd.Process.Pid, syscall.SIGTERM)
			select {
			case <-c.done:
			case <-time.After(300 * time.Millisecond):
				_ = syscall.Kill(-c.cmd.Process.Pid, syscall.SIGKILL)
				<-c.done
			}
		}
		<-c.readDone
	})
}
func (c *child) send(ctx context.Context, value any) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	raw, err := json.Marshal(value)
	if err != nil {
		return err
	}
	if len(raw)+1 > maxFrame {
		return rejected("Claude request exceeds the message limit.")
	}
	deadline := time.Now().Add(10 * time.Second)
	if d, ok := ctx.Deadline(); ok && d.Before(deadline) {
		deadline = d
	}
	if err = c.stdin.SetWriteDeadline(deadline); err != nil {
		return err
	}
	// Closing the owned pipe interrupts a write even when the child stops reading.
	stopped := make(chan struct{})
	stop := context.AfterFunc(ctx, func() { _ = c.stdin.Close(); close(stopped) })
	defer func() {
		if !stop() {
			<-stopped
		}
	}()
	raw = append(raw, '\n')
	for len(raw) > 0 {
		n, e := c.stdin.Write(raw)
		if e != nil {
			return unavailable("Could not send a request to Claude.")
		}
		raw = raw[n:]
	}
	return nil
}
func (c *child) next(ctx context.Context) (frame, error) {
	select {
	case <-ctx.Done():
		return frame{}, ctx.Err()
	case v, ok := <-c.events:
		if !ok {
			return frame{}, unavailable("Claude stopped before completing its reply.")
		}
		return v.frame, v.err
	}
}
func (c *child) control(ctx context.Context, request object, handle func(context.Context, frame) error) (json.RawMessage, error) {
	id := newID()
	if err := c.send(ctx, object{"type": "control_request", "request_id": id, "request": request}); err != nil {
		return nil, err
	}
	for {
		f, err := c.next(ctx)
		if err != nil {
			return nil, err
		}
		if f.Type == "control_response" && f.Response.RequestID == id {
			if f.Response.Subtype != "success" {
				record(c.log, "claude_failure", "stage", request["subtype"], "category", diagnosticCategory(f.Response.Error))
				return nil, claudeError(f.Response.Error)
			}
			return f.Response.Response, nil
		}
		if f.Type == "control_request" {
			if err := handle(ctx, f); err != nil {
				return nil, err
			}
		}
		if f.Type == "result" && f.IsError {
			return nil, claudeError(strings.Join(f.Errors, " ") + f.Result)
		}
	}
}
func (c *child) reply(ctx context.Context, id string, value any) error {
	return c.send(ctx, object{"type": "control_response", "response": object{"subtype": "success", "request_id": id, "response": value}})
}
func (c *child) rejectControl(ctx context.Context, id string) error {
	return c.send(ctx, object{"type": "control_response", "response": object{"subtype": "error", "request_id": id, "error": "Unsupported request"}})
}
func safeError(err error) error {
	var p *Error
	if errors.As(err, &p) {
		return p
	}
	if errors.Is(err, context.Canceled) {
		return rejected("Claude request cancelled.")
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return &Error{Code: CodeTimeout, Message: "Claude request timed out."}
	}
	return internalError()
}

// internalError is a failure on this side, before or after Claude Code ran, so it must not send the user to
// their installation or login. The cause goes to the log as its type only.
func internalError() error {
	return rejected("處理這次請求時發生內部錯誤，請重試。如果持續發生，請查看 backend.log")
}
