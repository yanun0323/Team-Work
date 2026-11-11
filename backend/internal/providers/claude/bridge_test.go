package claude

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"
)

// A real subprocess exercises pipes, cancellation and MCP envelopes without a model or credentials.
func TestClaudeChild(t *testing.T) {
	if os.Getenv("MHO_TEST_CLAUDE_CHILD") != "1" {
		return
	}
	signal.Ignore(syscall.SIGTERM)
	scanner := bufio.NewScanner(os.Stdin)
	scanner.Buffer(make([]byte, 65536), maxFrame)
	write := func(v any) { raw, _ := json.Marshal(v); fmt.Println(string(raw)) }
	assistant := func(id, text string) {
		write(object{"type": "assistant", "uuid": id, "message": object{"id": id, "content": []object{{"type": "text", "text": text}}, "usage": object{"input_tokens": 3, "output_tokens": 2}}})
	}
	result := func() {
		write(object{"type": "result", "stop_reason": "end_turn", "modelUsage": object{"haiku": object{"contextWindow": 200000}}})
	}
	tools := false
	round := 0
	responses := map[string]bool{}
	for scanner.Scan() {
		var f struct {
			Type      string `json:"type"`
			RequestID string `json:"request_id"`
			Request   struct {
				Subtype      string   `json:"subtype"`
				SystemPrompt []string `json:"systemPrompt"`
				Detail       string   `json:"detail"`
				Servers      []string `json:"sdkMcpServers"`
			} `json:"request"`
			Response struct {
				RequestID string `json:"request_id"`
				Response  struct {
					MCP struct {
						ID     int    `json:"id"`
						Result object `json:"result"`
					} `json:"mcp_response"`
				} `json:"response"`
			} `json:"response"`
			Message struct {
				Content []object `json:"content"`
			} `json:"message"`
		}
		if json.Unmarshal(scanner.Bytes(), &f) != nil {
			os.Exit(2)
		}
		switch f.Type {
		case "control_request":
			switch f.Request.Subtype {
			case "initialize":
				if os.Getenv("MHO_TEST_CLAUDE_FAILURE") == "control" {
					write(object{"type": "control_response", "response": object{"subtype": "error", "request_id": f.RequestID, "error": "private-credential: initialization failed"}})
					continue
				}
				tools = len(f.Request.Servers) > 0
				if os.Getenv("MHO_TEST_CLAUDE_AUTH_ERROR") == "1" {
					write(object{"type": "control_response", "response": object{"subtype": "error", "request_id": f.RequestID, "error": "authentication failed"}})
					continue
				}
				write(object{"type": "control_response", "response": object{"subtype": "success", "request_id": f.RequestID, "response": object{"account": object{"apiProvider": "firstParty", "subscriptionType": "pro"}, "models": []object{{"value": "haiku", "displayName": "Haiku 4.5", "supportedEffortLevels": []string{"low", "medium"}}}}}})
			case "set_model":
				write(object{"type": "control_response", "response": object{"subtype": "success", "request_id": f.RequestID}})
			case "get_context_usage":
				if f.Request.Detail != "summary" {
					os.Exit(4)
				}
				response := `{"maxTokens":180000,"rawMaxTokens":200000}`
				if value := os.Getenv("MHO_TEST_CLAUDE_CONTEXT"); value != "" {
					response = value
				}
				write(object{"type": "control_response", "response": object{"subtype": "success", "request_id": f.RequestID, "response": json.RawMessage(response)}})
			case "get_usage":
				if usage := os.Getenv("MHO_TEST_CLAUDE_USAGE"); usage != "" {
					write(object{"type": "control_response", "response": object{"subtype": "success", "request_id": f.RequestID, "response": json.RawMessage(usage)}})
					continue
				}
				write(object{"type": "control_response", "response": object{"subtype": "success", "request_id": f.RequestID, "response": object{"rate_limits_available": true, "rate_limits": object{"five_hour": object{"utilization": 25, "resets_at": "2030-01-01T00:00:00Z"}, "seven_day": object{"utilization": 40, "resets_at": "2030-01-07T00:00:00Z"}, "model_scoped": []object{}}}}})
			}
		case "user":
			if raw := os.Getenv("MHO_TEST_CLAUDE_REJECTED_TOOL"); raw != "" {
				write(object{"type": "control_request", "request_id": "list", "request": object{"subtype": "mcp_message", "server_name": "mho", "message": object{"jsonrpc": "2.0", "id": 8, "method": "tools/list"}}})
				var block object
				if json.Unmarshal([]byte(raw), &block) != nil {
					os.Exit(6)
				}
				if os.Getenv("MHO_TEST_CLAUDE_REJECTED_TOOL_STREAM") == "1" {
					write(object{"type": "stream_event", "event": object{"type": "content_block_start", "index": 0, "content_block": block}})
					write(object{"type": "stream_event", "event": object{"type": "content_block_stop", "index": 0}})
				} else {
					write(object{"type": "assistant", "uuid": "rejected", "message": object{"content": []object{block}}})
				}
				continue
			}
			switch os.Getenv("MHO_TEST_CLAUDE_FAILURE") {
			case "assistant":
				write(object{"type": "assistant", "error": "api_error", "message": object{"content": []object{{"type": "text", "text": "prompt is too long: private-prompt"}}}})
				continue
			case "result":
				write(object{"type": "result", "subtype": "error_during_execution", "is_error": true, "errors": []string{"private-token: tool failed"}, "result": "private-output"})
				continue
			case "usage-stream":
				write(object{"type": "stream_event", "event": object{"type": "message_start", "message": object{"id": "u", "usage": object{"input_tokens": 3, "cache_read_input_tokens": 4, "cache_creation_input_tokens": 2}}}})
				write(object{"type": "stream_event", "event": object{"type": "content_block_start", "index": 0, "content_block": object{"type": "tool_use", "id": "c0", "name": "mcp__mho__read", "input": object{}}}})
				write(object{"type": "stream_event", "event": object{"type": "content_block_stop", "index": 0}})
				write(object{"type": "result", "subtype": "error_during_execution", "is_error": true, "errors": []string{"private-token"}, "result": "private-output"})
				continue
			case "usage-result":
				write(object{"type": "result", "subtype": "error_during_execution", "is_error": true, "errors": []string{"private-token"}, "result": "private-output",
					"usage": object{"input_tokens": 5, "cache_read_input_tokens": 1}})
				continue
			case "exit":
				fmt.Fprintln(os.Stderr, "fetch failed: private-token private-prompt")
				os.Exit(23)
			case "unknown":
				write(object{"type": "assistant", "error": "private-token", "message": object{"content": []object{{"type": "text", "text": "private-output"}}}})
				continue
			case "invalid":
				fmt.Println("private-invalid-json")
				continue
			}
			raw, _ := json.Marshal(f.Message.Content)
			if strings.Contains(string(raw), "BLOCK_FOREVER") {
				for {
					time.Sleep(time.Hour)
				}
			}
			round++
			if mode := os.Getenv("MHO_TEST_CLAUDE_DENIED_TOOL"); mode != "" && round == 1 {
				call := mcpCall("denied", 9, "denied-call")
				call["request"].(object)["message"].(object)["params"].(object)["name"] = "write"
				if mode == "early" {
					write(call)
				}
				write(object{"type": "stream_event", "event": object{"type": "message_start", "message": object{"id": "denied"}}})
				write(object{"type": "stream_event", "event": object{"type": "content_block_delta", "delta": object{"type": "text_delta", "text": "Checking. "}}})
				write(object{"type": "stream_event", "event": object{"type": "content_block_start", "index": 0, "content_block": object{"type": "tool_use", "id": "denied-call", "name": "mcp__mho__write", "input": object{}}}})
				write(object{"type": "stream_event", "event": object{"type": "content_block_stop", "index": 0}})
				write(object{"type": "stream_event", "event": object{"type": "message_stop"}})
				write(object{"type": "assistant", "uuid": "denied", "message": object{"id": "denied", "stop_reason": "tool_use", "content": []object{{"type": "tool_use", "id": "denied-call", "name": "mcp__mho__write", "input": object{}}}}})
				if mode != "early" {
					write(call)
				}
				continue
			}
			if tools && round == 1 {
				tool := "mcp__mho__read"
				if os.Getenv("MHO_TEST_CLAUDE_UNPREFIXED") == "1" {
					tool = "read"
				}
				toolArgs := `{"path":"a.go"}`
				if value := os.Getenv("MHO_TEST_CLAUDE_TOOL_ARGS"); value != "" {
					toolArgs = value
				}
				write(object{"type": "stream_event", "event": object{"type": "message_start", "message": object{"id": "tools", "usage": object{"input_tokens": 10, "cache_read_input_tokens": 20}}}})
				for i := 0; i < 2; i++ {
					if os.Getenv("MHO_TEST_CLAUDE_ASSISTANT_TOOLS") == "1" {
						continue
					}
					write(object{"type": "stream_event", "event": object{"type": "content_block_start", "index": i, "content_block": object{"type": "tool_use", "id": fmt.Sprint("c", i), "name": tool, "input": object{}}}})
					write(object{"type": "stream_event", "event": object{"type": "content_block_delta", "index": i, "delta": object{"type": "input_json_delta", "partial_json": toolArgs}}})
					write(object{"type": "stream_event", "event": object{"type": "content_block_stop", "index": i}})
				}
				write(object{"type": "stream_event", "event": object{"type": "message_delta", "delta": object{"stop_reason": "tool_use"}, "usage": object{"output_tokens": 7}}})
				// One call before message_stop; the second deliberately arrives after it.
				write(mcpCall("r0", 0, "c0"))
				write(object{"type": "stream_event", "event": object{"type": "message_stop"}})
				write(object{"type": "assistant", "uuid": "old", "message": object{"id": "tools", "stop_reason": "tool_use", "content": []object{
					{"type": "tool_use", "id": "c0", "name": tool, "input": json.RawMessage(toolArgs)},
					{"type": "tool_use", "id": "c1", "name": "mcp__mho__read", "input": json.RawMessage(toolArgs)},
				}}})
				write(mcpCall("r1", 1, "c1"))
				write(object{"type": "tool_progress", "parent_tool_use_id": "c1", "tool_use_id": "c1", "heartbeat": true})
			} else {
				assistant(fmt.Sprint("m", round), "ok")
				result()
			}
		case "control_response":
			id := f.Response.RequestID
			if id == "denied" {
				body := f.Response.Response.MCP.Result
				if f.Response.Response.MCP.ID != 9 || body["isError"] != true || !strings.Contains(fmt.Sprint(body["content"]), "not available") {
					os.Exit(5)
				}
				write(object{"type": "stream_event", "event": object{"type": "message_start", "message": object{"id": "answer"}}})
				assistant("answer", "I cannot write files here.")
				result()
				continue
			}
			if id == "r0" || id == "r1" {
				want := 0
				if id == "r1" {
					want = 1
				}
				if f.Response.Response.MCP.ID != want {
					os.Exit(3)
				}
				body, _ := json.Marshal(f.Response.Response.MCP.Result)
				if !strings.Contains(string(body), fmt.Sprint("result", want)) {
					os.Exit(4)
				}
				responses[id] = true
				if len(responses) == 2 {
					write(object{"type": "stream_event", "event": object{"type": "message_start", "message": object{"id": "answer"}}})
					assistant("answer", "ok")
					result()
				}
			}
		}
	}
	os.Exit(0)
}
func mcpCall(id string, rpc int, call string) object {
	return object{"type": "control_request", "request_id": id, "request": object{"subtype": "mcp_message", "server_name": "mho", "message": object{"jsonrpc": "2.0", "id": rpc, "method": "tools/call", "params": object{"name": "read", "arguments": object{"path": "a.go"}, "_meta": object{"claudecode/toolUseId": call, "progressToken": rpc}}}}}
}
func fakeClaude(t *testing.T) {
	t.Helper()
	for _, key := range []string{"ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY"} {
		t.Setenv(key, "")
	}
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	wrapper := filepath.Join(t.TempDir(), "claude")
	if err = os.WriteFile(wrapper, []byte("#!/bin/sh\nexec '"+strings.ReplaceAll(executable, "'", "'\\''")+"' -test.run='^TestClaudeChild$'\n"), 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("MHO_CLAUDE_EXECUTABLE", wrapper)
	t.Setenv("MHO_TEST_CLAUDE_CHILD", "1")
	t.Setenv("CLAUDE_CONFIG_DIR", t.TempDir())
}
func text(s string) Block { return Block{Type: "text", Text: s} }
func base(t *testing.T) CompleteParams {
	return CompleteParams{Session: "s1", Cwd: t.TempDir(), Model: "haiku", System: "Preserve Mho instructions.", Messages: []ModelMessage{{Role: "user", Content: []Block{text("hello")}}}, Tools: []ToolSpec{{Name: "read", Parameters: json.RawMessage(`{"type":"object","properties":{"path":{"type":"string"}}}`)}}}
}
func runTurn(t *testing.T, b *bridge, p *CompleteParams) (CompleteResult, []Block) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	blocks := []Block{}
	result, err := b.complete(ctx, *p, func(v any) error {
		block := v.(Block)
		if n := len(blocks); n > 0 && blocks[n-1].Type == block.Type && (block.Type == "text" || block.Type == "thinking") {
			blocks[n-1].Text += block.Text
		} else {
			blocks = append(blocks, block)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	p.Messages = append(p.Messages, ModelMessage{Role: "assistant", Content: blocks})
	return result, blocks
}
func TestToolRoundTripReuseAndRebuild(t *testing.T) {
	fakeClaude(t)
	b := newBridge()
	defer b.close()
	p := base(t)
	result, blocks := runTurn(t, b, &p)
	if result.StopReason != "tool_use" || len(blocks) != 2 || result.Usage.Input != 30 || result.Usage.Output != 7 {
		t.Fatalf("%+v %+v", result, blocks)
	}
	first := b.sessions[p.Session].child
	// Results arrive in reverse order; IDs, not position, pair them.
	for i := 1; i >= 0; i-- {
		p.Messages = append(p.Messages, ModelMessage{Role: "tool", CallID: blocks[i].ID, Content: []Block{text(fmt.Sprint("result", i))}})
	}
	result, blocks = runTurn(t, b, &p)
	if result.StopReason != "end_turn" || len(blocks) != 1 || blocks[0].Text != "ok" || b.sessions[p.Session].child != first {
		t.Fatalf("%+v %+v", result, blocks)
	}
	p.Messages = append(p.Messages, ModelMessage{Role: "user", Content: []Block{text("again")}})
	runTurn(t, b, &p)
	if b.sessions[p.Session].child != first {
		t.Fatal("normal turn restarted child")
	}
	p.System = "Changed instructions"
	p.Tools = nil
	p.Messages = append(p.Messages, ModelMessage{Role: "user", Content: []Block{text("new")}})
	runTurn(t, b, &p)
	if b.sessions[p.Session].child == first {
		t.Fatal("changed instructions reused child")
	}
	select {
	case <-first.done:
	default:
		t.Fatal("old child still running")
	}
	mirror := b.sessions[p.Session].mirror
	if mirror.resume == "" {
		t.Fatal("history not imported")
	}
	b.close()
	if _, err := os.Stat(mirror.path); !os.IsNotExist(err) {
		t.Fatal("mirror not cleaned")
	}
}

// Both frame formats must normalize bare names, pair early/late MCP results by
// call ID, and continue on the same child without executing duplicate calls.
func TestUnprefixedToolRoundTrip(t *testing.T) {
	for _, assistantOnly := range []string{"0", "1"} {
		t.Run(assistantOnly, func(t *testing.T) {
			fakeClaude(t)
			t.Setenv("MHO_TEST_CLAUDE_UNPREFIXED", "1")
			t.Setenv("MHO_TEST_CLAUDE_ASSISTANT_TOOLS", assistantOnly)
			var logged bytes.Buffer
			b := newBridge()
			b.log = slog.New(slog.NewJSONHandler(&logged, nil))
			defer b.close()
			p := base(t)
			result, calls := runTurn(t, b, &p)
			if result.StopReason != "tool_use" || len(calls) != 2 {
				t.Fatalf("unexpected calls: %+v %+v", result, calls)
			}
			first := b.sessions[p.Session].child
			for i := 1; i >= 0; i-- {
				if calls[i].Name != "read" || calls[i].ID != fmt.Sprint("c", i) || string(calls[i].Args) != `{"path":"a.go"}` {
					t.Fatalf("call not preserved: %+v", calls[i])
				}
				p.Messages = append(p.Messages, ModelMessage{Role: "tool", CallID: calls[i].ID, Content: []Block{text(fmt.Sprint("result", i))}})
			}
			result, reply := runTurn(t, b, &p)
			if result.StopReason != "end_turn" || len(reply) != 1 || reply[0].Text != "ok" || b.sessions[p.Session].child != first {
				t.Fatalf("results did not resume the same child: %+v %+v", result, reply)
			}
			if !strings.Contains(logged.String(), `"msg":"tool_call_normalized"`) || strings.Contains(logged.String(), "a.go") {
				t.Fatal("missing or unsafe normalization diagnostic")
			}
		})
	}
}

// Remembering the history must not write into the arguments the caller holds: JSON encoding turns ">" into
// the longer "\u003e", and the old buffer had room for it, which cut the caller's copy off mid-value.
func TestRememberedHistoryLeavesToolArgumentsIntact(t *testing.T) {
	fakeClaude(t)
	args := `{"path":"2>` + strings.Repeat("a", 184-len(`{"path":"2>"}`)) + `"}`
	t.Setenv("MHO_TEST_CLAUDE_TOOL_ARGS", args)
	b := newBridge()
	defer b.close()
	p := base(t)
	_, calls := runTurn(t, b, &p)
	first := b.sessions[p.Session].child
	for i, call := range calls {
		p.Messages = append(p.Messages, ModelMessage{Role: "tool", CallID: call.ID, Content: []Block{text(fmt.Sprint("result", i))}})
	}
	runTurn(t, b, &p)
	for _, call := range calls {
		if string(call.Args) != args {
			t.Fatalf("arguments changed to %s", call.Args)
		}
	}
	p.Messages = append(p.Messages, ModelMessage{Role: "user", Content: []Block{text("again")}})
	runTurn(t, b, &p)
	if b.sessions[p.Session].child != first {
		t.Fatal("history stopped matching and the child restarted")
	}
}

// A history that cannot be rebuilt is our failure: the message must not blame the user's Claude Code setup,
// and the log must name the step without quoting the conversation.
func TestHistoryFailureIsReportedAsInternal(t *testing.T) {
	fakeClaude(t)
	var logged bytes.Buffer
	b := newBridge()
	b.log = slog.New(slog.NewJSONHandler(&logged, nil))
	defer b.close()
	p := base(t)
	p.Messages = []ModelMessage{
		{Role: "user", Content: []Block{text("hello")}},
		{Role: "assistant", Content: []Block{{Type: "tool_call", ID: "c0", Name: "read", Args: json.RawMessage(`{"path":"private-path`)}}},
		{Role: "tool", CallID: "c0", Content: []Block{text("result")}},
	}
	_, err := b.complete(context.Background(), p, func(any) error { return nil })
	if err == nil || strings.Contains(err.Error(), "login") || !strings.Contains(err.Error(), "backend.log") {
		t.Fatalf("%v", err)
	}
	out := logged.String()
	if !strings.Contains(out, `"msg":"history_failed"`) || !strings.Contains(out, `"error_type":"*json.MarshalerError"`) || strings.Contains(out, "private-path") {
		t.Fatal(out)
	}
}

func TestDiscoveryAndLaunchIsolation(t *testing.T) {
	fakeClaude(t)
	ids, efforts, err := discover(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(ids) != 1 || efforts[ids[0]] == nil && len(ids) == 0 {
		t.Fatalf("%v %v", ids, efforts)
	}
	args := launchArgs(base(t), "resume-id")
	joined := strings.Join(args, " ")
	for _, flag := range []string{"--tools ", "--setting-sources=", "--strict-mcp-config", "--permission-mode dontAsk", "--no-session-persistence", "--resume=resume-id", "mcp__mho__read", "disableAllHooks", "disableBundledSkills"} {
		if !strings.Contains(joined, flag) {
			t.Fatal("missing", flag)
		}
	}
	t.Setenv("ENABLE_TOOL_SEARCH", "true")
	env, err := childEnvironment()
	if err != nil {
		t.Fatal(err)
	}
	search := []string{}
	for _, entry := range env {
		if strings.HasPrefix(entry, "ENABLE_TOOL_SEARCH=") {
			search = append(search, entry)
		}
	}
	if len(search) != 1 || search[0] != "ENABLE_TOOL_SEARCH=false" {
		t.Fatal("tool search must stay off:", search)
	}
	t.Setenv("ANTHROPIC_API_KEY", "secret")
	if _, err := childEnvironment(); err == nil || strings.Contains(err.Error(), "secret") {
		t.Fatal(err)
	}
}
func TestCancellationBusyAndShutdown(t *testing.T) {
	fakeClaude(t)
	b := newBridge()
	defer b.close()
	p := base(t)
	p.Tools = nil
	p.Messages[0].Content = []Block{text("BLOCK_FOREVER")}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() { _, err := b.complete(ctx, p, func(any) error { return nil }); done <- err }()
	deadline := time.Now().Add(3 * time.Second)
	for {
		b.mu.Lock()
		active := len(b.active) > 0
		b.mu.Unlock()
		if active {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("not active")
		}
		time.Sleep(time.Millisecond)
	}
	if _, err := b.complete(context.Background(), p, func(any) error { return nil }); err == nil || !strings.Contains(err.Error(), "already") {
		t.Fatal(err)
	}
	cancel()
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("cancellation succeeded")
		}
	case <-time.After(3 * time.Second):
		t.Fatal("cancellation blocked")
	}
	if len(b.sessions) != 0 {
		t.Fatal("cancelled session retained")
	}
	var wg sync.WaitGroup
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			q := p
			q.Session = fmt.Sprint(i)
			_, _ = b.complete(context.Background(), q, func(any) error { return nil })
		}(i)
	}
	time.Sleep(30 * time.Millisecond)
	b.close()
	wg.Wait()
	if len(b.sessions) != 0 || len(b.active) != 0 {
		t.Fatal("shutdown retained sessions")
	}
}
func TestCloseKillsUncooperativeChild(t *testing.T) {
	fakeClaude(t)
	p := base(t)
	p.Tools = nil
	c, err := startChild(p, "", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer c.close()
	s := &session{child: c}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if _, err = s.initialize(ctx, ""); err != nil {
		t.Fatal(err)
	}
	if err = s.prompt(ctx, []object{{"type": "text", "text": "BLOCK_FOREVER"}}); err != nil {
		t.Fatal(err)
	}
	time.Sleep(30 * time.Millisecond)
	c.close()
	if err := syscall.Kill(c.cmd.Process.Pid, 0); err != syscall.ESRCH {
		t.Fatalf("child remains: %v", err)
	}
}
func TestStreamFallbackAndFailures(t *testing.T) {
	cases := []struct {
		name   string
		events string
		want   string
		fail   bool
	}{
		{"fallback", `{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"hel"}}}
{"type":"assistant","uuid":"a","message":{"id":"m","content":[{"type":"text","text":"hello"}]}}
{"type":"assistant","uuid":"a","message":{"id":"m","content":[{"type":"text","text":"hello"}]}}
{"type":"assistant","uuid":"b","message":{"id":"m","content":[{"type":"text","text":" second"}]}}
{"type":"result"}`, "hello second", false},
		{"unknown tool", `{"type":"assistant","message":{"content":[{"type":"tool_use","id":"x","name":"Bash","input":{}}]}}`, "", true},
		{"replacement", `{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"hello"}}}
{"type":"assistant","message":{"content":[{"type":"text","text":"different"}]}}`, "hello", true},
		{"subagent", `{"type":"assistant","parent_tool_use_id":"x"}`, "", true},
		{"overflow", `{"type":"result","is_error":true,"errors":["prompt is too long"]}`, "", true},
	}
	for _, tt := range cases {
		t.Run(tt.name, func(t *testing.T) {
			got := ""
			turn := newTurn(nil, func(v any) error { got += v.(Block).Text; return nil })
			s := &session{results: map[string]object{}, seenMessages: map[string]bool{}, closedMessages: map[string]bool{}}
			var err error
			done := false
			for _, line := range strings.Split(tt.events, "\n") {
				var f frame
				if e := json.Unmarshal([]byte(line), &f); e != nil {
					t.Fatal(e)
				}
				done, err = turn.consume(s, f)
				if err != nil {
					break
				}
			}
			if (err != nil) != tt.fail || got != tt.want || (!tt.fail && !done) {
				t.Fatalf("got %q done %v error %v", got, done, err)
			}
		})
	}
}
func TestMirrorPrivacyPairingAndImages(t *testing.T) {
	fakeClaude(t)
	p := base(t)
	p.Messages = append(p.Messages, ModelMessage{Role: "assistant", Content: []Block{{Type: "thinking", Text: "prior reasoning"}, {Type: "tool_call", ID: "c1", Name: "read", Args: json.RawMessage(`{}`)}, {Type: "tool_call", ID: "c2", Name: "read", Args: json.RawMessage(`{}`)}}}, ModelMessage{Role: "tool", CallID: "c1", IsError: true, Content: []Block{{Type: "image", MimeType: "image/png", Data: "aGk="}}})
	first, err := makeMirror(p)
	if err != nil {
		t.Fatal(err)
	}
	defer first.cleanup()
	second, err := makeMirror(p)
	if err != nil {
		t.Fatal(err)
	}
	defer second.cleanup()
	if first.resume == second.resume {
		t.Fatal("mirror reused UUID")
	}
	info, err := os.Stat(first.path)
	if err != nil || info.Mode().Perm() != 0600 {
		t.Fatalf("%v %v", info, err)
	}
	raw, err := os.ReadFile(first.path)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"[Earlier reasoning]", "mcp__mho__read", "aGk=", "image/png", "[no tool result recorded]", "\"tool_use_id\":\"c2\""} {
		if !strings.Contains(string(raw), want) {
			t.Fatal("missing", want)
		}
	}
	scanner := bufio.NewScanner(strings.NewReader(string(raw)))
	var parent any
	for scanner.Scan() {
		var record object
		if err = json.Unmarshal(scanner.Bytes(), &record); err != nil {
			t.Fatal(err)
		}
		if record["parentUuid"] != parent {
			t.Fatal("broken parent chain")
		}
		parent = record["uuid"]
	}
	// Unmarked user data and malformed ownership records never authorize deletion.
	userPath := filepath.Join(filepath.Dir(first.path), "user.jsonl")
	_ = os.WriteFile(userPath, []byte("private"), 0600)
	_ = os.WriteFile(filepath.Join(claudeDir(), "mho-company-owned", "invalid.json"), []byte(`{"pid":-1,"cwd":"/"}`), 0600)
	if err = sweepMirrors(); err != nil {
		t.Fatal(err)
	}
	if _, err = os.Stat(first.path); err != nil {
		t.Fatal("live mirror removed")
	}
	first.cleanup()
	if raw, err = os.ReadFile(userPath); err != nil || string(raw) != "private" {
		t.Fatal("user history changed")
	}
	if got := projectHash("/tmp/中文/🦄"); got != "-tmp------" {
		t.Fatal(got)
	}
}

func TestToolProgressIsNotASubagent(t *testing.T) {
	turn := newTurn(nil, func(any) error { return nil })
	done, err := turn.consume(&session{}, frame{Type: "tool_progress", ParentToolUseID: "toolu_mho"})
	if err != nil || done {
		t.Fatalf("tool heartbeat interrupted reply: done=%v err=%v", done, err)
	}
	for _, kind := range []string{"assistant", "stream_event"} {
		if _, err := turn.consume(&session{}, frame{Type: kind, ParentToolUseID: "agent"}); err == nil {
			t.Fatalf("accepted nested %s", kind)
		}
	}
}

func TestUnsupportedControlWithTextMessageIsRejected(t *testing.T) {
	reader, writer, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Close()
	defer writer.Close()
	s := &session{child: &child{stdin: writer}}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	// Elicitation uses a text message, unlike MCP's JSON-RPC message object.
	request := frame{RequestID: "dialog", Request: json.RawMessage(`{"subtype":"elicitation","mcp_server_name":"other","message":"Confirm action","mode":"form"}`)}
	if err := s.control(ctx, request); err != nil {
		t.Fatalf("unsupported request aborted conversation: %v", err)
	}
	var reply frame
	if err := json.NewDecoder(reader).Decode(&reply); err != nil {
		t.Fatal(err)
	}
	if reply.Response.Subtype != "error" || reply.Response.RequestID != "dialog" {
		t.Fatalf("did not reject request: %+v", reply)
	}
}

func TestUnavailableMhoToolReturnsDenialAndContinues(t *testing.T) {
	for _, mode := range []string{"early", "late"} {
		t.Run(mode, func(t *testing.T) {
			fakeClaude(t)
			t.Setenv("MHO_TEST_CLAUDE_DENIED_TOOL", mode)
			b := newBridge()
			defer b.close()
			p := base(t)
			result, blocks := runTurn(t, b, &p)
			if result.StopReason != "end_turn" || len(blocks) != 1 || blocks[0].Type != "text" || blocks[0].Text != "Checking. I cannot write files here." {
				t.Fatalf("denied tool did not recover: %+v %+v", result, blocks)
			}
			first := b.sessions[p.Session].child
			p.Messages = append(p.Messages, ModelMessage{Role: "user", Content: []Block{text("thanks")}})
			_, blocks = runTurn(t, b, &p)
			if len(blocks) != 1 || blocks[0].Text != "ok" || b.sessions[p.Session].child != first {
				t.Fatal("conversation did not remain usable after denial")
			}
		})
	}
}

func TestToolDenialDoesNotRelaxToolBoundary(t *testing.T) {
	for _, tc := range []struct {
		name string
		id   string
	}{
		{"Bash", "call"},
		{"write", "call"},
		{"read", ""},
		{"mcp__other__read", "call"},
		{"mcp__other__write", "call"},
		{"mcp__mho__write", ""},
		{"mcp__mho__", "call"},
		{"mcp__mho__bad.name", "call"},
	} {
		t.Run(tc.name+tc.id, func(t *testing.T) {
			turn := newTurn([]ToolSpec{{Name: "read"}}, func(any) error {
				t.Fatal("invalid tool was forwarded to the core")
				return nil
			})
			if err := turn.emitCall(claudeBlock{Name: tc.name, ID: tc.id}); err == nil {
				t.Fatal("invalid tool call was accepted")
			}
		})
	}
}

// Exercise the real subprocess/bridge path: diagnostics must survive both frame
// formats without logging tool names, IDs, arguments or model text.
func TestRejectedToolDiagnostics(t *testing.T) {
	for _, stream := range []string{"0", "1"} {
		for _, tc := range []struct {
			name, id, reason, kind, builtin string
			unprefixed                      bool
		}{
			{"ToolSearch", "private-call", "outside_mho", "tool_search", "ToolSearch", false},
			{"Bash", "private-call", "outside_mho", "builtin", "Bash", false},
			{"Read", "private-call", "outside_mho", "builtin", "Read", false},
			{"", "private-call", "outside_mho", "other", "", false},
			{"read", "", "missing_call_id", "other", "", true},
			{"mcp__private-server__private-tool", "private-call", "outside_mho", "other_mcp", "", false},
			{"private-tool", "private-call", "outside_mho", "other", "", false},
			{"mcp__mho__read", "", "missing_call_id", "mho", "", false},
			{"mcp__mho__private.name", "private-call", "invalid_tool_name", "mho", "", false},
		} {
			t.Run(stream+"/"+tc.reason+"/"+tc.kind, func(t *testing.T) {
				fakeClaude(t)
				raw, _ := json.Marshal(object{"type": "tool_use", "name": tc.name, "id": tc.id, "input": object{"path": "private-path", "token": "private-token"}, "text": "private-output"})
				t.Setenv("MHO_TEST_CLAUDE_REJECTED_TOOL", string(raw))
				t.Setenv("MHO_TEST_CLAUDE_REJECTED_TOOL_STREAM", stream)
				var logged bytes.Buffer
				b := newBridge()
				b.log = slog.New(slog.NewJSONHandler(&logged, nil))
				defer b.close()
				p := base(t)
				_, err := b.complete(context.Background(), p, func(any) error {
					t.Fatal("rejected tool was forwarded")
					return nil
				})
				if err == nil || errorCode(err) != CodeInvalidRequest {
					t.Fatalf("expected tool rejection, got %v", err)
				}
				if strings.Contains(logged.String(), "private-") || strings.Contains(logged.String(), "private.name") {
					t.Fatal("diagnostics leaked private content")
				}
				count, listed := 0, false
				for _, line := range strings.Split(strings.TrimSpace(logged.String()), "\n") {
					var event map[string]any
					if err := json.Unmarshal([]byte(line), &event); err != nil {
						t.Fatal(err)
					}
					if event["msg"] == "tools_list_requested" {
						listed = event["tools"] == float64(len(p.Tools)) && event["session"] == p.Session
					}
					if event["msg"] != "tool_call_rejected" {
						continue
					}
					if event["name_empty"] != (tc.name == "") || event["unprefixed_match"] != tc.unprefixed || event["builtin_tool"] != tc.builtin {
						t.Fatalf("incorrect tool classification: %+v", event)
					}
					count++
					if event["reason"] != tc.reason || event["tool_kind"] != tc.kind || event["has_call_id"] != (tc.id != "") || event["session"] != p.Session || event["attempt"] == nil {
						t.Fatalf("incorrect diagnostic: %+v", event)
					}
				}
				if count != 1 || !listed {
					t.Fatalf("expected one rejection and tool listing diagnostic, got %d, %v", count, listed)
				}
			})
		}
	}
}

func TestTokenUsagePreservesCacheWrites(t *testing.T) {
	u := (tokenUsage{Input: 10, Output: 5, CacheRead: 20, CacheCreate: 30}).modelUsage()
	if u.Input != 60 || u.Output != 5 || u.CacheRead != 20 || u.CacheWrite != 30 {
		t.Fatalf("usage = %+v", u)
	}
}

func TestCacheUsagePresenceSurvivesOutputOnlyDelta(t *testing.T) {
	for _, tc := range []struct {
		raw   string
		known bool
	}{
		{`{"input_tokens":100}`, false},
		{`{"input_tokens":100,"cache_read_input_tokens":null}`, false},
		{`{"input_tokens":100,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}`, true},
	} {
		var u tokenUsage
		if err := json.Unmarshal([]byte(tc.raw), &u); err != nil {
			t.Fatal(err)
		}
		if err := json.Unmarshal([]byte(`{"output_tokens":7}`), &u); err != nil {
			t.Fatal(err)
		}
		got := u.modelUsage()
		if got.CacheReadKnown() != tc.known || got.CacheWriteKnown() != tc.known || got.Input != 100 || got.Output != 7 {
			t.Fatalf("%s: %+v", tc.raw, got)
		}
	}
}

type lockedBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (w *lockedBuffer) Write(p []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.buf.Write(p)
}
func (w *lockedBuffer) String() string {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.buf.String()
}

func TestIdleProcessIsReusedWithinCacheLifetime(t *testing.T) {
	if idleProcess <= 5*time.Minute || idleProcess > time.Hour || newBridge().idle != idleProcess {
		t.Fatalf("idle process lifetime %v must stay within Claude's one-hour cache", idleProcess)
	}
	fakeClaude(t)
	logs := &lockedBuffer{}
	b := newBridge()
	b.log = slog.New(slog.NewJSONHandler(logs, nil))
	b.idle = 5 * time.Second
	defer b.close()
	p := base(t)
	_, blocks := runTurn(t, b, &p)
	first := b.sessions[p.Session].child
	time.Sleep(100 * time.Millisecond) // idle, but within the lifetime
	for i := range blocks {
		p.Messages = append(p.Messages, ModelMessage{Role: "tool", CallID: blocks[i].ID, Content: []Block{text(fmt.Sprint("result", i))}})
	}
	b.idle = 50 * time.Millisecond
	runTurn(t, b, &p)
	if b.sessions[p.Session].child != first {
		t.Fatal("a request within the idle lifetime restarted the process")
	}
	deadline := time.Now().Add(3 * time.Second)
	for {
		b.mu.Lock()
		gone := b.sessions[p.Session] == nil
		b.mu.Unlock()
		if gone {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("an idle process outlived its lifetime")
		}
		time.Sleep(10 * time.Millisecond)
	}
	var events []map[string]any
	for _, line := range strings.Split(strings.TrimSpace(logs.String()), "\n") {
		var e map[string]any
		if json.Unmarshal([]byte(line), &e) == nil && e["msg"] == "request_process" {
			events = append(events, e)
		}
	}
	if len(events) != 2 || events[0]["reused"] != false || events[0]["reason"] != "no_process" || events[1]["reused"] != true {
		t.Fatalf("process events %v", events)
	}
	if strings.Contains(logs.String(), "hello") || strings.Contains(logs.String(), "result0") {
		t.Fatal("the log quoted the conversation")
	}
}

func TestRestartReasons(t *testing.T) {
	p := base(t)
	p.Messages = append(p.Messages, ModelMessage{Role: "assistant", Content: []Block{text("hi")}})
	s := &session{signature: signature(p), expected: p.Messages}
	next := p
	next.Messages = append(append([]ModelMessage{}, p.Messages...), ModelMessage{Role: "user", Content: []Block{text("more")}})
	changed := next
	changed.System = "other"
	edited := next
	edited.Messages = append([]ModelMessage{{Role: "user", Content: []Block{text("edited")}}}, next.Messages[1:]...)
	odd := next
	odd.Messages = append(append([]ModelMessage{}, p.Messages...), ModelMessage{Role: "tool", CallID: "x", Content: []Block{text("r")}})
	for _, c := range []struct {
		s    *session
		p    CompleteParams
		want string
	}{{nil, next, "no_process"}, {s, next, ""}, {s, changed, "settings_changed"}, {s, edited, "history_changed"}, {s, odd, "unexpected_messages"}} {
		if got := restartReason(c.s, c.p); got != c.want {
			t.Errorf("restartReason = %q, want %q", got, c.want)
		}
	}
}
