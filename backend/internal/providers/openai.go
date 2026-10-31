package providers

import (
	"context"
	"encoding/json"
	"net/http"
	"sort"
	"strings"

	"github.com/yanun0323/mho-company/internal/model"
	"github.com/yanun0323/mho-company/internal/model/enum"
)

// openAI speaks Chat Completions: OpenAI's, Google's compatible endpoint and anything compatible.
type openAI struct{ client }

func (o openAI) auth(req *http.Request) { req.Header.Set("Authorization", "Bearer "+o.key) }

func (o openAI) Models(ctx context.Context) ([]model.ModelSpec, error) {
	return o.listModels(ctx, "/models", o.auth)
}

type chatMessage struct {
	Role       string     `json:"role"`
	Content    any        `json:"content,omitempty"`
	ToolCallID string     `json:"tool_call_id,omitempty"`
	ToolCalls  []chatCall `json:"tool_calls,omitempty"`
}

type chatCall struct {
	ID       string `json:"id"`
	Type     string `json:"type"`
	Function struct {
		Name      string `json:"name"`
		Arguments string `json:"arguments"`
	} `json:"function"`
}

func chatMessages(req model.ModelRequest) []chatMessage {
	var out []chatMessage
	if req.System != "" {
		out = append(out, chatMessage{Role: "system", Content: req.System})
	}
	for _, m := range req.Messages {
		var parts []map[string]any
		var calls []chatCall
		for _, b := range m.Content {
			switch b.Type {
			case enum.BlockText:
				parts = append(parts, map[string]any{"type": "text", "text": b.Text})
			case enum.BlockImage:
				parts = append(parts, map[string]any{"type": "image_url", "image_url": map[string]string{"url": "data:" + b.MimeType + ";base64," + b.Data}})
			case enum.BlockToolCall:
				c := chatCall{ID: b.ID, Type: "function"}
				c.Function.Name, c.Function.Arguments = b.Name, string(b.Args)
				calls = append(calls, c)
			case enum.BlockToolResult:
				out = append(out, chatMessage{Role: "tool", ToolCallID: b.ID, Content: b.Text})
				// a tool's message holds only text, so its image follows, once all the results are in
				if b.Data != "" {
					parts = append(parts, map[string]any{"type": "image_url", "image_url": map[string]string{"url": "data:" + b.MimeType + ";base64," + b.Data}})
				}
			}
		}
		if len(parts)+len(calls) == 0 {
			continue
		}
		msg := chatMessage{Role: string(m.Role), ToolCalls: calls}
		if len(parts) > 0 {
			msg.Content = parts
		}
		out = append(out, msg)
	}
	return out
}

func (o openAI) Complete(ctx context.Context, req model.ModelRequest, onText func(string)) (model.ModelReply, error) {
	body := map[string]any{
		"model": req.Model, "messages": chatMessages(req), "stream": true,
		"stream_options": map[string]bool{"include_usage": true},
	}
	if len(req.Tools) > 0 {
		tools := make([]map[string]any, len(req.Tools))
		for i, t := range req.Tools {
			tools[i] = map[string]any{"type": "function", "function": map[string]any{"name": t.Name, "description": t.Description, "parameters": t.Parameters}}
		}
		body["tools"] = tools
	}
	// The default omits the field; explicit levels (including compatible fallback) pass through.
	if req.Effort != "" {
		body["reasoning_effort"] = req.Effort
	}
	res, err := o.do(ctx, http.MethodPost, "/chat/completions", body, o.auth)
	if err != nil {
		return model.ModelReply{}, err
	}
	defer res.Body.Close()

	var reply model.ModelReply
	var text strings.Builder
	calls := map[int]*model.Block{}
	var args = map[int]*strings.Builder{}
	finished := false
	err = readSSE(res.Body, func(data []byte) (bool, error) {
		if string(data) == "[DONE]" {
			finished = true
			return true, nil
		}
		var chunk struct {
			Error   json.RawMessage `json:"error"`
			Choices []struct {
				Delta struct {
					Content   string `json:"content"`
					ToolCalls []struct {
						Index    int    `json:"index"`
						ID       string `json:"id"`
						Function struct {
							Name      string `json:"name"`
							Arguments string `json:"arguments"`
						} `json:"function"`
					} `json:"tool_calls"`
				} `json:"delta"`
				FinishReason string `json:"finish_reason"`
			} `json:"choices"`
			Usage *struct {
				Prompt     int `json:"prompt_tokens"`
				Completion int `json:"completion_tokens"`
				Details    struct {
					Cached int `json:"cached_tokens"`
				} `json:"prompt_tokens_details"`
			} `json:"usage"`
		}
		if json.Unmarshal(data, &chunk) != nil {
			return false, model.Errorf(model.CodeUnavailable, "模型回覆格式不正確")
		}
		if len(chunk.Error) > 0 && string(chunk.Error) != "null" {
			return false, model.Errorf(model.CodeInvalid, "模型回報錯誤，請檢查模型與設定")
		}
		if u := chunk.Usage; u != nil {
			reply.Usage = model.ModelUsage{Input: u.Prompt, Output: u.Completion, CacheRead: u.Details.Cached}
		}
		for _, c := range chunk.Choices {
			if c.Delta.Content != "" {
				text.WriteString(c.Delta.Content)
				onText(c.Delta.Content)
			}
			for _, d := range c.Delta.ToolCalls {
				if calls[d.Index] == nil {
					calls[d.Index] = &model.Block{Type: enum.BlockToolCall}
					args[d.Index] = &strings.Builder{}
				}
				if d.ID != "" {
					calls[d.Index].ID = d.ID
				}
				calls[d.Index].Name += d.Function.Name
				args[d.Index].WriteString(d.Function.Arguments)
			}
			if c.FinishReason == "length" {
				reply.Truncated = true
			}
		}
		return false, nil
	})
	if err != nil {
		if ctx.Err() != nil {
			return model.ModelReply{}, ctx.Err()
		}
		return model.ModelReply{}, err
	}
	if !finished {
		return model.ModelReply{}, model.Errorf(model.CodeUnavailable, "模型回覆沒有結束就中斷了")
	}
	if text.Len() > 0 {
		reply.Content = append(reply.Content, model.Block{Type: enum.BlockText, Text: text.String()})
	}
	if reply.Truncated { // never run partial tool arguments
		return reply, nil
	}
	indexes := make([]int, 0, len(calls))
	for i := range calls {
		indexes = append(indexes, i)
	}
	sort.Ints(indexes)
	var blocks []model.Block
	for _, i := range indexes {
		calls[i].Args = json.RawMessage(args[i].String())
		blocks = append(blocks, *calls[i])
	}
	if err := validCalls(blocks); err != nil {
		return model.ModelReply{}, err
	}
	reply.Content = append(reply.Content, blocks...)
	return reply, nil
}
