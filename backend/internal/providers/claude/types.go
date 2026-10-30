// Package claude runs models through an installed Claude Code executable, which owns the login: nothing
// here stores Claude credentials. Claude's own tools are off; every tool call comes back to the caller.
// Adapted from mho's claude-code provider.
package claude

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"sync"
	"time"

	"github.com/yanun0323/mho-company/internal/model"
	"github.com/yanun0323/mho-company/internal/model/enum"
)

// Error codes. A busy conversation passes, so it is retried like other passing failures.
const (
	CodeInvalidRequest  = model.CodeInvalid
	CodeUnavailable     = model.CodeUnavailable
	CodeBusy            = model.CodeUnavailable
	CodeContextOverflow = "context_overflow"
	CodeTimeout         = "timeout"
)

type (
	Error    = model.Error
	ToolSpec = model.ToolSpec
)

// Block, ModelMessage and CompleteParams are the bridge's own conversation: unlike model.Message, each tool
// result is a message of its own.
type Block struct {
	Type     string          `json:"type"`
	Text     string          `json:"text,omitempty"`
	ID       string          `json:"id,omitempty"`
	Name     string          `json:"name,omitempty"`
	Args     json.RawMessage `json:"args,omitempty"`
	MimeType string          `json:"mime_type,omitempty"`
	Data     string          `json:"data,omitempty"`
}

type ModelMessage struct {
	Role    string  `json:"role"`
	Content []Block `json:"content"`
	CallID  string  `json:"call_id,omitempty"`
	IsError bool    `json:"is_error,omitempty"`
}

type CompleteParams struct {
	Cwd      string
	Session  string
	Model    string
	System   string
	Thinking string
	Messages []ModelMessage
	Tools    []ToolSpec
}

type ModelUsage struct {
	Input, Output, CacheRead, CacheWrite  int
	CacheReadReported, CacheWriteReported bool
}

type CompleteResult struct {
	StopReason string
	Usage      ModelUsage
}

func modelUnavailable() *Error {
	return &Error{Code: CodeInvalidRequest, Message: "模型目前不能用，請換一個模型再試"}
}

// modelRefused recognizes explicit model errors, not generic failures.
func modelRefused(detail string) bool {
	s := strings.ToLower(detail)
	for _, code := range []string{"model_not_found", "model_not_available", "model_unavailable", "unsupported_model", "invalid_model"} {
		if strings.Contains(s, code) {
			return true
		}
	}
	for _, other := range []string{"network", "connection", "authentication", "login", "credential", "api key", "rate limit", "timeout", "timed out", "overload"} {
		if strings.Contains(s, other) {
			return false
		}
	}
	if !strings.Contains(s, "model") {
		return false
	}
	for _, phrase := range []string{"does not exist", "not found", "not available", "unavailable", "unsupported model", "model is not supported", "do not have access", "don't have access"} {
		if strings.Contains(s, phrase) {
			return true
		}
	}
	return false
}

// Client owns the Claude Code processes, which stay open between calls of one conversation.
type Client struct {
	bridge  *bridge
	mu      sync.Mutex
	efforts map[string][]string
}

// New sweeps away what a crashed server left in Claude's folder.
func New() (*Client, error) {
	if err := sweepMirrors(); err != nil {
		return nil, err
	}
	return &Client{bridge: newBridge()}, nil
}

// Close stops every process.
func (c *Client) Close() { c.bridge.close() }

// Models asks Claude Code what this login offers. A login that is missing, or is not a first-party
// subscription, comes back as an error saying what to do.
func (c *Client) Models(ctx context.Context) ([]string, error) {
	ids, efforts, err := discover(ctx)
	if err != nil {
		return nil, err
	}
	c.mu.Lock()
	c.efforts = efforts
	c.mu.Unlock()
	return ids, nil
}

var errLoggedOut = &Error{Code: CodeInvalidRequest, Message: "Claude Code 還沒登入訂閱：請在終端機執行 claude auth login"}

func discover(ctx context.Context) ([]string, map[string][]string, error) {
	home, err := osHome()
	if err != nil {
		return nil, nil, err
	}
	child, err := startChild(CompleteParams{Cwd: home}, "", nil)
	if err != nil {
		return nil, nil, err
	}
	defer child.close()
	s := &session{child: child}
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	raw, err := s.initialize(ctx, "")
	if err != nil {
		var auth *authError
		if errors.As(err, &auth) {
			return nil, nil, errLoggedOut
		}
		return nil, nil, safeError(err)
	}
	var init struct {
		Account struct {
			APIProvider      string `json:"apiProvider"`
			SubscriptionType string `json:"subscriptionType"`
		} `json:"account"`
		Models *[]struct {
			Value  string   `json:"value"`
			Effort []string `json:"supportedEffortLevels"`
		} `json:"models"`
	}
	if json.Unmarshal(raw, &init) != nil {
		return nil, nil, unavailable("Claude Code 回了無法讀取的帳號資料")
	}
	if init.Account.APIProvider != "firstParty" || init.Account.SubscriptionType == "" {
		return nil, nil, errLoggedOut
	}
	if init.Models == nil {
		return nil, nil, unavailable("Claude Code 回了無法讀取的模型清單")
	}
	ids := []string{}
	efforts := map[string][]string{}
	for _, m := range *init.Models {
		if m.Value != "" {
			ids = append(ids, m.Value)
			efforts[m.Value] = m.Effort
		}
	}
	if len(ids) == 0 {
		return nil, nil, errLoggedOut
	}
	return ids, efforts, nil
}

// supportedEffort leaves out a level the model does not take. Levels are looked up once per run of the server.
func (c *Client) supportedEffort(ctx context.Context, modelID, effort string) string {
	if effort == "" {
		return ""
	}
	c.mu.Lock()
	known := c.efforts
	c.mu.Unlock()
	if known == nil {
		if _, err := c.Models(ctx); err != nil {
			return ""
		}
		c.mu.Lock()
		known = c.efforts
		c.mu.Unlock()
	}
	for _, level := range known[modelID] {
		if level == effort {
			return effort
		}
	}
	return ""
}

// Complete asks for the model's next message.
func (c *Client) Complete(ctx context.Context, req model.ModelRequest, onText func(string)) (model.ModelReply, error) {
	params := CompleteParams{Cwd: req.Cwd, Session: req.Session, Model: req.Model, System: req.System, Tools: req.Tools,
		Thinking: c.supportedEffort(ctx, req.Model, req.Effort), Messages: toMessages(req.Messages)}
	var content []model.Block
	result, err := c.bridge.complete(ctx, params, func(v any) error {
		b, ok := v.(Block)
		if !ok {
			return nil
		}
		switch b.Type {
		case "text":
			onText(b.Text)
			if n := len(content); n > 0 && content[n-1].Type == enum.BlockText {
				content[n-1].Text += b.Text
			} else {
				content = append(content, model.Block{Type: enum.BlockText, Text: b.Text})
			}
		case "tool_call":
			content = append(content, model.Block{Type: enum.BlockToolCall, ID: b.ID, Name: b.Name, Args: b.Args})
		}
		return nil
	})
	if err != nil {
		if ctx.Err() != nil {
			return model.ModelReply{}, ctx.Err()
		}
		return model.ModelReply{}, safeError(err)
	}
	return model.ModelReply{Content: content, Truncated: result.StopReason == "max_tokens",
		Usage: model.ModelUsage{Input: result.Usage.Input, Output: result.Usage.Output, CacheRead: result.Usage.CacheRead}}, nil
}

func toMessages(msgs []model.Message) []ModelMessage {
	var out []ModelMessage
	for _, m := range msgs {
		var plain []Block
		for _, b := range m.Content {
			switch b.Type {
			case enum.BlockText:
				plain = append(plain, Block{Type: "text", Text: b.Text})
			case enum.BlockImage:
				plain = append(plain, Block{Type: "image", MimeType: b.MimeType, Data: b.Data})
			case enum.BlockToolCall:
				plain = append(plain, Block{Type: "tool_call", ID: b.ID, Name: b.Name, Args: b.Args})
			case enum.BlockToolResult:
				out = append(out, ModelMessage{Role: "tool", CallID: b.ID, IsError: b.IsError, Content: []Block{{Type: "text", Text: b.Text}}})
			}
		}
		if len(plain) > 0 {
			out = append(out, ModelMessage{Role: string(m.Role), Content: plain})
		}
	}
	return out
}
