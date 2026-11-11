package codex

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/yanun0323/Team-Work/internal/model"
	"github.com/yanun0323/Team-Work/internal/model/enum"
)

type memSecrets struct {
	mu sync.Mutex
	m  map[string]string
}

func (s *memSecrets) Secret(_ context.Context, id string) (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.m[id], nil
}
func (s *memSecrets) SetSecret(_ context.Context, id, v string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.m[id] = v
	return nil
}
func (s *memSecrets) DeleteSecret(_ context.Context, id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.m, id)
	return nil
}

func jwt(account string) string {
	claims, _ := json.Marshal(map[string]any{accountClaim: map[string]string{"chatgpt_account_id": account}})
	return "h." + base64.RawURLEncoding.EncodeToString(claims) + ".s"
}

// fake is ChatGPT's login service and backend.
type fake struct {
	mu          sync.Mutex
	refreshes   int
	form        url.Values
	reject      int // how many API calls answer 401
	bodies      []string
	headers     []http.Header
	stream      string
	status      int
	devicePolls int
	usage       string
}

func (f *fake) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	raw, _ := io.ReadAll(r.Body)
	switch r.URL.Path {
	case "/oauth/token":
		f.form, _ = url.ParseQuery(string(raw))
		if f.form.Get("grant_type") == "refresh_token" {
			f.refreshes++
		}
		fmt.Fprintf(w, `{"access_token":%q,"refresh_token":"r%d","expires_in":3600}`, jwt("acct"), f.refreshes)
	case "/api/accounts/deviceauth/usercode":
		fmt.Fprint(w, `{"device_auth_id":"dev","user_code":"AB-12","interval":"0.01"}`)
	case "/api/accounts/deviceauth/token":
		f.devicePolls++
		if f.devicePolls == 1 {
			w.WriteHeader(http.StatusForbidden)
			return
		}
		fmt.Fprint(w, `{"authorization_code":"devcode","code_verifier":"devver"}`)
	case "/codex/models":
		fmt.Fprint(w, `{"models":[{"slug":"gpt-a","visibility":"list","supported_reasoning_levels":[{"effort":"low"},{"effort":"xhigh"}]},{"slug":"hidden","visibility":"hide"}]}`)
	case "/wham/usage":
		fmt.Fprint(w, f.usage)
	case "/codex/responses":
		f.bodies = append(f.bodies, string(raw))
		f.headers = append(f.headers, r.Header.Clone())
		if f.reject > 0 {
			f.reject--
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		if f.status != 0 {
			w.WriteHeader(f.status)
		}
		fmt.Fprint(w, f.stream)
	}
}

func setup(t *testing.T, f *fake) (*Client, *memSecrets) {
	t.Helper()
	srv := httptest.NewServer(f)
	t.Cleanup(srv.Close)
	secrets := &memSecrets{m: map[string]string{}}
	c := New("mp-1", secrets)
	c.AuthURL, c.APIURL = srv.URL, srv.URL
	c.OpenBrowser = func(string) error { return nil }
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	c.CallbackAddr = l.Addr().String()
	l.Close()
	return c, secrets
}

func signIn(t *testing.T, c *Client, s *memSecrets, expires int64) {
	t.Helper()
	raw, _ := json.Marshal(Credentials{Access: jwt("acct"), Refresh: "r0", Expires: expires, AccountID: "acct"})
	s.m[c.ID] = string(raw)
}

func TestBrowserLoginComesBackToThisMachine(t *testing.T) {
	f := &fake{}
	c, secrets := setup(t, f)
	flow, err := c.Login(context.Background(), "browser")
	if err != nil {
		t.Fatal(err)
	}
	u, _ := url.Parse(flow.Prompt.URL)
	q := u.Query()
	if q.Get("code_challenge_method") != "S256" || q.Get("state") == "" || q.Get("client_id") != clientID {
		t.Fatal(flow.Prompt.URL)
	}
	done := make(chan error, 1)
	go func() { done <- flow.Wait(context.Background()) }()

	// a request with the wrong state, as another site could send, changes nothing
	res, err := http.Get("http://" + c.CallbackAddr + callbackPath + "?code=evil&state=wrong")
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != http.StatusBadRequest {
		t.Fatal(res.StatusCode)
	}
	res, err = http.Get("http://" + c.CallbackAddr + callbackPath + "?code=good&state=" + q.Get("state"))
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	if f.form.Get("code") != "good" || f.form.Get("code_verifier") == "" {
		t.Fatalf("%v", f.form)
	}
	var saved Credentials
	if json.Unmarshal([]byte(secrets.m["mp-1"]), &saved) != nil || saved.AccountID != "acct" || saved.Refresh == "" {
		t.Fatalf("%v", secrets.m)
	}
	// the port is free again
	if l, err := net.Listen("tcp", c.CallbackAddr); err != nil {
		t.Fatal("callback server left running")
	} else {
		l.Close()
	}
}

func TestPastingTheAddressAlsoSignsIn(t *testing.T) {
	c, secrets := setup(t, &fake{})
	flow, err := c.Login(context.Background(), "browser")
	if err != nil {
		t.Fatal(err)
	}
	u, _ := url.Parse(flow.Prompt.URL)
	if err := flow.Paste("http://localhost:1455/auth/callback?code=x&state=wrong"); err == nil {
		t.Fatal("another login's address was accepted")
	}
	if err := flow.Paste("hello there"); err == nil {
		t.Fatal("no code was accepted")
	}
	if err := flow.Paste("http://localhost:1455/auth/callback?code=x&state=" + u.Query().Get("state")); err != nil {
		t.Fatal(err)
	}
	if err := flow.Wait(context.Background()); err != nil {
		t.Fatal(err)
	}
	if secrets.m["mp-1"] == "" {
		t.Fatal("nothing saved")
	}
}

func TestCancellingALoginFreesThePortAndSavesNothing(t *testing.T) {
	c, secrets := setup(t, &fake{})
	flow, err := c.Login(context.Background(), "browser")
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := flow.Wait(ctx); !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
	if len(secrets.m) != 0 {
		t.Fatal("saved")
	}
	if l, err := net.Listen("tcp", c.CallbackAddr); err != nil {
		t.Fatal("port still held")
	} else {
		l.Close()
	}
}

func TestDeviceLogin(t *testing.T) {
	f := &fake{}
	c, secrets := setup(t, f)
	flow, err := c.Login(context.Background(), "device")
	if err != nil {
		t.Fatal(err)
	}
	if flow.Prompt.UserCode != "AB-12" || !strings.HasSuffix(flow.Prompt.URL, "/codex/device") {
		t.Fatalf("%+v", flow.Prompt)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := flow.Wait(ctx); err != nil {
		t.Fatal(err)
	}
	if f.form.Get("code") != "devcode" || f.form.Get("code_verifier") != "devver" || secrets.m["mp-1"] == "" {
		t.Fatalf("%v", f.form)
	}
}

func TestRefreshHappensOnceAndIsSaved(t *testing.T) {
	f := &fake{}
	c, secrets := setup(t, f)
	signIn(t, c, secrets, 0) // already run out
	var wg sync.WaitGroup
	for range 8 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, err := c.session(context.Background(), false); err != nil {
				t.Error(err)
			}
		}()
	}
	wg.Wait()
	if f.refreshes != 1 {
		t.Fatalf("a one-time refresh token was spent %d times", f.refreshes)
	}
	if !strings.Contains(secrets.m["mp-1"], `"refresh":"r1"`) {
		t.Fatal(secrets.m)
	}
}

const stream = `data: {"type":"response.output_text.delta","delta":"he"}

data: {"type":"response.output_text.delta","delta":"llo"}

data: {"type":"response.output_item.done","item":{"type":"function_call","call_id":"c1","name":"t","arguments":"{\"a\":1}"}}

data: {"type":"response.completed","response":{"usage":{"input_tokens":10,"output_tokens":5,"input_tokens_details":{"cached_tokens":4}}}}

`

var request = model.ModelRequest{Model: "gpt-a", System: "sys", Session: "s1", Effort: "max", Tools: []model.ToolSpec{{Name: "t", Parameters: json.RawMessage(`{"type":"object"}`)}},
	Messages: []model.Message{
		{Role: enum.RoleUser, Content: []model.Block{{Type: enum.BlockText, Text: "hi"}, {Type: enum.BlockImage, MimeType: "image/png", Data: "AA"}}},
		{Role: enum.RoleAssistant, Content: []model.Block{{Type: enum.BlockText, Text: "ok"}, {Type: enum.BlockToolCall, ID: "c0", Name: "t", Args: json.RawMessage(`{}`)}}},
		{Role: enum.RoleUser, Content: []model.Block{{Type: enum.BlockToolResult, ID: "c0", Text: "done"}}},
	}}

func TestCompleteAndTheRequestItSends(t *testing.T) {
	f := &fake{stream: stream}
	c, secrets := setup(t, f)
	signIn(t, c, secrets, time.Now().Add(time.Hour).UnixMilli())
	var text strings.Builder
	reply, err := c.Complete(context.Background(), request, func(s string) { text.WriteString(s) })
	if err != nil {
		t.Fatal(err)
	}
	if text.String() != "hello" || len(reply.Content) != 2 || reply.Content[1].Name != "t" || string(reply.Content[1].Args) != `{"a":1}` {
		t.Fatalf("%+v", reply)
	}
	if reply.Usage != (model.ModelUsage{Input: 10, Output: 5, CacheRead: 4}) {
		t.Fatalf("%+v", reply.Usage)
	}
	h := f.headers[0]
	if h.Get("chatgpt-account-id") != "acct" || !strings.HasPrefix(h.Get("Authorization"), "Bearer ") {
		t.Fatalf("%v", h)
	}
	sent := f.bodies[0]
	for _, want := range []string{`"instructions":"sys"`, `"type":"input_image"`, `"type":"output_text"`, `"type":"function_call","arguments":"{}"`, `"type":"function_call_output"`, `"call_id":"c0"`, `"effort":"max"`, `"prompt_cache_key":"s1"`, `"store":false`} {
		if !strings.Contains(sent, want) && !containsCall(sent, want) {
			t.Errorf("request has no %s: %s", want, sent)
		}
	}
}

// json encodes map keys in order, so a function_call's fields are not next to each other as written above.
func containsCall(sent, want string) bool {
	return strings.Contains(want, "function_call\"") && strings.Contains(sent, `"type":"function_call"`)
}

func TestTokensTurnedDownAreReplacedOnce(t *testing.T) {
	f := &fake{stream: stream, reject: 1}
	c, secrets := setup(t, f)
	signIn(t, c, secrets, time.Now().Add(time.Hour).UnixMilli())
	if _, err := c.Complete(context.Background(), request, func(string) {}); err != nil {
		t.Fatal(err)
	}
	if f.refreshes != 1 || len(f.bodies) != 2 {
		t.Fatalf("%d %d", f.refreshes, len(f.bodies))
	}
	f.reject = 5
	_, err := c.Complete(context.Background(), request, func(string) {})
	var known *model.Error
	if !errors.As(err, &known) || known.Code != model.CodeSignedOut {
		t.Fatal(err)
	}
}

func TestFailuresSayWhatToDoAndKeepServerTextOut(t *testing.T) {
	cases := []struct {
		status int
		body   string
		code   string
		want   string
	}{
		{429, `{"error":{"code":"usage_limit_reached"}}`, model.CodeInvalid, "額度用完"},
		{429, `{"error":{"message":"secret text"}}`, model.CodeUnavailable, "忙碌"},
		{503, `secret text`, model.CodeUnavailable, "忙碌"},
		{400, `{"error":{"message":"secret text"}}`, model.CodeInvalid, "拒絕"},
		{200, `data: {"type":"response.failed","response":{"error":{"code":"bad","message":"secret text"}}}` + "\n", model.CodeInvalid, "無法回覆"},
		{200, `data: {"type":"response.output_text.delta","delta":"he"}` + "\n", model.CodeUnavailable, "中斷"},
	}
	for _, tc := range cases {
		f := &fake{status: tc.status, stream: tc.body}
		c, secrets := setup(t, f)
		signIn(t, c, secrets, time.Now().Add(time.Hour).UnixMilli())
		_, err := c.Complete(context.Background(), request, func(string) {})
		var known *model.Error
		if !errors.As(err, &known) || known.Code != tc.code || !strings.Contains(known.Message, tc.want) || strings.Contains(known.Message, "secret") {
			t.Errorf("%d %s: %v", tc.status, tc.body, err)
		}
	}
}

func TestTruncatedRepliesRunNoTools(t *testing.T) {
	s := strings.ReplaceAll(stream, `"type":"response.completed","response":{`, `"type":"response.incomplete","response":{"incomplete_details":{"reason":"max_output_tokens"},`)
	f := &fake{stream: s}
	c, secrets := setup(t, f)
	signIn(t, c, secrets, time.Now().Add(time.Hour).UnixMilli())
	reply, err := c.Complete(context.Background(), request, func(string) {})
	if err != nil || !reply.Truncated || len(reply.Content) != 1 {
		t.Fatalf("%+v %v", reply, err)
	}
}

func TestModelsAndLogout(t *testing.T) {
	c, secrets := setup(t, &fake{})
	if _, err := c.Models(context.Background()); err == nil {
		t.Fatal("listed without a login")
	}
	signIn(t, c, secrets, time.Now().Add(time.Hour).UnixMilli())
	got, err := c.Models(context.Background())
	if err != nil || len(got) != 1 || got[0].ID != "gpt-a" || len(got[0].Thinking) != 2 || got[0].Thinking[1] != "xhigh" {
		t.Fatalf("%v %v", got, err)
	}
	if err := c.Logout(context.Background()); err != nil {
		t.Fatal(err)
	}
	if _, err := c.Complete(context.Background(), request, func(string) {}); err == nil {
		t.Fatal("worked after logging out")
	}
}

func TestToolImagesFollowAllTheOutputs(t *testing.T) {
	f := &fake{stream: stream}
	c, secrets := setup(t, f)
	signIn(t, c, secrets, time.Now().Add(time.Hour).UnixMilli())
	_, err := c.Complete(context.Background(), model.ModelRequest{Model: "gpt-a", Session: "s", Messages: []model.Message{{Role: enum.RoleUser, Content: []model.Block{
		{Type: enum.BlockToolResult, ID: "a", Text: "Image a.png", MimeType: "image/png", Data: "QUJD"},
		{Type: enum.BlockToolResult, ID: "b", Text: "plain"},
	}}}}, func(string) {})
	if err != nil {
		t.Fatal(err)
	}
	var sent struct {
		Input []struct {
			Type string `json:"type"`
		} `json:"input"`
	}
	if err := json.Unmarshal([]byte(f.bodies[0]), &sent); err != nil {
		t.Fatal(err)
	}
	if len(sent.Input) != 3 || sent.Input[0].Type != "function_call_output" || sent.Input[1].Type != "function_call_output" || sent.Input[2].Type != "message" {
		t.Fatalf("%s", f.bodies[0])
	}
	if !strings.Contains(f.bodies[0], "data:image/png;base64,QUJD") {
		t.Fatalf("%s", f.bodies[0])
	}
}

// What a run is told while it works follows a round of tool results, as a message of the user's after the outputs.
func TestWordsAfterToolResultsFollowTheOutputs(t *testing.T) {
	body := buildRequest(model.ModelRequest{Model: "gpt-a", Messages: []model.Message{
		{Role: enum.RoleUser, Content: []model.Block{{Type: enum.BlockText, Text: "do it"}}},
		{Role: enum.RoleAssistant, Content: []model.Block{{Type: enum.BlockToolCall, ID: "a", Name: "run_command", Args: json.RawMessage(`{}`)}}},
		{Role: enum.RoleUser, Content: []model.Block{{Type: enum.BlockToolResult, ID: "a", Text: "ran"}}},
		{Role: enum.RoleUser, Content: []model.Block{{Type: enum.BlockText, Text: "The task owner tells you while you work: use B"}}},
	}})
	raw, _ := json.Marshal(body["input"])
	var input []struct {
		Type    string `json:"type"`
		Role    string `json:"role"`
		CallID  string `json:"call_id"`
		Content []struct {
			Type string `json:"type"`
			Text string `json:"text"`
		} `json:"content"`
	}
	if err := json.Unmarshal(raw, &input); err != nil {
		t.Fatal(err)
	}
	if len(input) != 4 || input[2].Type != "function_call_output" || input[2].CallID != "a" {
		t.Fatalf("%s", raw)
	}
	if last := input[3]; last.Type != "message" || last.Role != "user" || len(last.Content) != 1 || last.Content[0].Type != "input_text" || !strings.Contains(last.Content[0].Text, "use B") {
		t.Fatalf("%s", raw)
	}
}

// With store false the backend keeps nothing, so a reasoning item must come back in the input for the model to
// continue from it after a tool call: exactly as it came, id included, where it came among the output items. Only the
// model that wrote it is sent it.
func TestReasoningItemsGoBackToTheSameModel(t *testing.T) {
	first := `{"type":"reasoning","id":"rs_1","summary":[{"type":"summary_text","text":"plan"}],"encrypted_content":"enc-1","status":"completed"}`
	second := `{"id":"rs_3","type":"reasoning","encrypted_content":"enc-3","summary":[]}`
	stream := strings.Join([]string{
		`data: {"type":"response.output_item.done","item":` + first + `}`,
		`data: {"type":"response.output_text.delta","delta":"look"}`,
		`data: {"type":"response.output_item.done","item":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"look"}]}}`,
		`data: {"type":"response.output_item.done","item":` + second + `}`,
		`data: {"type":"response.output_item.done","item":{"type":"reasoning","id":"rs_2","summary":[]}}`,
		`data: {"type":"response.output_item.done","item":{"type":"function_call","call_id":"c1","name":"read","arguments":"{}"}}`,
		`data: {"type":"response.completed","response":{"usage":{"input_tokens":10,"output_tokens":2,"input_tokens_details":{"cached_tokens":8}}}}`,
	}, "\n\n")
	reply, err := readStream(context.Background(), strings.NewReader(stream), func(string) {}, reasoningOrigin("gpt-a"))
	if err != nil {
		t.Fatal(err)
	}
	var kinds []enum.BlockType
	for _, b := range reply.Content {
		kinds = append(kinds, b.Type)
	}
	if !slices.Equal(kinds, []enum.BlockType{enum.BlockReasoning, enum.BlockText, enum.BlockReasoning, enum.BlockToolCall}) ||
		string(reply.Content[0].Raw) != first || string(reply.Content[2].Raw) != second || reply.Content[0].Origin != "codex:gpt-a" {
		t.Fatalf("%+v", reply.Content)
	}

	// Saved as the engine saves it, then sent on.
	conv := []model.Message{
		{Role: enum.RoleUser, Content: []model.Block{{Type: enum.BlockText, Text: "hi"}}},
		{Role: enum.RoleAssistant, Content: reply.Content},
		{Role: enum.RoleUser, Content: []model.Block{{Type: enum.BlockToolResult, ID: "c1", Text: "done"}}},
	}
	saved, _ := json.Marshal(conv)
	conv = nil
	if err := json.Unmarshal(saved, &conv); err != nil {
		t.Fatal(err)
	}
	input := func(modelID string) []string {
		raw, _ := json.Marshal(buildRequest(model.ModelRequest{Model: modelID, Messages: conv})["input"])
		var items []json.RawMessage
		if err := json.Unmarshal(raw, &items); err != nil {
			t.Fatal(err)
		}
		out := make([]string, len(items))
		for i, item := range items {
			out[i] = string(item)
		}
		return out
	}
	same := input("gpt-a")
	if len(same) != 6 || same[1] != first || !strings.Contains(same[2], `"look"`) || same[3] != second ||
		!strings.Contains(same[4], `"function_call"`) || !strings.Contains(same[5], `"function_call_output"`) {
		t.Fatalf("reasoning should go back unchanged, in its place: %q", same)
	}
	for _, other := range [][]string{input("gpt-b"), func() []string {
		conv[1].Content[0].Origin, conv[1].Content[2].Origin = "claude-code:gpt-a", "anthropic:gpt-a"
		return input("gpt-a")
	}()} {
		if len(other) != 4 || strings.Contains(strings.Join(other, ""), "enc-") {
			t.Fatalf("another model or provider got the reasoning: %q", other)
		}
	}
}

// Conversations saved before reasoning was kept have no such blocks, and go out as they did.
func TestOldConversationsGoOutUnchanged(t *testing.T) {
	var conv []model.Message
	if err := json.Unmarshal([]byte(`[{"role":"user","content":[{"type":"text","text":"hi"}]},{"role":"assistant","content":[{"type":"text","text":"ok"},{"type":"tool_call","id":"c1","name":"t","args":{}}]},{"role":"user","content":[{"type":"tool_result","id":"c1","text":"done"}]}]`), &conv); err != nil {
		t.Fatal(err)
	}
	raw, _ := json.Marshal(buildRequest(model.ModelRequest{Model: "gpt-a", Messages: conv})["input"])
	if string(raw) != `[{"content":[{"text":"hi","type":"input_text"}],"role":"user","type":"message"},{"content":[{"text":"ok","type":"output_text"}],"role":"assistant","type":"message"},{"arguments":"{}","call_id":"c1","name":"t","type":"function_call"},{"call_id":"c1","output":"done","type":"function_call_output"}]` {
		t.Fatalf("%s", raw)
	}
}

// A reply that ends unfinished or failed still says what it used, so it is counted, but leaves nothing to act on.
func TestFailedRepliesKeepTheirUsage(t *testing.T) {
	for _, end := range []string{
		`"type":"response.incomplete","response":{"incomplete_details":{"reason":"content_filter"},`,
		`"type":"response.failed","response":{"error":{"code":"server_error"},`,
	} {
		f := &fake{stream: strings.ReplaceAll(stream, `"type":"response.completed","response":{`, end)}
		c, secrets := setup(t, f)
		signIn(t, c, secrets, time.Now().Add(time.Hour).UnixMilli())
		reply, err := c.Complete(context.Background(), request, func(string) {})
		if err == nil || len(reply.Content) != 0 {
			t.Fatalf("%s: %v %+v", end, err, reply.Content)
		}
		if u := reply.Usage; u.Input != 10 || u.Output != 5 || u.CacheRead != 4 || u.CacheWriteKnown {
			t.Fatalf("%s: usage %+v", end, u)
		}
	}
}

// A response that finished before the call was canceled still used tokens, so they are kept;
// nothing it asked for may run.
func TestCanceledAfterFinishedResponseKeepsUsage(t *testing.T) {
	for _, end := range []string{
		`"type":"response.completed","response":{`,
		`"type":"response.incomplete","response":{"incomplete_details":{"reason":"max_output_tokens"},`,
	} {
		t.Run(end, func(t *testing.T) {
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			body := &cancelAtEOF{Reader: strings.NewReader(
				`data: {"type":"response.output_item.done","item":{"type":"function_call","call_id":"c1","name":"read","arguments":"{}"}}

data: {` + end + `"usage":{"input_tokens":10,"output_tokens":5,"input_tokens_details":{"cached_tokens":4}}}}
`), cancel: cancel}
			reply, err := readStream(ctx, body, func(string) {}, reasoningOrigin("m"))
			if err != context.Canceled || len(reply.Content) != 0 {
				t.Fatalf("err=%v content=%+v", err, reply.Content)
			}
			if reply.Usage.Input != 10 || reply.Usage.Output != 5 || reply.Usage.CacheRead != 4 {
				t.Fatalf("usage lost after terminal response: %+v", reply.Usage)
			}
		})
	}
}

// cancelAtEOF cancels the call once the whole stream has been read.
type cancelAtEOF struct {
	*strings.Reader
	cancel context.CancelFunc
}

func (r *cancelAtEOF) Read(p []byte) (int, error) {
	n, err := r.Reader.Read(p)
	if n == 0 {
		r.cancel()
	}
	return n, err
}
