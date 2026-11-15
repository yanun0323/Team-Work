package tools

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/yanun0323/Team-Work/internal/model"
)

const killGrace = 2 * time.Second

// Command runs a shell command. It is not sandboxed: it can reach whatever the server's user can.
type Command struct {
	// OutputDir keeps output too long to show; the system's temporary folder when empty.
	OutputDir string
	// Changed, when set, hears that the command may have changed files in the working directory.
	Changed func(path, source string)
	// Jobs keeps background commands, those of JobScope; none can start without it.
	Jobs     *Jobs
	JobScope string
}

func (Command) Spec() model.ToolSpec {
	return model.ToolSpec{Name: "run_command", Description: "Run a shell command in the working directory. Returns stdout and stderr together. Long output is cut to its last 2000 lines or 50KB, with the whole of it saved to a file. " +
		"With background true it starts the command and returns a job_id at once; you are told when it ends, with its output. Then job_id with action status, wait or kill checks it, waits for it or stops it. " +
		"A task step's background commands stop when the step ends; a chat's go on after your reply.",
		Parameters: json.RawMessage(`{"type":"object","properties":{"command":{"type":"string"},"timeout":{"type":"integer","description":"Seconds; none when omitted. With background, stops the command after that long; with action wait, the longest to wait"},` +
			`"background":{"type":"boolean","description":"Start the command and return at once with a job_id"},` +
			`"job_id":{"type":"string","description":"A background command, with action"},` +
			`"action":{"type":"string","enum":["status","wait","kill"],"description":"With job_id: status reports it now, wait waits for it to end, kill stops it and all it started"}}}`)}
}

// Streamer is a tool that can show what it is doing while it runs.
type Streamer interface {
	// RunStream is Run, also handing output the last lines so far, now and then while it runs.
	RunStream(ctx context.Context, cwd string, args json.RawMessage, output func(string)) model.ToolResult
}

const (
	// what is shown live is a glimpse, not the output: it goes to every connected page many times a second
	liveLines    = 12
	liveBytes    = 4 << 10
	liveInterval = 100 * time.Millisecond
)

func (t Command) Run(ctx context.Context, cwd string, raw json.RawMessage) model.ToolResult {
	return t.RunStream(ctx, cwd, raw, nil)
}

func (t Command) RunStream(ctx context.Context, cwd string, raw json.RawMessage, output func(string)) model.ToolResult {
	var args struct {
		Command    string `json:"command"`
		Timeout    int    `json:"timeout"`
		Background bool   `json:"background"`
		JobID      string `json:"job_id"`
		Action     string `json:"action"`
	}
	if err := decode(raw, &args); err != nil {
		return fail("invalid arguments: %v", err)
	}
	if args.Timeout < 0 {
		return fail("timeout must not be negative")
	}
	if args.JobID != "" || args.Action != "" {
		return t.job(ctx, args.JobID, args.Action, time.Duration(args.Timeout)*time.Second)
	}
	if strings.TrimSpace(args.Command) == "" {
		return fail("command is required")
	}
	if args.Background {
		var changed func()
		if t.Changed != nil && !readOnly(args.Command) {
			changed = func() { t.Changed(cwd, "run_command") }
		}
		if t.Jobs == nil {
			return fail("background commands are not available here")
		}
		r, err := t.Jobs.Start(t.JobScope, cwd, args.Command, time.Duration(args.Timeout)*time.Second, t.OutputDir, changed)
		if err != nil {
			return fail("%s", err)
		}
		where := ""
		if r.File != "" {
			where = " Its output goes to " + r.File + " as it comes."
		}
		return model.ToolResult{Text: fmt.Sprintf("Started background command %s.%s You will be told when it ends; run_command with job_id %q and action status, wait or kill checks it, waits for it or stops it.", r.ID, where, r.ID)}
	}
	// a command that surely only reads leaves the index alone; a search scans the folder first anyway
	if t.Changed != nil && !readOnly(args.Command) {
		defer t.Changed(cwd, "run_command")
	}
	runCtx := ctx
	if args.Timeout > 0 {
		var cancel context.CancelFunc
		runCtx, cancel = context.WithTimeout(ctx, time.Duration(args.Timeout)*time.Second)
		defer cancel()
	}
	shell := "bash"
	if _, err := exec.LookPath(shell); err != nil {
		shell = "sh"
	}
	out := &tail{dir: t.OutputDir, output: output}
	defer out.close()
	cmd := exec.CommandContext(runCtx, shell, "-c", args.Command)
	cmd.Dir = cwd
	cmd.Stdout, cmd.Stderr = out, out
	// its own process group, so stopping it stops everything it started
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Cancel = func() error { return syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL) }
	cmd.WaitDelay = killGrace
	err := cmd.Run()
	text := out.text()
	note := func(s string) string {
		if text != "" && !strings.HasSuffix(text, "\n") {
			text += "\n"
		}
		return text + s
	}
	var exit *exec.ExitError
	switch {
	case ctx.Err() != nil:
		return fail("%s", note("[stopped]"))
	case runCtx.Err() != nil:
		return fail("%s", note(fmt.Sprintf("[timed out after %d seconds]", args.Timeout)))
	case errors.As(err, &exit):
		return fail("%s", note(fmt.Sprintf("[exit code %d]", exit.ExitCode())))
	case err != nil:
		return fail("%s", note("[could not run: "+err.Error()+"]"))
	}
	return model.ToolResult{Text: text}
}

// job checks on, waits for or stops a background command.
func (t Command) job(ctx context.Context, id, action string, timeout time.Duration) model.ToolResult {
	if t.Jobs == nil {
		return fail("background commands are not available here")
	}
	if strings.TrimSpace(id) == "" {
		return fail("job_id is required with action")
	}
	var r JobReport
	var err error
	switch action {
	case "status":
		r, err = t.Jobs.Status(t.JobScope, id)
	case "wait":
		r, err = t.Jobs.Wait(ctx, t.JobScope, id, timeout)
	case "kill":
		r, err = t.Jobs.Kill(t.JobScope, id)
	default:
		return fail("action must be status, wait or kill")
	}
	if ctx.Err() != nil {
		return fail("[stopped]")
	}
	if err != nil {
		return fail("%s", err)
	}
	return model.ToolResult{Text: r.Text()}
}

// tail keeps the end of a command's output in memory. Once the output outgrows what a model is
// shown, all of it is also written to a file, so nothing is lost.
type tail struct {
	// mu lets a background command's output be read while it is written
	mu     sync.Mutex
	dir    string
	output func(string)
	shown  time.Time
	buf    []byte
	total  int
	file   *os.File
	// fileErr is why the full output could not be kept, if it could not.
	fileErr error
}

func (t *tail) Write(p []byte) (int, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.total += len(p)
	if t.file == nil && t.fileErr == nil && len(t.buf)+len(p) > maxBytes {
		t.save()
	}
	if t.file != nil && t.fileErr == nil {
		_, t.fileErr = t.file.Write(p)
	}
	t.buf = append(t.buf, p...)
	// Keep twice the limit so trimming does not run on every write.
	if len(t.buf) > 2*maxBytes {
		t.buf = append(t.buf[:0], t.buf[len(t.buf)-maxBytes:]...)
	}
	if t.output != nil && time.Since(t.shown) >= liveInterval {
		t.shown = time.Now()
		t.output(glimpse(t.buf))
	}
	return len(p), nil
}

// glimpse is the last few lines of what a command has written so far.
func glimpse(buf []byte) string {
	if len(buf) > liveBytes {
		buf = buf[len(buf)-liveBytes:]
		if i := bytes.IndexByte(buf, '\n'); i >= 0 && i < len(buf)-1 {
			buf = buf[i+1:]
		}
	}
	buf = bytes.TrimRight(buf, "\n")
	for lines := bytes.Count(buf, []byte("\n")) + 1; lines > liveLines; lines-- {
		buf = buf[bytes.IndexByte(buf, '\n')+1:]
	}
	return string(bytes.ToValidUTF8(buf, nil))
}

// name is the file that keeps all of the output, "" when there is none.
func (t *tail) name() string {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.file == nil || t.fileErr != nil {
		return ""
	}
	return t.file.Name()
}

// save starts the file with what is held so far; later writes go on after it.
func (t *tail) save() {
	if t.dir != "" {
		if t.fileErr = os.MkdirAll(t.dir, 0o700); t.fileErr != nil {
			return
		}
	}
	if t.file, t.fileErr = os.CreateTemp(t.dir, "command-*.log"); t.fileErr == nil {
		_, t.fileErr = t.file.Write(t.buf)
	}
}

func (t *tail) close() {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.file != nil {
		_ = t.file.Close()
	}
}

// text is the output to show: all of it when it fits, else its last lines with a note saying where the rest is.
func (t *tail) text() string {
	t.mu.Lock()
	defer t.mu.Unlock()
	buf := t.buf
	cut := t.total > len(buf)
	if len(buf) > maxBytes {
		buf, cut = buf[len(buf)-maxBytes:], true
	}
	if cut {
		// Start on a whole line, unless that would throw away most of what there is to show,
		// as it would for output that is one very long line.
		if i := bytes.IndexByte(buf, '\n'); i >= 0 && i < len(buf)/2 {
			buf = buf[i+1:]
		}
	}
	if lines := bytes.Count(buf, []byte("\n")); lines > maxLines {
		cut = true
		for skip := lines - maxLines; skip > 0; skip-- {
			buf = buf[bytes.IndexByte(buf, '\n')+1:]
		}
	}
	if !cut {
		return string(buf)
	}
	// Output that is short in bytes but long in lines has not been written out yet.
	if t.file == nil && t.fileErr == nil {
		t.save()
	}
	where := "the full output could not be saved"
	if t.file != nil && t.fileErr == nil {
		where = "full output: " + t.file.Name()
		if t.dir != "" {
			where += ", readable with read_file"
		}
	}
	shown := bytes.Count(buf, []byte("\n"))
	return fmt.Sprintf("[Output cut to its last %d lines; %s]\n%s", shown, where, bytes.ToValidUTF8(buf, nil))
}
