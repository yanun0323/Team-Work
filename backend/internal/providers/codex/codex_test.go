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
	if !errors.As(err, &known) || known.Code != model.CodeInvalid {
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
