package providers

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/yanun0323/Team-Work/internal/adapter"
	"github.com/yanun0323/Team-Work/internal/model"
	"github.com/yanun0323/Team-Work/internal/model/enum"
)

// The counting endpoint takes the same conversation the reply call would, without the stream or output fields
// a reply call needs, and answers with one number.
func TestAnthropicCountsTokens(t *testing.T) {
	p, asked, raw := serve(t, enum.ProviderAnthropic, 200, `{"input_tokens":4213}`)
	c, ok := p.(adapter.TokenCounter)
	if !ok {
		t.Fatal("anthropic does not count")
	}
	got, whole, err := c.CountTokens(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	if got != 4213 || !whole {
		t.Fatalf("counted %d whole=%v", got, whole)
	}
	if asked.URL.Path != "/v1/messages/count_tokens" {
		t.Fatalf("asked %v", asked.URL)
	}
	var sent map[string]any
	if json.Unmarshal(*raw, &sent) != nil {
		t.Fatalf("body is not json: %s", *raw)
	}
	for _, drop := range []string{"stream", "max_tokens", "output_config"} {
		if _, ok := sent[drop]; ok {
			t.Errorf("a count sends %s", drop)
		}
	}
	if sent["model"] != "m" || sent["system"] == nil || sent["tools"] == nil {
		t.Fatalf("a count must carry the whole request: %v", sent)
	}
	// the cache marks say nothing to a count
	if raw, _ := json.Marshal(sent["messages"]); strings.Contains(string(raw), "cache_control") {
		t.Errorf("a count marks the cache: %s", raw)
	}
}

// OpenAI's own API counts through the Responses API, with the system message as the first input item, as the
// reply call sends it.
func TestOpenAIResponsesCountsTokens(t *testing.T) {
	var sent map[string]any
	var path string
	p := serveBody(t, enum.ProviderOpenAI, `{"input_tokens":2048,"object":"response.input_tokens"}`, &sent, &path)
	c, ok := p.(adapter.TokenCounter)
	if !ok {
		t.Fatal("openAIResponses does not count")
	}
	got, whole, err := c.CountTokens(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	if got != 2048 || !whole {
		t.Fatalf("counted %d whole=%v", got, whole)
	}
	if path != "/v1/responses/input_tokens" {
		t.Fatalf("asked %v", path)
	}
	for _, drop := range []string{"stream", "store", "include", "prompt_cache_key"} {
		if _, ok := sent[drop]; ok {
			t.Errorf("a count sends %s", drop)
		}
	}
	raw, _ := json.Marshal(sent["input"])
	if !strings.Contains(string(raw), `"text":"sys"`) {
		t.Errorf("the system was left out: %s", raw)
	}
}

// A self-hosted server counts by tokenizing what the request carries. The question goes to the address the
// provider was set at with only its trailing /v1 taken off - a server proxied under a path prefix keeps that
// prefix, so its words and its key reach it and not another service behind the same host - and names the
// model, so a router counts with its vocabulary.
func TestLlamaCppTokenizes(t *testing.T) {
	var sent map[string]any
	var path string
	srv := capture(t, `{"tokens":[1,2,3,4,5,6,7]}`, &sent, &path)
	p := keyed(t, srv.URL+"/team-a/v1", enum.ProviderCompatible)
	c, ok := p.(adapter.TokenCounter)
	if !ok {
		t.Fatal("a self-hosted server does not count")
	}
	got, whole, err := c.CountTokens(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	if got != 7 || whole {
		t.Fatalf("counted %d whole=%v: a tokenize counts the words, not the whole request", got, whole)
	}
	if path != "/team-a/tokenize" {
		t.Fatalf("asked %v", path)
	}
	if sent["model"] != "m" {
		t.Errorf("the model was left out: %v", sent)
	}
	text, _ := sent["content"].(string)
	for _, want := range []string{"sys", "hi", "ok", `{"type":"object"}`} {
		if !strings.Contains(text, want) {
			t.Errorf("the text leaves out %q: %s", want, text)
		}
	}
}

// A server whose address does not end at the OpenAI API may keep its own endpoints elsewhere; counting there
// is given up rather than sent to a stranger on the host's root. A query or a fragment says nothing about
// where they are: the path is what must end in /v1.
func TestCountAddressWithoutAV1End(t *testing.T) {
	for _, tail := range []string{"/inference", "?route=/v1", "#piece/v1", "/v1beta"} {
		var path string
		srv := capture(t, `{"tokens":[1]}`, &map[string]any{}, &path)
		p := keyed(t, srv.URL+tail, enum.ProviderCompatible)
		if _, _, err := p.(adapter.TokenCounter).CountTokens(context.Background(), request); err == nil {
			t.Errorf("%v: counted at an address that may not serve /tokenize", tail)
		}
		if path != "" {
			t.Errorf("%v: asked %v", tail, path)
		}
	}
}

// A prefix that carries a user_info is not taken apart either: its address may belong to whomever set it.
func TestCountAddressOfAUser(t *testing.T) {
	p := keyed(t, "http://user:pw@host.example/v1", enum.ProviderCompatible)
	if _, _, err := p.(adapter.TokenCounter).CountTokens(context.Background(), request); err == nil {
		t.Fatal("counted at an address with a user_info")
	}
}

// A prefix set escaped stays escaped: /team%2Fa and /team/a are not promised to be the same service behind a
// proxy, so the question goes to the address exactly as it was set.
func TestTokenizeKeepsAnEscapedPrefix(t *testing.T) {
	var escaped, path string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		escaped, path = r.URL.EscapedPath(), r.URL.Path
		io.WriteString(w, `{"tokens":[1,2]}`)
	}))
	t.Cleanup(srv.Close)
	p := keyed(t, srv.URL+"/team%2Fa/v1", enum.ProviderCompatible)
	got, _, err := p.(adapter.TokenCounter).CountTokens(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	if got != 2 {
		t.Fatalf("counted %d", got)
	}
	if escaped != "/team%2Fa/tokenize" {
		t.Fatalf("asked %v (decoded %v)", escaped, path)
	}
}

// A big conversation tokenizes to hundreds of thousands of ids, well past a megabyte of JSON. The answer is
// counted as it streams, so a legal answer of any size counts.
func TestTokenizeCountsALargeAnswer(t *testing.T) {
	var sb strings.Builder
	sb.WriteString(`{"tokens":[`)
	for i := range 200_000 {
		if i > 0 {
			sb.WriteByte(',')
		}
		fmt.Fprintf(&sb, "%d", 10_000+i) // five digits each: the array alone passes 1 MiB
	}
	sb.WriteString("]}")
	answer := sb.String()
	if len(answer) < 1<<20 {
		t.Fatalf("the test answer is only %d bytes", len(answer))
	}
	var path string
	srv := capture(t, answer, &map[string]any{}, &path)
	p := keyed(t, srv.URL+"/v1", enum.ProviderCompatible)
	got, _, err := p.(adapter.TokenCounter).CountTokens(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	if got != 200_000 {
		t.Fatalf("counted %d", got)
	}
}

// A server with no counting endpoint answers 404; the number is not made up, the caller counts the rough way.
func TestCountWithoutAnEndpoint(t *testing.T) {
	p, _ := serveRoutes(t, enum.ProviderCompatible, map[string]string{})
	c := p.(adapter.TokenCounter)
	if _, _, err := c.CountTokens(context.Background(), request); err == nil {
		t.Fatal("no endpoint, no error")
	}
}

// A token array of anything but plain ids is no answer: a count of some of its items must not take the place
// of the safe estimate, so one wrong item fails the whole count. The document around it is held to the same
// shape: what does not close, or goes on after the one answer, counts for nothing.
func TestTokenizeRejectsAMixedAnswer(t *testing.T) {
	for _, body := range []string{
		`{"tokens":[null]}`,
		`{"tokens":[1,{}]}`,
		`{"tokens":[1,"two"]}`,
		`{"tokens":[1,"42"]}`, // a quoted number among ids is not one
		`{"tokens":[1,1.5]}`,
		`{"tokens":[1,true]}`,
		`{"tokens":[[1]]}`,
		`{"tokens":[0]]`,               // the array does not close
		`{"tokens":[0]}!`,              // nor does the document end here
		`{"tokens":[0]}{"tokens":[1]}`, // nor is a second document one answer
	} {
		var path string
		srv := capture(t, body, &map[string]any{}, &path)
		p := keyed(t, srv.URL+"/v1", enum.ProviderCompatible)
		if n, _, err := p.(adapter.TokenCounter).CountTokens(context.Background(), request); err == nil {
			t.Errorf("%q counted %d with no error", body, n)
		}
	}
}

func TestCountRejectsAnEmptyAnswer(t *testing.T) {
	for _, c := range []struct {
		kind enum.ProviderKind
		body string
	}{
		{enum.ProviderOpenAI, `{}`},
		{enum.ProviderOpenAI, `{"input_tokens":0}`},
		{enum.ProviderOpenAI, `not json`},
		{enum.ProviderCompatible, `{"tokens":[]}`},
		{enum.ProviderCompatible, `{"tokens":5}`},
		{enum.ProviderCompatible, `[1,2]`},
		{enum.ProviderCompatible, `{"tokens":{"id":1}}`}, // with_pieces answers objects, which count as no number
	} {
		p := answerAt(t, c.kind, c.body)
		if _, _, err := p.(adapter.TokenCounter).CountTokens(context.Background(), request); err == nil {
			t.Errorf("%q answered without a number", c.body)
		}
	}
}

// The subscriptions run through a SDK child process or ChatGPT's own backend, which the app cannot ask to count.
func TestSubscriptionsDoNotCount(t *testing.T) {
	for _, p := range []adapter.Provider{subscription{}} {
		if _, ok := p.(adapter.TokenCounter); ok {
			t.Errorf("%T counts", p)
		}
	}
	if _, ok := adapter.Provider(openAI{}).(adapter.TokenCounter); !ok {
		t.Error("openAI does not count")
	}
	if _, ok := adapter.Provider(anthropic{}).(adapter.TokenCounter); !ok {
		t.Error("anthropic does not count")
	}
	if _, ok := adapter.Provider(openAIResponses{}).(adapter.TokenCounter); !ok {
		t.Error("openAIResponses does not count")
	}
}

// countableText carries what the model at this address really receives: the instructions, the tools, and the
// words of the conversation as chatMessages sends them. Reasoning the endpoint never sees stays out, as does a
// raw item from another model or address, which the request leaves out too. A picture's base64 does not go to a
// text endpoint; its worth comes from roughImages, where the rough measure keeps holding it.
func TestCountableTextCarriesOnlyWhatIsSent(t *testing.T) {
	ours := chatOrigin("http://x/v1", "m")
	req := model.ModelRequest{System: "S", Tools: []model.ToolSpec{{Name: "T", Description: "D", Parameters: json.RawMessage(`{"P":1}`)}},
		Messages: []model.Message{
			{Role: enum.RoleUser, Content: []model.Block{{Type: enum.BlockText, Text: "W"}, {Type: enum.BlockImage, MimeType: "image/png", Data: "AAAA"}}},
			{Role: enum.RoleAssistant, Content: []model.Block{
				{Type: enum.BlockReasoning, Text: "never sent", Raw: json.RawMessage(`{"THOUGHTS"}`)},
				{Type: enum.BlockToolCall, Name: "C", Args: json.RawMessage(`{"A":2}`), Raw: json.RawMessage(`{"OURS"}`), Origin: ours},
				{Type: enum.BlockToolCall, Name: "C2", Args: json.RawMessage(`{"A":3}`), Raw: json.RawMessage(`{"THEIRS"}`), Origin: "chat:http://y/v1 other"},
			}},
			{Role: enum.RoleUser, Content: []model.Block{{Type: enum.BlockToolResult, Text: "R", Data: "BBBB", MimeType: "image/png"}}},
		}}
	text := countableText(req, ours)
	for _, want := range []string{"S", "T", "D", `{"P":1}`, "W", `{"A":2}`, `{"OURS"}`, "C2", `{"A":3}`, "R"} {
		if !strings.Contains(text, want) {
			t.Errorf("leaves out %q: %s", want, text)
		}
	}
	for _, drop := range []string{"never sent", `{"THOUGHTS"}`, `{"THEIRS"}`, "AAAA", "BBBB"} {
		if strings.Contains(text, drop) {
			t.Errorf("counts what is not sent: %q in %s", drop, text)
		}
	}
	if got := roughImages(req.Messages); got != 2*countImageWords {
		t.Fatalf("images held at %d", got)
	}
	// what the text endpoint answered and what it cannot price add up in CountTokens: three tokens of words
	// still carry the two pictures' rough worth
	var path string
	srv := capture(t, `{"tokens":[1,2,3]}`, &map[string]any{}, &path)
	p := keyed(t, srv.URL+"/v1", enum.ProviderCompatible)
	n, whole, err := p.(adapter.TokenCounter).CountTokens(context.Background(), req)
	if err != nil {
		t.Fatal(err)
	}
	if n != 3+2*countImageWords || whole {
		t.Fatalf("counted %d whole=%v", n, whole)
	}
}

// capture is a server that answers one body and keeps the JSON it was sent and the path it was asked at.
func capture(t *testing.T, answer string, into *map[string]any, path *string) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		*path = r.URL.Path
		raw, _ := io.ReadAll(r.Body)
		if len(raw) > 0 {
			if err := json.Unmarshal(raw, into); err != nil {
				t.Errorf("body is not json: %s", raw)
			}
		}
		io.WriteString(w, answer)
	}))
	t.Cleanup(srv.Close)
	return srv
}

// keyed is the provider a set address and key make, as the factory builds one.
func keyed(t *testing.T, base string, kind enum.ProviderKind) adapter.Provider {
	t.Helper()
	p, err := NewFactory(nil, nil).For(model.ModelProvider{Name: "x", Kind: kind, BaseURL: base, Auth: model.ProviderAuth{Kind: "apiKey"}}, "sk-key")
	if err != nil {
		t.Fatal(err)
	}
	return p
}

// serveBody is a server answering under /v1, for a provider built the way serveRoutes builds one.
func serveBody(t *testing.T, kind enum.ProviderKind, answer string, into *map[string]any, path *string) adapter.Provider {
	t.Helper()
	return keyed(t, capture(t, answer, into, path).URL+"/v1", kind)
}

// answerAt answers every path with one body.
func answerAt(t *testing.T, kind enum.ProviderKind, answer string) adapter.Provider {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		io.WriteString(w, answer)
	}))
	t.Cleanup(srv.Close)
	return keyed(t, srv.URL+"/v1", kind)
}
