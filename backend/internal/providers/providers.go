// Package providers talks to model APIs. Replies are read as they stream; failures never carry the
// server's own text, which can echo keys.
package providers

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/yanun0323/mho-company/internal/adapter"
	"github.com/yanun0323/mho-company/internal/model"
	"github.com/yanun0323/mho-company/internal/model/enum"
	"github.com/yanun0323/mho-company/internal/providers/claude"
	"github.com/yanun0323/mho-company/internal/providers/codex"
)

const maxEvent = 8 << 20

// Subscription models carry these prefixes, so they never clash with the same model on an API key.
const (
	prefixClaude = "claude-code/"
	prefixCodex  = "openai-codex/"
)

// Factory makes providers, and owns what subscriptions keep between calls.
type Factory struct {
	secrets adapter.Secrets
	log     *slog.Logger
	mu      sync.Mutex
	claude  *claude.Client
	codex   map[string]*codex.Client
}

func NewFactory(secrets adapter.Secrets, log *slog.Logger) *Factory {
	return &Factory{secrets: secrets, log: log, codex: map[string]*codex.Client{}}
}

// ClaudeCode is the setup of the program Claude subscriptions run through.
func (f *Factory) ClaudeCode() adapter.ClaudeCode { return claudeCode{claude.NewSetup()} }

type claudeCode struct{ *claude.Setup }

// Status reports the models with the id a provider knows them by.
func (c claudeCode) Status(ctx context.Context) (adapter.ClaudeStatus, error) {
	s, err := c.Setup.Status(ctx)
	if err != nil {
		return adapter.ClaudeStatus{}, err
	}
	models := make([]string, len(s.Models))
	for i, id := range s.Models {
		models[i] = prefixClaude + id
	}
	return adapter.ClaudeStatus{Installed: s.Installed, Version: s.Version, SignedIn: s.SignedIn, Models: models}, nil
}

// Close stops the Claude Code processes. Call it after the last run has ended.
func (f *Factory) Close() {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.claude != nil {
		f.claude.Close()
		f.claude = nil
	}
}

func (f *Factory) claudeClient() (*claude.Client, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.claude == nil {
		c, err := claude.New(f.log)
		if err != nil {
			return nil, model.Errorf(model.CodeInvalid, "無法使用 Claude Code 的設定資料夾")
		}
		f.claude = c
	}
	return f.claude, nil
}

// codexClient keeps one client per provider, as its lock guards the provider's refresh token.
func (f *Factory) codexClient(id string) *codex.Client {
	f.mu.Lock()
	defer f.mu.Unlock()
	c := f.codex[id]
	if c == nil {
		c = codex.New(id, f.secrets)
		f.codex[id] = c
	}
	return c
}

// subscription is a signed-in client, seen with its prefixed model ids.
type subscription struct {
	prefix string
	client interface {
		Complete(context.Context, model.ModelRequest, func(string)) (model.ModelReply, error)
		Models(context.Context) ([]model.ModelSpec, error)
	}
}

func (s subscription) Complete(ctx context.Context, req model.ModelRequest, onText func(string)) (model.ModelReply, error) {
	req.Model = strings.TrimPrefix(req.Model, s.prefix)
	return s.client.Complete(ctx, req, onText)
}

func (s subscription) Models(ctx context.Context) ([]model.ModelSpec, error) {
	specs, err := s.client.Models(ctx)
	if err != nil {
		return nil, err
	}
	out := make([]model.ModelSpec, len(specs))
	for i, m := range specs {
		out[i] = model.ModelSpec{ID: s.prefix + m.ID, Thinking: m.Thinking}
	}
	return out, nil
}

func (f *Factory) subscriptionFor(p model.ModelProvider) (adapter.Provider, error) {
	switch p.Kind {
	case enum.ProviderAnthropic:
		c, err := f.claudeClient()
		if err != nil {
			return nil, err
		}
		return subscription{prefix: prefixClaude, client: c}, nil
	case enum.ProviderOpenAI:
		return subscription{prefix: prefixCodex, client: f.codexClient(p.ID)}, nil
	}
	return nil, model.Errorf(model.CodeInvalid, "這種供應商不能用訂閱登入")
}

// Login starts signing in. Claude Code owns its own login, so that one is only checked.
func (f *Factory) Login(ctx context.Context, p model.ModelProvider, method string) (*adapter.LoginFlow, error) {
	switch p.Kind {
	case enum.ProviderAnthropic:
		provider, err := f.subscriptionFor(p)
		if err != nil {
			return nil, err
		}
		return &adapter.LoginFlow{
			Prompt: model.LoginPrompt{Method: "terminal", Command: "claude auth login"},
			Paste:  func(string) error { return model.Errorf(model.CodeInvalid, "Claude Code 的登入不用貼上內容") },
			Wait: func(ctx context.Context) error {
				_, err := provider.Models(ctx)
				return err
			},
		}, nil
	case enum.ProviderOpenAI:
		return f.codexClient(p.ID).Login(ctx, method)
	}
	return nil, model.Errorf(model.CodeInvalid, "這種供應商不能用訂閱登入")
}

// Logout forgets a ChatGPT login. Claude Code's own login stays as it is.
func (f *Factory) Logout(ctx context.Context, p model.ModelProvider) error {
	if p.Kind == enum.ProviderOpenAI {
		return f.codexClient(p.ID).Logout(ctx)
	}
	return nil
}

// Images draws with a ChatGPT subscription, whatever model the employee runs on.
func (f *Factory) Images(p model.ModelProvider) (adapter.ImageMaker, error) {
	if !model.MakesImages(p) {
		return nil, model.Errorf(model.CodeInvalid, "只有 ChatGPT 訂閱可以生成圖片")
	}
	if !p.Auth.SignedIn {
		return nil, model.Errorf(model.CodeInvalid, "「%s」還沒登入", p.Name)
	}
	return f.codexClient(p.ID), nil
}

func (f *Factory) For(p model.ModelProvider, key string) (adapter.Provider, error) {
	if p.Auth.Kind != "apiKey" {
		if !p.Auth.SignedIn {
			return nil, model.Errorf(model.CodeInvalid, "「%s」還沒登入", p.Name)
		}
		return f.subscriptionFor(p)
	}
	if key == "" {
		return nil, model.Errorf(model.CodeInvalid, "「%s」沒有 API Key", p.Name)
	}
	c := client{base: strings.TrimRight(p.BaseURL, "/"), key: key, http: newHTTP()}
	switch p.Kind {
	case enum.ProviderAnthropic:
		if c.base == "" {
			c.base = "https://api.anthropic.com"
		}
		return anthropic{c}, nil
	case enum.ProviderOpenAI:
		if c.base == "" {
			c.base = "https://api.openai.com/v1"
		}
		return openAI{c}, nil
	case enum.ProviderGoogle:
		if c.base == "" {
			c.base = "https://generativelanguage.googleapis.com/v1beta/openai"
		}
		return openAI{c}, nil
	case enum.ProviderCompatible:
		if c.base == "" {
			return nil, model.Errorf(model.CodeInvalid, "「%s」沒有填 API 位址", p.Name)
		}
		return openAI{c}, nil
	}
	return nil, model.Errorf(model.CodeInvalid, "不認識的供應商種類 %s", p.Kind)
}

func newHTTP() *http.Client {
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.ResponseHeaderTimeout = 2 * time.Minute
	// never forward a key or a request to a redirected address
	return &http.Client{Transport: transport, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
}

type client struct {
	base string
	key  string
	http *http.Client
}

func (c client) do(ctx context.Context, method, path string, body any, auth func(*http.Request)) (*http.Response, error) {
	var reader io.Reader
	if body != nil {
		raw, err := json.Marshal(body)
		if err != nil {
			return nil, model.Errorf(model.CodeInvalid, "模型請求無法編碼")
		}
		reader = bytes.NewReader(raw)
	}
	req, err := http.NewRequestWithContext(ctx, method, c.base+path, reader)
	if err != nil {
		return nil, model.Errorf(model.CodeInvalid, "API 位址不正確")
	}
	auth(req)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Accept", "text/event-stream")
	}
	res, err := c.http.Do(req)
	if err != nil {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		return nil, model.Errorf(model.CodeUnavailable, "連不上模型供應商")
	}
	if res.StatusCode != http.StatusOK {
		defer res.Body.Close()
		switch {
		case contextOverflowed(res):
			return nil, model.Errorf(model.CodeContextOverflow, "對話太長，超過模型能讀取的長度")
		case res.StatusCode == http.StatusUnauthorized || res.StatusCode == http.StatusForbidden:
			return nil, model.Errorf(model.CodeInvalid, "API Key 無效或沒有權限")
		case res.StatusCode == http.StatusTooManyRequests || res.StatusCode >= 500:
			return nil, model.Errorf(model.CodeUnavailable, "模型供應商暫時無法回應（HTTP %d）", res.StatusCode)
		}
		return nil, model.Errorf(model.CodeInvalid, "模型供應商拒絕了請求（HTTP %d），請檢查模型與設定", res.StatusCode)
	}
	return res, nil
}

// thinkingOrder is the levels weakest first, as a provider that answers with a set leaves the order open.
var thinkingOrder = []string{"off", "minimal", "low", "medium", "high", "xhigh", "max"}

// listModels reads `{"data":[{"id":...}]}`, which both API families answer. The levels come from where a provider
// reports them: Anthropic's capabilities.effort, or the effort.supported_levels of some OpenAI-style servers.
func (c client) listModels(ctx context.Context, path string, auth func(*http.Request)) ([]model.ModelSpec, error) {
	res, err := c.do(ctx, http.MethodGet, path, nil, auth)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	var body struct {
		Data []struct {
			ID           string `json:"id"`
			Capabilities struct {
				Effort map[string]json.RawMessage `json:"effort"`
			} `json:"capabilities"`
			Effort struct {
				Levels []string `json:"supported_levels"`
			} `json:"effort"`
		} `json:"data"`
	}
	if err := json.NewDecoder(io.LimitReader(res.Body, 4<<20)).Decode(&body); err != nil {
		return nil, model.Errorf(model.CodeUnavailable, "模型清單格式不正確")
	}
	out := make([]model.ModelSpec, 0, len(body.Data))
	for _, m := range body.Data {
		if m.ID != "" {
			levels := m.Effort.Levels
			if len(levels) == 0 {
				levels = supportedLevels(m.Capabilities.Effort)
			}
			out = append(out, model.ModelSpec{ID: strings.TrimPrefix(m.ID, "models/"), Thinking: levels})
		}
	}
	return out, nil
}

// supportedLevels reads `{"supported":true,"low":{"supported":true},...}`; a level that isn't there is not offered.
func supportedLevels(effort map[string]json.RawMessage) []string {
	var levels []string
	for _, level := range thinkingOrder {
		var support struct {
			Supported bool `json:"supported"`
		}
		if raw, ok := effort[level]; ok && json.Unmarshal(raw, &support) == nil && support.Supported {
			levels = append(levels, level)
		}
	}
	return levels
}

// readSSE calls event with each event's data, until it returns true or the stream ends.
func readSSE(r io.Reader, event func([]byte) (bool, error)) error {
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 64<<10), maxEvent)
	for sc.Scan() {
		data, ok := strings.CutPrefix(sc.Text(), "data:")
		if !ok {
			continue
		}
		stop, err := event([]byte(strings.TrimPrefix(data, " ")))
		if stop || err != nil {
			return err
		}
	}
	if sc.Err() != nil {
		return model.Errorf(model.CodeUnavailable, "模型回覆中斷")
	}
	return nil
}

func validCalls(calls []model.Block) error {
	seen := map[string]bool{}
	for _, c := range calls {
		var args map[string]json.RawMessage
		if c.ID == "" || c.Name == "" || seen[c.ID] || json.Unmarshal(c.Args, &args) != nil || args == nil {
			return model.Errorf(model.CodeUnavailable, "模型回了格式不正確的工具呼叫（%s）", c.Name)
		}
		seen[c.ID] = true
	}
	return nil
}

// contextOverflowed reads a refusal for whether the conversation was too long. Providers only say so in words.
func contextOverflowed(res *http.Response) bool {
	if res.StatusCode != http.StatusBadRequest && res.StatusCode != http.StatusRequestEntityTooLarge {
		return false
	}
	raw, _ := io.ReadAll(io.LimitReader(res.Body, 64<<10))
	body := strings.ToLower(string(raw))
	for _, sign := range []string{"context_length_exceeded", "maximum context length", "prompt is too long", "context window"} {
		if strings.Contains(body, sign) {
			return true
		}
	}
	return false
}
