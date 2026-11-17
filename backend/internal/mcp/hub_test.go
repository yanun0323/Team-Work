package mcp

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	sdk "github.com/modelcontextprotocol/go-sdk/mcp"
	"github.com/rs/zerolog"
)

// TestMain runs the test binary as a stdio MCP server when asked to, so the hub can start a real one.
func TestMain(m *testing.M) {
	if os.Getenv("TEAM_WORK_MCP_TEST_SERVER") == "1" {
		if err := testServer(os.Getenv("TEAM_WORK_MCP_TEST_GREETING")).Run(context.Background(), &sdk.StdioTransport{}); err != nil {
			os.Exit(1)
		}
		os.Exit(0)
	}
	os.Exit(m.Run())
}

type echoArgs struct {
	Text string `json:"text"`
}

func testServer(greeting string) *sdk.Server {
	s := sdk.NewServer(&sdk.Implementation{Name: "test", Version: "1"}, &sdk.ServerOptions{Instructions: "Echoes text back.\nMore lines."})
	sdk.AddTool(s, &sdk.Tool{Name: "echo", Description: "Say it back", Annotations: &sdk.ToolAnnotations{ReadOnlyHint: true}},
		func(_ context.Context, _ *sdk.CallToolRequest, in echoArgs) (*sdk.CallToolResult, any, error) {
			return &sdk.CallToolResult{Content: []sdk.Content{&sdk.TextContent{Text: greeting + in.Text}}}, nil, nil
		})
	sdk.AddTool(s, &sdk.Tool{Name: "fail.now", Description: "Always fails"},
		func(context.Context, *sdk.CallToolRequest, struct{}) (*sdk.CallToolResult, any, error) {
			return &sdk.CallToolResult{IsError: true, Content: []sdk.Content{&sdk.TextContent{Text: "it broke"}}}, nil, nil
		})
	sdk.AddTool(s, &sdk.Tool{Name: "picture", Description: "A picture"},
		func(context.Context, *sdk.CallToolRequest, struct{}) (*sdk.CallToolResult, any, error) {
			return &sdk.CallToolResult{Content: []sdk.Content{&sdk.TextContent{Text: "here"}, &sdk.ImageContent{MIMEType: "image/png", Data: []byte{1, 2, 3}}}}, nil, nil
		})
	return s
}

func writeConfig(t *testing.T, dir string, servers map[string]any) string {
	t.Helper()
	raw, err := json.Marshal(map[string]any{"mcpServers": servers})
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, "mcp.json")
	if err := os.WriteFile(path, raw, 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func stdioEntry(greeting string) map[string]any {
	return map[string]any{"command": os.Args[0], "env": map[string]string{"TEAM_WORK_MCP_TEST_SERVER": "1", "TEAM_WORK_MCP_TEST_GREETING": greeting}}
}

func find(t *testing.T, l Listing, name string) Tool {
	t.Helper()
	for _, tool := range l.Tools {
		if tool.Name == name {
			return tool
		}
	}
	t.Fatalf("no tool %s in %+v (problems %v)", name, l.Tools, l.Problems)
	return Tool{}
}

func TestStdioServer(t *testing.T) {
	dir := t.TempDir()
	h := NewHub(writeConfig(t, dir, map[string]any{"local": stdioEntry("hi ")}), zerolog.Nop())
	defer h.Close()
	ctx := context.Background()

	l := h.Tools(ctx)
	if len(l.Problems) > 0 {
		t.Fatalf("problems: %v", l.Problems)
	}
	if len(l.Servers) != 1 || l.Servers[0].About != "Echoes text back." {
		t.Fatalf("servers = %+v, want the first line of its instructions", l.Servers)
	}
	echo := find(t, l, "mcp__local__echo")
	if !echo.ReadOnly || echo.Exposure != Script || !strings.Contains(echo.Description, "Say it back") {
		t.Fatalf("echo = %+v", echo)
	}
	var schema map[string]any
	if err := json.Unmarshal(echo.Schema, &schema); err != nil || schema["type"] != "object" {
		t.Fatalf("schema = %s", echo.Schema)
	}
	if got := h.Call(ctx, echo, json.RawMessage(`{"text":"there"}`)); got.IsError || got.Text != "hi there" {
		t.Fatalf("echo = %+v", got)
	}
	// a name with a character providers refuse
	if got := h.Call(ctx, find(t, l, "mcp__local__fail_now"), nil); !got.IsError || got.Text != "it broke" {
		t.Fatalf("fail = %+v", got)
	}
	pic := h.Call(ctx, find(t, l, "mcp__local__picture"), nil)
	if pic.Text != "here" || pic.MimeType != "image/png" || pic.Data != "AQID" {
		t.Fatalf("picture = %+v", pic)
	}
}

func TestChangedConfigConnectsAgain(t *testing.T) {
	dir := t.TempDir()
	path := writeConfig(t, dir, map[string]any{"local": stdioEntry("one ")})
	h := NewHub(path, zerolog.Nop())
	defer h.Close()
	ctx := context.Background()
	echo := find(t, h.Tools(ctx), "mcp__local__echo")
	if got := h.Call(ctx, echo, json.RawMessage(`{"text":"x"}`)); got.Text != "one x" {
		t.Fatalf("before = %+v", got)
	}
	writeConfig(t, dir, map[string]any{"local": stdioEntry("two ")})
	echo = find(t, h.Tools(ctx), "mcp__local__echo")
	if got := h.Call(ctx, echo, json.RawMessage(`{"text":"x"}`)); got.Text != "two x" {
		t.Fatalf("after = %+v", got)
	}
	writeConfig(t, dir, map[string]any{})
	if l := h.Tools(ctx); len(l.Tools) != 0 {
		t.Fatalf("tools after removal = %+v", l.Tools)
	}
	if got := h.Call(ctx, echo, nil); !got.IsError || !strings.Contains(got.Text, "no longer listed") {
		t.Fatalf("call after removal = %+v", got)
	}
}

func TestHTTPServerGetsHeaders(t *testing.T) {
	handler := sdk.NewStreamableHTTPHandler(func(*http.Request) *sdk.Server { return testServer("web ") }, nil)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer secret" {
			http.Error(w, "no", http.StatusUnauthorized)
			return
		}
		handler.ServeHTTP(w, r)
	}))
	defer srv.Close()
	t.Setenv("TEAM_WORK_TEST_TOKEN", "secret")
	dir := t.TempDir()
	h := NewHub(writeConfig(t, dir, map[string]any{
		"docs": map[string]any{"url": srv.URL, "headers": map[string]string{"Authorization": "Bearer ${TEAM_WORK_TEST_TOKEN}"}, "description": "Docs", "toolExposure": map[string]string{"picture": "hidden", "fail.now": "codemode"}},
	}), zerolog.Nop())
	defer h.Close()
	ctx := context.Background()
	l := h.Tools(ctx)
	if len(l.Servers) != 1 || l.Servers[0].About != "Docs" {
		t.Fatalf("servers = %+v, problems %v", l.Servers, l.Problems)
	}
	if len(l.Tools) != 2 || find(t, l, "mcp__docs__fail_now").Exposure != Script {
		t.Fatalf("tools = %+v, want the picture hidden and fail.now for scripts", l.Tools)
	}
	if got := h.Call(ctx, find(t, l, "mcp__docs__echo"), json.RawMessage(`{"text":"ok"}`)); got.Text != "web ok" {
		t.Fatalf("echo = %+v", got)
	}
}

func TestUnreachableServerIsReportedAndLeftAlone(t *testing.T) {
	dir := t.TempDir()
	h := NewHub(writeConfig(t, dir, map[string]any{"gone": map[string]any{"command": filepath.Join(dir, "missing")}}), zerolog.Nop())
	defer h.Close()
	l := h.Tools(context.Background())
	if len(l.Problems) != 1 || !strings.Contains(l.Problems[0], `"gone"`) {
		t.Fatalf("problems = %v", l.Problems)
	}
	start := time.Now()
	h.Tools(context.Background())
	if time.Since(start) > time.Second {
		t.Fatal("a server that just failed was tried again at once")
	}
}

func TestLoad(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("TEAM_WORK_TEST_KEY", "k1")
	path := writeConfig(t, dir, map[string]any{
		"a":        map[string]any{"command": "~/bin/srv", "args": []string{"--key=${TEAM_WORK_TEST_KEY}", "${TEAM_WORK_TEST_UNSET:-dflt}"}, "timeout": 5, "exposure": "deferred"},
		"off":      map[string]any{"command": "x", "enabled": false},
		"off2":     map[string]any{"command": "x", "disabled": true},
		"sse":      map[string]any{"type": "sse", "url": "http://x"},
		"both":     map[string]any{"command": "x", "url": "http://x"},
		"none":     map[string]any{},
		"bad name": map[string]any{"command": "x"},
		"rel":      map[string]any{"command": "x", "cwd": "here"},
		"a-b":      map[string]any{"command": "x"},
		"a_b":      map[string]any{"command": "x"},
		"expo":     map[string]any{"command": "x", "exposure": "sometimes"},
	})
	servers, problems := Load(path)
	if len(servers) != 2 || servers[0].Name != "a" || servers[1].Name != "a-b" {
		t.Fatalf("servers = %+v", servers)
	}
	home, _ := os.UserHomeDir()
	a := servers[0]
	if a.Command != filepath.Join(home, "bin/srv") || a.Args[0] != "--key=k1" || a.Args[1] != "dflt" || a.Timeout != 5*time.Second || a.Exposure != Script {
		t.Fatalf("a = %+v", a)
	}
	// sse, both, none, bad name, rel, a_b (same tools as a-b) and expo
	if len(problems) != 7 {
		t.Fatalf("problems = %v", problems)
	}
	if s, p := Load(filepath.Join(dir, "absent.json")); s != nil || p != nil {
		t.Fatalf("absent file = %v %v", s, p)
	}
}

func TestToolName(t *testing.T) {
	taken := map[string]bool{}
	long := toolName("server", strings.Repeat("x", 80), taken)
	if len(long) > maxName || !strings.HasPrefix(long, "mcp__server__xxx") {
		t.Fatalf("long = %q", long)
	}
	first := toolName("s", "a.b", taken)
	taken[first] = true
	second := toolName("s", "a-b", taken)
	if first != "mcp__s__a_b" || second == first || len(second) > maxName {
		t.Fatalf("first %q second %q", first, second)
	}
}
