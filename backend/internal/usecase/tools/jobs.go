package tools

import (
	"context"
	"errors"
	"fmt"
	"os/exec"
	"slices"
	"strings"
	"sync"
	"syscall"
	"time"
)

// MaxJobs is how many background commands one scope may have running at once.
const MaxJobs = 8

// States of a background command.
const (
	JobRunning  = "running"
	JobExited   = "exited"
	JobTimedOut = "timed_out"
	JobKilled   = "killed"
	JobFailed   = "failed"
)

// Jobs keeps the background commands run_command starts, each in a scope: a task step's run or a chat. A command runs
// in a process group of its own, so stopping it stops everything it started; ending a scope stops all of its own.
type Jobs struct {
	// Done, when set, hears that a command of scope ended, once its result is final. It is called with no lock held.
	Done func(scope string)

	mu      sync.Mutex
	seq     int
	byID    map[string]*job
	signals map[string]chan struct{}
	closed  bool
}

type job struct {
	id, scope, command string
	pgid               int
	out                *tail
	done               chan struct{}
	timer              *time.Timer
	// stoppedAs is why it was stopped, before it ended: timed out or killed.
	stoppedAs string
	// state and code are final once done is closed.
	state string
	code  int
	// taken says its end was reported, by status, wait, kill or a notice; shown that a chat already shows it ended.
	taken, shown bool
}

// JobReport is a background command as it is now.
type JobReport struct {
	ID       string
	Command  string
	State    string
	ExitCode int
	// Output is the last of what it wrote, cut as run_command cuts it; File holds all of it.
	Output string
	File   string
	// Shown says a chat already shows that it ended.
	Shown bool
}

// Text is the report as the model reads it.
func (r JobReport) Text() string {
	command := r.Command
	if len(command) > 200 {
		command = cutUTF8(command, 200) + "…"
	}
	var status string
	switch r.State {
	case JobRunning:
		status = "is still running."
	case JobExited:
		status = fmt.Sprintf("exited with code %d.", r.ExitCode)
	case JobTimedOut:
		status = "ran past its timeout and was stopped."
	case JobKilled:
		status = "was stopped."
	default:
		status = "could not run."
	}
	text := fmt.Sprintf("Background command %s (%s) %s", r.ID, command, status)
	switch {
	case r.Output != "" && r.State == JobRunning:
		text += "\nOutput so far:\n" + strings.TrimRight(r.Output, "\n")
	case r.Output != "":
		text += "\nOutput:\n" + strings.TrimRight(r.Output, "\n")
	case r.State != JobRunning:
		text += " No output."
	}
	if r.File != "" {
		text += "\nFull output: " + r.File
	}
	return text
}

// Line is the report in one line, for a chat to show, without the output.
func (r JobReport) Line() string {
	switch r.State {
	case JobExited:
		return fmt.Sprintf(`{"job_id":%q,"state":%q,"exit_code":%d}`, r.ID, r.State, r.ExitCode)
	}
	return fmt.Sprintf(`{"job_id":%q,"state":%q}`, r.ID, r.State)
}

var errNoJob = errors.New("no such background command here; job ids come from run_command with background true")

// Start runs command in the background in scope, from cwd, its output kept in outDir as it comes. timeout, when
// above zero, stops it after that long. changed hears once it ended, when it may have written files.
func (j *Jobs) Start(scope, cwd, command string, timeout time.Duration, outDir string, changed func()) (JobReport, error) {
	if j == nil {
		return JobReport{}, errors.New("background commands are not available here")
	}
	j.mu.Lock()
	defer j.mu.Unlock()
	if j.closed {
		return JobReport{}, errors.New("the server is stopping")
	}
	if running := j.runningLocked(scope); len(running) >= MaxJobs {
		return JobReport{}, fmt.Errorf("%d background commands are already running here, the most at once (%s); wait for or kill one first", MaxJobs, strings.Join(running, ", "))
	}
	out := &tail{dir: outDir}
	out.save() // all of it is kept from the start, so its file can be named at once
	shell := "bash"
	if _, err := exec.LookPath(shell); err != nil {
		shell = "sh"
	}
	cmd := exec.Command(shell, "-c", command)
	cmd.Dir = cwd
	cmd.Stdout, cmd.Stderr = out, out
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	// what it started may hold its output open after it ends; that is not waited for long
	cmd.WaitDelay = killGrace
	if err := cmd.Start(); err != nil {
		out.close()
		return JobReport{}, fmt.Errorf("could not run: %v", err)
	}
	j.seq++
	jb := &job{id: fmt.Sprintf("job-%d", j.seq), scope: scope, command: command, pgid: cmd.Process.Pid, out: out, done: make(chan struct{}), state: JobRunning}
	if j.byID == nil {
		j.byID = map[string]*job{}
	}
	j.byID[jb.id] = jb
	if timeout > 0 {
		jb.timer = time.AfterFunc(timeout, func() { j.stop(jb, JobTimedOut) })
	}
	go j.wait(jb, cmd, changed)
	return j.reportLocked(jb), nil
}

func (j *Jobs) wait(jb *job, cmd *exec.Cmd, changed func()) {
	err := cmd.Wait()
	if jb.timer != nil {
		jb.timer.Stop()
	}
	jb.out.close()
	j.mu.Lock()
	var exit *exec.ExitError
	switch {
	case jb.stoppedAs != "":
		jb.state = jb.stoppedAs
	case cmd.ProcessState != nil && cmd.ProcessState.Exited():
		// errors.Is(err, exec.ErrWaitDelay) too: it ended, only what it started kept its output open
		jb.state, jb.code = JobExited, cmd.ProcessState.ExitCode()
	case errors.As(err, &exit):
		jb.state, jb.code = JobKilled, exit.ExitCode()
	default:
		jb.state = JobFailed
	}
	close(jb.done)
	if ch := j.signals[jb.scope]; ch != nil {
		close(ch)
		delete(j.signals, jb.scope)
	}
	j.mu.Unlock()
	if changed != nil {
		changed()
	}
	if j.Done != nil {
		j.Done(jb.scope)
	}
}

// stop kills a running command's process group, as why says.
func (j *Jobs) stop(jb *job, why string) {
	j.mu.Lock()
	running := jb.state == JobRunning
	if running && jb.stoppedAs == "" {
		jb.stoppedAs = why
	}
	j.mu.Unlock()
	if running {
		_ = syscall.Kill(-jb.pgid, syscall.SIGKILL)
	}
}

func (j *Jobs) find(scope, id string) (*job, error) {
	j.mu.Lock()
	defer j.mu.Unlock()
	if jb := j.byID[strings.TrimSpace(id)]; jb != nil && jb.scope == scope {
		return jb, nil
	}
	return nil, errNoJob
}

// reportLocked is jb as it is now; an end it reports is taken, so it is not reported again.
func (j *Jobs) reportLocked(jb *job) JobReport {
	r := JobReport{ID: jb.id, Command: jb.command, State: jb.state, ExitCode: jb.code, Output: jb.out.text(), File: jb.out.name(), Shown: jb.shown}
	if jb.state != JobRunning {
		jb.taken = true
	}
	return r
}

// Status is a command as it is now, without waiting.
func (j *Jobs) Status(scope, id string) (JobReport, error) {
	if j == nil {
		return JobReport{}, errNoJob
	}
	jb, err := j.find(scope, id)
	if err != nil {
		return JobReport{}, err
	}
	j.mu.Lock()
	defer j.mu.Unlock()
	return j.reportLocked(jb), nil
}

// Wait waits for a command to end, for at most timeout when it is above zero, or until ctx ends: then it reports it
// still running, and it goes on.
func (j *Jobs) Wait(ctx context.Context, scope, id string, timeout time.Duration) (JobReport, error) {
	if j == nil {
		return JobReport{}, errNoJob
	}
	jb, err := j.find(scope, id)
	if err != nil {
		return JobReport{}, err
	}
	var limit <-chan time.Time
	if timeout > 0 {
		t := time.NewTimer(timeout)
		defer t.Stop()
		limit = t.C
	}
	select {
	case <-jb.done:
	case <-limit:
	case <-ctx.Done():
		return JobReport{}, ctx.Err()
	}
	j.mu.Lock()
	defer j.mu.Unlock()
	return j.reportLocked(jb), nil
}

// Kill stops a command and everything it started, and reports how it ended.
func (j *Jobs) Kill(scope, id string) (JobReport, error) {
	if j == nil {
		return JobReport{}, errNoJob
	}
	jb, err := j.find(scope, id)
	if err != nil {
		return JobReport{}, err
	}
	j.stop(jb, JobKilled)
	select {
	case <-jb.done:
	case <-time.After(2 * killGrace):
	}
	j.mu.Lock()
	defer j.mu.Unlock()
	return j.reportLocked(jb), nil
}

// Running is the ids of the commands of scope still running.
func (j *Jobs) Running(scope string) []string {
	if j == nil {
		return nil
	}
	j.mu.Lock()
	defer j.mu.Unlock()
	return j.runningLocked(scope)
}

func (j *Jobs) runningLocked(scope string) []string {
	var ids []string
	for _, jb := range j.byID {
		if jb.scope == scope && jb.state == JobRunning {
			ids = append(ids, jb.id)
		}
	}
	slices.SortFunc(ids, compareIDs)
	return ids
}

// compareIDs orders job ids as they were given out.
func compareIDs(a, b string) int {
	if len(a) != len(b) {
		return len(a) - len(b)
	}
	return strings.Compare(a, b)
}

// HasEnded says whether a command of scope ended with nobody told yet.
func (j *Jobs) HasEnded(scope string) bool {
	if j == nil {
		return false
	}
	j.mu.Lock()
	defer j.mu.Unlock()
	for _, jb := range j.byID {
		if jb.scope == scope && jb.state != JobRunning && !jb.taken {
			return true
		}
	}
	return false
}

// Ended takes the commands of scope that ended with nobody told yet, oldest first: each is reported once.
func (j *Jobs) Ended(scope string) []JobReport {
	return j.ended(scope, true)
}

// Show marks as shown the commands of scope that ended, with nobody told and no chat showing it yet, and returns
// them; they are still to be taken.
func (j *Jobs) Show(scope string) []JobReport {
	return j.ended(scope, false)
}

func (j *Jobs) ended(scope string, take bool) []JobReport {
	if j == nil {
		return nil
	}
	j.mu.Lock()
	defer j.mu.Unlock()
	var out []JobReport
	for _, jb := range j.byID {
		if jb.scope != scope || jb.state == JobRunning || jb.taken || !take && jb.shown {
			continue
		}
		out = append(out, j.reportLocked(jb))
		jb.taken = take
		jb.shown = true
	}
	slices.SortFunc(out, func(a, b JobReport) int { return compareIDs(a.ID, b.ID) })
	return out
}

// Signal is closed when the next command of scope ends.
func (j *Jobs) Signal(scope string) <-chan struct{} {
	if j == nil {
		return nil
	}
	j.mu.Lock()
	defer j.mu.Unlock()
	if j.signals == nil {
		j.signals = map[string]chan struct{}{}
	}
	ch := j.signals[scope]
	if ch == nil {
		ch = make(chan struct{})
		j.signals[scope] = ch
	}
	return ch
}

// End stops every command of scope with all it started, waits a little for them to go, and forgets them.
func (j *Jobs) End(scope string) {
	if j == nil {
		return
	}
	j.mu.Lock()
	var mine []*job
	for _, jb := range j.byID {
		if jb.scope == scope {
			mine = append(mine, jb)
		}
	}
	j.mu.Unlock()
	j.endAll(mine)
	j.mu.Lock()
	for _, jb := range mine {
		delete(j.byID, jb.id)
	}
	j.mu.Unlock()
}

// Close ends every scope; no command starts after it.
func (j *Jobs) Close() {
	if j == nil {
		return
	}
	j.mu.Lock()
	j.closed = true
	var all []*job
	for _, jb := range j.byID {
		all = append(all, jb)
	}
	j.byID = nil
	j.mu.Unlock()
	j.endAll(all)
}

func (j *Jobs) endAll(list []*job) {
	for _, jb := range list {
		j.stop(jb, JobKilled)
		// what a finished command started may still run in its group
		_ = syscall.Kill(-jb.pgid, syscall.SIGKILL)
	}
	deadline := time.After(2 * killGrace)
	for _, jb := range list {
		select {
		case <-jb.done:
		case <-deadline:
			return
		}
	}
}
