package usecase

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"slices"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/rs/zerolog"

	"github.com/yanun0323/Team-Work/internal/adapter"
	"github.com/yanun0323/Team-Work/internal/model"
	"github.com/yanun0323/Team-Work/internal/model/enum"
	"github.com/yanun0323/Team-Work/internal/semantic"
	"github.com/yanun0323/Team-Work/internal/usecase/tools"
)

// stepsFake answers each model call with the next of its steps, given what the call was sent.
type stepsFake struct {
	mu    sync.Mutex
	steps []func(model.ModelRequest) (model.ModelReply, error)
	seen  []model.ModelRequest
}

func (f *stepsFake) Complete(_ context.Context, req model.ModelRequest, _ func(string)) (model.ModelReply, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	req.Tools = slices.Clone(req.Tools)
	req.Messages = slices.Clone(req.Messages)
	f.seen = append(f.seen, req)
	if len(f.steps) == 0 {
		return model.ModelReply{Content: []model.Block{{Type: enum.BlockText, Text: "done"}}}, nil
	}
	next := f.steps[0]
	f.steps = f.steps[1:]
	return next(req)
}
func (f *stepsFake) Models(context.Context) ([]model.ModelSpec, error) { return nil, nil }

func toolCall(id, name string, args any) model.Block {
	raw, _ := json.Marshal(args)
	return model.Block{Type: enum.BlockToolCall, ID: id, Name: name, Args: raw}
}

func calls(blocks ...model.Block) model.ModelReply { return model.ModelReply{Content: blocks} }

func offers(req model.ModelRequest, name string) bool {
	return slices.ContainsFunc(req.Tools, func(s model.ToolSpec) bool { return s.Name == name })
}

func lastResults(req model.ModelRequest) []model.Block {
	for i := len(req.Messages) - 1; i >= 0; i-- {
		if m := req.Messages[i]; len(m.Content) > 0 && m.Content[0].Type == enum.BlockToolResult {
			return m.Content
		}
	}
	return nil
}

func codeModeEngine() *Engine {
	return &Engine{w: model.NewWorld(), log: zerolog.Nop(), dirty: map[string]bool{}, runs: map[string]*run{}, clock: func() float64 { return 1 }}
}

func (e *Engine) setCodeMode(on bool) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.w.Preferences.CodeMode = on
}

// readTurn is a turn with read_file, and write_file, which exec must never reach.
func readTurn(e *Engine, provider adapter.Provider, cwd string) *turn {
	list := []adapter.Tool{tools.Read{}, tools.Write{}}
	tr := &turn{provider: provider, tools: map[string]adapter.Tool{}, cwd: cwd,
		onStart: func() {}, onText: func(string) {}, onReply: func(model.ModelReply) bool { return true }, onTool: func(model.Block) {}, onResults: func(model.Message) {}}
	for _, tool := range list {
		tr.req.Tools = append(tr.req.Tools, tool.Spec())
		tr.tools[tool.Spec().Name] = tool
	}
	e.codeMode(tr, codeModeSource{Kind: "step"})
	return tr
}

// The setting counts from the next model call: within one turn, on is offered and runs, off is neither offered nor
// run, and every try at the model (a retry, a call after compacting) reads it again.
func TestExecFollowsTheSettingAtEachModelCall(t *testing.T) {
	cwd := t.TempDir()
	if err := os.WriteFile(filepath.Join(cwd, "a.txt"), []byte("one\ntwo\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	e := codeModeEngine()
	script := toolCall("x1", toolExec, map[string]string{"code": `const f = tools.read_file({path: "a.txt"}); text(f.totalLines, typeof tools.write_file)`})
	fake := &stepsFake{steps: []func(model.ModelRequest) (model.ModelReply, error){
		func(model.ModelRequest) (model.ModelReply, error) {
			e.setCodeMode(true)
			return calls(toolCall("r1", "read_file", map[string]string{"path": "a.txt"})), nil
		},
		func(model.ModelRequest) (model.ModelReply, error) {
			// turned off while the model answers: the exec it sent runs, as this call offered it
			e.setCodeMode(false)
			return calls(script), nil
		},
		func(model.ModelRequest) (model.ModelReply, error) {
			return calls(toolCall("x2", toolExec, map[string]string{"code": `text(1)`})), nil
		},
		func(model.ModelRequest) (model.ModelReply, error) {
			e.setCodeMode(true)
			return model.ModelReply{}, model.Errorf(model.CodeUnavailable, "busy")
		},
		func(model.ModelRequest) (model.ModelReply, error) {
			e.setCodeMode(false)
			return model.ModelReply{}, model.Errorf(model.CodeContextOverflow, "too long")
		},
	}}
	tr := readTurn(e, fake, cwd)
	if offers(tr.req, toolExec) || tr.tools[toolExec] != nil {
		t.Fatal("offered while off")
	}
	tr.compact = func(context.Context) ([]model.Message, bool) {
		e.setCodeMode(true)
		return tr.req.Messages, true
	}
	tr.compactAt = 1 << 30
	old := retryDelay
	retryDelay = time.Millisecond
	defer func() { retryDelay = old }()
	if _, err := tr.run(context.Background()); err != nil {
		t.Fatal(err)
	}
	seen := fake.seen
	want := []bool{false, true, false, false, true, true}
	if len(seen) != len(want) {
		t.Fatalf("%d calls", len(seen))
	}
	for i, req := range seen {
		if offers(req, toolExec) != want[i] {
			t.Fatalf("call %d offers exec: %v", i+1, !want[i])
		}
	}
	if got := lastResults(seen[2]); len(got) != 1 || got[0].IsError || got[0].Text != "2 undefined" {
		t.Fatalf("exec while on: %+v", got)
	}
	if got := lastResults(seen[3]); len(got) != 1 || !got[0].IsError || got[0].Text != "unknown tool exec" {
		t.Fatalf("exec after off: %+v", got)
	}
	// the other tools are offered as they were, and the list is never shared with the next call
	if !offers(seen[0], "read_file") || !offers(seen[5], "write_file") || len(seen[1].Tools) != 3 || len(seen[2].Tools) != 2 {
		t.Fatalf("%d %d", len(seen[1].Tools), len(seen[2].Tools))
	}
}

// exec lists only what may be called from it, and the same tools always read the same.
func TestExecDeclaresOnlyItsReadingTools(t *testing.T) {
	e := codeModeEngine()
	e.setCodeMode(true)
	tr := readTurn(e, &stepsFake{}, t.TempDir())
	spec := tr.req.Tools[len(tr.req.Tools)-1]
	if spec.Name != toolExec || !strings.Contains(spec.Description, "  read_file(args: {") || strings.Contains(spec.Description, "write_file") {
		t.Fatal(spec.Description)
	}
	if again := readTurn(e, &stepsFake{}, t.TempDir()); again.req.Tools[len(again.req.Tools)-1].Description != spec.Description {
		t.Fatal("the same tools read differently")
	}
	// nothing to call from it: no exec at all
	none := &turn{tools: map[string]adapter.Tool{"write_file": tools.Write{}}, req: model.ModelRequest{Tools: []model.ToolSpec{tools.Write{}.Spec()}}}
	e.codeMode(none, codeModeSource{})
	if none.prepare != nil || offers(none.req, toolExec) {
		t.Fatal("exec with nothing to call")
	}
}

var declared = regexp.MustCompile(`(?m)^  ([a-z_]+)\(args`)

func execNamesOf(req model.ModelRequest) []string {
	for _, s := range req.Tools {
		if s.Name == toolExec {
			var out []string
			for _, m := range declared.FindAllStringSubmatch(s.Description, -1) {
				out = append(out, m[1])
			}
			return out
		}
	}
	return nil
}

// A meeting the owner holds reads only; its participants get exec over what they read, the chair too.
func TestMeetingTurnsGetExec(t *testing.T) {
	e := codeModeEngine()
	for _, chair := range []bool{false, true} {
		in := &meetingRun{taskID: "t1", subID: "s1", key: "k", allowed: []enum.Tool{enum.ToolReadFile}, chair: chair, r: &run{}}
		if tr := e.meetingTurn(in); offers(tr.req, toolExec) {
			t.Fatal("offered while off")
		}
		e.setCodeMode(true)
		tr := e.meetingTurn(in)
		if got := execNamesOf(tr.req); !slices.Equal(got, []string{"read_file"}) {
			t.Fatalf("chair %v: %v", chair, got)
		}
		e.setCodeMode(false)
	}
}

// What the user said while exec ran is read right after its result, as after any tool.
func TestSteerFollowsExec(t *testing.T) {
	e := codeModeEngine()
	e.setCodeMode(true)
	fake := &stepsFake{steps: []func(model.ModelRequest) (model.ModelReply, error){
		func(model.ModelRequest) (model.ModelReply, error) {
			return calls(toolCall("x", toolExec, map[string]string{"code": `text("ran")`})), nil
		},
	}}
	tr := readTurn(e, fake, t.TempDir())
	steered := 0
	tr.steer = func() []model.Message {
		steered++
		return []model.Message{userText("also look at b")}
	}
	if _, err := tr.run(context.Background()); err != nil {
		t.Fatal(err)
	}
	msgs := fake.seen[1].Messages
	if steered != 1 || len(msgs) < 2 || msgs[len(msgs)-2].Content[0].Text != "ran" || msgs[len(msgs)-1].Content[0].Text != "also look at b" {
		t.Fatalf("%d %+v", steered, msgs)
	}
}

// Semantic search comes into exec only while it is on, and gives its result as data.
func TestExecSemanticSearchOnlyWhileOn(t *testing.T) {
	if runtime.GOOS != "darwin" {
		t.Skip("macOS only")
	}
	cwd := t.TempDir()
	if err := os.WriteFile(filepath.Join(cwd, "toucan.go"), []byte("package main\n// toucan feeding schedule\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if out, err := exec.Command("git", "-C", cwd, "init", "-q").CombinedOutput(); err != nil {
		t.Fatalf("%v %s", err, out)
	}
	on := semantic.New(semantic.Options{DataDir: t.TempDir(), Log: zerolog.Nop(), BaseURL: "http://127.0.0.1:1/", Retry: time.Millisecond,
		Platform: semantic.Platform{OS: "27.0", Arm64: true, Helper: "/nonexistent"}})
	on.Start(true, nil)
	t.Cleanup(on.Close)
	off := semantic.New(semantic.Options{DataDir: t.TempDir(), Log: zerolog.Nop(), Platform: semantic.Platform{OS: "27.0", Arm64: true, Helper: "/h"}})
	off.Start(false, nil)

	e := codeModeEngine()
	e.setCodeMode(true)
	for _, c := range []struct {
		service *semantic.Service
		want    []string
	}{{nil, []string{"read_file"}}, {off, []string{"read_file"}}, {on, []string{"read_file", "semantic_search"}}} {
		fake := &stepsFake{steps: []func(model.ModelRequest) (model.ModelReply, error){
			func(model.ModelRequest) (model.ModelReply, error) {
				return calls(toolCall("x", toolExec, map[string]string{"code": `const r = tools.semantic_search({query: "toucan feeding"}); text(r.mode, r.results.length, r.results[0].path)`})), nil
			},
		}}
		tr := &turn{provider: fake, tools: map[string]adapter.Tool{}, cwd: cwd,
			onStart: func() {}, onText: func(string) {}, onReply: func(model.ModelReply) bool { return true }, onTool: func(model.Block) {}, onResults: func(model.Message) {}}
		for _, tool := range tools.For([]enum.Tool{enum.ToolReadFile}, tools.Env{Semantic: c.service}) {
			tr.req.Tools = append(tr.req.Tools, tool.Spec())
			tr.tools[tool.Spec().Name] = tool
		}
		e.codeMode(tr, codeModeSource{Kind: "step"})
		if got := execNamesOf(tr.req); !slices.Equal(got, c.want) {
			t.Fatalf("%v", got)
		}
		if _, err := tr.run(context.Background()); err != nil {
			t.Fatal(err)
		}
		res := lastResults(fake.seen[1])[0]
		if c.service == on && (res.IsError || res.Text != "keyword 1 toucan.go") || c.service != on && !res.IsError {
			t.Fatalf("%+v", res)
		}
	}
}

// An exec call shows what it reads and how long its script is, never the script.
func TestExecShowsWithoutItsCode(t *testing.T) {
	code := "const k = 'sk-SECRET_MARKER';\ntools.read_file({path: k}); tools['list_tasks'](); tools.nope(); tools.write_file({}); tools.read_file({})"
	raw, _ := json.Marshal(map[string]string{"code": code})
	want := "exec list_tasks, read_file (" + strconv.Itoa(len([]rune(code))) + " chars)"
	if got := toolLine(model.Block{Name: toolExec, Args: raw}); got != want {
		t.Fatalf("%q, want %q", got, want)
	}
	raw, _ = json.Marshal(map[string]string{"code": "text(1)"})
	if got := toolLine(model.Block{Name: toolExec, Args: raw}); got != "exec (7 chars)" {
		t.Fatal(got)
	}
	for _, bad := range []string{`{"code":1}`, `[]`, `{}`, `nope`} {
		if got := toolLine(model.Block{Name: toolExec, Args: json.RawMessage(bad)}); got != "exec (invalid arguments)" {
			t.Fatal(got)
		}
	}
	// a merge's log goes by the same line
	if got := toolLine(model.Block{Name: "read_file", Args: json.RawMessage(`{"path":"a"}`)}); got != `read_file {"path":"a"}` {
		t.Fatal(got)
	}
}

// exec with arguments that are no script fails plainly, as invalid_arguments.
func TestExecRefusesWhatIsNoScript(t *testing.T) {
	e := codeModeEngine()
	e.setCodeMode(true)
	tr := readTurn(e, &stepsFake{}, t.TempDir())
	for _, raw := range []string{`{}`, `{"code":""}`, `{"code":3}`, `[]`} {
		res := tr.tools[toolExec].Run(context.Background(), tr.cwd, json.RawMessage(raw))
		if !res.IsError || !strings.HasPrefix(res.Text, "exec failed (invalid_arguments): ") {
			t.Fatalf("%s: %+v", raw, res)
		}
	}
	res := tr.tools[toolExec].Run(context.Background(), tr.cwd, json.RawMessage(`{"code":"text(1)\nnope()"}`))
	if !res.IsError || res.Text != "exec failed (script_error): ReferenceError: nope is not defined (line 2, column 5)\nOutput before the failure:\n1" {
		t.Fatalf("%q", res.Text)
	}
	res = tr.tools[toolExec].Run(context.Background(), tr.cwd, json.RawMessage(`{"code":"1"}`))
	if res.IsError || res.Text != "(no output)" {
		t.Fatalf("%+v", res)
	}
}

// A failed exec, its message and the output before it together, still fits what a tool may hand back.
func TestExecFailureFitsTheLimits(t *testing.T) {
	e := codeModeEngine()
	e.setCodeMode(true)
	tr := readTurn(e, &stepsFake{}, t.TempDir())
	for _, c := range []struct{ code, starts string }{
		{`for (let i = 0; i < 1999; i++) text('a'.repeat(20)); throw 'x\n'.repeat(100000)`, "exec failed (script_error): x\nx\n"},
		{`for (let i = 0; i < 50; i++) text('b'.repeat(1000)); throw 'y'.repeat(1000000)`, "exec failed (script_error): yyy"},
		{`for (;;) text('c'.repeat(1000))`, "exec failed (output_limit): "},
		{`for (;;) text('d')`, "exec failed (output_limit): "},
	} {
		raw, _ := json.Marshal(map[string]string{"code": c.code})
		res := tr.tools[toolExec].Run(context.Background(), tr.cwd, raw)
		if !res.IsError || !strings.HasPrefix(res.Text, c.starts) || !strings.Contains(res.Text, "\nOutput before the failure:\n") {
			t.Fatalf("%s: %.200q", c.code, res.Text)
		}
		if n := strings.Count(res.Text, "\n") + 1; n > 2000 || len(res.Text) > 50<<10 {
			t.Fatalf("%s: %d lines, %d bytes", c.code, n, len(res.Text))
		}
	}
}
