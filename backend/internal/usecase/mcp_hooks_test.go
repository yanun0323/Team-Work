package usecase_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	sdk "github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/yanun0323/Team-Work/internal/model"
	"github.com/yanun0323/Team-Work/internal/model/enum"
	"github.com/yanun0323/Team-Work/internal/usecase"
)

// mcpServer is a remote MCP server with echo, offered directly, and secret, which mcp.json leaves to scripts.
func mcpServer(t *testing.T) string {
	t.Helper()
	s := sdk.NewServer(&sdk.Implementation{Name: "docs", Version: "1"}, &sdk.ServerOptions{Instructions: "Product docs"})
	sdk.AddTool(s, &sdk.Tool{Name: "echo", Description: "Say it back"},
		func(_ context.Context, _ *sdk.CallToolRequest, in struct {
			Text string `json:"text"`
		}) (*sdk.CallToolResult, any, error) {
			return &sdk.CallToolResult{Content: []sdk.Content{&sdk.TextContent{Text: "echo: " + in.Text}}}, nil, nil
		})
	sdk.AddTool(s, &sdk.Tool{Name: "secret", Description: "The secret"},
		func(context.Context, *sdk.CallToolRequest, struct{}) (*sdk.CallToolResult, any, error) {
			return &sdk.CallToolResult{Content: []sdk.Content{&sdk.TextContent{Text: "SECRET_42"}}}, nil, nil
		})
	srv := httptest.NewServer(sdk.NewStreamableHTTPHandler(func(*http.Request) *sdk.Server { return s }, nil))
	t.Cleanup(srv.Close)
	return srv.URL
}

func writeJSON(t *testing.T, path string, v any) {
	t.Helper()
	if err := os.WriteFile(path, mustJSON(v), 0o600); err != nil {
		t.Fatal(err)
	}
}

func offers(req model.ModelRequest, name string) bool {
	return slices.ContainsFunc(req.Tools, func(s model.ToolSpec) bool { return s.Name == name })
}

func toolSpec(req model.ModelRequest, name string) model.ToolSpec {
	for _, s := range req.Tools {
		if s.Name == name {
			return s
		}
	}
	return model.ToolSpec{}
}

func chatResult(t *testing.T, r *rig, chatID string) model.Block {
	t.Helper()
	var out model.Block
	for _, req := range r.fake.requests() {
		if req.Session == chatID && lastIsResult(req) {
			out = execResultOf(req)
		}
	}
	return out
}

// An employee whose blueprint lets them run commands gets the servers of mcp.json in the data folder: a tool set to
// direct like any other, and the rest, by default, only through exec, which the run then has with the script tool's
// setting off. One who may not run commands gets none, and no exec for them.
func TestMCPToolsReachWhoMayRunCommands(t *testing.T) {
	t.Parallel()
	url := mcpServer(t) // first, so it closes after the engine that connects to it
	r := newRig(t, func(req model.ModelRequest) (model.ModelReply, error) {
		switch {
		case lastIsResult(req):
			return say("done"), nil
		case hasExec(req):
			return call("exec", map[string]string{"code": `text(await tools.mcp__docs__secret({}) + "|" + await tools.mcp__docs__echo({text: "hi"}))`}), nil
		}
		return say("nothing to call"), nil
	})
	writeJSON(t, filepath.Join(r.data, "mcp.json"), map[string]any{"mcpServers": map[string]any{
		"docs": map[string]any{"url": url, "toolExposure": map[string]string{"echo": "direct"}},
	}})
	bp, err := r.e.CreateBlueprint(model.Blueprint{Name: "Reader", Prompt: "你只讀", Tools: []enum.Tool{enum.ToolReadFile}})
	if err != nil {
		t.Fatal(err)
	}
	reader, err := r.e.Hire(usecase.NewReplica{TeamID: r.team.ID, BlueprintID: bp.ID, Name: "Reader", Model: "fake"})
	if err != nil {
		t.Fatal(err)
	}
	chat := func(who string) string {
		c, err := r.e.CreateChat(usecase.NewChat{TeamID: r.team.ID, ReplicaID: who, Text: "查"})
		if err != nil {
			t.Fatal(err)
		}
		r.wait("the chat", chatDone(c.ID))
		return c.ID
	}

	// the owner's blueprint runs commands; the script tool's setting is off
	if err := r.e.UpdatePreferences(map[string]json.RawMessage{"codeMode": json.RawMessage(`false`)}); err != nil {
		t.Fatal(err)
	}
	theirs := chat(r.owner.ID)
	for _, req := range r.fake.requests() {
		if req.Session != theirs {
			continue
		}
		if offers(req, "mcp__docs__secret") || !offers(req, "mcp__docs__echo") || !hasExec(req) {
			t.Fatalf("want echo offered directly, secret only to scripts and exec on: %s", mustJSON(req.Tools))
		}
		if exec := toolSpec(req, "exec").Description; !strings.Contains(exec, "- docs (1 tools, named mcp__docs__…): Product docs") {
			t.Fatalf("exec does not tell of the server: %s", exec)
		}
	}
	if res := chatResult(t, r, theirs); res.Name != "exec" || !strings.Contains(res.Text, "SECRET_42|echo: hi") {
		t.Fatalf("exec = %+v", res)
	}
	if r.world().Preferences.CodeMode {
		t.Fatal("the script tool's setting was changed")
	}

	mine := chat(reader.ID)
	for _, req := range r.fake.requests() {
		if req.Session == mine && (strings.Contains(string(mustJSON(req.Tools)), "mcp__") || hasExec(req)) {
			t.Fatal("MCP tools or exec offered to an employee who may not run commands")
		}
	}
}

// The hooks in hooks.json in the data folder run on a chat's work: SessionStart's words reach the model, PreToolUse
// blocks a command and rewrites a write, PostToolUse adds to a result, Stop sends the model back once, and
// UserPromptSubmit keeps a message from the model.
func TestHooksRunOnAChat(t *testing.T) {
	t.Parallel()
	r := newRig(t, func(req model.ModelRequest) (model.ModelReply, error) {
		last := req.Messages[len(req.Messages)-1]
		switch {
		case lastIsResult(req) && execResultOf(req).Name == "run_command":
			return call("write_file", map[string]string{"path": "orig.txt", "content": "x"}), nil
		case lastIsResult(req):
			return say("done"), nil
		case strings.Contains(last.Content[0].Text, "A Stop hook"):
			return say("tests ok"), nil
		}
		return call("run_command", map[string]string{"command": "echo forbidden > bad.txt"}), nil
	})
	hook := func(matcher, command string) map[string]any {
		return map[string]any{"matcher": matcher, "hooks": []map[string]any{{"type": "command", "command": command}}}
	}
	writeJSON(t, filepath.Join(r.data, "hooks.json"), map[string]any{"hooks": map[string]any{
		"SessionStart":     []any{hook("startup", "echo session context here")},
		"UserPromptSubmit": []any{hook("", `grep -q blockme && { echo "not allowed" >&2; exit 2; }; exit 0`)},
		"PreToolUse": []any{
			hook("Bash", `grep -q forbidden && { echo "no forbidden" >&2; exit 2; }; exit 0`),
			hook("Write", `echo '{"hookSpecificOutput":{"permissionDecision":"allow","updatedInput":{"file_path":"moved.txt","content":"moved"}}}'`),
		},
		"PostToolUse": []any{hook("Write", `echo '{"hookSpecificOutput":{"additionalContext":"remember to test"}}'`)},
		"Stop":        []any{hook("", `grep -q '"stop_hook_active":true' && exit 0; echo '{"decision":"block","reason":"run the tests"}'`)},
	}})
	c, err := r.e.CreateChat(usecase.NewChat{TeamID: r.team.ID, ReplicaID: r.owner.ID, Text: "做事"})
	if err != nil {
		t.Fatal(err)
	}
	w := r.wait("the chat", chatDone(c.ID))

	reqs := r.fake.requests()
	if !strings.Contains(reqs[0].System, "session context here") {
		t.Fatal("SessionStart's words are not in the system prompt")
	}
	if _, err := os.Stat(filepath.Join(r.folder, "bad.txt")); err == nil {
		t.Fatal("the blocked command ran")
	}
	if res := execResultOf(reqs[1]); !res.IsError || !strings.Contains(res.Text, "no forbidden") {
		t.Fatalf("run_command = %+v", res)
	}
	if raw, err := os.ReadFile(filepath.Join(r.folder, "moved.txt")); err != nil || string(raw) != "moved" {
		t.Fatalf("the rewritten write: %q %v", raw, err)
	}
	if _, err := os.Stat(filepath.Join(r.folder, "orig.txt")); err == nil {
		t.Fatal("the write ran as first asked")
	}
	if res := execResultOf(reqs[2]); !strings.Contains(res.Text, "[hook] remember to test") {
		t.Fatalf("write_file = %+v", res)
	}
	if len(reqs) != 4 || !strings.Contains(reqs[3].Messages[len(reqs[3].Messages)-1].Content[0].Text, "run the tests") {
		t.Fatalf("the Stop hook did not send the model back once: %d requests", len(reqs))
	}
	said := w.Chats[c.ID].Messages
	if last := said[len(said)-1]; last.Text != "tests ok" {
		t.Fatalf("the chat ends with %+v", last)
	}

	before := len(r.fake.requests())
	blocked, err := r.e.CreateChat(usecase.NewChat{TeamID: r.team.ID, ReplicaID: r.owner.ID, Text: "please blockme"})
	if err != nil {
		t.Fatal(err)
	}
	w = r.wait("the blocked chat", chatDone(blocked.ID))
	if len(r.fake.requests()) != before {
		t.Fatal("the model was asked about a blocked message")
	}
	msgs := w.Chats[blocked.ID].Messages
	if last := msgs[len(msgs)-1]; !strings.Contains(last.Text, "not allowed") || last.Failed {
		t.Fatalf("the chat ends with %+v", last)
	}
}
