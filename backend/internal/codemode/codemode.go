// Package codemode runs a script a model wrote in QuickJS compiled to WebAssembly, where the only reach is the
// functions the host hands it: no files, network, environment, processes, timers or modules. The script calls them as
// async tools, `await tools.<name>(args)`, side by side with Promise.all when it likes, and only what it writes with
// text() and console, and what it returns, comes back.
//
// Each run has a VM of its own whose memory cannot pass MemoryLimit, and at most MaxWorkers VMs are alive in the
// process at once. The VM is driven from Go: a tool call runs in a goroutine, and its result is handed to the script
// when it comes, so the VM never waits inside itself.
package codemode

import (
	"context"
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
	"unicode/utf8"

	"github.com/fastschema/qjs"
)

// Reasons a run fails.
const (
	ReasonInvalid     = "invalid_arguments"
	ReasonTimeout     = "timeout"
	ReasonCancelled   = "cancelled"
	ReasonBusy        = "busy"
	ReasonNoWorker    = "no_worker"
	ReasonStalled     = "stalled"
	ReasonOutputLimit = "output_limit"
	ReasonScript      = "script_error"
)

const (
	// MemoryLimit is all the memory a script's VM may have.
	MemoryLimit = 256 << 20
	// jsMemoryLimit is what QuickJS lets the script allocate, under MemoryLimit, so running out is an error the
	// script can catch before the VM itself has no room.
	jsMemoryLimit = MemoryLimit - 16<<20
	// MaxWorkers is how many scripts may have a VM at the same time, across the process.
	MaxWorkers = 4
	// maxParallel is how many calls of one script that change nothing run at the same time.
	maxParallel = 8
	// A script fails when its output passes these: large data belongs in a file, written with a tool.
	maxOutputChars = 16 << 20
	maxOutputItems = 100_000
	// MaxStoreValue and MaxStoreTotal bound store(), in characters of JSON.
	MaxStoreValue = 256 << 10
	MaxStoreTotal = 1 << 20
)

var (
	// workerWait is how long a script waits for a free worker before it fails without running.
	workerWait = time.Minute
	// busyLimit is how long the VM may run at a stretch, without waiting on a tool, before the script is stopped.
	busyLimit = time.Minute
	// callsGrace is how long a run that ended waits for the calls it stopped to return.
	callsGrace = 10 * time.Second
	workers    = make(chan struct{}, MaxWorkers)
)

// sandboxRoot is the folder the VM's files would come from: one that is never made, so the engine's own file
// functions, which a script could still import, find nothing to read and nowhere to write.
var sandboxRoot = filepath.Join(os.TempDir(), fmt.Sprintf("codemode-nothing-%d-%d", os.Getpid(), time.Now().UnixNano()))

//go:embed prelude.js
var prelude string

// file names the script in positions and stacks; prefix shares its first line, so lines in errors are the script's.
const (
	file   = "exec.js"
	prefix = "globalThis.__cm_main = (async () => {"
	suffix = "\n})().then((v) => __cm_finish(true, v), (e) => __cm_finish(false, e)); undefined;"
)

// Func is a tool the script may call as `await tools.<Name>(args)`. Call gets args as a JSON object and returns what
// marshals to JSON: data, or a tool's text as a string. Its error rejects the call with an Error the script may catch;
// a *Failure ends the whole script instead, which it cannot catch.
type Func struct {
	Name, Description string
	// Serial calls change something: they run one at a time, in the order the script made them.
	Serial bool
	Call   func(ctx context.Context, args json.RawMessage) (any, error)
}

// Options are what the host decides for a run.
type Options struct {
	// SpillDir keeps output too long to hand back; the system's temporary folder when empty.
	SpillDir string
	// Store is what earlier scripts kept with store(). A run that succeeds and changed it gives the new one back.
	Store map[string]json.RawMessage
}

// Failure is why a run failed. Line and Column point into the script as given, when known.
type Failure struct {
	Reason  string
	Message string
	Line    int
	Column  int
}

func (f *Failure) Error() string { return f.Reason + ": " + f.Message }

// Result is how a run went.
type Result struct {
	// Text is what goes back to the model: how the script ended, its output and its error.
	Text string
	Err  *Failure
	// Calls is how many times the script called each tool.
	Calls map[string]int
	// Store is the store after a run that succeeded and changed it; nil otherwise.
	Store    map[string]json.RawMessage
	Duration time.Duration
	// Output is how many bytes of output the script wrote, before any was cut.
	Output int
}

// outcome is a finished call: its result as JSON for the script, or a failure that ends the run.
type outcome struct {
	id   int64
	raw  string
	fail *Failure
}

type sandbox struct {
	// ctx is the run's: its end stops the VM and every call. parent is the caller's, to tell stopping from timing out.
	ctx, parent context.Context
	fns         map[string]Func
	list        []Func
	vm          *qjs.Runtime
	vmCancel    context.CancelFunc
	busy        atomic.Bool

	// What follows is the VM goroutine's alone.
	nextID   int64
	inflight int
	waiting  map[int64]string
	calls    map[string]int
	items    []string
	console  []string
	chars    int
	count    int
	exited   bool
	finished bool
	dead     bool
	failed   *Failure
	store    map[string]json.RawMessage
	changed  bool

	// Calls run on other goroutines.
	callCtx    context.Context
	slots      chan struct{}
	lastSerial chan struct{}
	wg         sync.WaitGroup
	mu         sync.Mutex
	done       []outcome
	ready      chan struct{}
}

// Run runs code as the body of an async function, with fns as tools. It returns once the script settled, failed, ran
// out of time or ctx ended; the calls it started are stopped then.
func Run(ctx context.Context, code string, fns []Func, o Options) Result {
	started := time.Now()
	s := &sandbox{parent: ctx, fns: make(map[string]Func, len(fns)), list: fns, waiting: map[int64]string{}, calls: map[string]int{},
		store: o.Store, slots: make(chan struct{}, maxParallel), ready: make(chan struct{}, 1)}
	for _, fn := range fns {
		s.fns[fn.Name] = fn
	}
	opts, bad := parseOptions(code)
	if bad == nil && strings.TrimSpace(code) == "" {
		bad = &Failure{Reason: ReasonInvalid, Message: "code is required"}
	}
	if bad != nil {
		s.failed = bad
		return s.result(started, opts, o.SpillDir)
	}
	var cancel context.CancelFunc
	if opts.timeout > 0 {
		s.ctx, cancel = context.WithTimeout(ctx, opts.timeout)
	} else {
		s.ctx, cancel = context.WithCancel(ctx)
	}
	defer cancel()
	if s.acquire() {
		defer func() { <-workers }()
		s.run(code)
	}
	return s.result(started, opts, o.SpillDir)
}

// acquire waits for a free worker, as long as the run may.
func (s *sandbox) acquire() bool {
	wait := time.NewTimer(workerWait)
	defer wait.Stop()
	select {
	case workers <- struct{}{}:
		return true
	case <-wait.C:
		s.fail(&Failure{Reason: ReasonNoWorker, Message: fmt.Sprintf("no script worker was free within %s; %d scripts run at most at once", workerWait, MaxWorkers)})
	case <-s.ctx.Done():
		s.ended()
	}
	return false
}

func (s *sandbox) run(code string) {
	wasm, err := cappedWasm()
	if err != nil {
		s.fail(&Failure{Reason: ReasonScript, Message: "the script engine is broken: " + err.Error()})
		return
	}
	vmCtx, vmCancel := context.WithCancel(context.Background())
	s.vmCancel = vmCancel
	defer vmCancel()
	callCtx, stopCalls := context.WithCancel(s.ctx)
	s.callCtx = callCtx
	defer s.stopCalls(stopCalls)

	s.vm, err = qjs.New(qjs.Option{CWD: sandboxRoot, Context: vmCtx, CloseOnContextDone: true, MemoryLimit: jsMemoryLimit,
		QuickJSWasmBytes: wasm, Stdout: io.Discard, Stderr: io.Discard})
	if err != nil {
		s.fail(&Failure{Reason: ReasonScript, Message: "the script engine did not start: " + err.Error()})
		return
	}
	defer s.close()
	c := s.vm.Context()
	s.enter(func() {
		c.SetFunc("__cm_host", s.host)
		s.eval("prelude.js", prelude)
	})
	if s.over() {
		return
	}
	s.enter(func() {
		v, err := c.Eval(file, qjs.Code(prefix+code+suffix))
		if err != nil {
			s.fail(syntaxFailure(err))
			return
		}
		v.Free()
	})
	for !s.over() {
		if s.inflight == 0 {
			s.fail(&Failure{Reason: ReasonStalled, Message: "the script waits on a promise nothing can settle: no tool call is pending, and there are no timers"})
			return
		}
		select {
		case <-s.ready:
		case <-s.ctx.Done():
			s.ended()
			return
		}
		for _, o := range s.take() {
			s.inflight--
			if o.fail != nil {
				s.fail(o.fail)
				return
			}
			s.waiting[o.id] = o.raw
			s.enter(func() { s.eval("settle.js", "__cm_settle("+strconv.FormatInt(o.id, 10)+")") })
			if s.over() {
				return
			}
		}
	}
}

// eval runs a piece of the host's own code in the VM; what it throws fails the script.
func (s *sandbox) eval(name, code string) {
	v, err := s.vm.Context().Eval(name, qjs.Code(code))
	if err != nil {
		s.fail(&Failure{Reason: ReasonScript, Message: firstLine(err.Error())})
		return
	}
	v.Free()
}

// enter runs fn in the VM, watched: the VM is stopped when the run ends or when it runs busyLimit at a stretch, and
// a VM that stopped or broke fails the script and is never entered again.
func (s *sandbox) enter(fn func()) {
	if s.dead {
		return
	}
	busy := time.AfterFunc(busyLimit, func() {
		s.busy.Store(true)
		s.vmCancel()
	})
	watch := context.AfterFunc(s.ctx, s.vmCancel)
	defer func() {
		busy.Stop()
		watch()
		if r := recover(); r != nil {
			s.dead = true
			s.broke(fmt.Sprint(r))
		}
	}()
	fn()
}

// broke says why the VM stopped: what the run asked for (an exit, a failure already known, time up, stopping), or
// else the engine itself giving up.
func (s *sandbox) broke(why string) {
	switch {
	case s.exited || s.failed != nil:
	case s.busy.Load():
		s.fail(&Failure{Reason: ReasonBusy, Message: fmt.Sprintf("the script ran JavaScript for %s without waiting on a tool", busyLimit)})
	case s.ctx.Err() != nil:
		s.ended()
	case strings.Contains(why, "out of bounds memory access"):
		s.fail(&Failure{Reason: ReasonScript, Message: "RangeError: Maximum call stack size exceeded"})
	default:
		s.fail(&Failure{Reason: ReasonScript, Message: "InternalError: the script engine stopped: " + firstLine(why)})
	}
}

// close ends the VM; one already closed by stopping it may complain, which changes nothing.
func (s *sandbox) close() {
	defer func() { _ = recover() }()
	s.vm.Close()
}

// stopCalls stops the calls still running once the run is over, and waits a while for them to return.
func (s *sandbox) stopCalls(stop context.CancelFunc) {
	stop()
	done := make(chan struct{})
	go func() {
		s.wg.Wait()
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(callsGrace):
	}
}

// over says whether the script is done, one way or another.
func (s *sandbox) over() bool { return s.finished || s.exited || s.failed != nil || s.dead }

// fail ends the script; the first failure stands.
func (s *sandbox) fail(f *Failure) {
	if s.failed == nil && !s.exited {
		s.failed = f
	}
}

// ended fails the script because its context ended: stopped by the caller, or out of time.
func (s *sandbox) ended() {
	if s.parent.Err() != nil {
		s.fail(&Failure{Reason: ReasonCancelled, Message: "stopped"})
		return
	}
	s.fail(&Failure{Reason: ReasonTimeout, Message: "the script ran past its timeout_ms"})
}

// host is everything the script asks of the host, through the prelude. It runs on the VM goroutine, inside the VM.
func (s *sandbox) host(this *qjs.This) (*qjs.Value, error) {
	c := this.Context()
	args := this.Args()
	defer func() {
		for _, a := range args {
			a.Free()
		}
	}()
	str := func(i int) string {
		if i >= len(args) || args[i].IsUndefined() {
			return ""
		}
		return args[i].String()
	}
	defined := func(i int) bool { return i < len(args) && !args[i].IsUndefined() }
	switch str(0) {
	case "tools":
		type entry struct {
			Name        string `json:"name"`
			Description string `json:"description"`
		}
		list := make([]entry, len(s.list))
		for i, fn := range s.list {
			list[i] = entry{fn.Name, fn.Description}
		}
		raw, _ := json.Marshal(list)
		return c.NewString(string(raw)), nil
	case "call":
		id, err := s.start(str(1), str(2))
		if err != nil {
			return nil, err
		}
		return c.NewInt64(id), nil
	case "take":
		id, _ := strconv.ParseInt(str(1), 10, 64)
		raw := s.waiting[id]
		delete(s.waiting, id)
		return c.NewString(raw), nil
	case "text":
		s.write(&s.items, str(1))
	case "console":
		s.write(&s.console, str(1))
	case "exit":
		s.exited = true
		s.vmCancel()
	case "store":
		if msg := s.keep(str(1), str(2), defined(2)); msg != "" {
			return c.NewString(msg), nil
		}
	case "load":
		if raw, ok := s.store[str(1)]; ok {
			return c.NewString(string(raw)), nil
		}
	case "return":
		if defined(1) {
			s.write(&s.items, str(1))
		}
		s.finished = true
	case "error":
		s.finished = true
		message := str(1)
		// out of memory with no room left to make the error, QuickJS throws null
		if message == "null" && s.vm.Mem().Size() >= MemoryLimit-jsMemoryLimit/8 {
			message = "InternalError: out of memory"
		}
		s.fail(scriptFailure(message, str(2)))
	default:
		return nil, errors.New("unknown host call")
	}
	return c.NewUndefined(), nil
}

// write adds an output item, or ends the script once its output passes the limits.
func (s *sandbox) write(to *[]string, text string) {
	if s.over() {
		return
	}
	s.chars += utf8.RuneCountInString(text)
	s.count++
	if s.chars > maxOutputChars || s.count > maxOutputItems {
		s.fail(&Failure{Reason: ReasonOutputLimit, Message: fmt.Sprintf("the output passed %d characters or %d text() and console calls; write large data to a file with a tool instead", maxOutputChars, maxOutputItems)})
		s.vmCancel()
		return
	}
	*to = append(*to, text)
}

// keep is store(key, raw), raw JSON or, when not given, deleting the key; what it refuses comes back as the reason.
func (s *sandbox) keep(key, raw string, given bool) string {
	next := make(map[string]json.RawMessage, len(s.store)+1)
	for k, v := range s.store {
		next[k] = v
	}
	if !given {
		if _, ok := next[key]; ok {
			delete(next, key)
			s.store, s.changed = next, true
		}
		return ""
	}
	n := utf8.RuneCountInString(raw)
	if n > MaxStoreValue {
		return fmt.Sprintf("a stored value may have at most %d characters of JSON", MaxStoreValue)
	}
	total := n
	for k, v := range s.store {
		if k != key {
			total += utf8.RuneCount(v)
		}
	}
	if total > MaxStoreTotal {
		return fmt.Sprintf("stored values together may have at most %d characters of JSON", MaxStoreTotal)
	}
	next[key] = json.RawMessage(raw)
	s.store, s.changed = next, true
	return ""
}

// start begins a call and returns its id; its result comes back through ready. Nothing starts once the run is over:
// its promise never settles, and the run ends without looking.
func (s *sandbox) start(name, raw string) (int64, error) {
	fn, ok := s.fns[name]
	if !ok {
		return 0, fmt.Errorf("%s is not one of the tools", name)
	}
	s.nextID++
	id := s.nextID
	if s.over() {
		return id, nil
	}
	s.calls[name]++
	s.inflight++
	s.wg.Add(1)
	if fn.Serial {
		prev, done := s.lastSerial, make(chan struct{})
		s.lastSerial = done
		go func() {
			defer s.wg.Done()
			defer close(done)
			if prev != nil {
				<-prev
			}
			s.deliver(id, fn, raw)
		}()
		return id, nil
	}
	go func() {
		defer s.wg.Done()
		select {
		case s.slots <- struct{}{}:
			defer func() { <-s.slots }()
			s.deliver(id, fn, raw)
		case <-s.callCtx.Done():
			s.post(outcome{id: id, raw: failed("stopped")})
		}
	}()
	return id, nil
}

// deliver runs one call and posts its result.
func (s *sandbox) deliver(id int64, fn Func, args string) {
	if s.callCtx.Err() != nil {
		s.post(outcome{id: id, raw: failed("stopped")})
		return
	}
	v, err := fn.Call(s.callCtx, json.RawMessage(args))
	var f *Failure
	switch {
	case errors.As(err, &f):
		s.post(outcome{id: id, fail: f})
		return
	case err != nil:
		s.post(outcome{id: id, raw: failed(err.Error())})
		return
	}
	data, err := json.Marshal(v)
	if err != nil {
		s.post(outcome{id: id, raw: failed("tools." + fn.Name + " returned what is not JSON")})
		return
	}
	s.post(outcome{id: id, raw: `{"ok":true,"value":` + string(data) + `}`})
}

func failed(message string) string {
	raw, _ := json.Marshal(message)
	return `{"ok":false,"error":` + string(raw) + `}`
}

func (s *sandbox) post(o outcome) {
	s.mu.Lock()
	s.done = append(s.done, o)
	s.mu.Unlock()
	select {
	case s.ready <- struct{}{}:
	default:
	}
}

func (s *sandbox) take() []outcome {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := s.done
	s.done = nil
	return out
}

var position = regexp.MustCompile(regexp.QuoteMeta(file) + `:(\d+):(\d+)`)

// at is the first place in the script a stack names. QuickJS counts the first line's columns from 0, from the start
// of the prefix, and the others' from 1.
func at(stack string) (line, column int) {
	m := position.FindStringSubmatch(stack)
	if m == nil {
		return 0, 0
	}
	line, _ = strconv.Atoi(m[1])
	column, _ = strconv.Atoi(m[2])
	if line == 1 {
		column = max(column-len(prefix)+1, 1)
	}
	return line, column
}

// scriptFailure is what the script threw and did not catch.
func scriptFailure(message, stack string) *Failure {
	f := &Failure{Reason: ReasonScript, Message: message}
	f.Line, f.Column = at(stack)
	return f
}

// syntaxFailure is a script that does not parse, at its place in the script.
func syntaxFailure(err error) *Failure {
	text := err.Error()
	f := &Failure{Reason: ReasonScript, Message: firstLine(text)}
	f.Line, f.Column = at(text)
	return f
}

func firstLine(s string) string {
	line, _, _ := strings.Cut(strings.TrimSpace(s), "\n")
	return line
}
