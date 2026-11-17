package hooks

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// runner writes hooks.json with groups on one event.
func runner(t *testing.T, ev Event, groups ...map[string]any) *Runner {
	t.Helper()
	raw, err := json.Marshal(map[string]any{"hooks": map[Event]any{ev: groups}})
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(t.TempDir(), "hooks.json")
	if err := os.WriteFile(path, raw, 0o600); err != nil {
		t.Fatal(err)
	}
	return &Runner{Path: path}
}

func cmd(matcher string, commands ...string) map[string]any {
	var hs []map[string]any
	for _, c := range commands {
		hs = append(hs, map[string]any{"type": "command", "command": c})
	}
	return map[string]any{"matcher": matcher, "hooks": hs}
}

func pre(t *testing.T) Input {
	return Input{SessionID: "s1", Cwd: t.TempDir(), HookEventName: PreToolUse, ToolName: "Bash", ToolInput: json.RawMessage(`{"command":"rm -rf /"}`)}
}

func TestExitTwoBlocksWithStderr(t *testing.T) {
	r := runner(t, PreToolUse, cmd("Bash", `grep -q 'rm -rf' && { echo "no deleting" >&2; exit 2; }; exit 0`))
	got := r.Run(context.Background(), pre(t), "run_command", "Bash")
	if !got.Block || got.Reason != "no deleting" {
		t.Fatalf("outcome = %+v", got)
	}
}

func TestMatcher(t *testing.T) {
	for _, tc := range []struct {
		matcher string
		want    bool
	}{
		{"", true}, {"*", true}, {"Bash", true}, {"Edit|Bash", true}, {"run_command", true}, {"Bas", false}, {"mcp__.*", false}, {"^B.*h$", true},
	} {
		ok, err := matches(tc.matcher, []string{"run_command", "Bash"})
		if err != nil || ok != tc.want {
			t.Errorf("matches(%q) = %v, %v; want %v", tc.matcher, ok, err, tc.want)
		}
	}
	if _, err := matches("(", []string{"x"}); err == nil {
		t.Error("a broken regular expression was accepted")
	}
}

func TestJSONDecisions(t *testing.T) {
	ctx := context.Background()
	deny := `echo '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"not here"}}'`
	if got := runner(t, PreToolUse, cmd("", deny)).Run(ctx, pre(t), "Bash"); !got.Block || got.Reason != "not here" {
		t.Fatalf("deny = %+v", got)
	}
	allow := `echo '{"hookSpecificOutput":{"permissionDecision":"allow","updatedInput":{"command":"ls"},"additionalContext":"rewritten"},"systemMessage":"hi user"}'`
	got := runner(t, PreToolUse, cmd("", allow)).Run(ctx, pre(t), "Bash")
	if got.Block || string(got.UpdatedInput) != `{"command":"ls"}` || len(got.Context) != 1 || got.Context[0] != "rewritten" || len(got.Notices) != 1 || got.Notices[0] != "hi user" {
		t.Fatalf("allow = %+v", got)
	}
	ask := `echo '{"hookSpecificOutput":{"permissionDecision":"ask"}}'`
	if got := runner(t, PreToolUse, cmd("", ask)).Run(ctx, pre(t), "Bash"); !got.Block {
		t.Fatalf("ask = %+v, want it not run", got)
	}
	halt := `echo '{"continue":false,"stopReason":"enough"}'`
	if got := runner(t, PostToolUse, cmd("", halt)).Run(ctx, Input{HookEventName: PostToolUse, Cwd: t.TempDir()}, "Bash"); !got.Halt || got.HaltReason != "enough" {
		t.Fatalf("halt = %+v", got)
	}
	block := `echo '{"decision":"block","reason":"tests fail"}'`
	if got := runner(t, Stop, cmd("", block)).Run(ctx, Input{HookEventName: Stop, Cwd: t.TempDir()}); !got.Block || got.Reason != "tests fail" {
		t.Fatalf("stop block = %+v", got)
	}
}

func TestPlainStdoutIsContextOnlyWherePromptsGo(t *testing.T) {
	ctx := context.Background()
	if got := runner(t, UserPromptSubmit, cmd("", "echo today is Monday")).Run(ctx, Input{HookEventName: UserPromptSubmit, Cwd: t.TempDir(), Prompt: "hi"}); len(got.Context) != 1 || got.Context[0] != "today is Monday" {
		t.Fatalf("prompt = %+v", got)
	}
	if got := runner(t, PostToolUse, cmd("", "echo ignored")).Run(ctx, Input{HookEventName: PostToolUse, Cwd: t.TempDir()}); len(got.Context) != 0 {
		t.Fatalf("post = %+v", got)
	}
}

func TestStdinCwdAndEnv(t *testing.T) {
	in := pre(t)
	out := filepath.Join(t.TempDir(), "seen")
	r := runner(t, PreToolUse, cmd("", `cat > `+out+` && pwd >> `+out+` && echo "$CLAUDE_PROJECT_DIR" >> `+out))
	r.Run(context.Background(), in, "Bash")
	raw, err := os.ReadFile(out)
	if err != nil {
		t.Fatal(err)
	}
	lines := strings.Split(strings.TrimSpace(string(raw)), "\n")
	var seen Input
	if err := json.Unmarshal([]byte(lines[0]), &seen); err != nil || seen.ToolName != "Bash" || seen.SessionID != "s1" || seen.HookEventName != PreToolUse {
		t.Fatalf("stdin = %s (%v)", lines[0], err)
	}
	real, _ := filepath.EvalSymlinks(in.Cwd)
	if got, _ := filepath.EvalSymlinks(lines[1]); got != real || lines[2] != in.Cwd {
		t.Fatalf("cwd and env = %q", lines[1:])
	}
}

func TestFailuresAndTimeoutsAreNoticesOnly(t *testing.T) {
	r := runner(t, PreToolUse, map[string]any{"hooks": []map[string]any{
		{"type": "command", "command": "echo broken >&2; exit 1"},
		{"type": "command", "command": "sleep 5", "timeout": 0.2},
		{"type": "prompt", "prompt": "skipped"},
	}})
	start := time.Now()
	got := r.Run(context.Background(), pre(t), "Bash")
	if time.Since(start) > 4*time.Second {
		t.Fatal("the timeout did not stop the hook")
	}
	if got.Block || len(got.Notices) != 2 || !strings.Contains(got.Notices[0], "code 1: broken") || !strings.Contains(got.Notices[1], "timed out") {
		t.Fatalf("outcome = %+v", got)
	}
}

func TestNoFileAndDisabled(t *testing.T) {
	r := &Runner{Path: filepath.Join(t.TempDir(), "hooks.json")}
	if r.Has(PreToolUse) || len(r.Run(context.Background(), pre(t)).Notices) != 0 {
		t.Fatal("a missing file ran something")
	}
	if err := os.WriteFile(r.Path, []byte(`{"disableAllHooks":true,"hooks":{"PreToolUse":[{"hooks":[{"type":"command","command":"exit 2"}]}]}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if r.Has(PreToolUse) || r.Run(context.Background(), pre(t), "Bash").Block {
		t.Fatal("disabled hooks ran")
	}
	if err := os.WriteFile(r.Path, []byte(`{`), 0o600); err != nil {
		t.Fatal(err)
	}
	if got := r.Run(context.Background(), pre(t), "Bash"); len(got.Notices) != 1 {
		t.Fatalf("broken file = %+v", got)
	}
	var none *Runner
	if none.Has(PreToolUse) || none.Run(context.Background(), pre(t)).Block {
		t.Fatal("a nil runner ran something")
	}
}
