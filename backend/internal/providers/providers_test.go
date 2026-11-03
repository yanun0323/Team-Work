package providers

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"testing"

	"github.com/yanun0323/Team-Work/internal/adapter"
	"github.com/yanun0323/Team-Work/internal/model"
	"github.com/yanun0323/Team-Work/internal/model/enum"
)

func serve(t *testing.T, kind enum.ProviderKind, status int, body string) (adapter.Provider, *http.Request, *[]byte) {
	t.Helper()
	got, raw := &http.Request{}, &[]byte{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		*got = *r
		*raw, _ = io.ReadAll(r.Body)
		w.WriteHeader(status)
		io.WriteString(w, body)
	}))
	t.Cleanup(srv.Close)
	p, err := NewFactory(nil, nil).For(model.ModelProvider{Name: "x", Kind: kind, BaseURL: srv.URL, Auth: model.ProviderAuth{Kind: "apiKey"}}, "sk-key")
	if err != nil {
		t.Fatal(err)
	}
	return p, got, raw
}

var request = model.ModelRequest{Model: "m", System: "sys", Effort: "max", Tools: []model.ToolSpec{{Name: "t", Parameters: json.RawMessage(`{"type":"object"}`)}},
	Messages: []model.Message{
		{Role: enum.RoleUser, Content: []model.Block{{Type: enum.BlockText, Text: "hi"}}},
		{Role: enum.RoleAssistant, Content: []model.Block{{Type: enum.BlockToolCall, ID: "c0", Name: "t", Args: json.RawMessage(`{}`)}}},
		{Role: enum.RoleUser, Content: []model.Block{{Type: enum.BlockToolResult, ID: "c0", Name: "t", Text: "ok"}}},
	}}

const chatStream = `data: {"choices":[{"delta":{"content":"he"}}]}

data: {"choices":[{"delta":{"content":"llo"}}]}

data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"t","arguments":"{\"a\""}}]}}]}

data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":":1}"}}]},"finish_reason":"tool_calls"}]}

data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5,"prompt_tokens_details":{"cached_tokens":4}}}

data: [DONE]
`

func TestChatCompletionsStream(t *testing.T) {
	p, req, body := serve(t, enum.ProviderOpenAI, 200, chatStream)
	var text strings.Builder
	reply, err := p.Complete(context.Background(), request, func(s string) { text.WriteString(s) })
	if err != nil {
		t.Fatal(err)
	}
	if text.String() != "hello" || len(reply.Content) != 2 || reply.Content[1].Name != "t" || string(reply.Content[1].Args) != `{"a":1}` {
		t.Fatalf("%q %+v", text.String(), reply)
	}
	if reply.Usage != (model.ModelUsage{Input: 10, Output: 5, CacheRead: 4}) {
		t.Fatalf("%+v", reply.Usage)
	}
	if req.Header.Get("Authorization") != "Bearer sk-key" || req.URL.Path != "/chat/completions" {
		t.Fatalf("%v %v", req.Header, req.URL)
	}
	sent := string(*body)
	for _, want := range []string{`"role":"tool"`, `"tool_call_id":"c0"`, `"reasoning_effort":"max"`, `"role":"system"`} {
		if !strings.Contains(sent, want) {
			t.Errorf("request has no %s: %s", want, sent)
		}
	}
}

func TestNoLevelSendsNoReasoningField(t *testing.T) {
	p, _, body := serve(t, enum.ProviderCompatible, 200, "data: [DONE]\n")
	plain := request
	plain.Effort = ""
	if _, err := p.Complete(context.Background(), plain, func(string) {}); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(*body), "reasoning_effort") {
		t.Fatal("sent a field the server can refuse")
	}
}

const messagesStream = `event: message_start
data: {"type":"message_start","message":{"usage":{"input_tokens":3,"cache_read_input_tokens":4,"cache_creation_input_tokens":0}}}

data: {"type":"content_block_start","index":0,"content_block":{"type":"text"}}

data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hi"}}

data: {"type":"content_block_stop"}

data: {"type":"content_block_start","content_block":{"type":"tool_use","id":"c1","name":"t"}}

data: {"type":"content_block_delta","delta":{"type":"input_json_delta","partial_json":"{\"a\":1}"}}

data: {"type":"content_block_stop"}

data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":9}}

data: {"type":"message_stop"}
`

func TestMessagesStream(t *testing.T) {
	p, req, body := serve(t, enum.ProviderAnthropic, 200, messagesStream)
	reply, err := p.Complete(context.Background(), request, func(string) {})
	if err != nil {
		t.Fatal(err)
	}
	if len(reply.Content) != 2 || reply.Content[0].Text != "hi" || string(reply.Content[1].Args) != `{"a":1}` {
		t.Fatalf("%+v", reply)
	}
	if reply.Usage != (model.ModelUsage{Input: 7, Output: 9, CacheRead: 4}) {
		t.Fatalf("%+v", reply.Usage)
	}
	if req.Header.Get("x-api-key") != "sk-key" || req.Header.Get("anthropic-version") == "" {
		t.Fatalf("%v", req.Header)
	}
	if !strings.Contains(string(*body), `"tool_use_id":"c0"`) {
		t.Fatalf("%s", *body)
	}
	// the system and the last message are marked for the cache, nothing else
	var sent struct {
		System   []map[string]any `json:"system"`
		Messages []struct {
			Content []map[string]any `json:"content"`
		} `json:"messages"`
	}
	if err := json.Unmarshal(*body, &sent); err != nil {
		t.Fatal(err)
	}
	if len(sent.System) != 1 || sent.System[0]["cache_control"] == nil {
		t.Fatalf("%s", *body)
	}
	if n := strings.Count(string(*body), `"cache_control"`); n != 2 {
		t.Fatalf("%d marks: %s", n, *body)
	}
	last := sent.Messages[len(sent.Messages)-1].Content
	if last[len(last)-1]["cache_control"] == nil {
		t.Fatalf("%s", *body)
	}
}

func TestTruncatedRepliesRunNoTools(t *testing.T) {
	stream := strings.ReplaceAll(messagesStream, `"stop_reason":"tool_use"`, `"stop_reason":"max_tokens"`)
	p, _, _ := serve(t, enum.ProviderAnthropic, 200, stream)
	reply, err := p.Complete(context.Background(), request, func(string) {})
	if err != nil {
		t.Fatal(err)
	}
	if !reply.Truncated || len(reply.Content) != 1 {
		t.Fatalf("%+v", reply)
	}
}

func TestFailuresKeepTheServersTextOut(t *testing.T) {
	for _, c := range []struct {
		status int
		code   string
	}{{401, model.CodeInvalid}, {400, model.CodeInvalid}, {429, model.CodeUnavailable}, {503, model.CodeUnavailable}} {
		p, _, _ := serve(t, enum.ProviderOpenAI, c.status, `{"error":{"message":"bad key sk-key"}}`)
		_, err := p.Complete(context.Background(), request, func(string) {})
		var known *model.Error
		if !errors.As(err, &known) || known.Code != c.code || strings.Contains(known.Message, "sk-key") {
			t.Errorf("%d: %v", c.status, err)
		}
	}
}

func TestStreamEndingEarlyCanBeRetried(t *testing.T) {
	p, _, _ := serve(t, enum.ProviderOpenAI, 200, `data: {"choices":[{"delta":{"content":"he"}}]}`+"\n")
	_, err := p.Complete(context.Background(), request, func(string) {})
	var known *model.Error
	if !errors.As(err, &known) || known.Code != model.CodeUnavailable {
		t.Fatalf("%v", err)
	}
}

func TestModels(t *testing.T) {
	p, _, _ := serve(t, enum.ProviderOpenAI, 200, `{"data":[{"id":"a"},{"id":"models/b"}]}`)
	got, err := p.Models(context.Background())
	if err != nil || len(got) != 2 || got[1].ID != "b" || got[0].Thinking != nil {
		t.Fatalf("%v %v", got, err)
	}
}

func TestProvidersReportLevels(t *testing.T) {
	p, _, _ := serve(t, enum.ProviderAnthropic, 200, `{"data":[
		{"id":"a","capabilities":{"effort":{"supported":true,"max":{"supported":true},"xhigh":null,"high":{"supported":false},"low":{"supported":true}}}},
		{"id":"b","capabilities":null}]}`)
	got, err := p.Models(context.Background())
	if err != nil || !slices.Equal(got[0].Thinking, []string{"low", "max"}) || got[1].Thinking != nil {
		t.Fatalf("%+v %v", got, err)
	}
	p, _, _ = serve(t, enum.ProviderCompatible, 200, `{"data":[{"id":"d","effort":{"supported_levels":["low","high","max"]}}]}`)
	got, err = p.Models(context.Background())
	if err != nil || !slices.Equal(got[0].Thinking, []string{"low", "high", "max"}) {
		t.Fatalf("%+v %v", got, err)
	}
}

func TestAnthropicGetsTheLevel(t *testing.T) {
	p, _, body := serve(t, enum.ProviderAnthropic, 200, messagesStream)
	if _, err := p.Complete(context.Background(), request, func(string) {}); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(*body), `"output_config":{"effort":"max"}`) {
		t.Fatal(string(*body))
	}
}

func TestSubscriptions(t *testing.T) {
	f := NewFactory(nil, nil)
	defer f.Close()
	if _, err := f.For(model.ModelProvider{Kind: enum.ProviderOpenAI, Auth: model.ProviderAuth{Kind: "subscription"}}, ""); err == nil {
		t.Fatal("used without signing in")
	}
	on := model.ProviderAuth{Kind: "subscription", SignedIn: true}
	if _, err := f.For(model.ModelProvider{Kind: enum.ProviderGoogle, Auth: on}, ""); err == nil {
		t.Fatal("Google has no subscription here")
	}
	if _, err := f.For(model.ModelProvider{Kind: enum.ProviderOpenAI, Auth: on}, ""); err != nil {
		t.Fatal(err)
	}
	if _, err := f.Login(context.Background(), model.ModelProvider{Kind: enum.ProviderCompatible}, ""); err == nil {
		t.Fatal("a compatible API has no login")
	}
}

type stub struct{ got string }

func (s *stub) Complete(_ context.Context, req model.ModelRequest, _ func(string)) (model.ModelReply, error) {
	s.got = req.Model
	return model.ModelReply{}, nil
}
func (s *stub) Models(context.Context) ([]model.ModelSpec, error) {
	return []model.ModelSpec{{ID: "a", Thinking: []string{"low"}}}, nil
}

func TestSubscriptionModelsCarryAPrefixOnlyHere(t *testing.T) {
	s := &stub{}
	p := subscription{prefix: prefixCodex, client: s}
	specs, err := p.Models(context.Background())
	if err != nil || specs[0].ID != "openai-codex/a" || specs[0].Thinking[0] != "low" {
		t.Fatalf("%v %v", specs, err)
	}
	if _, err := p.Complete(context.Background(), model.ModelRequest{Model: specs[0].ID}, nil); err != nil || s.got != "a" {
		t.Fatalf("%q %v", s.got, err)
	}
}

func TestCompatibleExplicitNoneIsSent(t *testing.T) {
	p, _, body := serve(t, enum.ProviderCompatible, 200, "data: [DONE]\n")
	req := request
	req.Effort = "none"
	if _, err := p.Complete(context.Background(), req, func(string) {}); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(*body), `"reasoning_effort":"none"`) {
		t.Fatal("none was treated as default")
	}
}

func TestToolResultImagesReachTheModel(t *testing.T) {
	msgs := []model.Message{{Role: enum.RoleUser, Content: []model.Block{
		{Type: enum.BlockToolResult, ID: "a", Text: "Image a.png", MimeType: "image/png", Data: "QUJD"},
		{Type: enum.BlockToolResult, ID: "b", Text: "plain"},
	}}}

	anthropic, _ := json.Marshal(anthropicMessages(msgs))
	var sent []map[string]any
	json.Unmarshal(anthropic, &sent)
	results := sent[0]["content"].([]any)
	if parts, ok := results[0].(map[string]any)["content"].([]any); !ok || len(parts) != 2 || parts[1].(map[string]any)["type"] != "image" {
		t.Fatalf("anthropic: %s", anthropic)
	}
	if results[1].(map[string]any)["content"] != "plain" {
		t.Fatalf("anthropic: %s", anthropic)
	}

	// every tool message must come straight after the call, so the image waits behind them
	chat := chatMessages(model.ModelRequest{Messages: msgs})
	if len(chat) != 3 || chat[0].Role != "tool" || chat[1].Role != "tool" || chat[2].Role != "user" {
		t.Fatalf("openai: %+v", chat)
	}
	if body, _ := json.Marshal(chat[2].Content); !strings.Contains(string(body), "data:image/png;base64,QUJD") {
		t.Fatalf("openai: %s", body)
	}
}

func TestTooLongIsToldApartFromOtherRefusals(t *testing.T) {
	p, _, _ := serve(t, enum.ProviderOpenAI, http.StatusBadRequest, `{"error":{"code":"context_length_exceeded"}}`)
	_, err := p.Complete(context.Background(), model.ModelRequest{Model: "m"}, func(string) {})
	var failure *model.Error
	if !errors.As(err, &failure) || failure.Code != model.CodeContextOverflow {
		t.Fatalf("%v", err)
	}
	p, _, _ = serve(t, enum.ProviderOpenAI, http.StatusBadRequest, `{"error":{"code":"other"}}`)
	_, err = p.Complete(context.Background(), model.ModelRequest{Model: "m"}, func(string) {})
	if !errors.As(err, &failure) || failure.Code != model.CodeInvalid {
		t.Fatalf("%v", err)
	}
}
