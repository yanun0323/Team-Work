package providers

import (
	"context"
	"encoding/json"
	"net/http"
	"net/url"
	"slices"
	"strings"

	"github.com/yanun0323/Team-Work/internal/model"
	"github.com/yanun0323/Team-Work/internal/model/enum"
)

// openAI speaks Chat Completions: Google's compatible endpoint and anything compatible. OpenAI's own API is spoken
// through the Responses API instead, by openAIResponses.
type openAI struct {
	client
	// askServer: a compatible server, asked what length it runs a model at when its list does not say.
	askServer bool
}

func (o openAI) auth(req *http.Request) { req.Header.Set("Authorization", "Bearer "+o.key) }

func (o openAI) Models(ctx context.Context) ([]model.ModelSpec, error) {
	listed, err := o.listed(ctx, "/models", o.auth)
	if err != nil {
		return nil, err
	}
	specs := specsOf(listed)
	if o.askServer {
		for i, m := range listed {
			var caps []string
			if json.Unmarshal(m.Capabilities, &caps) == nil && slices.Contains(caps, "image_generation") {
				specs[i].ImageGeneration = true
				specs[i].ImageOnly = !slices.Contains(caps, "chat")
			}
		}
	}
	if !o.askServer || !slices.ContainsFunc(specs, func(s model.ModelSpec) bool { return !s.ImageOnly && s.ContextWindow == 0 }) {
		return specs, nil
	}
	var windows map[string]int
	if slices.ContainsFunc(listed, llamaCpp) {
		windows = o.llamaCppWindows(ctx, specs)
	} else {
		windows = o.lmStudioWindows(ctx)
	}
	for i := range specs {
		if specs[i].ContextWindow == 0 {
			specs[i].ContextWindow = windows[specs[i].ID]
		}
	}
	return specs, nil
}

// serverRoot is where a server's own endpoints are, outside the /v1 of its OpenAI-compatible API.
func (o openAI) serverRoot() string {
	u, err := url.Parse(o.base)
	if err != nil || u.Host == "" {
		return ""
	}
	return u.Scheme + "://" + u.Host
}

// llamaCppProbes is the most models llama.cpp's server is asked about, one request each.
const llamaCppProbes = 32

// llamaCppWindows reads the length llama.cpp's server gives each request, the n_ctx of its /props. A server in router
// mode answers for a model it has loaded; autoload=false keeps the question from loading one.
// https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md
func (o openAI) llamaCppWindows(ctx context.Context, specs []model.ModelSpec) map[string]int {
	root, out := o.serverRoot(), map[string]int{}
	if root == "" {
		return out
	}
	asked := 0
	for _, s := range specs {
		if s.ImageOnly || s.ContextWindow > 0 || asked == llamaCppProbes || ctx.Err() != nil {
			continue
		}
		asked++
		var body struct {
			Settings struct {
				NCtx float64 `json:"n_ctx"`
			} `json:"default_generation_settings"`
		}
		if o.getJSON(ctx, root, "/props?autoload=false&model="+url.QueryEscape(s.ID), &body) == nil && body.Settings.NCtx > 0 {
			out[s.ID] = int(body.Settings.NCtx)
		}
	}
	return out
}

// lmStudioWindows reads the length LM Studio loaded each model at, by its key and by the id of each copy loaded. A
// model not loaded has only its max_context_length, the length it was trained to, which is not taken.
// https://lmstudio.ai/docs/developer/rest/list
func (o openAI) lmStudioWindows(ctx context.Context) map[string]int {
	root, out := o.serverRoot(), map[string]int{}
	if root == "" {
		return out
	}
	var body struct {
		Models []struct {
			Key    string `json:"key"`
			Loaded []struct {
				ID     string `json:"id"`
				Config struct {
					ContextLength float64 `json:"context_length"`
				} `json:"config"`
			} `json:"loaded_instances"`
		} `json:"models"`
	}
	if o.getJSON(ctx, root, "/api/v1/models", &body) != nil {
		return out
	}
	for _, m := range body.Models {
		for _, l := range m.Loaded {
			if n := int(l.Config.ContextLength); n > 0 {
				if out[m.Key] == 0 {
					out[m.Key] = n
				}
				out[l.ID] = n
			}
		}
	}
	return out
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
	// ExtraContent is what a provider attached to the call to have it back: Gemini's thought signature, which Gemini 3
	// requires with each call it made (`{"google":{"thought_signature":...}}`).
	ExtraContent json.RawMessage `json:"extra_content,omitempty"`
}

// chatOrigin marks what this model at this address attached to its calls. A signature holds only for the model that
// made it, so no other one is sent it.
func chatOrigin(base, modelID string) string { return "chat:" + base + " " + modelID }

func chatMessages(req model.ModelRequest, origin string) []chatMessage {
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
				if m.Role == enum.RoleAssistant && b.Origin == origin && len(b.Raw) > 0 {
					c.ExtraContent = b.Raw
				}
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

// maxContinues is the most times one reply cut at the server's output limit is asked to go on.
const maxContinues = 3

func (o openAI) Complete(ctx context.Context, req model.ModelRequest, onText func(string)) (model.ModelReply, error) {
	messages := chatMessages(req, chatOrigin(o.base, req.Model))
	body := map[string]any{
		"model": req.Model, "messages": messages, "stream": true,
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

	origin := chatOrigin(o.base, req.Model)
	var reply model.ModelReply
	var text strings.Builder
	// Calls in the order they began. A piece names its call by index, but Gemini sends parallel calls whole, one to a
	// chunk, with no index or 0 on each, so a piece with an id not seen yet begins a new call.
	var calls []*model.Block
	var args []*strings.Builder
	byIndex, byID := map[int]int{}, map[string]int{}
	slot := func(index *int, id string) int {
		at, known := -1, false
		if index != nil {
			at, known = byIndex[*index]
		}
		if id != "" {
			if i, ok := byID[id]; ok {
				return i
			}
			if !known || calls[at].ID != "" {
				at = -1
			}
		} else if !known {
			at = len(calls) - 1
		}
		if at < 0 {
			calls = append(calls, &model.Block{Type: enum.BlockToolCall})
			args = append(args, &strings.Builder{})
			at = len(calls) - 1
		}
		if index != nil {
			byIndex[*index] = at
		}
		if id != "" {
			calls[at].ID, byID[id] = id, at
		}
		return at
	}
	for round := 0; ; round++ {
		var usage model.ModelUsage
		err := o.stream(ctx, body, func(u model.ModelUsage) { usage = u }, func(delta chatDelta) {
			if delta.Content != "" {
				text.WriteString(delta.Content)
				onText(delta.Content)
			}
			for _, d := range delta.ToolCalls {
				i := slot(d.Index, d.ID)
				calls[i].Name += d.Function.Name
				args[i].WriteString(d.Function.Arguments)
				// it may come on any one of the call's pieces; a later piece without it leaves it be
				if len(d.ExtraContent) > 0 && string(d.ExtraContent) != "null" {
					calls[i].Raw, calls[i].Origin = d.ExtraContent, origin
				}
			}
		}, &reply.Truncated)
		if round == 0 {
			reply.Usage = usage
		} else {
			// a continuation's input is the first request's plus what was written, so only its output is new
			reply.Usage.Output += usage.Output
		}
		if err != nil {
			if round == 0 || ctx.Err() != nil {
				return failed(reply, err)
			}
			reply.Truncated = true // the continuation failed: the reply stays as it was cut
			break
		}
		partial := strings.TrimRight(text.String(), " \t\r\n")
		if !reply.Truncated || !o.askServer || len(calls) > 0 || partial == "" || round == maxContinues {
			break
		}
		// Ask a self-hosted server to extend the cut reply rather than begin a new one: vLLM, SGLang and sushi read
		// continue_final_message, and vLLM refuses it unless add_generation_prompt is off. Trailing whitespace is left
		// out, as the model writes it again (sushi trims it from the prompt). Only self-hosted servers are asked: a
		// hosted API would refuse the field or answer the partial as a new turn.
		text.Reset()
		text.WriteString(partial)
		reply.Truncated = false
		body["messages"] = append(slices.Clip(messages), chatMessage{Role: "assistant", Content: partial})
		body["continue_final_message"], body["add_generation_prompt"] = true, false
	}
	if text.Len() > 0 {
		reply.Content = append(reply.Content, model.Block{Type: enum.BlockText, Text: text.String()})
	}
	if reply.Truncated { // never run partial tool arguments
		return reply, nil
	}
	var blocks []model.Block
	for i, c := range calls {
		c.Args = json.RawMessage(args[i].String())
		blocks = append(blocks, *c)
	}
	if err := validCalls(blocks); err != nil {
		return failed(reply, err)
	}
	reply.Content = append(reply.Content, blocks...)
	return reply, nil
}

// chatDelta is one piece of a streamed reply.
type chatDelta struct {
	Content   string `json:"content"`
	ToolCalls []struct {
		Index    *int   `json:"index"`
		ID       string `json:"id"`
		Function struct {
			Name      string `json:"name"`
			Arguments string `json:"arguments"`
		} `json:"function"`
		ExtraContent json.RawMessage `json:"extra_content"`
	} `json:"tool_calls"`
}

// stream sends one request and reads its reply, handing each piece to onDelta, the usage to onUsage, and setting
// *cut when the server stopped it at its output limit.
func (o openAI) stream(ctx context.Context, body map[string]any, onUsage func(model.ModelUsage), onDelta func(chatDelta), cut *bool) error {
	res, err := o.do(ctx, http.MethodPost, "/chat/completions", body, o.auth)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	finished := false
	err = readSSE(res.Body, func(data []byte) (bool, error) {
		if string(data) == "[DONE]" {
			finished = true
			return true, nil
		}
		var chunk struct {
			Error   json.RawMessage `json:"error"`
			Choices []struct {
				Delta        chatDelta `json:"delta"`
				FinishReason string    `json:"finish_reason"`
			} `json:"choices"`
			Usage *struct {
				Prompt     int `json:"prompt_tokens"`
				Completion int `json:"completion_tokens"`
				Details    struct {
					Cached *int `json:"cached_tokens"` // nil when not reported
				} `json:"prompt_tokens_details"`
			} `json:"usage"`
		}
		if json.Unmarshal(data, &chunk) != nil {
			return false, model.Errorf(model.CodeUnavailable, "模型回覆格式不正確")
		}
		if len(chunk.Error) > 0 && string(chunk.Error) != "null" {
			if saysTooLong(string(chunk.Error)) { // some servers refuse a long conversation once the reply has begun
				return false, model.Errorf(model.CodeContextOverflow, "對話太長，超過模型能讀取的長度")
			}
			return false, model.Errorf(model.CodeInvalid, "模型回報錯誤，請檢查模型與設定")
		}
		if u := chunk.Usage; u != nil {
			usage := model.ModelUsage{Input: u.Prompt, Output: u.Completion}
			if u.Details.Cached != nil {
				usage.CacheRead, usage.CacheReadKnown = *u.Details.Cached, true
			}
			onUsage(usage)
		}
		for _, c := range chunk.Choices {
			onDelta(c.Delta)
			if c.FinishReason == "length" {
				*cut = true
			}
		}
		return false, nil
	})
	if err != nil {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		return err
	}
	if !finished {
		return model.Errorf(model.CodeUnavailable, "模型回覆沒有結束就中斷了")
	}
	return nil
}
