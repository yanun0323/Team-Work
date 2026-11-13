package tools

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/rs/zerolog"

	"github.com/yanun0323/Team-Work/internal/model/enum"
	"github.com/yanun0323/Team-Work/internal/semantic"
)

// onService is semantic search turned on, with a model that cannot be downloaded: searches are keyword only.
func onService(t *testing.T) *semantic.Service {
	t.Helper()
	if runtime.GOOS != "darwin" {
		t.Skip("macOS only")
	}
	s := semantic.New(semantic.Options{DataDir: t.TempDir(), Log: zerolog.Nop(), BaseURL: "http://127.0.0.1:1/", Retry: time.Millisecond,
		Platform: semantic.Platform{OS: "27.0", Arm64: true, Helper: "/nonexistent"}})
	s.Start(true, nil)
	t.Cleanup(s.Close)
	return s
}

func toolNames(allowed []enum.Tool, env Env) []string {
	var out []string
	for _, t := range For(allowed, env) {
		out = append(out, t.Spec().Name)
	}
	return out
}

func TestSemanticSearchComesWithReadFileWhileOn(t *testing.T) {
	all := []enum.Tool{enum.ToolReadFile, enum.ToolWriteFile, enum.ToolRunCommand}
	if got := toolNames(all, Env{}); slices.Contains(got, "semantic_search") {
		t.Fatalf("no service: %v", got)
	}
	off := semantic.New(semantic.Options{DataDir: t.TempDir(), Log: zerolog.Nop(), Platform: semantic.Platform{OS: "27.0", Arm64: true, Helper: "/h"}})
	off.Start(false, nil)
	if got := toolNames(all, Env{Semantic: off}); slices.Contains(got, "semantic_search") {
		t.Fatalf("off: %v", got)
	}
	unsupported := semantic.New(semantic.Options{DataDir: t.TempDir(), Log: zerolog.Nop(), Platform: semantic.Platform{OS: "13.3", Helper: "/h"}})
	unsupported.Start(true, nil)
	if got := toolNames(all, Env{Semantic: unsupported}); slices.Contains(got, "semantic_search") {
		t.Fatalf("unsupported: %v", got)
	}
	on := onService(t)
	if got := toolNames(all, Env{Semantic: on}); !slices.Contains(got, "semantic_search") {
		t.Fatalf("on: %v", got)
	}
	if got := toolNames([]enum.Tool{enum.ToolWriteFile, enum.ToolRunCommand, enum.ToolWebSearch}, Env{Semantic: on}); slices.Contains(got, "semantic_search") {
		t.Fatalf("without read_file: %v", got)
	}
	// turned off: the tool leaves new lists, and one a running Claude Code kept says so
	tool := For(all, Env{Semantic: on})[1]
	on.Disable()
	if got := toolNames(all, Env{Semantic: on}); slices.Contains(got, "semantic_search") {
		t.Fatalf("after turning off: %v", got)
	}
	if r := tool.Run(context.Background(), t.TempDir(), json.RawMessage(`{"query":"x"}`)); !r.IsError || !strings.Contains(r.Text, "grep") {
		t.Fatalf("%+v", r)
	}
}

func TestSemanticSearchToolFallsBackToKeywords(t *testing.T) {
	on := onService(t)
	dir := t.TempDir()
	exec.Command("git", "init", "-q", dir).Run()
	os.WriteFile(filepath.Join(dir, "a.go"), []byte("package a\n// toucan feeding schedule\n"), 0o644)
	tool := SemanticSearch{Service: on, Task: "task-1", Replica: "r"}
	r := tool.Run(context.Background(), dir, json.RawMessage(`{"query":"toucan schedule","limit":5}`))
	if r.IsError {
		t.Fatal(r.Text)
	}
	var res semantic.Result
	if err := json.Unmarshal([]byte(r.Text), &res); err != nil {
		t.Fatal(err)
	}
	if res.Mode != "keyword" || res.Reason == "" || len(res.Results) != 1 || res.Results[0].Path != "a.go" || res.Results[0].StartLine != 1 || res.Results[0].EndLine != 2 {
		t.Fatalf("%+v", res)
	}
	for _, bad := range []string{`{"query":""}`, `{"query":"x","limit":50}`, `{"query":3}`} {
		if r := tool.Run(context.Background(), dir, json.RawMessage(bad)); !r.IsError {
			t.Fatalf("%s: %+v", bad, r)
		}
	}
	if r := tool.Run(context.Background(), "", json.RawMessage(`{"query":"x"}`)); !r.IsError {
		t.Fatal("searched with no working directory")
	}
}

func TestWritesAreReported(t *testing.T) {
	dir := t.TempDir()
	var heard []string
	changed := func(path, source string) { heard = append(heard, source+":"+filepath.Base(path)) }
	ctx := context.Background()
	if r := (Write{Changed: changed}).Run(ctx, dir, args(map[string]string{"path": "a.txt", "content": "one two"})); r.IsError {
		t.Fatal(r.Text)
	}
	if r := (Edit{Changed: changed}).Run(ctx, dir, args(map[string]any{"path": "a.txt", "edits": []map[string]string{{"old": "one", "new": "1"}}})); r.IsError {
		t.Fatal(r.Text)
	}
	// a failed edit reports nothing
	if r := (Edit{Changed: changed}).Run(ctx, dir, args(map[string]any{"path": "a.txt", "edits": []map[string]string{{"old": "missing", "new": "1"}}})); !r.IsError {
		t.Fatal("edited")
	}
	if r := (Command{Changed: changed}).Run(ctx, dir, args(map[string]string{"command": "echo hi > b.txt"})); r.IsError {
		t.Fatal(r.Text)
	}
	want := []string{"write_file:a.txt", "edit_file:a.txt", "run_command:" + filepath.Base(dir)}
	if !slices.Equal(heard, want) {
		t.Fatalf("%v", heard)
	}
}
