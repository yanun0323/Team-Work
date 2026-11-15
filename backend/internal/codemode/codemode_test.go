package codemode_test

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"reflect"
	"regexp"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/rs/zerolog"

	"github.com/yanun0323/Team-Work/internal/codemode"
)

func counter(name string, n *int, out any) codemode.Func {
	return codemode.Func{Name: name, Params: json.RawMessage(`{"type":"object","properties":{}}`), Returns: "unknown",
		Call: func(context.Context, json.RawMessage) (any, error) { *n++; return out, nil }}
}

func run(t *testing.T, code string, fns ...codemode.Func) codemode.Result {
	t.Helper()
	return codemode.Run(context.Background(), code, fns, codemode.DefaultLimits(), codemode.Hooks{})
}

func TestToolsChainAndOnlyTheOutputComesBack(t *testing.T) {
	list := codemode.Func{Name: "list", Call: func(context.Context, json.RawMessage) (any, error) {
		return []map[string]any{{"id": "a", "done": true}, {"id": "b", "done": false}, {"id": "c", "done": true}}, nil
	}}
	var asked []string
	read := codemode.Func{Name: "read", Call: func(_ context.Context, raw json.RawMessage) (any, error) {
		var a struct{ ID string }
		_ = json.Unmarshal(raw, &a)
		asked = append(asked, a.ID)
		return map[string]any{"id": a.ID, "size": len(a.ID) * 10}, nil
	}}
	res := run(t, `
const done = tools.list().filter(x => x.done);
let total = 0;
for (const x of done) total += tools.read({ID: x.id}).size;
text("done " + done.length);
console.log({total});
return done.map(x => x.id);`, list, read)
	if res.Err != nil {
		t.Fatalf("failed: %+v", res.Err)
	}
	if want := "done 2\n{\"total\":20}\n[\"a\",\"c\"]"; res.Output != want {
		t.Fatalf("output %q, want %q", res.Output, want)
	}
	if !reflect.DeepEqual(asked, []string{"a", "c"}) || res.Calls["list"] != 1 || res.Calls["read"] != 2 {
		t.Fatalf("calls %v, asked %v", res.Calls, asked)
	}
}

func TestEmptyOutputAndReturnedString(t *testing.T) {
	if res := run(t, `1 + 1;`); res.Err != nil || res.Output != "" {
		t.Fatalf("%+v", res)
	}
	if res := run(t, `return "hi"`); res.Output != `"hi"` {
		t.Fatalf("output %q", res.Output)
	}
	if res := run(t, "  "); res.Err == nil || res.Err.Reason != codemode.ReasonInvalid {
		t.Fatalf("%+v", res.Err)
	}
}

func TestToolErrorsCanBeCaught(t *testing.T) {
	bad := codemode.Func{Name: "bad", Call: func(context.Context, json.RawMessage) (any, error) { return nil, errors.New("no task x") }}
	res := run(t, `try { tools.bad({}) } catch (e) { text(e instanceof Error, e.message) }`, bad)
	if res.Err != nil || res.Output != "true no task x" {
		t.Fatalf("%+v", res)
	}
	res = run(t, "text('a')\ntools.bad({})", bad)
	if res.Err == nil || res.Err.Reason != codemode.ReasonScript || res.Err.Line != 2 || !strings.Contains(res.Err.Message, "no task x") || res.Output != "a" {
		t.Fatalf("%+v", res)
	}
}

func TestArgumentsMustBeAnObject(t *testing.T) {
	n := 0
	res := run(t, `tools.f([1])`, counter("f", &n, nil))
	if res.Err == nil || res.Err.Reason != codemode.ReasonScript || n != 0 {
		t.Fatalf("%+v n=%d", res.Err, n)
	}
}

func TestUnknownToolIsNeverRun(t *testing.T) {
	res := run(t, `tools.write_file({path: "x", content: "y"})`)
	if res.Err == nil || res.Err.Reason != codemode.ReasonScript || !strings.Contains(res.Err.Message, "TypeError") {
		t.Fatalf("%+v", res.Err)
	}
}

func TestNoHostCapabilities(t *testing.T) {
	res := run(t, `text([typeof require, typeof process, typeof setTimeout, typeof setInterval, typeof fetch, typeof XMLHttpRequest, typeof module, typeof Deno, typeof Bun].join(","))`)
	if res.Err != nil || res.Output != strings.Repeat("undefined,", 8)+"undefined" {
		t.Fatalf("%+v", res)
	}
	res = run(t, `tools.x = 1; text(Object.isFrozen(tools), typeof tools.x)`)
	if res.Output != "true undefined" {
		t.Fatalf("%q", res.Output)
	}
}

func TestSyntaxErrorPointsIntoTheScript(t *testing.T) {
	res := run(t, "text(1)\nlet = = 2")
	if res.Err == nil || res.Err.Reason != codemode.ReasonScript || res.Err.Line != 2 {
		t.Fatalf("%+v", res.Err)
	}
	res = run(t, `nope()`)
	if res.Err == nil || res.Err.Line != 1 || res.Err.Column != 5 { // goja points at the call
		t.Fatalf("%+v", res.Err)
	}
}

func goroutinesSettle(t *testing.T, before int) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for runtime.NumGoroutine() > before {
		if time.Now().After(deadline) {
			t.Fatalf("goroutines %d, before %d", runtime.NumGoroutine(), before)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func TestEndlessLoopTimesOutUncaught(t *testing.T) {
	before := runtime.NumGoroutine()
	lim := codemode.DefaultLimits()
	lim.Timeout = 200 * time.Millisecond
	started := time.Now()
	res := codemode.Run(context.Background(), `try { while (true) {} } catch (e) {} finally { text("finally") }; text("after")`, nil, lim, codemode.Hooks{})
	if res.Err == nil || res.Err.Reason != codemode.ReasonTimeout || res.Output != "" {
		t.Fatalf("%+v", res)
	}
	if time.Since(started) > 2*time.Second {
		t.Fatalf("took %s", time.Since(started))
	}
	goroutinesSettle(t, before)
}

func TestCancelStopsAtOnce(t *testing.T) {
	before := runtime.NumGoroutine()
	ctx, cancel := context.WithCancel(context.Background())
	time.AfterFunc(100*time.Millisecond, cancel)
	started := time.Now()
	res := codemode.Run(ctx, `for (;;) { try { for(;;){} } catch (e) { text("caught") } }`, nil, codemode.DefaultLimits(), codemode.Hooks{})
	if res.Err == nil || res.Err.Reason != codemode.ReasonCancelled || res.Output != "" {
		t.Fatalf("%+v", res)
	}
	if d := time.Since(started); d > time.Second {
		t.Fatalf("took %s", d)
	}
	goroutinesSettle(t, before)
}

func TestCancelWhileAToolWaits(t *testing.T) {
	before := runtime.NumGoroutine()
	ctx, cancel := context.WithCancel(context.Background())
	slow := codemode.Func{Name: "slow", Call: func(ctx context.Context, _ json.RawMessage) (any, error) {
		cancel()
		<-ctx.Done() // a tool that follows ctx returns once it ends
		return nil, ctx.Err()
	}}
	res := codemode.Run(ctx, `try { tools.slow({}) } catch (e) { text("caught") }; text("after")`, []codemode.Func{slow}, codemode.DefaultLimits(), codemode.Hooks{})
	if res.Err == nil || res.Err.Reason != codemode.ReasonCancelled || res.Output != "" {
		t.Fatalf("%+v", res)
	}
	goroutinesSettle(t, before)
}

func TestCallLimitCannotBeCaught(t *testing.T) {
	n := 0
	res := run(t, `try { for (;;) tools.x({}) } catch (e) { text("caught") } finally { tools.x({}); text("finally") }; text("after")`, counter("x", &n, 1))
	if res.Err == nil || res.Err.Reason != codemode.ReasonCallLimit || n != 64 || res.Output != "" || res.Calls["x"] != 64 {
		t.Fatalf("%+v n=%d", res, n)
	}
}

func TestOutputLimitCannotBeCaught(t *testing.T) {
	res := run(t, `try { for (;;) text("x".repeat(1000)) } catch (e) {} finally { text("finally") }; text("after")`)
	if res.Err == nil || res.Err.Reason != codemode.ReasonOutputLimit || len(res.Output) > 50<<10 || len(res.Output) < 49<<10 || strings.Contains(res.Output, "after") || strings.Contains(res.Output, "finally") {
		t.Fatalf("%v %d", res.Err, len(res.Output))
	}
	res = run(t, `for (let i = 0; i < 3000; i++) text(i)`)
	if res.Err == nil || res.Err.Reason != codemode.ReasonOutputLimit || strings.Count(res.Output, "\n")+1 != 2000 {
		t.Fatalf("%v %d", res.Err, strings.Count(res.Output, "\n"))
	}
	res = run(t, `return "y".repeat(60000)`)
	if res.Err == nil || res.Err.Reason != codemode.ReasonOutputLimit || len(res.Output) != 50<<10 {
		t.Fatalf("%v %d", res.Err, len(res.Output))
	}
}

func TestBeforeCallEndsTheScript(t *testing.T) {
	n, seen := 0, 0
	h := codemode.Hooks{BeforeCall: func(string) error {
		if seen++; seen > 1 {
			return &codemode.Failure{Reason: "owner_limit", Message: "spent"}
		}
		return nil
	}}
	res := codemode.Run(context.Background(), `for (let i = 0; i < 3; i++) { try { tools.x({}) } catch (e) { text("caught") } }; text("after")`,
		[]codemode.Func{counter("x", &n, 1)}, codemode.DefaultLimits(), h)
	if res.Err == nil || res.Err.Reason != "owner_limit" || n != 1 || res.Output != "" {
		t.Fatalf("%+v n=%d", res, n)
	}
}

func TestDeepRecursionFails(t *testing.T) {
	res := run(t, `function f(){ return f() } try { f() } catch (e) { text("caught") }`)
	if res.Err == nil || res.Err.Reason != codemode.ReasonScript {
		t.Fatalf("%+v", res)
	}
}

func TestToolsListed(t *testing.T) {
	n := 0
	f := counter("x", &n, nil)
	f.Description = "does x"
	res := run(t, `text(ALL_TOOLS)`, f)
	if res.Output != `[{"name":"x","description":"does x"}]` {
		t.Fatalf("%q", res.Output)
	}
}

func TestDeclarations(t *testing.T) {
	fns := []codemode.Func{{Name: "read_file", Description: "Read a file.",
		Params:  json.RawMessage(`{"type":"object","properties":{"path":{"type":"string","description":"Where"},"offset":{"type":"integer"},"kind":{"type":"string","enum":["a","b"]},"tags":{"type":"array","items":{"type":"string"}}},"required":["path"]}`),
		Returns: "{ content: string }"}}
	got := codemode.Declarations(fns)
	want := "declare const tools: {\n  /** Read a file. */\n  read_file(args: {\n    /** Where */\n    path: string;\n    offset?: number;\n    kind?: \"a\" | \"b\";\n    tags?: string[];\n  }): { content: string };\n};"
	if got != want {
		t.Fatalf("got\n%s\nwant\n%s", got, want)
	}
	if codemode.Declarations(fns) != got {
		t.Fatal("not the same twice")
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
	got := codemode.TypeOf(reflect.TypeFor[[]v]())
	want := "{\n  id: string;\n  teamId?: string;\n  tags: string[] | null;\n  ptr: {\n    a: number;\n  } | null;\n  opt?: {\n    a: number;\n  };\n  map?: Record<string, {\n    a: number;\n  }>;\n  raw: unknown;\n  times: Record<string, boolean[] | null> | null;\n}[]"
	if got != want {
		t.Fatalf("got\n%s\nwant\n%s", got, want)
	}
}

func TestLogKeepsNoContent(t *testing.T) {
	var buf bytes.Buffer
	z := zerolog.New(&buf)
	n := 0
	res := run(t, `const SECRET_MARKER = "sk-SECRET_MARKER"; tools.x({key: SECRET_MARKER}); text(SECRET_MARKER); throw new Error(SECRET_MARKER)`, counter("x", &n, "SECRET_MARKER"))
	codemode.Log(z, res).Str("source", "step").Send()
	ok := run(t, `text("SECRET_MARKER")`)
	codemode.Log(z, ok).Send()
	out := buf.String()
	if strings.Contains(out, "SECRET_MARKER") {
		t.Fatalf("log has content: %s", out)
	}
	for _, want := range []string{`"message":"codemode_failed"`, `"reason":"script_error"`, `"tools":"x:1"`, `"calls":1`, `"line":1`, `"message":"codemode_done"`, `"out_bytes":13`, `"out_lines":1`, `"ms":`} {
		if !strings.Contains(out, want) {
			t.Fatalf("log lacks %s: %s", want, out)
		}
	}
}

// guarded runs body in a child test process that is killed after a hard limit, so a sandbox that does not stop shows
// as a failure instead of hanging the tests.
func guarded(t *testing.T, body func(t *testing.T)) {
	t.Helper()
	if os.Getenv("CODEMODE_GUARDED") == t.Name() {
		body(t)
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
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

// What the script returned or threw is shown while the run is still watched: code that runs then (toJSON, toString)
// cannot outlast the time limit, nor stopping.
func TestShowingTheResultIsStillWatched(t *testing.T) {
	guarded(t, func(t *testing.T) {
		lim := codemode.DefaultLimits()
		lim.Timeout = 200 * time.Millisecond
		for _, code := range []string{
			`text("before"); return {toJSON() { while (true) {} }}`,
			`text("before"); return {a: {toJSON() { try { for (;;) {} } finally { text("finally") } }}}`,
			`text("before"); throw {toString() { while (true) {} }}`,
			`text("before"); throw {toString() { try { for (;;) {} } catch (e) { return "caught" } }}`,
			`text("before"); return function f() {}`, // shown with String, after Function.prototype.toString is replaced below
		} {
			if strings.Contains(code, "function f") {
				code = `Function.prototype.toString = function () { for (;;) {} }; ` + code
			}
			before := runtime.NumGoroutine()
			started := time.Now()
			res := codemode.Run(context.Background(), code, nil, lim, codemode.Hooks{})
			if res.Err == nil || res.Err.Reason != codemode.ReasonTimeout || res.Output != "before" {
				t.Fatalf("%s: %+v", code, res)
			}
			if d := time.Since(started); d > 2*time.Second {
				t.Fatalf("%s: took %s", code, d)
			}
			goroutinesSettle(t, before)
		}

		before := runtime.NumGoroutine()
		ctx, cancel := context.WithCancel(context.Background())
		time.AfterFunc(100*time.Millisecond, cancel)
		started := time.Now()
		var n int
		res := codemode.Run(ctx, `return {toJSON() { tools.c({}); for (;;) {} }}`, []codemode.Func{counter("c", &n, 1)}, codemode.DefaultLimits(), codemode.Hooks{})
		if res.Err == nil || res.Err.Reason != codemode.ReasonCancelled || res.Output != "" || n != 1 {
			t.Fatalf("%+v", res)
		}
		if d := time.Since(started); d > time.Second {
			t.Fatalf("took %s", d)
		}
		goroutinesSettle(t, before)

		// Limits met while showing the result end the run the same way.
		res = codemode.Run(context.Background(), `return {toJSON() { for (;;) text("x".repeat(1000)) }}`, nil, codemode.DefaultLimits(), codemode.Hooks{})
		if res.Err == nil || res.Err.Reason != codemode.ReasonOutputLimit || len(res.Output) > 50<<10 {
			t.Fatalf("%v %d", res.Err, len(res.Output))
		}
	})
}

// A thrown value that cannot be turned into text still fails as the script's error.
func TestThrownValueThatCannotBeShown(t *testing.T) {
	guarded(t, func(t *testing.T) {
		res := run(t, `throw {toString() { throw new Error("no") }}`)
		if res.Err == nil || res.Err.Reason != codemode.ReasonScript || res.Err.Message != "the script threw what cannot be shown" {
			t.Fatalf("%+v", res.Err)
		}
		res = run(t, `throw {toString() { return "custom" }}`)
		if res.Err == nil || res.Err.Reason != codemode.ReasonScript || res.Err.Message != "custom" {
			t.Fatalf("%+v", res.Err)
		}
		res = run(t, `return {toJSON() { throw new TypeError("bad") }}`)
		if res.Err == nil || res.Err.Reason != codemode.ReasonScript || res.Err.Message != "TypeError: bad" {
			t.Fatalf("%+v", res.Err)
		}
	})
}

// The script cannot change how its output and arguments are written by replacing JSON or String.
func TestReplacedBuiltinsAreNotUsed(t *testing.T) {
	guarded(t, func(t *testing.T) {
		var got string
		echo := codemode.Func{Name: "echo", Call: func(_ context.Context, raw json.RawMessage) (any, error) {
			got = string(raw)
			return map[string]any{"back": 1}, nil
		}}
		res := run(t, `
JSON.stringify = function () { for (;;) {} };
JSON.parse = function () { for (;;) {} };
String = function () { for (;;) {} };
text({a: 1});
text(tools.echo({p: "x"}).back);
return {b: 2, toJSON() { return {c: 3} }};`, echo)
		if res.Err != nil || res.Output != "{\"a\":1}\n1\n{\"c\":3}" || got != `{"p":"x"}` {
			t.Fatalf("%+v %q", res, got)
		}
	})
}

// However much the script throws, the message stays short.
func TestFailureMessageIsShort(t *testing.T) {
	res := run(t, `throw "x\n".repeat(100000) + "y".repeat(1000000)`)
	if res.Err == nil || strings.Count(res.Err.Message, "\n") >= 20 || len(res.Err.Message) > 2<<10 {
		t.Fatalf("%d bytes", len(res.Err.Message))
	}
	if got := codemode.Fit("é"+strings.Repeat("a\n", 5), 3, 4); got != "éa\n" {
		t.Fatalf("%q", got)
	}
}
