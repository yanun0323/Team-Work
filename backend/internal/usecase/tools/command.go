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
	"syscall"
	"time"

	"github.com/yanun0323/Team-Work/internal/model"
)

const killGrace = 2 * time.Second

// Command runs a shell command. It is not sandboxed: it can reach whatever the server's user can.
type Command struct {
	// OutputDir keeps output too long to show; the system's temporary folder when empty.
	OutputDir string
}

func (Command) Spec() model.ToolSpec {
	return model.ToolSpec{Name: "run_command", Description: "Run a shell command in the working directory. Returns stdout and stderr together. Long output is cut to its last 2000 lines or 50KB, with the whole of it saved to a file.",
		Parameters: json.RawMessage(`{"type":"object","properties":{"command":{"type":"string"},"timeout":{"type":"integer","description":"Seconds; none when omitted"}},"required":["command"]}`)}
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
		Command string `json:"command"`
		Timeout int    `json:"timeout"`
	}
	if err := decode(raw, &args); err != nil {
		return fail("invalid arguments: %v", err)
	}
	if strings.TrimSpace(args.Command) == "" {
		return fail("command is required")
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

// tail keeps the end of a command's output in memory. Once the output outgrows what a model is
// shown, all of it is also written to a file, so nothing is lost.
type tail struct {
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
	if t.file != nil {
		_ = t.file.Close()
	}
}

// text is the output to show: all of it when it fits, else its last lines with a note saying where the rest is.
func (t *tail) text() string {
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
