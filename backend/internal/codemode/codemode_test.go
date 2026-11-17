package codemode

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"regexp"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/rs/zerolog"
)

var took = regexp.MustCompile(`in \d+\.\d\ds`)

// shown is a result's text without the time it took.
func shown(res Result) string { return took.ReplaceAllString(res.Text, "in Ns") }

func run(t *testing.T, code string, fns ...Func) Result {
	t.Helper()
	return Run(context.Background(), code, fns, Options{SpillDir: t.TempDir()})
}

func counter(name string, n *atomic.Int32, out any) Func {
	return Func{Name: name, Call: func(context.Context, json.RawMessage) (any, error) { n.Add(1); return out, nil }}
}

func TestToolsChainAndOnlyTheOutputComesBack(t *testing.T) {
	list := Func{Name: "list", Call: func(context.Context, json.RawMessage) (any, error) {
		return []map[string]any{{"id": "a", "done": true}, {"id": "b", "done": false}, {"id": "c", "done": true}}, nil
	}}
	var mu sync.Mutex
	var asked []string
	read := Func{Name: "read", Call: func(_ context.Context, raw json.RawMessage) (any, error) {
		var a struct{ ID string }
		_ = json.Unmarshal(raw, &a)
		mu.Lock()
		asked = append(asked, a.ID)
		mu.Unlock()
		return map[string]any{"id": a.ID, "size": len(a.ID) * 10}, nil
	}}
	res := run(t, `
const done = (await tools.list()).filter(x => x.done);
let total = 0;
for (const x of done) total += (await tools.read({ID: x.id})).size;
text("done " + done.length);
console.log({total}, "items");
return done.map(x => x.id);`, list, read)
	if res.Err != nil {
		t.Fatalf("failed: %+v", res.Err)
	}
	want := "Script completed in Ns\n==> text 1/2 <==\ndone 2\n==> text 2/2 <==\n[\"a\",\"c\"]\n<console_output>\n{\"total\":20} items\n</console_output>"
	if shown(res) != want {
		t.Fatalf("got\n%s\nwant\n%s", shown(res), want)
	}
	if !reflect.DeepEqual(asked, []string{"a", "c"}) || res.Calls["list"] != 1 || res.Calls["read"] != 2 {
		t.Fatalf("calls %v, asked %v", res.Calls, asked)
	}
}

func TestReturnedValuesAndNoOutput(t *testing.T) {
	if res := run(t, `1 + 1;`); res.Err != nil || shown(res) != "Script completed in Ns" {
		t.Fatalf("%+v", res)
	}
	// a returned string reads as text does, as it is
	if res := run(t, `return "hi"`); shown(res) != "Script completed in Ns\nhi" {
		t.Fatalf("%q", res.Text)
	}
	if res := run(t, `return {toJSON() { throw new Error("cannot show") }}`); res.Err == nil || res.Err.Message != "Error: cannot show" {
		t.Fatalf("%+v", res.Err)
	}
	for _, code := range []string{"  ", ""} {
		if res := run(t, code); res.Err == nil || res.Err.Reason != ReasonInvalid {
			t.Fatalf("%q: %+v", code, res.Err)
		}
	}
}

func TestToolErrorsCanBeCaught(t *testing.T) {
	bad := Func{Name: "bad", Call: func(context.Context, json.RawMessage) (any, error) { return nil, errors.New("no task x") }}
	res := run(t, `try { await tools.bad({}) } catch (e) { text(String(e instanceof Error) + " " + e.message) }`, bad)
	if res.Err != nil || shown(res) != "Script completed in Ns\ntrue no task x" {
		t.Fatalf("%+v", res)
	}
	// Promise.allSettled keeps what succeeded
	n := atomic.Int32{}
	res = run(t, `const r = await Promise.allSettled([tools.bad(), tools.ok()]); return r.map(x => x.status)`, bad, counter("ok", &n, 1))
	if res.Err != nil || !strings.HasSuffix(res.Text, `["rejected","fulfilled"]`) {
		t.Fatalf("%+v", res)
	}
	res = run(t, "text('a')\nawait tools.bad({})", bad)
	if res.Err == nil || res.Err.Reason != ReasonScript || res.Err.Line != 2 || res.Err.Message != "Error: no task x" {
		t.Fatalf("%#v", res.Err)
	}
	if want := "Script failed in Ns\na\nScript error: Error: no task x (line 2, column "; !strings.HasPrefix(shown(res), want) {
		t.Fatalf("%q", res.Text)
	}
}

func TestArgumentsMustBeAnObject(t *testing.T) {
	n := atomic.Int32{}
	res := run(t, `await tools.f([1])`, counter("f", &n, nil))
	if res.Err == nil || !strings.HasPrefix(res.Err.Message, "TypeError: tools.f takes one object of arguments") || n.Load() != 0 {
		t.Fatalf("%+v n=%d", res.Err, n.Load())
	}
	res = run(t, `await tools.f(); await tools.f(null); await tools.f({a: 1})`, counter("f", &n, nil))
	if res.Err != nil || n.Load() != 3 {
		t.Fatalf("%+v n=%d", res.Err, n.Load())
	}
}

func TestUnknownToolIsNeverRun(t *testing.T) {
	res := run(t, `await tools.write_file({path: "x", content: "y"})`)
	if res.Err == nil || !strings.Contains(res.Err.Message, "TypeError") {
		t.Fatalf("%+v", res.Err)
	}
}

// The script reaches nothing of the host but its tools: no globals for it, and the engine's own file functions, which
// it can still import, find no folder to read or write.
func TestNoHostCapabilities(t *testing.T) {
	res := run(t, `text([typeof require, typeof process, typeof setTimeout, typeof setInterval, typeof fetch, typeof XMLHttpRequest,
  typeof std, typeof os, typeof print, typeof bjson, typeof Deno, typeof Bun, typeof WebAssembly, typeof __cm_host].join(","))`)
	if res.Err != nil || !strings.HasSuffix(res.Text, "\n"+strings.Repeat("undefined,", 13)+"undefined") {
		t.Fatalf("%+v", res)
	}
	res = run(t, `"use strict"; try { tools.x = 1 } catch {} text(String(Object.isFrozen(tools)) + " " + typeof tools.x)`)
	if !strings.HasSuffix(res.Text, "\ntrue undefined") {
		t.Fatalf("%q", res.Text)
	}
	dir := t.TempDir()
	secret := filepath.Join(dir, "secret.txt")
	if err := os.WriteFile(secret, []byte("SECRET"), 0o600); err != nil {
		t.Fatal(err)
	}
	made := filepath.Join(dir, "made.txt")
	code := `const std = await import("qjs:std");
const read = std.loadFile(` + quote(secret) + `);
const f = std.open(` + quote(made) + `, "w");
if (f) { f.puts("x"); f.close() }
return [String(read), String(f), String(std.getenv("HOME"))]`
	res = run(t, code)
	if res.Err != nil || !strings.HasSuffix(res.Text, `["null","null","undefined"]`) {
		t.Fatalf("%+v", res)
	}
	if _, err := os.Stat(made); err == nil {
		t.Fatal("the script wrote a file")
	}
}

func quote(s string) string {
	raw, _ := json.Marshal(s)
	return string(raw)
}

func TestSyntaxErrorPointsIntoTheScript(t *testing.T) {
	res := run(t, "text(1)\nlet = = 2")
	if res.Err == nil || res.Err.Reason != ReasonScript || res.Err.Line != 2 || !strings.HasPrefix(res.Err.Message, "SyntaxError: ") {
		t.Fatalf("%+v", res.Err)
	}
	res = run(t, `nope()`)
	if res.Err == nil || res.Err.Line != 1 || res.Err.Column != 1 || res.Err.Message != "ReferenceError: nope is not defined" {
		t.Fatalf("%+v", res.Err)
	}
	res = run(t, "  x.y = 1")
	if res.Err == nil || res.Err.Line != 1 || res.Err.Column < 3 {
		t.Fatalf("%#v", res.Err)
	}
}

// slow waits d or until its context ends, and counts how many run at once.
type slow struct {
	d          time.Duration
	mu         sync.Mutex
	now, most  int
	order      []string
	cancelled  atomic.Int32
	interrupts chan struct{}
}

func (s *slow) fn(name string, serial bool) Func {
	return Func{Name: name, Serial: serial, Call: func(ctx context.Context, raw json.RawMessage) (any, error) {
		var a struct{ N string }
		_ = json.Unmarshal(raw, &a)
		s.mu.Lock()
		s.now++
		s.most = max(s.most, s.now)
		s.order = append(s.order, a.N)
		s.mu.Unlock()
		defer func() {
			s.mu.Lock()
			s.now--
			s.mu.Unlock()
		}()
		select {
		case <-time.After(s.d):
			return a.N, nil
		case <-ctx.Done():
			s.cancelled.Add(1)
			return nil, ctx.Err()
		}
	}}
}

// Calls that change nothing run side by side, and their results come back in the order asked for.
func TestPromiseAllRunsCallsAtOnce(t *testing.T) {
	s := &slow{d: 200 * time.Millisecond}
	start := time.Now()
	res := run(t, `return await Promise.all(["a", "b", "c"].map(N => tools.read({N})))`, s.fn("read", false))
	if res.Err != nil || !strings.HasSuffix(res.Text, `["a","b","c"]`) {
		t.Fatalf("%+v", res)
	}
	if s.most != 3 || time.Since(start) > 500*time.Millisecond {
		t.Fatalf("%d at once, took %s", s.most, time.Since(start))
	}
}

// Calls that change something run one at a time, in the order the script made them, even when it waits for them
// together; calls that change nothing still run beside them.
func TestSerialCallsRunInOrder(t *testing.T) {
	writes := &slow{d: 60 * time.Millisecond}
	reads := &slow{d: 60 * time.Millisecond}
	res := run(t, `await Promise.all([tools.write({N: "1"}), tools.write({N: "2"}), tools.read({N: "r"}), tools.write({N: "3"})]); text("ok")`,
		writes.fn("write", true), reads.fn("read", false))
	if res.Err != nil || writes.most != 1 || !slices.Equal(writes.order, []string{"1", "2", "3"}) || reads.most != 1 {
		t.Fatalf("%+v most %d order %v", res.Err, writes.most, writes.order)
	}
}

// A tool's *Failure ends the script, which cannot catch it.
func TestAToolsFailureEndsTheScript(t *testing.T) {
	refuse := Func{Name: "x", Call: func(context.Context, json.RawMessage) (any, error) {
		return nil, &Failure{Reason: "refused", Message: "not now"}
	}}
	res := run(t, `text("before"); try { await tools.x() } catch (e) { text("caught") } text("after")`, refuse)
	if res.Err == nil || res.Err.Reason != "refused" || shown(res) != "Script failed in Ns\nbefore\nScript error (refused): not now" {
		t.Fatalf("%+v %q", res.Err, res.Text)
	}
}

func TestOptionsLine(t *testing.T) {
	n := atomic.Int32{}
	for _, code := range []string{
		"await tools.f()\n// @options: {\"timeout_ms\": 10}",
		`// @options: {"timeout": 10}`,
		`// @options: {"max_output_tokens": 0}`,
		`// @options: {"max_output_tokens": 100001}`,
		`// @options: {"timeout_ms": -1}`,
		`// @options: nope`,
	} {
		res := run(t, code, counter("f", &n, nil))
		if res.Err == nil || res.Err.Reason != ReasonInvalid {
			t.Fatalf("%q: %+v", code, res.Err)
		}
	}
	if n.Load() != 0 {
		t.Fatal("a script with a bad options line ran")
	}
	res := run(t, "// @options: {\"max_output_tokens\": 5}\ntext('x'.repeat(100))")
	if res.Err != nil || !strings.Contains(res.Text, "\nxxxxxxxxxx\n[... 80 characters cut; the whole output is in ") {
		t.Fatalf("%+v", res)
	}
}

// timeout_ms is a deadline for the whole script, a tool's wait included; the tool is stopped too.
func TestTimeoutStopsTheScriptAndItsCalls(t *testing.T) {
	s := &slow{d: 10 * time.Second}
	start := time.Now()
	res := run(t, "// @options: {\"timeout_ms\": 150}\ntry { await tools.read({N: \"a\"}) } catch (e) { text(\"caught\") }", s.fn("read", false))
	if res.Err == nil || res.Err.Reason != ReasonTimeout || time.Since(start) > 2*time.Second || strings.Contains(res.Text, "caught") {
		t.Fatalf("%+v after %s", res, time.Since(start))
	}
	if s.cancelled.Load() != 1 {
		t.Fatal("the call was not stopped")
	}
}

// guarded runs body in a child test process that is killed after a hard limit, so a sandbox that does not stop shows
// as a failure instead of hanging the tests.
func guarded(t *testing.T, limit time.Duration, body func(t *testing.T)) {
	t.Helper()
	if os.Getenv("CODEMODE_GUARDED") == t.Name() {
		// the first VM compiles the engine, which takes seconds under the race detector: not what is timed
		if res := Run(context.Background(), "1", nil, Options{}); res.Err != nil {
			t.Fatalf("%+v", res.Err)
		}
		body(t)
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), limit)
	defer cancel()
	cmd := exec.CommandContext(ctx, os.Args[0], "-test.run=^"+regexp.QuoteMeta(t.Name())+"$", "-test.v", "-test.count=1")
	cmd.Env = append(os.Environ(), "CODEMODE_GUARDED="+t.Name())
	out, err := cmd.CombinedOutput()
	if ctx.Err() != nil {
		t.Fatalf("the child did not finish in time:\n%s", out)
	}
	if err != nil || !strings.Contains(string(out), "--- PASS: "+t.Name()) {
		t.Fatalf("child: %v\n%s", err, out)
	}
}

// JavaScript that runs on without waiting on a tool is stopped, however it loops, and the script cannot catch it.
func TestBusyScriptIsStopped(t *testing.T) {
	guarded(t, 30*time.Second, func(t *testing.T) {
		busyLimit = 200 * time.Millisecond
		n := atomic.Int32{}
		for _, code := range []string{
			`for (;;) {}`,
			`await tools.f(); try { while (true) {} } catch (e) { text("caught") }`,
			`return {toJSON() { for (;;) {} }}`,
		} {
			start := time.Now()
			res := run(t, code, counter("f", &n, 1))
			if res.Err == nil || res.Err.Reason != ReasonBusy || strings.Contains(res.Text, "caught") || time.Since(start) > 3*time.Second {
				t.Fatalf("%s: %+v after %s", code, res, time.Since(start))
			}
		}
		// waiting on tools is not being busy
		s := &slow{d: 150 * time.Millisecond}
		if res := run(t, `for (let i = 0; i < 3; i++) await tools.read({N: "x"}); text("done")`, s.fn("read", false)); res.Err != nil {
			t.Fatalf("%+v", res.Err)
		}
	})
}

func TestCancelStopsTheScript(t *testing.T) {
	guarded(t, 30*time.Second, func(t *testing.T) {
		for _, code := range []string{`for (;;) {}`, `await tools.read({N: "a"})`} {
			s := &slow{d: 10 * time.Second}
			ctx, cancel := context.WithCancel(context.Background())
			time.AfterFunc(100*time.Millisecond, cancel)
			start := time.Now()
			res := Run(ctx, code, []Func{s.fn("read", false)}, Options{})
			if res.Err == nil || res.Err.Reason != ReasonCancelled || time.Since(start) > 2*time.Second {
				t.Fatalf("%s: %+v after %s", code, res.Err, time.Since(start))
			}
		}
	})
}

// A script that waits on what nothing can settle fails at once, as there are no timers.
func TestWaitingOnNothingFailsAtOnce(t *testing.T) {
	start := time.Now()
	res := run(t, `text("a"); await new Promise(() => {}); text("b")`)
	if res.Err == nil || res.Err.Reason != ReasonStalled || time.Since(start) > time.Second || !strings.Contains(res.Text, "\na\n") {
		t.Fatalf("%+v", res)
	}
}

// Calls the script did not wait for are stopped once it ends.
func TestCallsLeftRunningAreStopped(t *testing.T) {
	s := &slow{d: 10 * time.Second}
	start := time.Now()
	res := run(t, `tools.read({N: "a"}); return 1`, s.fn("read", false))
	if res.Err != nil || !strings.HasSuffix(res.Text, "\n1") || time.Since(start) > 2*time.Second || s.cancelled.Load() != 1 {
		t.Fatalf("%+v %d", res, s.cancelled.Load())
	}
}

// exit() ends the script at once, successfully, with its output and what it stored; catching it changes nothing.
func TestExitEndsAtOnce(t *testing.T) {
	res := Run(context.Background(), `text("a"); store("k", 1); try { exit() } catch {} text("b"); for (;;) {}`, nil, Options{})
	if res.Err != nil || shown(res) != "Script completed in Ns\na" || string(res.Store["k"]) != "1" {
		t.Fatalf("%+v", res)
	}
}

func TestStoreKeepsValuesForLaterScripts(t *testing.T) {
	kept := map[string]json.RawMessage{"n": json.RawMessage(`1`), "gone": json.RawMessage(`"x"`)}
	res := Run(context.Background(), `const v = load("n"); store("n", v + 1); store("gone", undefined); store("obj", {a: [1]});
const o = load("obj"); o.a.push(2); return [load("missing") === undefined, load("obj").a.length]`, nil, Options{Store: kept})
	if res.Err != nil || !strings.HasSuffix(res.Text, "[true,1]") {
		t.Fatalf("%+v", res)
	}
	if !reflect.DeepEqual(res.Store, map[string]json.RawMessage{"n": json.RawMessage(`2`), "obj": json.RawMessage(`{"a":[1]}`)}) {
		t.Fatalf("%s", res.Store)
	}
	if string(kept["n"]) != "1" || kept["gone"] == nil {
		t.Fatal("the store handed in was changed")
	}
	// a failed script keeps nothing; reading alone changes nothing
	if res := Run(context.Background(), `store("n", 5); throw new Error("x")`, nil, Options{Store: kept}); res.Store != nil {
		t.Fatalf("%s", res.Store)
	}
	if res := Run(context.Background(), `load("n")`, nil, Options{Store: kept}); res.Store != nil {
		t.Fatalf("%s", res.Store)
	}
	res = run(t, `const caught = [];
for (const f of [() => store("big", "x".repeat(262144)), () => store(1, 1), () => store("f", () => 1)]) {
  try { f() } catch (e) { caught.push(e.name) }
}
return caught`)
	if res.Err != nil || !strings.HasSuffix(res.Text, `["RangeError","TypeError","TypeError"]`) {
		t.Fatalf("%+v", res)
	}
}

func TestStoredValuesTogetherAreBounded(t *testing.T) {
	big := json.RawMessage(`"` + strings.Repeat("y", MaxStoreTotal-100) + `"`)
	res := Run(context.Background(), `try { store("more", "z".repeat(200)) } catch (e) { return e.name }`, nil, Options{Store: map[string]json.RawMessage{"big": big}})
	if res.Err != nil || !strings.HasSuffix(res.Text, "\nRangeError") || res.Store != nil {
		t.Fatalf("%+v", res)
	}
}

// Memory is capped for the VM as a whole, however the script fills it; the next script runs as usual.
func TestMemoryIsCapped(t *testing.T) {
	guarded(t, 3*time.Minute, func(t *testing.T) {
		for _, code := range []string{
			`const a = []; for (;;) a.push("x".repeat(1000) + a.length)`,
			`let s = "x"; for (;;) s = s + s`,
			`const a = []; for (let i = 0; ; i++) a.push({i, t: "y" + i})`,
		} {
			start := time.Now()
			res := run(t, code)
			if res.Err == nil || res.Err.Reason != ReasonScript || !strings.Contains(res.Err.Message, "out of memory") || time.Since(start) > time.Minute {
				t.Fatalf("%s: %+v after %s", code, res.Err, time.Since(start))
			}
		}
		if res := run(t, `return [1, 2, 3].map(x => x * 2)`); res.Err != nil {
			t.Fatalf("%+v", res.Err)
		}
	})
}

func TestDeepRecursionFails(t *testing.T) {
	guarded(t, 30*time.Second, func(t *testing.T) {
		res := run(t, `function f(n) { return f(n + 1) + 1 } return f(0)`)
		if res.Err == nil || res.Err.Reason != ReasonScript {
			t.Fatalf("%+v", res)
		}
		if res := run(t, `return 2`); res.Err != nil {
			t.Fatalf("%+v", res.Err)
		}
	})
}

// Output past the limit keeps its start and end, with the whole of it in a file the result names.
func TestLongOutputIsCutAndKept(t *testing.T) {
	dir := t.TempDir()
	res := Run(context.Background(), `text("<" + "x".repeat(100000) + ">")`, nil, Options{SpillDir: dir})
	m := regexp.MustCompile(`\n\[\.\.\. (\d+) characters cut; the whole output is in (\S+) \.\.\.\]\n`).FindStringSubmatch(res.Text)
	if res.Err != nil || m == nil || m[1] != "60002" || filepath.Dir(m[2]) != dir {
		t.Fatalf("%+v %.300q", res.Err, res.Text)
	}
	whole, err := os.ReadFile(m[2])
	if err != nil || string(whole) != "<"+strings.Repeat("x", 100000)+">" {
		t.Fatalf("%v %d", err, len(whole))
	}
	if !strings.Contains(res.Text, "\n<xxx") || !strings.HasSuffix(res.Text, "xxx>") || len(res.Text) > 40_200 {
		t.Fatalf("%d", len(res.Text))
	}
}

// Output past what any model could read fails the script, which cannot catch it; what came before stays.
func TestOutputLimitEndsTheScript(t *testing.T) {
	res := run(t, `const big = "x".repeat(1 << 20); try { for (;;) text(big) } catch (e) { text("caught") }`)
	if res.Err == nil || res.Err.Reason != ReasonOutputLimit || strings.Contains(res.Text, "caught") || res.Output < maxOutputChars-(1<<20) {
		t.Fatalf("%+v %d", res.Err, res.Output)
	}
}

// At most MaxWorkers scripts have a VM at once; another waits for one, and fails without running when none frees.
func TestWorkersAreShared(t *testing.T) {
	guarded(t, 30*time.Second, func(t *testing.T) {
		workerWait = 300 * time.Millisecond
		release := make(chan struct{})
		var started atomic.Int32
		hold := Func{Name: "hold", Call: func(ctx context.Context, _ json.RawMessage) (any, error) {
			started.Add(1)
			select {
			case <-release:
			case <-ctx.Done():
			}
			return 1, nil
		}}
		var wg sync.WaitGroup
		results := make([]Result, MaxWorkers)
		for i := range MaxWorkers {
			wg.Add(1)
			go func() {
				defer wg.Done()
				results[i] = Run(context.Background(), `await tools.hold()`, []Func{hold}, Options{})
			}()
		}
		for started.Load() < MaxWorkers {
			time.Sleep(5 * time.Millisecond)
		}
		n := atomic.Int32{}
		extra := Run(context.Background(), `await tools.f()`, []Func{counter("f", &n, 1)}, Options{})
		if extra.Err == nil || extra.Err.Reason != ReasonNoWorker || n.Load() != 0 {
			t.Fatalf("%+v", extra.Err)
		}
		close(release)
		wg.Wait()
		for _, r := range results {
			if r.Err != nil {
				t.Fatalf("%+v", r.Err)
			}
		}
		if res := Run(context.Background(), `await tools.f()`, []Func{counter("f", &n, 1)}, Options{}); res.Err != nil {
			t.Fatalf("%+v", res.Err)
		}
	})
}

func TestToolsListed(t *testing.T) {
	n := atomic.Int32{}
	f := counter("x", &n, nil)
	f.Description = "does x"
	res := run(t, `text(ALL_TOOLS)`, f)
	if !strings.HasSuffix(res.Text, "\n"+`[{"name":"x","description":"does x"}]`) {
		t.Fatalf("%q", res.Text)
	}
}

func TestTypeOf(t *testing.T) {
	type inner struct {
		A int `json:"a"`
	}
	type v struct {
		ID    string            `json:"id"`
		Team  string            `json:"teamId,omitempty"`
		Tags  []string          `json:"tags"`
		Ptr   *inner            `json:"ptr"`
		Opt   *inner            `json:"opt,omitempty"`
		Map   map[string]inner  `json:"map,omitempty"`
		Raw   json.RawMessage   `json:"raw"`
		Skip  string            `json:"-"`
		Times map[string][]bool `json:"times"`
	}
	got := TypeOf(reflect.TypeFor[[]v]())
	want := "{\n  id: string;\n  teamId?: string;\n  tags: string[] | null;\n  ptr: {\n    a: number;\n  } | null;\n  opt?: {\n    a: number;\n  };\n  map?: Record<string, {\n    a: number;\n  }>;\n  raw: unknown;\n  times: Record<string, boolean[] | null> | null;\n}[]"
	if got != want {
		t.Fatalf("got\n%s\nwant\n%s", got, want)
	}
}

func TestLogKeepsNoContent(t *testing.T) {
	var buf bytes.Buffer
	z := zerolog.New(&buf)
	n := atomic.Int32{}
	res := run(t, `const SECRET_MARKER = "sk-SECRET_MARKER"; await tools.x({key: SECRET_MARKER}); text(SECRET_MARKER); throw new TypeError(SECRET_MARKER)`, counter("x", &n, "SECRET_MARKER"))
	Log(z, res).Str("source", "step").Send()
	ok := run(t, `text("SECRET_MARKER")`)
	Log(z, ok).Send()
	out := buf.String()
	if strings.Contains(out, "SECRET_MARKER") {
		t.Fatalf("log has content: %s", out)
	}
	for _, want := range []string{`"message":"codemode_failed"`, `"reason":"script_error"`, `"error":"TypeError"`, `"tools":"x:1"`, `"calls":1`, `"line":1`, `"message":"codemode_done"`, `"out_bytes":13`, `"ms":`} {
		if !strings.Contains(out, want) {
			t.Fatalf("log lacks %s: %s", want, out)
		}
	}
}

// The module's memory is capped at MemoryLimit, and nothing else of it changes.
func TestCapMemory(t *testing.T) {
	capped, err := cappedWasm()
	if err != nil {
		t.Fatal(err)
	}
	maxPages := func(wasm []byte) (least, most uint64, hasMax bool) {
		for i := 8; i < len(wasm); {
			size, body, _ := uleb(wasm, i+1)
			if wasm[i] == 5 {
				_, at, _ := uleb(wasm, body)
				flags := wasm[at]
				least, at, _ = uleb(wasm, at+1)
				if flags == 1 {
					most, _, _ = uleb(wasm, at)
				}
				return least, most, flags == 1
			}
			i = body + int(size)
		}
		t.Fatal("no memory")
		return
	}
	least, _, _ := maxPages(qjsWasm)
	gotLeast, most, has := maxPages(capped)
	if !has || most != MemoryLimit/wasmPage || gotLeast != least || len(capped)-len(qjsWasm) > 8 {
		t.Fatalf("%d %d %v", gotLeast, most, has)
	}
	if _, err := capMemory([]byte("nope"), 1); err == nil {
		t.Fatal("not a module")
	}
}

// The embedded engine is the one the Go side at go.mod's version was built for.
func TestWasmMatchesTheModule(t *testing.T) {
	out, err := exec.Command("go", "list", "-m", "-f", "{{.Dir}}", "github.com/fastschema/qjs").Output()
	if err != nil || strings.TrimSpace(string(out)) == "" {
		t.Skipf("module not found: %v", err)
	}
	theirs, err := os.ReadFile(filepath.Join(strings.TrimSpace(string(out)), "qjs.wasm"))
	if err != nil {
		t.Skip(err)
	}
	if !bytes.Equal(theirs, qjsWasm) {
		t.Fatal("qjs.wasm differs from the module's: copy it again from the module go.mod names")
	}
}
