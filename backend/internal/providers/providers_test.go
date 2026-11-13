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
	"time"

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
	p, req, body := serve(t, enum.ProviderCompatible, 200, chatStream)
	var text strings.Builder
	reply, err := p.Complete(context.Background(), request, func(s string) { text.WriteString(s) })
	if err != nil {
		t.Fatal(err)
	}
	if text.String() != "hello" || len(reply.Content) != 2 || reply.Content[1].Name != "t" || string(reply.Content[1].Args) != `{"a":1}` {
		t.Fatalf("%q %+v", text.String(), reply)
	}
	if reply.Usage != (model.ModelUsage{Input: 10, Output: 5, CacheRead: 4, CacheReadKnown: true}) {
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
	if reply.Usage != (model.ModelUsage{Input: 7, Output: 9, CacheRead: 4, CacheReadKnown: true, CacheWriteKnown: true}) {
		t.Fatalf("%+v", reply.Usage)
	}
	written, _, _ := serve(t, enum.ProviderAnthropic, 200, strings.Replace(messagesStream, `"cache_creation_input_tokens":0`, `"cache_creation_input_tokens":2`, 1))
	if r, err := written.Complete(context.Background(), request, func(string) {}); err != nil || r.Usage != (model.ModelUsage{Input: 9, Output: 9, CacheRead: 4, CacheReadKnown: true, CacheWrite: 2, CacheWriteKnown: true}) {
		t.Fatalf("cache writes: %+v %v", r.Usage, err)
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

// Some local servers list capabilities as names and the levels as reasoning_efforts.
func TestCapabilityNamesAndReasoningEfforts(t *testing.T) {
	p, _, _ := serve(t, enum.ProviderCompatible, 200, `{"object":"list","data":[
		{"id":"beamster/Qwen","capabilities":["chat","tool_use","reasoning"],"reasoning_efforts":["off","low","medium","xhigh"],
			"reasoning_effort_budgets":{"low":2048},"meta":{"engine":"mlx"}},
		{"id":"plain","capabilities":["chat"]}]}`)
	got, err := p.Models(context.Background())
	if err != nil || len(got) != 2 || got[0].ID != "beamster/Qwen" ||
		!slices.Equal(got[0].Thinking, []string{"off", "low", "medium", "xhigh"}) || got[1].Thinking != nil {
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

func TestOnlyOpenAIGetsAPromptCacheKey(t *testing.T) {
	for _, c := range []struct {
		kind    enum.ProviderKind
		session string
		want    bool
	}{{enum.ProviderOpenAI, "sub-1", true}, {enum.ProviderOpenAI, "", false}, {enum.ProviderGoogle, "sub-1", false}, {enum.ProviderCompatible, "sub-1", false}} {
		stream := "data: [DONE]\n"
		if c.kind == enum.ProviderOpenAI {
			stream = `data: {"type":"response.completed","response":{"usage":{"input_tokens":1,"output_tokens":1}}}` + "\n"
		}
		p, _, body := serve(t, c.kind, 200, stream)
		req := request
		req.Session = c.session
		if _, err := p.Complete(context.Background(), req, func(string) {}); err != nil {
			t.Fatal(err)
		}
		if got := strings.Contains(string(*body), `"prompt_cache_key":"sub-1"`); got != c.want || (!c.want && strings.Contains(string(*body), "prompt_cache_key")) {
			t.Errorf("%s session %q: sent prompt_cache_key %v, want %v", c.kind, c.session, got, c.want)
		}
	}
}

func TestKeyedProvidersSkipReasoningBlocks(t *testing.T) {
	msgs := []model.Message{{Role: enum.RoleAssistant, Content: []model.Block{
		{Type: enum.BlockReasoning, Raw: json.RawMessage(`{"type":"thinking","signature":"sig-x"}`), Origin: "claude-code:m"},
		{Type: enum.BlockText, Text: "ok"},
	}}}
	a, _ := json.Marshal(anthropicMessages(msgs))
	o, _ := json.Marshal(chatMessages(model.ModelRequest{Messages: msgs}))
	for _, body := range []string{string(a), string(o)} {
		if strings.Contains(body, "sig-x") || !strings.Contains(body, "ok") {
			t.Fatalf("%s", body)
		}
	}
}

// A compatible API that says nothing about its cache leaves the read unknown, not a miss.
func TestUnreportedCacheReadIsUnknown(t *testing.T) {
	p, _, _ := serve(t, enum.ProviderCompatible, 200, strings.Replace(chatStream, `,"prompt_tokens_details":{"cached_tokens":4}`, "", 1))
	reply, err := p.Complete(context.Background(), request, func(string) {})
	if err != nil || reply.Usage != (model.ModelUsage{Input: 10, Output: 5}) {
		t.Fatalf("%+v %v", reply.Usage, err)
	}
}

const responsesStream = `data: {"type":"response.output_text.delta","delta":"he"}

data: {"type":"response.output_text.delta","delta":"llo"}

data: {"type":"response.output_item.done","item":{"id":"msg_1","type":"message","role":"assistant","phase":"commentary","content":[{"type":"output_text","text":"hello"}]}}

data: {"type":"response.output_item.done","item":{"id":"fc_1","type":"function_call","call_id":"c1","name":"t","arguments":"{\"a\": 1}"}}

data: {"type":"response.completed","response":{"usage":{"input_tokens":10,"output_tokens":5,"input_tokens_details":{"cached_tokens":4,"cache_write_tokens":6}}}}
`

// OpenAI's own API is spoken as ChatGPT's backend is, through the Responses API, so it keeps the cache the same way:
// nothing stored there, the system prompt leading the input, and what the model wrote going back as it came.
func TestOpenAISpeaksResponses(t *testing.T) {
	p, req, body := serve(t, enum.ProviderOpenAI, 200, responsesStream)
	var text strings.Builder
	sent := request
	sent.Session = "sub-1"
	reply, err := p.Complete(context.Background(), sent, func(s string) { text.WriteString(s) })
	if err != nil {
		t.Fatal(err)
	}
	if req.URL.Path != "/responses" || req.Header.Get("Authorization") != "Bearer sk-key" {
		t.Fatalf("%v %v", req.URL, req.Header)
	}
	if text.String() != "hello" || len(reply.Content) != 2 || reply.Content[0].Origin != "openai:m" ||
		reply.Content[1].Name != "t" || string(reply.Content[1].Args) != `{"a": 1}` {
		t.Fatalf("%q %+v", text.String(), reply.Content)
	}
	if reply.Usage != (model.ModelUsage{Input: 10, Output: 5, CacheRead: 4, CacheReadKnown: true, CacheWrite: 6, CacheWriteKnown: true}) {
		t.Fatalf("%+v", reply.Usage)
	}
	got := string(*body)
	for _, want := range []string{`"store":false`, `"role":"developer"`, `"include":["reasoning.encrypted_content"]`, `"reasoning":{"effort":"max"}`, `"prompt_cache_key":"sub-1"`, `"type":"function_call_output"`} {
		if !strings.Contains(got, want) {
			t.Errorf("request has no %s: %s", want, got)
		}
	}
	// the API asks a verified organization for summaries, and not every model takes a verbosity
	for _, unwanted := range []string{"summary", "verbosity", "instructions", "messages"} {
		if strings.Contains(got, `"`+unwanted+`"`) {
			t.Errorf("request has %s: %s", unwanted, got)
		}
	}
}

// Models that do not reason refuse a request for encrypted reasoning.
func TestOnlyReasoningModelsAreAskedForTheirReasoning(t *testing.T) {
	for id, want := range map[string]bool{"gpt-5.5": true, "gpt-6-luna": true, "o3": true, "gpt-4.1": false, "gpt-4o-mini": false, "chat-latest": false, "chatgpt-4o-latest": false, "gpt-5-chat-latest": false} {
		p, _, body := serve(t, enum.ProviderOpenAI, 200, responsesStream)
		req := request
		req.Model = id
		if _, err := p.Complete(context.Background(), req, func(string) {}); err != nil {
			t.Fatal(err)
		}
		if got := strings.Contains(string(*body), "reasoning.encrypted_content"); got != want {
			t.Errorf("%s: asked for reasoning %v, want %v", id, got, want)
		}
	}
}

// A reply that stops sending for too long is given up on, as one that can be tried again.
func TestAStalledReplyIsGivenUp(t *testing.T) {
	stall := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		io.WriteString(w, `data: {"choices":[{"delta":{"content":"he"}}]}`+"\n\n")
		w.(http.Flusher).Flush()
		<-stall
	}))
	defer srv.Close()
	defer close(stall) // before the server closes, as it waits for its handlers
	defer func(d time.Duration) { streamIdle = d }(streamIdle)
	streamIdle = 50 * time.Millisecond
	for _, kind := range []enum.ProviderKind{enum.ProviderOpenAI, enum.ProviderCompatible, enum.ProviderAnthropic} {
		p, err := NewFactory(nil, nil).For(model.ModelProvider{Name: "x", Kind: kind, BaseURL: srv.URL, Auth: model.ProviderAuth{Kind: "apiKey"}}, "sk")
		if err != nil {
			t.Fatal(err)
		}
		done := make(chan error, 1)
		go func() {
			_, err := p.Complete(context.Background(), request, func(string) {})
			done <- err
		}()
		select {
		case err := <-done:
			var known *model.Error
			if !errors.As(err, &known) || known.Code != model.CodeUnavailable {
				t.Fatalf("%s: %v", kind, err)
			}
		case <-time.After(5 * time.Second):
			t.Fatalf("%s: still waiting", kind)
		}
	}
}

// Every key-paid provider shares one pool of connections, so a conversation's calls reuse the one already open.
func TestKeyedProvidersShareTheirConnections(t *testing.T) {
	f := NewFactory(nil, nil)
	a, _ := f.For(model.ModelProvider{Kind: enum.ProviderOpenAI, Auth: model.ProviderAuth{Kind: "apiKey"}}, "k1")
	b, _ := f.For(model.ModelProvider{Kind: enum.ProviderCompatible, BaseURL: "http://x", Auth: model.ProviderAuth{Kind: "apiKey"}}, "k2")
	if a.(openAIResponses).http != b.(openAI).http {
		t.Fatal("each provider opened its own connections")
	}
}
