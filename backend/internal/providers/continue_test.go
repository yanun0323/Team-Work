package providers

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/yanun0323/Team-Work/internal/adapter"
	"github.com/yanun0323/Team-Work/internal/model"
	"github.com/yanun0323/Team-Work/internal/model/enum"
)

// serveRounds answers the n-th request with replies[n] (the last one again once they run out) and keeps every body.
func serveRounds(t *testing.T, kind enum.ProviderKind, replies ...string) (adapter.Provider, *[]map[string]any) {
	t.Helper()
	bodies := &[]map[string]any{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		var body map[string]any
		json.Unmarshal(raw, &body)
		*bodies = append(*bodies, body)
		reply := replies[min(len(*bodies), len(replies))-1]
		if status, rest, ok := strings.Cut(reply, " "); ok && status == "500" {
			w.WriteHeader(500)
			io.WriteString(w, rest)
			return
		}
		io.WriteString(w, reply)
	}))
	t.Cleanup(srv.Close)
	p, err := NewFactory(nil, nil).For(model.ModelProvider{Name: "x", Kind: kind, BaseURL: srv.URL, Auth: model.ProviderAuth{Kind: "apiKey"}}, "k")
	if err != nil {
		t.Fatal(err)
	}
	return p, bodies
}

func cutStream(text string, prompt, completion int) string {
	chunk, _ := json.Marshal(map[string]any{"choices": []any{map[string]any{"delta": map[string]string{"content": text}, "finish_reason": "length"}}})
	usage, _ := json.Marshal(map[string]any{"choices": []any{}, "usage": map[string]any{"prompt_tokens": prompt, "completion_tokens": completion, "prompt_tokens_details": map[string]int{"cached_tokens": prompt / 2}}})
	return "data: " + string(chunk) + "\n\ndata: " + string(usage) + "\n\ndata: [DONE]\n"
}

func lastMessage(body map[string]any) map[string]any {
	msgs, _ := body["messages"].([]any)
	if len(msgs) == 0 {
		return nil
	}
	m, _ := msgs[len(msgs)-1].(map[string]any)
	return m
}

// A self-hosted server that cuts a reply at its output limit is asked to go on from where it stopped
// (continue_final_message, as vLLM, SGLang and sushi name it), so a long answer arrives whole instead of failing.
func TestCompatibleRepliesCutAtTheLimitAreContinued(t *testing.T) {
	end := `data: {"choices":[{"delta":{"content":"第二段"},"finish_reason":"stop"}]}

data: {"choices":[],"usage":{"prompt_tokens":108,"completion_tokens":3,"prompt_tokens_details":{"cached_tokens":100}}}

data: [DONE]
`
	p, bodies := serveRounds(t, enum.ProviderCompatible, cutStream("第一段\n\n", 100, 8), end)
	var streamed strings.Builder
	reply, err := p.Complete(context.Background(), request, func(s string) { streamed.WriteString(s) })
	if err != nil {
		t.Fatal(err)
	}
	if reply.Truncated || len(reply.Content) != 1 || reply.Content[0].Text != "第一段第二段" {
		t.Fatalf("%+v", reply)
	}
	if !strings.Contains(streamed.String(), "第一段") || !strings.HasSuffix(streamed.String(), "第二段") {
		t.Fatalf("streamed %q", streamed.String())
	}
	// counted as one reply: the first request's input, and every piece of output
	if reply.Usage != (model.ModelUsage{Input: 100, Output: 11, CacheRead: 50, CacheReadKnown: true}) {
		t.Fatalf("%+v", reply.Usage)
	}
	if len(*bodies) != 2 {
		t.Fatalf("%d requests", len(*bodies))
	}
	first, second := (*bodies)[0], (*bodies)[1]
	if _, ok := first["continue_final_message"]; ok {
		t.Fatalf("first request asked to continue: %v", first)
	}
	if second["continue_final_message"] != true || second["add_generation_prompt"] != false {
		t.Fatalf("second request: %v", second)
	}
	// the partial goes back as the assistant's last message, its trailing blank lines left for the model to write
	if last := lastMessage(second); last["role"] != "assistant" || last["content"] != "第一段" {
		t.Fatalf("last message %v", last)
	}
	if len(second["messages"].([]any)) != len(first["messages"].([]any))+1 || second["tools"] == nil {
		t.Fatalf("second request is not the first plus the partial: %v", second)
	}
}

func TestContinuingStopsAfterAFewTries(t *testing.T) {
	p, bodies := serveRounds(t, enum.ProviderCompatible, cutStream("又一段", 10, 5))
	reply, err := p.Complete(context.Background(), request, func(string) {})
	if err != nil {
		t.Fatal(err)
	}
	if !reply.Truncated || len(*bodies) != 1+maxContinues || reply.Content[0].Text != strings.Repeat("又一段", 1+maxContinues) {
		t.Fatalf("%d requests: %+v", len(*bodies), reply)
	}
}

// A continuation that fails leaves the reply as cut, which the caller reports as before.
func TestAFailedContinuationLeavesTheReplyCut(t *testing.T) {
	p, bodies := serveRounds(t, enum.ProviderCompatible, cutStream("一段", 10, 5), `500 {"error":"boom"}`)
	reply, err := p.Complete(context.Background(), request, func(string) {})
	if err != nil || !reply.Truncated || reply.Content[0].Text != "一段" || reply.Usage.Output != 5 || len(*bodies) != 2 {
		t.Fatalf("%v %d requests: %+v", err, len(*bodies), reply)
	}
}

func TestRepliesThatCannotBeContinuedStayCut(t *testing.T) {
	callCut := `data: {"choices":[{"delta":{"content":"先讀檔","tool_calls":[{"index":0,"id":"c1","function":{"name":"t","arguments":"{\"pa"}}]},"finish_reason":"length"}]}

data: [DONE]
`
	thoughtOnly := `data: {"choices":[{"delta":{"content":"  "},"finish_reason":"length"}]}

data: [DONE]
`
	for name, c := range map[string]struct {
		kind   enum.ProviderKind
		stream string
	}{
		"not self-hosted":  {enum.ProviderGoogle, cutStream("一段", 10, 5)},
		"half a tool call": {enum.ProviderCompatible, callCut},
		"no text":          {enum.ProviderCompatible, thoughtOnly},
	} {
		p, bodies := serveRounds(t, c.kind, c.stream)
		reply, err := p.Complete(context.Background(), request, func(string) {})
		if err != nil || !reply.Truncated || len(*bodies) != 1 {
			t.Errorf("%s: %v %d requests: %+v", name, err, len(*bodies), reply)
		}
	}
}
