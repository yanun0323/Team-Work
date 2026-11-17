// Package hooks runs the commands the user's hooks.json sets on events of an employee's work, in the format Claude
// Code and Codex use:
//
//	{"hooks": {"PreToolUse": [{"matcher": "Bash", "hooks": [{"type": "command", "command": "~/check.sh", "timeout": 30}]}]}}
//
// A hook gets the event as JSON on stdin. Exit code 0 lets the work go on, and its stdout may be JSON saying more;
// exit code 2 blocks what can be blocked, with stderr as the reason; any other code is reported and ignored.
package hooks

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"regexp"
	"strings"
	"sync"
	"syscall"
	"time"
)

// Event is when a hook runs.
type Event string

const (
	SessionStart       Event = "SessionStart"
	UserPromptSubmit   Event = "UserPromptSubmit"
	PreToolUse         Event = "PreToolUse"
	PostToolUse        Event = "PostToolUse"
	PostToolUseFailure Event = "PostToolUseFailure"
	Stop               Event = "Stop"
)

const (
	defaultTimeout = 600 * time.Second
	// a prompt waits on its hooks before anything else happens, so they get less
	promptTimeout = 30 * time.Second
	maxOutput     = 1 << 20
	killGrace     = 2 * time.Second
)

// Input is what a hook reads on stdin. Fields an event does not have are left out.
type Input struct {
	SessionID      string          `json:"session_id"`
	TranscriptPath *string         `json:"transcript_path"`
	Cwd            string          `json:"cwd"`
	HookEventName  Event           `json:"hook_event_name"`
	Source         string          `json:"source,omitempty"`
	Prompt         string          `json:"prompt,omitempty"`
	ToolName       string          `json:"tool_name,omitempty"`
	ToolInput      json.RawMessage `json:"tool_input,omitempty"`
	ToolResponse   any             `json:"tool_response,omitempty"`
	ToolUseID      string          `json:"tool_use_id,omitempty"`
	Error          string          `json:"error,omitempty"`
	StopHookActive *bool           `json:"stop_hook_active,omitempty"`
	// Model and Agent say who is working, which Claude Code's hooks do not: the model and the employee's name.
	Model string `json:"model,omitempty"`
	Agent string `json:"agent_name,omitempty"`
}

// Outcome is what the hooks of one event decided together.
type Outcome struct {
	// Block refuses what can be refused (a tool call, a prompt, stopping), for Reason. After a tool ran, it only
	// tells the model Reason.
	Block  bool
	Reason string
	// Allow is a hook letting a tool call through, with UpdatedInput in place of its arguments when set.
	UpdatedInput json.RawMessage
	// Context is more for the model to read.
	Context []string
	// Halt ends the work, for HaltReason.
	Halt       bool
	HaltReason string
	// Notices are for the user: what hooks said to them, and hooks that failed.
	Notices []string
}

// Runner reads hooks.json at Path each time an event comes, so a change counts at once. A nil Runner runs nothing.
type Runner struct {
	Path string
}

type handler struct {
	Type    string  `json:"type"`
	Command string  `json:"command"`
	Timeout float64 `json:"timeout"`
}

type group struct {
	Matcher string    `json:"matcher"`
	Hooks   []handler `json:"hooks"`
}

type file struct {
	Hooks    map[Event][]group `json:"hooks"`
	Disabled bool              `json:"disableAllHooks"`
}

// Has says whether any hook is set on the event, so the work can skip building its input.
func (r *Runner) Has(ev Event) bool {
	f, err := r.load()
	return err != nil || len(f.Hooks[ev]) > 0
}

func (r *Runner) load() (file, error) {
	if r == nil || r.Path == "" {
		return file{}, nil
	}
	raw, err := os.ReadFile(r.Path)
	if errors.Is(err, os.ErrNotExist) {
		return file{}, nil
	}
	if err != nil {
		return file{}, err
	}
	var f file
	if err := json.Unmarshal(raw, &f); err != nil {
		return file{}, err
	}
	if f.Disabled {
		return file{}, nil
	}
	return f, nil
}

// Run runs the event's hooks whose matcher matches one of names, all at once, with in on their stdin, in cwd.
func (r *Runner) Run(ctx context.Context, in Input, names ...string) Outcome {
	f, err := r.load()
	if err != nil {
		return Outcome{Notices: []string{fmt.Sprintf("hooks.json could not be read: %v", err)}}
	}
	var commands []handler
	seen := map[string]bool{}
	var out Outcome
	for _, g := range f.Hooks[in.HookEventName] {
		ok, err := matches(g.Matcher, names)
		if err != nil {
			out.Notices = append(out.Notices, fmt.Sprintf("%s hook matcher %q: %v", in.HookEventName, g.Matcher, err))
			continue
		}
		if !ok {
			continue
		}
		for _, h := range g.Hooks {
			// only commands run here; the same command set twice runs once, as in Claude Code
			if h.Type != "command" || strings.TrimSpace(h.Command) == "" || seen[h.Command] {
				continue
			}
			seen[h.Command] = true
			commands = append(commands, h)
		}
	}
	if len(commands) == 0 {
		return out
	}
	stdin, err := json.Marshal(in)
	if err != nil {
		out.Notices = append(out.Notices, err.Error())
		return out
	}
	stdin = append(stdin, '\n') // a script reading a line gets all of it
	results := make([]ran, len(commands))
	var wg sync.WaitGroup
	for i, h := range commands {
		wg.Go(func() { results[i] = run(ctx, h, in, stdin) })
	}
	wg.Wait()
	for _, res := range results {
		out.add(in.HookEventName, res)
	}
	return out
}

// matches says whether a matcher picks one of names: everything when empty or *, the names it lists when it is only
// words and |, and otherwise those its regular expression finds in.
func matches(matcher string, names []string) (bool, error) {
	if matcher == "" || matcher == "*" {
		return true, nil
	}
	if plain.MatchString(matcher) {
		for _, want := range strings.Split(matcher, "|") {
			for _, n := range names {
				if n == want {
					return true, nil
				}
			}
		}
		return false, nil
	}
	re, err := regexp.Compile(matcher)
	if err != nil {
		return false, err
	}
	for _, n := range names {
		if re.MatchString(n) {
			return true, nil
		}
	}
	return false, nil
}

var plain = regexp.MustCompile(`^[A-Za-z0-9_|]+$`)

// ran is how one hook ended.
type ran struct {
	command        string
	code           int
	stdout, stderr string
	err            error
}

func run(ctx context.Context, h handler, in Input, stdin []byte) ran {
	timeout := defaultTimeout
	if in.HookEventName == UserPromptSubmit {
		timeout = promptTimeout
	}
	if h.Timeout > 0 {
		timeout = time.Duration(h.Timeout * float64(time.Second))
	}
	runCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	shell := "bash"
	if _, err := exec.LookPath(shell); err != nil {
		shell = "sh"
	}
	cmd := exec.CommandContext(runCtx, shell, "-c", h.Command)
	cmd.Dir = in.Cwd
	cmd.Env = append(os.Environ(), "CLAUDE_PROJECT_DIR="+in.Cwd, "TEAM_WORK_PROJECT_DIR="+in.Cwd)
	cmd.Stdin = bytes.NewReader(stdin)
	var stdout, stderr capped
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	// its own process group, so a timeout stops everything it started
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Cancel = func() error { return syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL) }
	cmd.WaitDelay = killGrace
	err := cmd.Run()
	res := ran{command: h.Command, stdout: stdout.String(), stderr: strings.TrimSpace(stderr.String())}
	var exit *exec.ExitError
	switch {
	case runCtx.Err() != nil && ctx.Err() == nil:
		res.err = fmt.Errorf("timed out after %s", timeout)
	case ctx.Err() != nil:
		res.err = ctx.Err()
	case errors.As(err, &exit):
		res.code = exit.ExitCode()
	case err != nil:
		res.err = err
	}
	return res
}

// output is the JSON a hook may print on stdout.
type output struct {
	Continue           *bool  `json:"continue"`
	StopReason         string `json:"stopReason"`
	SystemMessage      string `json:"systemMessage"`
	Decision           string `json:"decision"`
	Reason             string `json:"reason"`
	HookSpecificOutput struct {
		PermissionDecision       string          `json:"permissionDecision"`
		PermissionDecisionReason string          `json:"permissionDecisionReason"`
		UpdatedInput             json.RawMessage `json:"updatedInput"`
		AdditionalContext        string          `json:"additionalContext"`
	} `json:"hookSpecificOutput"`
}

// add folds one hook's ending into the outcome.
func (o *Outcome) add(ev Event, r ran) {
	name := hookName(r.command)
	if r.err != nil {
		if !errors.Is(r.err, context.Canceled) {
			o.Notices = append(o.Notices, fmt.Sprintf("%s hook %s: %v", ev, name, r.err))
		}
		return
	}
	switch r.code {
	case 0:
	case 2:
		reason := r.stderr
		if reason == "" {
			reason = "blocked by hook " + name
		}
		if ev == SessionStart {
			o.Notices = append(o.Notices, fmt.Sprintf("%s hook %s: %s", ev, name, reason))
			return
		}
		o.block(reason)
		return
	default:
		note := fmt.Sprintf("%s hook %s exited with code %d", ev, name, r.code)
		if r.stderr != "" {
			note += ": " + r.stderr
		}
		o.Notices = append(o.Notices, note)
		return
	}
	text := strings.TrimSpace(r.stdout)
	var out output
	if !strings.HasPrefix(text, "{") || json.Unmarshal([]byte(text), &out) != nil {
		// plain text goes to the model only where Claude Code puts it there
		if text != "" && (ev == SessionStart || ev == UserPromptSubmit) {
			o.Context = append(o.Context, text)
		}
		return
	}
	if out.SystemMessage != "" {
		o.Notices = append(o.Notices, out.SystemMessage)
	}
	if out.Continue != nil && !*out.Continue {
		o.Halt = true
		o.HaltReason = join(o.HaltReason, cmpOr(out.StopReason, "stopped by hook "+name))
	}
	if c := strings.TrimSpace(out.HookSpecificOutput.AdditionalContext); c != "" {
		o.Context = append(o.Context, c)
	}
	switch strings.ToLower(out.HookSpecificOutput.PermissionDecision) {
	case "deny":
		o.block(cmpOr(out.HookSpecificOutput.PermissionDecisionReason, "denied by hook "+name))
	case "ask":
		// no one is asked in the middle of a run: what a hook wants a person to approve does not run
		o.block(cmpOr(out.HookSpecificOutput.PermissionDecisionReason, "hook "+name+" wants the user to approve this") +
			" (hooks cannot ask the user here, so the call was not run)")
	case "allow":
		if len(out.HookSpecificOutput.UpdatedInput) > 0 && o.UpdatedInput == nil {
			o.UpdatedInput = out.HookSpecificOutput.UpdatedInput
		}
	}
	if out.Decision == "block" && ev != SessionStart {
		o.block(cmpOr(out.Reason, "blocked by hook "+name))
	}
}

func (o *Outcome) block(reason string) {
	o.Block = true
	o.Reason = join(o.Reason, reason)
}

func join(a, b string) string {
	if a == "" {
		return b
	}
	return a + "\n" + b
}

func cmpOr(a, b string) string {
	if a != "" {
		return a
	}
	return b
}

// hookName is a command as short as it can be told by, for a notice.
func hookName(command string) string {
	command = strings.Join(strings.Fields(command), " ")
	if r := []rune(command); len(r) > 80 {
		command = string(r[:77]) + "..."
	}
	return "`" + command + "`"
}

// capped keeps what a hook writes up to maxOutput.
type capped struct{ bytes.Buffer }

func (c *capped) Write(p []byte) (int, error) {
	if room := maxOutput - c.Len(); room > 0 {
		c.Buffer.Write(p[:min(len(p), room)])
	}
	return len(p), nil
}
