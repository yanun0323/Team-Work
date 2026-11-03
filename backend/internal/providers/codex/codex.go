// Package codex runs models through a ChatGPT subscription, the way the Codex CLI does: sign in with OAuth,
// then call the ChatGPT backend's Responses API. Tokens are kept as the provider's secret. Adapted from
// mho's openai-codex provider.
package codex

import (
	"bufio"
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/url"
	"os/exec"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/yanun0323/Team-Work/internal/adapter"
	"github.com/yanun0323/Team-Work/internal/i18n"
	"github.com/yanun0323/Team-Work/internal/model"
	"github.com/yanun0323/Team-Work/internal/model/enum"
)

// These are the values the Codex CLI itself logs in with; the ChatGPT backend accepts no others.
const (
	clientID     = "app_EMoamEEZ73f0CkXaXp7hrann"
	scope        = "openid profile email offline_access"
	CallbackAddr = "127.0.0.1:1455"
	callbackPath = "/auth/callback"
	redirectURI  = "http://localhost:1455" + callbackPath
	originator   = "mho"
	accountClaim = "https://api.openai.com/auth"
	loginTimeout = 15 * time.Minute
	refreshEarly = time.Minute
	AuthURL      = "https://auth.openai.com"
	APIURL       = "https://chatgpt.com/backend-api"
	// catalogClientVersion: the backend filters models by it. Verified against Codex CLI 0.160.1 by mho.
	catalogClientVersion = "0.160.1"
)

func overflowed() *model.Error {
	return model.Errorf(model.CodeContextOverflow, "對話太長，超過模型能讀取的長度")
}

// Credentials are the tokens of one ChatGPT account.
type Credentials struct {
	Access    string `json:"access"`
	Refresh   string `json:"refresh"`
	Expires   int64  `json:"expires"` // Unix milliseconds
	AccountID string `json:"account_id"`
}

// Client is one provider's connection. Its lock keeps two calls from spending the same refresh token,
// which works only once.
type Client struct {
	ID           string
	Secrets      adapter.Secrets
	AuthURL      string
	APIURL       string
	CallbackAddr string
	HTTP         *http.Client
	OpenBrowser  func(string) error
	refreshing   sync.Mutex
}

// New connects provider id to ChatGPT.
func New(id string, secrets adapter.Secrets) *Client {
	return &Client{ID: id, Secrets: secrets, AuthURL: AuthURL, APIURL: APIURL, CallbackAddr: CallbackAddr, OpenBrowser: openBrowser,
		// no overall timeout: a reply streams for as long as the model writes
		HTTP: &http.Client{Transport: &http.Transport{Proxy: http.ProxyFromEnvironment, ResponseHeaderTimeout: 2 * time.Minute},
			CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}}
}

func openBrowser(address string) error {
	name := "xdg-open"
	if runtime.GOOS == "darwin" {
		name = "open"
	}
	cmd := exec.Command(name, address)
	if err := cmd.Start(); err != nil {
		return err
	}
	go func() { _ = cmd.Wait() }() // exits at once, having handed the address over
	return nil
}

func rejected(format string, args ...any) *model.Error {
	return model.Errorf(model.CodeInvalid, format, args...)
}

// signedOut is a sign-in that is missing or no longer accepted; signing in again is the fix.
func signedOut(format string, args ...any) *model.Error {
	return model.Errorf(model.CodeSignedOut, format, args...)
}

func unavailable(format string, args ...any) *model.Error {
	return model.Errorf(model.CodeUnavailable, format, args...)
}

func randomHex(n int) string {
	b := make([]byte, n)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

// Login starts a sign-in by method (browser or device). The flow's Wait ends when it is done and saved.
func (c *Client) Login(ctx context.Context, method string) (*adapter.LoginFlow, error) {
	if method == "device" {
		return c.deviceLogin(ctx)
	}
	return c.browserLogin()
}

// browserLogin sends the user to the login page and waits for the browser to come back to this machine
// with a code. The port is the Codex CLI's and may be taken; pasting the final address still works then.
func (c *Client) browserLogin() (*adapter.LoginFlow, error) {
	verifier := base64.RawURLEncoding.EncodeToString([]byte(randomHex(32)))
	challenge := sha256.Sum256([]byte(verifier))
	state := randomHex(16)
	login := c.AuthURL + "/oauth/authorize?" + url.Values{
		"response_type": {"code"}, "client_id": {clientID}, "redirect_uri": {redirectURI}, "scope": {scope},
		"code_challenge": {base64.RawURLEncoding.EncodeToString(challenge[:])}, "code_challenge_method": {"S256"}, "state": {state},
		"id_token_add_organizations": {"true"}, "codex_cli_simplified_flow": {"true"}, "originator": {originator},
	}.Encode()

	arrived := make(chan string, 1)
	var srv *http.Server
	var listener net.Listener
	if l, err := net.Listen("tcp", c.CallbackAddr); err == nil {
		listener = l
		srv = &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			q := r.URL.Query()
			if r.URL.Path != callbackPath || q.Get("state") != state || q.Get("code") == "" {
				http.Error(w, "This is not the login that was started.", http.StatusBadRequest)
				return
			}
			_, _ = io.WriteString(w, "<!doctype html><meta charset=utf-8><title>Team Work</title><p>"+i18n.T("登入成功，可以關閉這個視窗。"))
			select {
			case arrived <- q.Get("code"):
			default:
			}
		})}
		go func() { _ = srv.Serve(l) }() // ends with the Close in Wait
	}
	_ = c.OpenBrowser(login) // the address is also shown, for when this does nothing useful

	pasted := make(chan string, 1)
	return &adapter.LoginFlow{
		Prompt: model.LoginPrompt{Method: "browser", URL: login},
		Paste: func(value string) error {
			code, gotState := parsePasted(value)
			if gotState != "" && gotState != state {
				return rejected("這個網址屬於另一次登入，請重新登入")
			}
			if code == "" {
				return rejected("貼上的內容找不到登入代碼")
			}
			select {
			case pasted <- code:
			default:
			}
			return nil
		},
		Wait: func(ctx context.Context) error {
			if srv != nil {
				// the listener too: Close alone can miss one Serve has not picked up yet, and the next
				// login needs this port at once
				defer func() { _ = srv.Close(); _ = listener.Close() }()
			}
			ctx, cancel := context.WithTimeout(ctx, loginTimeout)
			defer cancel()
			var code string
			select {
			case code = <-arrived:
			case code = <-pasted:
			case <-ctx.Done():
				return loginStopped(ctx)
			}
			return c.exchange(ctx, code, verifier, redirectURI)
		},
	}, nil
}

func loginStopped(ctx context.Context) error {
	if errors.Is(ctx.Err(), context.DeadlineExceeded) {
		return rejected("登入逾時，請再試一次")
	}
	return ctx.Err()
}

// parsePasted finds the code in the whole address the browser ended on, its query, or the bare code.
func parsePasted(s string) (code, state string) {
	s = strings.TrimSpace(s)
	if u, err := url.Parse(s); err == nil && u.Query().Get("code") != "" {
		return u.Query().Get("code"), u.Query().Get("state")
	}
	if q, err := url.ParseQuery(strings.TrimPrefix(s, "?")); err == nil && q.Get("code") != "" {
		return q.Get("code"), q.Get("state")
	}
	if strings.ContainsAny(s, " /?&=") {
		return "", ""
	}
	return s, ""
}

// deviceLogin gives the user a short code to type in on any device, and waits until they have.
func (c *Client) deviceLogin(ctx context.Context) (*adapter.LoginFlow, error) {
	var device struct {
		ID       string          `json:"device_auth_id"`
		UserCode string          `json:"user_code"`
		Interval json.RawMessage `json:"interval"`
	}
	status, body, err := c.postJSON(ctx, c.AuthURL+"/api/accounts/deviceauth/usercode", map[string]string{"client_id": clientID})
	if err != nil {
		return nil, err
	}
	if status != http.StatusOK || json.Unmarshal(body, &device) != nil || device.ID == "" || device.UserCode == "" {
		return nil, rejected("ChatGPT 無法開始裝置代碼登入（%d），請改用瀏覽器登入", status)
	}
	// the wait between checks comes as a number, or as a number in quotes
	interval := 5 * time.Second
	var secs float64
	if json.Unmarshal(bytes.Trim(device.Interval, `"`), &secs) == nil && secs > 0 {
		interval = time.Duration(secs * float64(time.Second))
	}
	return &adapter.LoginFlow{
		Prompt: model.LoginPrompt{Method: "device", URL: c.AuthURL + "/codex/device", UserCode: device.UserCode},
		Paste:  func(string) error { return rejected("裝置代碼登入不用貼上內容") },
		Wait: func(ctx context.Context) error {
			ctx, cancel := context.WithTimeout(ctx, loginTimeout)
			defer cancel()
			for {
				select {
				case <-time.After(interval):
				case <-ctx.Done():
					return loginStopped(ctx)
				}
				status, body, err := c.postJSON(ctx, c.AuthURL+"/api/accounts/deviceauth/token", map[string]string{"device_auth_id": device.ID, "user_code": device.UserCode})
				if err != nil {
					continue // a passing network failure; the next check may get through
				}
				if status == http.StatusOK {
					var done struct {
						Code     string `json:"authorization_code"`
						Verifier string `json:"code_verifier"`
					}
					if json.Unmarshal(body, &done) != nil || done.Code == "" || done.Verifier == "" {
						return rejected("ChatGPT 回了無法讀取的登入結果")
					}
					return c.exchange(ctx, done.Code, done.Verifier, c.AuthURL+"/deviceauth/callback")
				}
				// not entered yet is said in several ways; anything else is final
				if status == http.StatusForbidden || status == http.StatusNotFound || bytes.Contains(body, []byte("authorization_pending")) || bytes.Contains(body, []byte("slow_down")) {
					continue
				}
				return rejected("裝置代碼登入失敗（%d）", status)
			}
		},
	}, nil
}

func (c *Client) postJSON(ctx context.Context, address string, payload any) (int, []byte, error) {
	raw, err := json.Marshal(payload)
	if err != nil {
		return 0, nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, address, bytes.NewReader(raw))
	if err != nil {
		return 0, nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	res, err := c.HTTP.Do(req)
	if err != nil {
		return 0, nil, unavailable("連不上 ChatGPT 的登入服務")
	}
	defer res.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(res.Body, 64<<10))
	return res.StatusCode, body, nil
}

func (c *Client) exchange(ctx context.Context, code, verifier, redirect string) error {
	creds, err := c.token(ctx, url.Values{"grant_type": {"authorization_code"}, "client_id": {clientID}, "code": {code}, "code_verifier": {verifier}, "redirect_uri": {redirect}})
	if err != nil {
		return err
	}
	c.refreshing.Lock()
	defer c.refreshing.Unlock()
	return c.save(ctx, creds)
}

func (c *Client) save(ctx context.Context, creds Credentials) error {
	raw, err := json.Marshal(creds)
	if err != nil {
		return err
	}
	return c.Secrets.SetSecret(ctx, c.ID, string(raw))
}

// token trades a login code or a refresh token for tokens. A refusal is invalid_request, which trying
// again will not change; trouble reaching the service is unavailable.
func (c *Client) token(ctx context.Context, form url.Values) (Credentials, error) {
	var creds Credentials
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.AuthURL+"/oauth/token", strings.NewReader(form.Encode()))
	if err != nil {
		return creds, err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	res, err := c.HTTP.Do(req)
	if err != nil {
		if ctx.Err() != nil {
			return creds, ctx.Err()
		}
		return creds, unavailable("連不上 ChatGPT 的登入服務")
	}
	defer res.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(res.Body, 64<<10))
	switch {
	case res.StatusCode == http.StatusBadRequest || res.StatusCode == http.StatusUnauthorized || res.StatusCode == http.StatusForbidden:
		return creds, rejected("ChatGPT 不接受這次登入（%d），請重新登入", res.StatusCode)
	case res.StatusCode != http.StatusOK:
		return creds, unavailable("ChatGPT 的登入服務暫時有問題（%d）", res.StatusCode)
	}
	var out struct {
		Access    string  `json:"access_token"`
		Refresh   string  `json:"refresh_token"`
		ExpiresIn float64 `json:"expires_in"`
	}
	if json.Unmarshal(body, &out) != nil || out.Access == "" || out.Refresh == "" {
		return creds, unavailable("ChatGPT 的登入服務回了無法讀取的內容")
	}
	account := accountID(out.Access)
	if account == "" {
		return creds, rejected("這次登入沒有說明是哪個 ChatGPT 帳號")
	}
	return Credentials{Access: out.Access, Refresh: out.Refresh, AccountID: account,
		Expires: time.Now().Add(time.Duration(out.ExpiresIn * float64(time.Second))).UnixMilli()}, nil
}

// accountID reads the ChatGPT account out of an access token, which is a JWT.
func accountID(access string) string {
	parts := strings.Split(access, ".")
	if len(parts) != 3 {
		return ""
	}
	raw, err := base64.RawURLEncoding.DecodeString(strings.TrimRight(parts[1], "="))
	if err != nil {
		return ""
	}
	var claims map[string]json.RawMessage
	if json.Unmarshal(raw, &claims) != nil {
		return ""
	}
	var auth struct {
		Account string `json:"chatgpt_account_id"`
	}
	_ = json.Unmarshal(claims[accountClaim], &auth)
	return auth.Account
}

// session returns tokens good to use now, replacing them when about to run out; force replaces them
// regardless, for when the service turned the current ones down.
func (c *Client) session(ctx context.Context, force bool) (Credentials, error) {
	c.refreshing.Lock()
	defer c.refreshing.Unlock()
	var creds Credentials
	raw, err := c.Secrets.Secret(ctx, c.ID)
	if err != nil {
		return creds, err
	}
	if raw == "" || json.Unmarshal([]byte(raw), &creds) != nil || creds.Access == "" || creds.Refresh == "" {
		return creds, signedOut("還沒登入 ChatGPT")
	}
	if !force && time.Now().Add(refreshEarly).UnixMilli() < creds.Expires {
		return creds, nil
	}
	fresh, err := c.token(ctx, url.Values{"grant_type": {"refresh_token"}, "refresh_token": {creds.Refresh}, "client_id": {clientID}})
	if err != nil {
		var known *model.Error
		if errors.As(err, &known) && known.Code == model.CodeInvalid {
			return creds, signedOut("ChatGPT 的登入已失效，請重新登入")
		}
		return creds, err
	}
	// the old refresh token is spent, so a login that cannot be saved is lost at the next start
	if err := c.save(ctx, fresh); err != nil {
		return fresh, err
	}
	return fresh, nil
}

func (c *Client) headers(req *http.Request, creds Credentials) {
	req.Header.Set("Authorization", "Bearer "+creds.Access)
	req.Header.Set("chatgpt-account-id", creds.AccountID)
	req.Header.Set("originator", originator)
}

// Models lists what the subscription offers.
func (c *Client) Models(ctx context.Context) ([]model.ModelSpec, error) {
	for attempt := 0; attempt < 2; attempt++ {
		creds, err := c.session(ctx, attempt > 0)
		if err != nil {
			return nil, err
		}
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.APIURL+"/codex/models?client_version="+catalogClientVersion, nil)
		if err != nil {
			return nil, err
		}
		c.headers(req, creds)
		res, err := c.HTTP.Do(req)
		if err != nil {
			if ctx.Err() != nil {
				return nil, ctx.Err()
			}
			return nil, unavailable("連不上 ChatGPT")
		}
		if res.StatusCode == http.StatusUnauthorized && attempt == 0 {
			res.Body.Close()
			continue
		}
		if res.StatusCode != http.StatusOK {
			res.Body.Close()
			return nil, unavailable("ChatGPT 無法提供模型清單（%d）", res.StatusCode)
		}
		var body struct {
			Models *[]struct {
				ID         string `json:"slug"`
				Visibility string `json:"visibility"`
				Levels     []struct {
					Effort string `json:"effort"`
				} `json:"supported_reasoning_levels"`
			} `json:"models"`
		}
		err = json.NewDecoder(io.LimitReader(res.Body, 4<<20)).Decode(&body)
		res.Body.Close()
		if err != nil || body.Models == nil {
			return nil, unavailable("ChatGPT 回了無法讀取的模型清單")
		}
		out := []model.ModelSpec{}
		for _, m := range *body.Models {
			if m.ID != "" && m.Visibility == "list" {
				spec := model.ModelSpec{ID: m.ID}
				for _, level := range m.Levels {
					spec.Thinking = append(spec.Thinking, level.Effort)
				}
				out = append(out, spec)
			}
		}
		return out, nil
	}
	return nil, signedOut("ChatGPT 的登入已失效，請重新登入")
}

// Logout forgets the tokens.
func (c *Client) Logout(ctx context.Context) error {
	c.refreshing.Lock()
	defer c.refreshing.Unlock()
	return c.Secrets.DeleteSecret(ctx, c.ID)
}

func buildRequest(req model.ModelRequest) map[string]any {
	instructions := req.System
	if instructions == "" {
		instructions = "You are a helpful assistant." // the backend refuses a request without any
	}
	input := []any{}
	for _, m := range req.Messages {
		role := string(m.Role)
		var parts, images []map[string]string
		flush := func() {
			if len(parts) > 0 {
				input = append(input, map[string]any{"type": "message", "role": role, "content": parts})
				parts = nil
			}
		}
		for _, b := range m.Content {
			switch b.Type {
			case enum.BlockText:
				kind := "input_text"
				if m.Role == enum.RoleAssistant {
					kind = "output_text"
				}
				parts = append(parts, map[string]string{"type": kind, "text": b.Text})
			case enum.BlockImage:
				parts = append(parts, map[string]string{"type": "input_image", "image_url": "data:" + b.MimeType + ";base64," + b.Data, "detail": "auto"})
			case enum.BlockToolCall:
				flush()
				args := string(b.Args)
				if args == "" {
					args = "{}"
				}
				input = append(input, map[string]any{"type": "function_call", "call_id": b.ID, "name": b.Name, "arguments": args})
			case enum.BlockToolResult:
				flush()
				input = append(input, map[string]any{"type": "function_call_output", "call_id": b.ID, "output": b.Text})
				// an output holds only text, so its image follows, once all the outputs are in
				if b.Data != "" {
					images = append(images, map[string]string{"type": "input_image", "image_url": "data:" + b.MimeType + ";base64," + b.Data, "detail": "auto"})
				}
			}
		}
		flush()
		parts = images
		flush()
	}
	body := map[string]any{
		"model": req.Model, "store": false, "stream": true, "instructions": instructions, "input": input,
		"text": map[string]string{"verbosity": "low"}, "include": []string{"reasoning.encrypted_content"},
		"tool_choice": "auto", "parallel_tool_calls": true,
	}
	if req.Session != "" {
		body["prompt_cache_key"] = req.Session
	}
	if req.Effort != "" {
		body["reasoning"] = map[string]string{"effort": req.Effort, "summary": "auto"}
	}
	if len(req.Tools) > 0 {
		tools := make([]map[string]any, len(req.Tools))
		for i, t := range req.Tools {
			tools[i] = map[string]any{"type": "function", "name": t.Name, "description": t.Description, "parameters": t.Parameters, "strict": false}
		}
		body["tools"] = tools
	}
	return body
}

// Complete asks for the model's next message.
func (c *Client) Complete(ctx context.Context, req model.ModelRequest, onText func(string)) (model.ModelReply, error) {
	raw, err := json.Marshal(buildRequest(req))
	if err != nil {
		return model.ModelReply{}, rejected("模型請求無法編碼")
	}
	// tokens the backend turns down are replaced once: they can be withdrawn before they run out
	var res *http.Response
	for attempt := 0; ; attempt++ {
		creds, err := c.session(ctx, attempt > 0)
		if err != nil {
			return model.ModelReply{}, err
		}
		httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, c.APIURL+"/codex/responses", bytes.NewReader(raw))
		if err != nil {
			return model.ModelReply{}, rejected("ChatGPT 位址不正確")
		}
		c.headers(httpReq, creds)
		httpReq.Header.Set("User-Agent", "mho")
		httpReq.Header.Set("OpenAI-Beta", "responses=experimental")
		httpReq.Header.Set("Accept", "text/event-stream")
		httpReq.Header.Set("Content-Type", "application/json")
		if req.Session != "" {
			httpReq.Header.Set("session-id", req.Session)
			httpReq.Header.Set("x-client-request-id", req.Session)
		}
		res, err = c.HTTP.Do(httpReq)
		if err != nil {
			if ctx.Err() != nil {
				return model.ModelReply{}, ctx.Err()
			}
			return model.ModelReply{}, unavailable("連不上 ChatGPT")
		}
		if res.StatusCode != http.StatusUnauthorized || attempt > 0 {
			break
		}
		res.Body.Close()
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return model.ModelReply{}, statusError(res)
	}
	return readStream(ctx, res.Body, onText)
}

// readStream reads the reply. Server text never goes into errors, as it can echo the conversation.
func readStream(ctx context.Context, body io.Reader, onText func(string)) (model.ModelReply, error) {
	var reply model.ModelReply
	var text strings.Builder
	var calls []model.Block
	finished := false
	sc := bufio.NewScanner(body)
	sc.Buffer(make([]byte, 0, 64<<10), 8<<20)
	for sc.Scan() && !finished {
		data, ok := strings.CutPrefix(sc.Text(), "data:")
		if !ok {
			continue
		}
		var ev struct {
			Type  string `json:"type"`
			Delta string `json:"delta"`
			Code  string `json:"code"`
			Item  struct {
				Type      string `json:"type"`
				CallID    string `json:"call_id"`
				Name      string `json:"name"`
				Arguments string `json:"arguments"`
			} `json:"item"`
			Response struct {
				Usage struct {
					Input   int `json:"input_tokens"`
					Output  int `json:"output_tokens"`
					Details struct {
						Cached int `json:"cached_tokens"`
					} `json:"input_tokens_details"`
				} `json:"usage"`
				Error struct {
					Code string `json:"code"`
				} `json:"error"`
				Incomplete struct {
					Reason string `json:"reason"`
				} `json:"incomplete_details"`
			} `json:"response"`
		}
		if json.Unmarshal([]byte(strings.TrimSpace(data)), &ev) != nil {
			continue
		}
		switch ev.Type {
		case "response.output_text.delta":
			text.WriteString(ev.Delta)
			onText(ev.Delta)
		case "response.output_item.done":
			if ev.Item.Type == "function_call" {
				args := ev.Item.Arguments
				if !json.Valid([]byte(args)) {
					args = "{}" // the tool will say what is missing
				}
				calls = append(calls, model.Block{Type: enum.BlockToolCall, ID: ev.Item.CallID, Name: ev.Item.Name, Args: json.RawMessage(args)})
			}
		case "response.completed", "response.incomplete":
			u := ev.Response.Usage
			reply.Usage = model.ModelUsage{Input: u.Input, Output: u.Output, CacheRead: u.Details.Cached}
			if ev.Type == "response.incomplete" {
				if ev.Response.Incomplete.Reason != "max_output_tokens" {
					return model.ModelReply{}, rejected("ChatGPT 沒有完成這次回覆")
				}
				reply.Truncated = true
			}
			finished = true
		case "response.failed", "error":
			code := ev.Code
			if ev.Type == "response.failed" {
				code = ev.Response.Error.Code
			}
			if code == "context_length_exceeded" {
				return model.ModelReply{}, overflowed()
			}
			return model.ModelReply{}, rejected("ChatGPT 無法回覆（%s）", orUnknown(code))
		}
	}
	if ctx.Err() != nil {
		return model.ModelReply{}, ctx.Err()
	}
	if !finished {
		return model.ModelReply{}, unavailable("ChatGPT 的回覆中斷了")
	}
	if text.Len() > 0 {
		reply.Content = append(reply.Content, model.Block{Type: enum.BlockText, Text: text.String()})
	}
	if !reply.Truncated { // never run partial tool arguments
		reply.Content = append(reply.Content, calls...)
	}
	return reply, nil
}

func orUnknown(code string) string {
	if code == "" {
		return i18n.T("沒有說明原因")
	}
	return code
}

// statusError explains a refused request. Overload may pass; a used-up allowance or a bad login will not.
func statusError(res *http.Response) *model.Error {
	raw, _ := io.ReadAll(io.LimitReader(res.Body, 4<<10))
	var body struct {
		Error struct {
			Code     string `json:"code"`
			Type     string `json:"type"`
			ResetsAt int64  `json:"resets_at"`
		} `json:"error"`
	}
	_ = json.Unmarshal(raw, &body)
	kind := body.Error.Code + " " + body.Error.Type
	switch {
	case strings.Contains(kind, "context_length_exceeded"):
		return overflowed()
	case res.StatusCode == http.StatusUnauthorized:
		return signedOut("ChatGPT 不接受這個登入，請重新登入")
	case res.StatusCode == http.StatusForbidden:
		return rejected("ChatGPT 不接受這個登入，請重新登入")
	case strings.Contains(kind, "usage_limit_reached") || strings.Contains(kind, "usage_not_included"):
		msg := i18n.T("ChatGPT 訂閱的額度用完了")
		if body.Error.ResetsAt > 0 {
			msg = i18n.T("ChatGPT 訂閱的額度用完了，大約 %d 分鐘後恢復", max(int(time.Until(time.Unix(body.Error.ResetsAt, 0)).Minutes()), 0))
		}
		return rejected("%s", msg)
	case res.StatusCode == http.StatusTooManyRequests || res.StatusCode >= 500:
		return unavailable("ChatGPT 忙碌中（%d）", res.StatusCode)
	}
	return rejected("ChatGPT 拒絕了請求（%d）", res.StatusCode)
}
