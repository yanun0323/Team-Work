// Package codemode runs a short script a model wrote, in a sandbox whose only reach is the functions the host hands
// it: no files, network, environment, processes, timers or modules. The script calls those functions synchronously,
// keeps what they return to itself, and gives back only what it writes with text() and what it returns.
//
// The sandbox isolates capabilities, not resources: the interpreter has no memory limit, and it runs in the calling
// process.
package codemode

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/dop251/goja"
)

// Reasons a run fails.
const (
	ReasonInvalid     = "invalid_arguments"
	ReasonTimeout     = "timeout"
	ReasonCancelled   = "cancelled"
	ReasonCallLimit   = "call_limit"
	ReasonOutputLimit = "output_limit"
	ReasonScript      = "script_error"
)

// Func is a function the script may call as tools.<Name>(args). Params is the JSON Schema of args, Returns the
// TypeScript type of what it returns, both for Declarations. Call gets args as a JSON object and returns a value that
// marshals to JSON; its error reaches the script as a catchable Error with the same message.
type Func struct {
	Name        string
	Description string
	Params      json.RawMessage
	Returns     string
	Call        func(ctx context.Context, args json.RawMessage) (any, error)
}

// Limits bound one run.
type Limits struct {
	Timeout  time.Duration
	MaxCalls int
	// MaxLines and MaxBytes bound the output handed back.
	MaxLines, MaxBytes int
}

// DefaultLimits are a minute, 64 calls and the output any tool may hand to a model.
func DefaultLimits() Limits {
	return Limits{Timeout: time.Minute, MaxCalls: 64, MaxLines: 2000, MaxBytes: 50 << 10}
}

// Hooks let the host take part in a run.
type Hooks struct {
	// BeforeCall comes before each function runs. An error ends the whole script, which cannot catch it, and the function
	// does not run; a *Failure keeps its reason.
	BeforeCall func(name string) error
}

// Failure is why a run failed. Line and Column point into the script as given, when known.
type Failure struct {
	Reason  string
	Message string
	Line    int
	Column  int
}

func (f *Failure) Error() string { return f.Reason + ": " + f.Message }

// Result is how a run went: what it wrote, and why it failed when it did. Output is kept on failure too, cut at the
// limit when the output itself was too long.
type Result struct {
	Output   string
	Err      *Failure
	Calls    map[string]int
	Duration time.Duration
}

// file names the script in positions and stacks.
const file = "exec.js"

// prefix shares the script's first line, so lines in errors are the script's own.
const prefix = "(function(){"

// Run runs code as the body of a function, with fns as tools. It returns once the script ended, failed, ran out of
// time or ctx ended; nothing it started is left running.
func Run(ctx context.Context, code string, fns []Func, lim Limits, h Hooks) Result {
	started := time.Now()
	s := &sandbox{lim: lim, h: h, calls: map[string]int{}}
	res := s.run(ctx, code, fns)
	if res.Err != nil {
		res.Err.Message = Fit(res.Err.Message, maxMessageLines, maxMessageBytes)
	}
	res.Duration = time.Since(started)
	return res
}

// A failure's message is kept short, whatever the script threw, so the output before it still has room.
const (
	maxMessageLines = 20
	maxMessageBytes = 2 << 10
)

// Fit cuts text to at most lines lines and bytes bytes, never inside a character.
func Fit(text string, lines, bytes int) string {
	if parts := strings.SplitN(text, "\n", lines+1); len(parts) > lines {
		text = strings.Join(parts[:lines], "\n")
	}
	return cutUTF8(text, bytes)
}

type sandbox struct {
	lim Limits
	h   Hooks
	vm  *goja.Runtime
	ctx context.Context
	// parent is the caller's context: ending it cancels, ending ctx alone is the timeout.
	parent context.Context
	calls  map[string]int
	total  int
	out    strings.Builder
	lines  int
	// mu guards failed, which the watcher may set while the script runs.
	mu     sync.Mutex
	failed *Failure

	// jsonText, jsonValue and toText are JSON.stringify, JSON.parse and String as the script found them, before it
	// could replace them; so is errorType, Error.
	jsonText, jsonValue, toText goja.Callable
	errorType                   goja.Constructor
}

// fail ends the script for good: the first failure stands, the interpreter stops at its next step whatever the
// script catches, and every later call to the host does nothing.
func (s *sandbox) fail(f *Failure) {
	s.mu.Lock()
	if s.failed == nil {
		s.failed = f
	}
	s.mu.Unlock()
	s.vm.Interrupt(f)
}

// stopped says whether the script has failed, failing it first when its time is up: the watcher may not have
// interrupted it yet.
func (s *sandbox) stopped() bool {
	if s.ctx.Err() != nil {
		s.ended()
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.failed != nil
}

// ended fails the script because its context ended: stopped by the caller, or out of time.
func (s *sandbox) ended() {
	if s.parent.Err() != nil {
		s.fail(&Failure{Reason: ReasonCancelled, Message: "stopped"})
		return
	}
	s.fail(&Failure{Reason: ReasonTimeout, Message: fmt.Sprintf("the script ran longer than %s", s.lim.Timeout)})
}

func (s *sandbox) run(parent context.Context, code string, fns []Func) Result {
	if strings.TrimSpace(code) == "" {
		return Result{Err: &Failure{Reason: ReasonInvalid, Message: "code is required"}, Calls: s.calls}
	}
	program, err := goja.Compile(file, prefix+code+"\n})()", false)
	if err != nil {
		return Result{Err: syntaxFailure(err), Calls: s.calls}
	}
	ctx, cancel := context.WithTimeout(parent, s.lim.Timeout)
	defer cancel()
	s.ctx, s.parent = ctx, parent
	s.vm = goja.New()
	s.vm.SetMaxCallStackSize(1000)
	if err := s.setup(fns); err != nil {
		return Result{Err: &Failure{Reason: ReasonScript, Message: err.Error()}, Calls: s.calls}
	}

	done, watched := make(chan struct{}), make(chan struct{})
	go func() {
		defer close(watched)
		select {
		case <-ctx.Done():
			s.ended()
		case <-done:
		}
	}()
	value, runErr := s.vm.RunProgram(program)
	// Showing what the script returned or threw runs its code again (toJSON, toString), so it is still watched until
	// the result is settled.
	failed := s.finish(value, runErr)
	close(done)
	<-watched // the watcher may still be interrupting; it is gone before Run returns
	return Result{Output: s.out.String(), Err: failed, Calls: s.calls}
}

// finish settles how the run went once the script's body is over: what it threw, or what it returned added to the
// output. A failure that came first, or while showing these, stands over anything else.
func (s *sandbox) finish(value goja.Value, runErr error) *Failure {
	if s.stopped() {
		return s.failure()
	}
	if runErr != nil {
		f := s.scriptFailure(runErr)
		if s.stopped() {
			return s.failure()
		}
		return f
	}
	if value == nil || goja.IsUndefined(value) {
		return nil
	}
	text, err := s.show(value, true)
	if s.stopped() {
		return s.failure()
	}
	if err != nil {
		f := s.scriptFailure(err)
		if s.stopped() {
			return s.failure()
		}
		return f
	}
	s.write(text)
	return s.failure()
}

func (s *sandbox) failure() *Failure {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.failed
}

// setup gives the script its globals: tools, ALL_TOOLS, text and console, and nothing else the host has.
func (s *sandbox) setup(fns []Func) error {
	vm := s.vm
	freeze, _ := goja.AssertFunction(vm.Get("Object").ToObject(vm).Get("freeze"))
	jsonObj := vm.Get("JSON").ToObject(vm)
	s.jsonValue, _ = goja.AssertFunction(jsonObj.Get("parse"))
	s.jsonText, _ = goja.AssertFunction(jsonObj.Get("stringify"))
	s.toText, _ = goja.AssertFunction(vm.Get("String"))
	s.errorType, _ = goja.AssertConstructor(vm.Get("Error"))
	tools := vm.NewObject()
	list := make([]any, 0, len(fns))
	for _, fn := range fns {
		if err := tools.Set(fn.Name, s.tool(fn)); err != nil {
			return err
		}
		item := vm.NewObject()
		_ = item.Set("name", fn.Name)
		_ = item.Set("description", fn.Description)
		if _, err := freeze(goja.Undefined(), item); err != nil {
			return err
		}
		list = append(list, item)
	}
	all := vm.NewArray(list...)
	console := vm.NewObject()
	text := func(call goja.FunctionCall) goja.Value {
		if s.stopped() {
			return goja.Undefined()
		}
		parts := make([]string, len(call.Arguments))
		for i, v := range call.Arguments {
			shown, err := s.show(v, false)
			if err != nil {
				panic(s.thrown(err))
			}
			parts[i] = shown
		}
		s.write(strings.Join(parts, " "))
		return goja.Undefined()
	}
	for _, name := range []string{"log", "info", "warn", "error", "debug"} {
		_ = console.Set(name, text)
	}
	for _, o := range []*goja.Object{tools, all, console} {
		if _, err := freeze(goja.Undefined(), o); err != nil {
			return err
		}
	}
	for name, v := range map[string]any{"tools": tools, "ALL_TOOLS": all, "console": console, "text": text} {
		if err := vm.Set(name, v); err != nil {
			return err
		}
	}
	return nil
}

// tool is fn as the script calls it: arguments in as JSON, the result out as plain JavaScript values.
func (s *sandbox) tool(fn Func) func(goja.FunctionCall) goja.Value {
	return func(call goja.FunctionCall) goja.Value {
		if s.stopped() {
			return goja.Undefined()
		}
		args := json.RawMessage("{}")
		if a := call.Argument(0); !goja.IsUndefined(a) && !goja.IsNull(a) {
			if o, ok := a.(*goja.Object); !ok || o.ClassName() == "Array" || o.ClassName() == "Function" {
				panic(s.vm.NewTypeError("tools.%s takes one object of arguments", fn.Name))
			}
			raw, err := s.stringify(a)
			if errors.Is(err, errNoJSON) {
				panic(s.vm.NewTypeError("tools.%s takes arguments JSON can write", fn.Name))
			}
			if err != nil {
				panic(s.thrown(err))
			}
			args = json.RawMessage(raw)
		}
		if s.total >= s.lim.MaxCalls {
			s.fail(&Failure{Reason: ReasonCallLimit, Message: fmt.Sprintf("the script called tools more than %d times", s.lim.MaxCalls)})
			return goja.Undefined()
		}
		if s.h.BeforeCall != nil {
			if err := s.h.BeforeCall(fn.Name); err != nil {
				var f *Failure
				if !errors.As(err, &f) {
					f = &Failure{Reason: "refused", Message: err.Error()}
				}
				s.fail(f)
				return goja.Undefined()
			}
		}
		s.total++
		s.calls[fn.Name]++
		v, err := fn.Call(s.ctx, args)
		if s.stopped() {
			return goja.Undefined()
		}
		if err != nil {
			panic(s.newError(err.Error()))
		}
		raw, err := json.Marshal(v)
		if err != nil {
			panic(s.newError(fmt.Sprintf("tools.%s returned what is not JSON", fn.Name)))
		}
		out, err := s.jsonValue(goja.Undefined(), s.vm.ToValue(string(raw)))
		if err != nil {
			panic(s.thrown(err))
		}
		return out
	}
}

// newError is an Error made by Error as the script found it, so replacing Error changes nothing; it is what to throw.
func (s *sandbox) newError(message string) any {
	o, err := s.errorType(nil, s.vm.ToValue(message))
	if err != nil {
		return s.thrown(err)
	}
	return o
}

// show is a value as text: a string as it is, anything else as JSON, or as JavaScript prints it when JSON has no
// form for it. A returned string is JSON too, so it reads as the value it is.
func (s *sandbox) show(v goja.Value, quoteStrings bool) (string, error) {
	if _, obj := v.(*goja.Object); !obj && !quoteStrings {
		if str, ok := v.Export().(string); ok {
			return str, nil
		}
	}
	out, err := s.stringify(v)
	if errors.Is(err, errNoJSON) {
		return s.str(v)
	}
	return out, err
}

// str is String(v) as the script would get it, which may run its code (toString) and may throw.
func (s *sandbox) str(v goja.Value) (string, error) {
	out, err := s.toText(goja.Undefined(), v)
	if err != nil {
		return "", err
	}
	return out.String(), nil
}

var errNoJSON = errors.New("no JSON form")

// stringify is JSON.stringify inside the script, so what it drops (functions, undefined) is dropped the same way.
func (s *sandbox) stringify(v goja.Value) (string, error) {
	out, err := s.jsonText(goja.Undefined(), v)
	if err != nil {
		return "", err
	}
	if goja.IsUndefined(out) {
		return "", errNoJSON
	}
	return out.String(), nil
}

// thrown is an error from inside the interpreter as the host throws it back into the script: what the script threw
// as it came, an interruption or stack overflow as it is, so the script still cannot catch it, and anything else as a
// TypeError. The interpreter turns no other Go error into JavaScript; it would crash the process.
func (s *sandbox) thrown(err error) any {
	var stopped *goja.InterruptedError
	var overflow *goja.StackOverflowError
	var ex *goja.Exception
	switch {
	case errors.As(err, &stopped) || errors.As(err, &overflow):
		return err
	case errors.As(err, &ex):
		return ex.Value()
	}
	return s.vm.NewTypeError("%s", err.Error())
}

// write adds a line of output, or ends the script when the output would grow past its limits; what fits is kept.
func (s *sandbox) write(text string) {
	sep := ""
	if s.out.Len() > 0 {
		sep = "\n"
	}
	adds := strings.Count(text, "\n") + 1
	if s.lines+adds <= s.lim.MaxLines && s.out.Len()+len(sep)+len(text) <= s.lim.MaxBytes {
		s.out.WriteString(sep)
		s.out.WriteString(text)
		s.lines += adds
		return
	}
	room := s.lim.MaxLines - s.lines
	if room > 0 {
		lines := strings.SplitN(text, "\n", room+1)
		part := strings.Join(lines[:min(room, len(lines))], "\n")
		part = cutUTF8(part, s.lim.MaxBytes-s.out.Len()-len(sep))
		if part != "" {
			s.out.WriteString(sep)
			s.out.WriteString(part)
			s.lines += strings.Count(part, "\n") + 1
		}
	}
	s.fail(&Failure{Reason: ReasonOutputLimit, Message: fmt.Sprintf("the output passed %d lines or %dKB", s.lim.MaxLines, s.lim.MaxBytes>>10)})
}

func cutUTF8(s string, n int) string {
	if n <= 0 {
		return ""
	}
	if len(s) <= n {
		return s
	}
	s = s[:n]
	for !utf8.ValidString(s) {
		s = s[:len(s)-1]
	}
	return s
}

// syntaxFailure is a script that does not parse, at its place in the script.
func syntaxFailure(err error) *Failure {
	f := &Failure{Reason: ReasonScript, Message: err.Error()}
	var ce *goja.CompilerSyntaxError
	if errors.As(err, &ce) {
		f.Message = "SyntaxError: " + ce.Message
		if ce.File != nil {
			p := ce.File.Position(ce.Offset)
			f.Line, f.Column = p.Line, p.Column
		}
	}
	if f.Line == 1 {
		f.Column = max(f.Column-len(prefix), 1)
	}
	return f
}

// scriptFailure is what the script threw and did not catch, at the deepest place in the script it came from. Showing
// what it threw may run its code (toString), so it is called while the script is still watched.
func (s *sandbox) scriptFailure(err error) *Failure {
	f := &Failure{Reason: ReasonScript, Message: "the script failed"}
	var so *goja.StackOverflowError
	var ex *goja.Exception
	switch {
	case errors.As(err, &so):
		f.Message = "RangeError: Maximum call stack size exceeded"
	case errors.As(err, &ex):
		// Never ex.Error(): it turns the value into text outside the interpreter's guard.
		if v := ex.Value(); v != nil {
			if shown, err := s.str(v); err == nil {
				f.Message = shown
			} else {
				f.Message = "the script threw what cannot be shown"
			}
		}
		for _, frame := range ex.Stack() {
			if frame.SrcName() == file {
				p := frame.Position()
				f.Line, f.Column = p.Line, p.Column
				break
			}
		}
	default:
		f.Message = err.Error()
	}
	if f.Line == 1 {
		f.Column = max(f.Column-len(prefix), 1)
	}
	return f
}
