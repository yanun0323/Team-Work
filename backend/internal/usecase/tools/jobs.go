package tools

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
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
// in a process group of its own, and is over once nothing of that group is left, not when its shell is: stopping it
// stops everything it started, and ending a scope stops all of its own. A scope that ended takes no more commands.
//
// The group is led by a keeper, a process of the command's own that waits doing nothing and is not reaped until the
// command is over. While the keeper is not reaped its process id, which is the group's, can belong to nobody else, so
// signalling the group cannot reach another's processes; once it is reaped the group is never signalled again.
type Jobs struct {
	// Done, when set, hears that a command of scope ended, once its result is final and before Wait and Kill return
	// it. It is called with no lock held; End and Close may be waiting for it, so it must not wait on their callers.
	Done func(scope string)

	mu      sync.Mutex
	seq     int
	byID    map[string]*job
	signals map[string]chan struct{}
	// over are the scopes that ended; nothing starts in them again.
	over   map[string]bool
	closed bool

	// signal sends sig to process group pgid; syscall.Kill when nil. Tests watch it.
	signal func(pgid int, sig syscall.Signal) error
	// started, when set, runs in Start holding the lock, once the scope may start a command and before it does.
	started func()
	// busy says whether a process group has a live process other than except; groupBusy when nil. Tests make it fail.
	busy func(pgid, except int) (bool, error)
	// endWait is how long End and Close wait for the commands they stop; endWaitDefault when zero.
	endWait time.Duration
}

func (j *Jobs) groupBusy(pgid, except int) (bool, error) {
	if j.busy != nil {
		return j.busy(pgid, except)
	}
	return groupBusy(pgid, except)
}

// errLookupFailing is a lookup FailLookups makes fail.
var errLookupFailing = errors.New("process groups cannot be looked up (test)")

// FailLookups is for tests of what uses Jobs: while failing is set, no process group can be looked up; otherwise
// they are looked up as ever. endWait, when above zero, shortens how long End and Close wait. Call it before any
// command starts.
func (j *Jobs) FailLookups(failing *atomic.Bool, endWait time.Duration) {
	j.mu.Lock()
	defer j.mu.Unlock()
	if len(j.byID) > 0 {
		panic("FailLookups after a command started")
	}
	j.busy = func(pgid, except int) (bool, error) {
		if failing.Load() {
			return false, errLookupFailing
		}
		return groupBusy(pgid, except)
	}
	if endWait > 0 {
		j.endWait = endWait
	}
}

type job struct {
	id, scope, command string
	pgid               int
	out                *tail
	done               chan struct{}
	timer              *time.Timer
	// stoppedAs is why it was stopped, before it ended: timed out or killed.
	stoppedAs string
	// state and code are final once done is closed; so is the group no longer being the command's own.
	state string
	code  int
	// taken says its end was reported by wait, kill or a notice, so it is not told again; shown that a chat already
	// shows it ended.
	taken, shown bool
	// unsure says its process group could not be looked up, so all of it was stopped to be sure.
	unsure bool
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
	// Unsure says what it started could not be looked up, so all of it was stopped.
	Unsure bool
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
	if r.Unsure {
		text += " Its processes could not be looked up, so all it started was stopped."
	}
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

// groupPoll is how often a command whose shell is done is checked for what it started; groupRetry the longest wait
// between lookups of a group that cannot be looked up.
const (
	groupPoll  = 100 * time.Millisecond
	groupRetry = time.Second
)

// endWaitDefault is how long End and Close wait for the commands they stop.
const endWaitDefault = 2*killGrace + time.Second

// Start runs command in the background in scope, from cwd, its output kept in outDir as it comes. timeout, when
// above zero, stops it after that long. changed hears once it is over, when it may have written files. Nothing starts
// once ctx ended, or the scope did.
func (j *Jobs) Start(ctx context.Context, scope, cwd, command string, timeout time.Duration, outDir string, changed func()) (JobReport, error) {
	if j == nil {
		return JobReport{}, errors.New("background commands are not available here")
	}
	j.mu.Lock()
	defer j.mu.Unlock()
	switch {
	case j.closed:
		return JobReport{}, errors.New("the server is stopping")
	case j.over[scope]:
		return JobReport{}, errors.New("this run has ended; no background command can start in it")
	case ctx.Err() != nil:
		return JobReport{}, errors.New("stopped before the command started")
	}
	if running := j.runningLocked(scope); len(running) >= MaxJobs {
		return JobReport{}, fmt.Errorf("%d background commands are already running here, the most at once (%s); wait for or kill one first", MaxJobs, strings.Join(running, ", "))
	}
	if j.started != nil {
		j.started()
	}
	keeper, release, err := startKeeper()
	if err != nil {
		return JobReport{}, fmt.Errorf("could not run: %v", err)
	}
	outR, outW, err := os.Pipe()
	if err != nil {
		j.reap(keeper, release)
		return JobReport{}, fmt.Errorf("could not run: %v", err)
	}
	out := &tail{dir: outDir}
	out.save() // all of it is kept from the start, so its file can be named at once
	shell := "bash"
	if _, err := exec.LookPath(shell); err != nil {
		shell = "sh"
	}
	cmd := exec.Command(shell, "-c", command)
	cmd.Dir = cwd
	// a file, not a writer: what the command starts writes to it directly, for as long as it runs
	cmd.Stdout, cmd.Stderr = outW, outW
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true, Pgid: keeper.Process.Pid}
	err = cmd.Start()
	_ = outW.Close()
	if err != nil {
		_ = outR.Close()
		out.close()
		j.reap(keeper, release)
		return JobReport{}, fmt.Errorf("could not run: %v", err)
	}
	copied := make(chan struct{})
	go func() {
		_, _ = io.Copy(out, outR)
		close(copied)
	}()
	j.seq++
	jb := &job{id: fmt.Sprintf("job-%d", j.seq), scope: scope, command: command, pgid: keeper.Process.Pid, out: out, done: make(chan struct{}), state: JobRunning}
	if j.byID == nil {
		j.byID = map[string]*job{}
	}
	j.byID[jb.id] = jb
	if timeout > 0 {
		jb.timer = time.AfterFunc(timeout, func() { j.stop(jb, JobTimedOut) })
	}
	go j.watch(jb, cmd, keeper, release, outR, copied, changed)
	return j.reportLocked(jb, false), nil
}

// startKeeper starts a process that leads a new process group and waits, doing nothing, until release is closed
// (or this process ends) or it is killed. It is reaped by reap only.
func startKeeper() (*exec.Cmd, *os.File, error) {
	in, release, err := os.Pipe()
	if err != nil {
		return nil, nil, err
	}
	keeper := exec.Command("/bin/sh", "-c", "read -r _")
	keeper.Stdin = in
	keeper.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	err = keeper.Start()
	_ = in.Close()
	if err != nil {
		_ = release.Close()
		return nil, nil, err
	}
	return keeper, release, nil
}

// reap lets a keeper go and reaps it; its group's id is free for others from then on.
func (j *Jobs) reap(keeper *exec.Cmd, release *os.File) {
	_ = release.Close()
	_ = keeper.Process.Kill()
	_ = keeper.Wait()
}

func (j *Jobs) kill(pgid int) {
	if j.signal != nil {
		_ = j.signal(pgid, syscall.SIGKILL)
		return
	}
	_ = syscall.Kill(-pgid, syscall.SIGKILL)
}

// watch waits for a command to be over: its shell, then everything left in its group but the keeper. When the group
// cannot be looked up, nothing can say what is left of it: all of it is stopped while the group is still the
// command's own, and it is looked up again until it can be, however long that takes; until then the command is not
// over. Only once it is does watch let the output go, say the folder changed, settle how it ended and let the
// keeper go.
func (j *Jobs) watch(jb *job, cmd *exec.Cmd, keeper *exec.Cmd, release, outR *os.File, copied chan struct{}, changed func()) {
	err := cmd.Wait()
	for wait := groupPoll; ; time.Sleep(wait) {
		busy, lookErr := j.groupBusy(jb.pgid, keeper.Process.Pid)
		if lookErr == nil && !busy {
			break
		}
		if lookErr == nil {
			wait = groupPoll
			continue
		}
		j.mu.Lock()
		jb.unsure = true
		j.mu.Unlock()
		j.stop(jb, JobKilled)
		wait = min(2*wait, groupRetry)
	}
	// only what left the group can still hold the output open; it is not waited for long
	select {
	case <-copied:
	case <-time.After(killGrace):
		_ = outR.Close()
		<-copied
	}
	_ = outR.Close()
	if jb.timer != nil {
		jb.timer.Stop()
	}
	// anything that joined the group since goes too: its id is still the command's own, as the keeper is not reaped
	j.mu.Lock()
	j.kill(jb.pgid)
	j.mu.Unlock()
	jb.out.close()
	if changed != nil {
		changed() // all it wrote is written
	}
	j.mu.Lock()
	var exit *exec.ExitError
	switch {
	case jb.stoppedAs != "":
		jb.state = jb.stoppedAs
	case cmd.ProcessState != nil && cmd.ProcessState.Exited():
		jb.state, jb.code = JobExited, cmd.ProcessState.ExitCode()
	case errors.As(err, &exit):
		jb.state, jb.code = JobKilled, exit.ExitCode()
	default:
		jb.state = JobFailed
	}
	if ch := j.signals[jb.scope]; ch != nil {
		close(ch)
		delete(j.signals, jb.scope)
	}
	if j.closed || j.over[jb.scope] {
		delete(j.byID, jb.id) // its scope ended while it was not over yet; nobody is told of it now
	}
	j.mu.Unlock()
	// over: its group is never signalled again, so its id may go to another
	j.reap(keeper, release)
	if j.Done != nil {
		j.Done(jb.scope)
	}
	close(jb.done)
}

// stop kills a command that is not over, with everything in its process group, as why says. The group is signalled
// holding the lock, so the command cannot be over, and its keeper reaped, in between.
func (j *Jobs) stop(jb *job, why string) {
	j.mu.Lock()
	defer j.mu.Unlock()
	if jb.state != JobRunning {
		return
	}
	if jb.stoppedAs == "" {
		jb.stoppedAs = why
	}
	j.kill(jb.pgid)
}

func (j *Jobs) find(scope, id string) (*job, error) {
	j.mu.Lock()
	defer j.mu.Unlock()
	if jb := j.byID[strings.TrimSpace(id)]; jb != nil && jb.scope == scope {
		return jb, nil
	}
	return nil, errNoJob
}

// reportLocked is jb as it is now. take, when it is over, has its end reported here, so nobody is told it again.
func (j *Jobs) reportLocked(jb *job, take bool) JobReport {
	r := JobReport{ID: jb.id, Command: jb.command, State: jb.state, ExitCode: jb.code, Output: jb.out.text(), File: jb.out.name(), Shown: jb.shown, Unsure: jb.unsure}
	if take && jb.state != JobRunning {
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
	// a look only: how it ended is still told, unless it is waited for or killed
	return j.reportLocked(jb, false), nil
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
	return j.reportLocked(jb, true), nil
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
	case <-time.After(j.waitEnd()):
	}
	j.mu.Lock()
	defer j.mu.Unlock()
	return j.reportLocked(jb, true), nil
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

// RunningUnder is the ids of the commands still running in every scope whose name starts with prefix.
func (j *Jobs) RunningUnder(prefix string) []string {
	if j == nil {
		return nil
	}
	j.mu.Lock()
	defer j.mu.Unlock()
	var ids []string
	for _, jb := range j.byID {
		if strings.HasPrefix(jb.scope, prefix) && jb.state == JobRunning {
			ids = append(ids, jb.id)
		}
	}
	slices.SortFunc(ids, compareIDs)
	return ids
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
		out = append(out, j.reportLocked(jb, take))
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

// End stops every command of scope with all it started, waits a little for them to go, and forgets those that are
// over. The scope takes no command after it, so one starting at the same time is either stopped here or never
// starts. It returns the ids of those not over yet, whose groups could not be looked up: they stay known as running,
// and are forgotten once they are over.
func (j *Jobs) End(scope string) []string {
	if j == nil {
		return nil
	}
	j.mu.Lock()
	if j.over == nil {
		j.over = map[string]bool{}
	}
	j.over[scope] = true
	var mine []*job
	for _, jb := range j.byID {
		if jb.scope == scope {
			mine = append(mine, jb)
		}
	}
	j.mu.Unlock()
	j.endAll(mine)
	j.mu.Lock()
	defer j.mu.Unlock()
	var left []string
	for _, jb := range mine {
		if jb.state == JobRunning {
			left = append(left, jb.id)
		} else {
			delete(j.byID, jb.id)
		}
	}
	slices.SortFunc(left, compareIDs)
	return left
}

// Seal has scope take no more commands, at once and without waiting; what runs goes on until End stops it. A run
// stopped before it can end its scope seals it, so nothing it was still starting gets in after it is let go.
func (j *Jobs) Seal(scope string) {
	if j == nil {
		return
	}
	j.mu.Lock()
	defer j.mu.Unlock()
	if j.over == nil {
		j.over = map[string]bool{}
	}
	j.over[scope] = true
}

// Close ends every scope, as End does each; no command starts after it. It returns the ids of those not over yet:
// they stay known as running until they are.
func (j *Jobs) Close() []string {
	if j == nil {
		return nil
	}
	j.mu.Lock()
	j.closed = true
	var all []*job
	for _, jb := range j.byID {
		all = append(all, jb)
	}
	j.mu.Unlock()
	j.endAll(all)
	j.mu.Lock()
	defer j.mu.Unlock()
	var left []string
	for _, jb := range all {
		if jb.state == JobRunning {
			left = append(left, jb.id)
		} else {
			delete(j.byID, jb.id)
		}
	}
	slices.SortFunc(left, compareIDs)
	return left
}

// endAll stops the commands that are not over yet; those that are have nothing left to stop.
func (j *Jobs) endAll(list []*job) {
	for _, jb := range list {
		j.stop(jb, JobKilled)
	}
	deadline := time.After(j.waitEnd())
	for _, jb := range list {
		select {
		case <-jb.done:
		case <-deadline:
			return
		}
	}
}

func (j *Jobs) waitEnd() time.Duration {
	if j.endWait > 0 {
		return j.endWait
	}
	return endWaitDefault
}
