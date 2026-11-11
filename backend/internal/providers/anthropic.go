package providers

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"

	"github.com/yanun0323/Team-Work/internal/model"
	"github.com/yanun0323/Team-Work/internal/model/enum"
)

const anthropicMaxTokens = 16000

// anthropic speaks the Messages API.
type anthropic struct{ client }

func (a anthropic) auth(req *http.Request) {
	req.Header.Set("x-api-key", a.key)
	req.Header.Set("anthropic-version", "2023-06-01")
}

func (a anthropic) Models(ctx context.Context) ([]model.ModelSpec, error) {
	return a.listModels(ctx, "/v1/models?limit=1000", a.auth)
}

func anthropicImage(b model.Block) map[string]any {
	return map[string]any{"type": "image", "source": map[string]string{"type": "base64", "media_type": b.MimeType, "data": b.Data}}
}

func anthropicMessages(msgs []model.Message) []map[string]any {
	out := make([]map[string]any, 0, len(msgs))
	for _, m := range msgs {
		var content []map[string]any
		for _, b := range m.Content {
			switch b.Type {
			case enum.BlockText:
				content = append(content, map[string]any{"type": "text", "text": b.Text})
			case enum.BlockImage:
				content = append(content, anthropicImage(b))
			case enum.BlockToolCall:
				content = append(content, map[string]any{"type": "tool_use", "id": b.ID, "name": b.Name, "input": b.Args})
			case enum.BlockToolResult:
				var result any = b.Text
				if b.Data != "" {
					result = []map[string]any{{"type": "text", "text": b.Text}, anthropicImage(b)}
				}
				content = append(content, map[string]any{"type": "tool_result", "tool_use_id": b.ID, "content": result, "is_error": b.IsError})
			}
		}
		if len(content) > 0 {
			out = append(out, map[string]any{"role": string(m.Role), "content": content})
		}
	}
	return out
}

var anthropicCache = map[string]string{"type": "ephemeral"}

// anthropicCached marks the last block of the messages for the API to cache everything up to it.
func anthropicCached(msgs []map[string]any) []map[string]any {
	if len(msgs) == 0 {
		return msgs
	}
	content := msgs[len(msgs)-1]["content"].([]map[string]any)
	content[len(content)-1]["cache_control"] = anthropicCache
	return msgs
}

func (a anthropic) Complete(ctx context.Context, req model.ModelRequest, onText func(string)) (model.ModelReply, error) {
	body := map[string]any{
		"model": req.Model, "max_tokens": anthropicMaxTokens, "stream": true,
		"messages": anthropicCached(anthropicMessages(req.Messages)),
	}
	// the API caches only up to a marked block: one after the tools and system, which rarely change, and one at
	// the end of the messages, so the next call of the turn or chat reads all before it from the cache
	if req.System != "" {
		body["system"] = []map[string]any{{"type": "text", "text": req.System, "cache_control": anthropicCache}}
	}
	if len(req.Tools) > 0 {
		tools := make([]map[string]any, len(req.Tools))
		for i, t := range req.Tools {
			tools[i] = map[string]any{"name": t.Name, "description": t.Description, "input_schema": t.Parameters}
		}
		body["tools"] = tools
	}
	if req.Effort != "" {
		body["output_config"] = map[string]string{"effort": req.Effort}
	}
	res, err := a.do(ctx, http.MethodPost, "/v1/messages", body, a.auth)
	if err != nil {
		return model.ModelReply{}, err
	}
	defer res.Body.Close()

	var reply model.ModelReply
	var blocks []model.Block
	var text, args strings.Builder
	var open *model.Block
	finished := false
	err = readSSE(res.Body, func(data []byte) (bool, error) {
		var ev struct {
			Type  string `json:"type"`
			Block struct {
				Type string `json:"type"`
				ID   string `json:"id"`
				Name string `json:"name"`
			} `json:"content_block"`
			Delta struct {
				Type        string `json:"type"`
				Text        string `json:"text"`
				PartialJSON string `json:"partial_json"`
				StopReason  string `json:"stop_reason"`
			} `json:"delta"`
			Message struct {
				Usage struct {
					Input     int  `json:"input_tokens"`
					CacheRead int  `json:"cache_read_input_tokens"`
					CacheMake *int `json:"cache_creation_input_tokens"` // nil when not reported
				} `json:"usage"`
			} `json:"message"`
			Usage struct {
				Output int `json:"output_tokens"`
			} `json:"usage"`
		}
		if json.Unmarshal(data, &ev) != nil {
			return false, model.Errorf(model.CodeUnavailable, "模型回覆格式不正確")
		}
		switch ev.Type {
		case "message_start":
			u := ev.Message.Usage
			reply.Usage.CacheRead = u.CacheRead
			if u.CacheMake != nil {
				reply.Usage.CacheWrite, reply.Usage.CacheWriteKnown = *u.CacheMake, true
			}
			reply.Usage.Input = u.Input + u.CacheRead + reply.Usage.CacheWrite
		case "content_block_start":
			open = nil
			if ev.Block.Type == "tool_use" {
				open = &model.Block{Type: enum.BlockToolCall, ID: ev.Block.ID, Name: ev.Block.Name}
				args.Reset()
			}
		case "content_block_delta":
			switch ev.Delta.Type {
			case "text_delta":
				text.WriteString(ev.Delta.Text)
				onText(ev.Delta.Text)
			case "input_json_delta":
				args.WriteString(ev.Delta.PartialJSON)
			}
		case "content_block_stop":
			if open != nil {
				open.Args = json.RawMessage(args.String())
				if len(open.Args) == 0 {
					open.Args = json.RawMessage("{}")
				}
				blocks = append(blocks, *open)
				open = nil
			}
		case "message_delta":
			reply.Usage.Output = ev.Usage.Output
			reply.Truncated = ev.Delta.StopReason == "max_tokens"
		case "message_stop":
			finished = true
			return true, nil
		case "error":
			return false, model.Errorf(model.CodeUnavailable, "模型回報暫時性錯誤")
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
	if reply.Truncated {
		return reply, nil
	}
	if err := validCalls(blocks); err != nil {
		return model.ModelReply{}, err
	}
	reply.Content = append(reply.Content, blocks...)
	return reply, nil
}
