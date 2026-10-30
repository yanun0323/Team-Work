package claude

import (
	"context"
	"encoding/json"
	"log/slog"
	"path/filepath"
	"reflect"
	"regexp"
	"strings"
	"sync"
	"time"
)

type pendingCall struct {
	controlID string
	rpcID     json.RawMessage
}
type session struct {
	child          *child
	mirror         *mirror
	signature      string
	expected       []ModelMessage
	toolIDs        []string
	tools          []ToolSpec
	pending        map[string]pendingCall
	results        map[string]object
	closedMessages map[string]bool
	seenMessages   map[string]bool
	messageID      string
	timer          *time.Timer
}

func (s *session) close() {
	if s.timer != nil {
		s.timer.Stop()
	}
	s.child.close()
	s.mirror.cleanup()
}
func (s *session) mcpReply(ctx context.Context, p pendingCall, result object) error {
	return s.child.reply(ctx, p.controlID, object{"mcp_response": object{"jsonrpc": "2.0", "id": p.rpcID, "result": result}})
}
func (s *session) control(ctx context.Context, f frame) error {
	// Other control requests can use a text message instead of an MCP object.
	// Reject unsupported requests before decoding their subtype-specific fields.
	var header struct {
		Subtype    string `json:"subtype"`
		ServerName string `json:"server_name"`
	}
	if json.Unmarshal(f.Request, &header) != nil {
		return unavailable("Claude sent an invalid control request.")
	}
	if header.Subtype != "mcp_message" || header.ServerName != "mho" {
		return s.child.rejectControl(ctx, f.RequestID)
	}
	var r struct {
		Message struct {
			ID     json.RawMessage `json:"id"`
			Method string          `json:"method"`
			Params struct {
				ProtocolVersion string `json:"protocolVersion"`
				Name            string `json:"name"`
				Meta            struct {
					ToolUseID string `json:"claudecode/toolUseId"`
				} `json:"_meta"`
			} `json:"params"`
		} `json:"message"`
	}
	if json.Unmarshal(f.Request, &r) != nil {
		return unavailable("Claude sent an invalid control request.")
	}
	call := pendingCall{f.RequestID, r.Message.ID}
	if len(call.rpcID) == 0 {
		call.rpcID = json.RawMessage(`0`)
		return s.mcpReply(ctx, call, object{})
	}
	switch r.Message.Method {
	case "initialize":
		return s.mcpReply(ctx, call, object{"protocolVersion": r.Message.Params.ProtocolVersion, "capabilities": object{"tools": object{}}, "serverInfo": object{"name": "mho", "version": "1.0.0"}})
	case "ping":
		return s.mcpReply(ctx, call, object{})
	case "tools/list":
		tools := []object{}
		for _, t := range s.tools {
			tools = append(tools, object{"name": t.Name, "description": t.Description, "inputSchema": t.Parameters})
		}
		return s.mcpReply(ctx, call, object{"tools": tools})
	case "tools/call":
		known := false
		for _, t := range s.tools {
			if t.Name == r.Message.Params.Name {
				known = true
			}
		}
		id := r.Message.Params.Meta.ToolUseID
		if id == "" {
			return rejected("Claude omitted its tool call ID.")
		}
		if !known {
			return s.mcpReply(ctx, call, object{"isError": true, "content": []object{{"type": "text", "text": "This tool is not available in this conversation. Nothing was executed. Use only the supplied tools and continue answering without retrying this action."}}})
		}
		if _, exists := s.pending[id]; exists {
			return rejected("Claude repeated a pending tool call.")
		}
		if result, ok := s.results[id]; ok {
			delete(s.results, id)
			return s.mcpReply(ctx, call, result)
		}
		// Park the request. Only Mho's next complete request supplies the result.
		s.pending[id] = call
		return nil
	default:
		return s.child.reply(ctx, f.RequestID, object{"mcp_response": object{"jsonrpc": "2.0", "id": call.rpcID, "error": object{"code": -32601, "message": "Unknown method"}}})
	}
}
func (s *session) initialize(ctx context.Context, system string) (json.RawMessage, error) {
	request := object{"subtype": "initialize"}
	if system != "" {
		request["systemPrompt"] = []string{system}
	}
	if len(s.tools) > 0 {
		request["sdkMcpServers"] = []string{"mho"}
	}
	return s.child.control(ctx, request, s.control)
}
func (s *session) prompt(ctx context.Context, blocks []object) error {
	return s.child.send(ctx, object{"type": "user", "message": object{"role": "user", "content": blocks}, "parent_tool_use_id": nil, "session_id": ""})
}

type bridge struct {
	log        *slog.Logger
	mu         sync.Mutex
	sessions   map[string]*session
	active     map[string]context.CancelFunc
	closed     bool
	work       sync.WaitGroup
	onMetadata func(string, int)
}

func newBridge() *bridge {
	return &bridge{sessions: map[string]*session{}, active: map[string]context.CancelFunc{}}
}
func (b *bridge) close() {
	b.mu.Lock()
	b.closed = true
	for _, cancel := range b.active {
		cancel()
	}
	b.mu.Unlock()
	b.work.Wait()
	b.mu.Lock()
	defer b.mu.Unlock()
	for key, s := range b.sessions {
		s.close()
		delete(b.sessions, key)
	}
}

var toolName = regexp.MustCompile(`^[a-zA-Z0-9_-]+$`)

func validate(p CompleteParams) error {
	if p.Model == "" || !filepath.IsAbs(p.Cwd) || len(p.Messages) == 0 {
		return rejected("A model, absolute working directory and conversation are required.")
	}
	names := map[string]bool{}
	for _, t := range p.Tools {
		var schema struct {
			Type string `json:"type"`
		}
		if !toolName.MatchString(t.Name) || names[t.Name] || json.Unmarshal(t.Parameters, &schema) != nil || schema.Type != "object" {
			return rejected("Tools need unique names and object parameter schemas.")
		}
		names[t.Name] = true
	}
	_, err := messagesFor(p.Messages)
	return err
}
func signature(p CompleteParams) string {
	raw, _ := json.Marshal([]any{p.Cwd, p.Model, p.System, p.Thinking, p.Tools})
	return string(raw)
}
func sameJSON(a, b any) bool {
	// RawMessage object key order is not meaningful to history reuse.
	x, _ := json.Marshal(a)
	y, _ := json.Marshal(b)
	var xv, yv any
	if json.Unmarshal(x, &xv) != nil || json.Unmarshal(y, &yv) != nil {
		return false
	}
	return reflect.DeepEqual(xv, yv)
}
func reusable(s *session, p CompleteParams) bool {
	if s.signature != signature(p) || len(p.Messages) <= len(s.expected) || !sameJSON(p.Messages[:len(s.expected)], s.expected) {
		return false
	}
	extra := p.Messages[len(s.expected):]
	if len(s.toolIDs) == 0 {
		for _, m := range extra {
			if m.Role != "user" {
				return false
			}
		}
		return true
	}
	if len(extra) != len(s.toolIDs) {
		return false
	}
	ids := map[string]bool{}
	for _, id := range s.toolIDs {
		ids[id] = true
	}
	for _, m := range extra {
		if m.Role != "tool" || !ids[m.CallID] {
			return false
		}
		delete(ids, m.CallID)
	}
	return len(ids) == 0
}
func (b *bridge) complete(ctx context.Context, p CompleteParams, chunk func(any) error) (_ CompleteResult, err error) {
	started := time.Now()
	log := b.log
	if log != nil {
		log = log.With("session", p.Session, "attempt", newID())
	}
	record(log, "request_started", "messages", len(p.Messages), "tools", len(p.Tools))
	defer func() {
		record(log, "request_finished", "success", err == nil, "code", errorCode(err), "duration_ms", time.Since(started).Milliseconds())
	}()
	if err = validate(p); err != nil {
		return CompleteResult{}, err
	}
	key := p.Session
	if key == "" {
		key = newID()
	}
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	b.mu.Lock()
	if b.closed {
		b.mu.Unlock()
		return CompleteResult{}, unavailable("Claude provider is stopping.")
	}
	if _, ok := b.active[key]; ok {
		b.mu.Unlock()
		return CompleteResult{}, &Error{Code: CodeBusy, Message: "This Claude conversation already has a request running."}
	}
	b.active[key] = cancel
	b.work.Add(1)
	s := b.sessions[key]
	if s != nil && s.timer != nil {
		s.timer.Stop()
	}
	b.mu.Unlock()
	keep := false
	defer func() {
		b.mu.Lock()
		if s != nil {
			if keep && !b.closed {
				b.sessions[key] = s
				s.timer = time.AfterFunc(5*time.Minute, func() {
					b.mu.Lock()
					defer b.mu.Unlock()
					if b.sessions[key] == s && b.active[key] == nil {
						delete(b.sessions, key)
						s.close()
					}
				})
			} else {
				delete(b.sessions, key)
				s.close()
			}
		}
		delete(b.active, key)
		b.mu.Unlock()
		b.work.Done()
	}()
	if s != nil && !reusable(s, p) {
		b.mu.Lock()
		delete(b.sessions, key)
		b.mu.Unlock()
		s.close()
		s = nil
	}
	if s == nil {
		cwd, e := filepath.EvalSymlinks(p.Cwd)
		if e != nil {
			return CompleteResult{}, rejected("The project folder was not found.")
		}
		canonical := p
		canonical.Cwd = cwd
		history, e := makeMirror(canonical)
		if e != nil {
			return CompleteResult{}, safeError(e)
		}
		processLog := b.log
		if processLog != nil {
			processLog = processLog.With("session", p.Session)
		}
		c, e := startChild(canonical, history.resume, processLog)
		if e != nil {
			history.cleanup()
			return CompleteResult{}, e
		}
		s = &session{child: c, mirror: history, signature: signature(p), tools: p.Tools, pending: map[string]pendingCall{}, results: map[string]object{}, closedMessages: map[string]bool{}, seenMessages: map[string]bool{}}
		record(log, "request_process", "pid", c.cmd.Process.Pid)
		initCtx, stop := context.WithTimeout(ctx, 15*time.Second)
		_, e = s.initialize(initCtx, p.System)
		stop()
		if e != nil {
			return CompleteResult{}, e
		}
		if e = s.prompt(ctx, history.prompt); e != nil {
			return CompleteResult{}, e
		}
	} else {
		record(log, "request_process", "pid", s.child.cmd.Process.Pid)
		extra := p.Messages[len(s.expected):]
		if len(s.toolIDs) > 0 {
			for _, m := range extra {
				blocks := []object{}
				for _, block := range m.Content {
					if block.Type == "image" {
						blocks = append(blocks, object{"type": "image", "mimeType": block.MimeType, "data": block.Data})
					} else {
						blocks = append(blocks, object{"type": "text", "text": block.Text})
					}
				}
				result := object{"content": blocks, "isError": m.IsError}
				if call, ok := s.pending[m.CallID]; ok {
					delete(s.pending, m.CallID)
					if e := s.mcpReply(ctx, call, result); e != nil {
						return CompleteResult{}, e
					}
				} else {
					s.results[m.CallID] = result
				}
			}
		} else {
			msgs, e := messagesFor(extra)
			if e != nil {
				return CompleteResult{}, e
			}
			blocks := []object{}
			for _, m := range msgs {
				blocks = append(blocks, m.Content...)
			}
			if e = s.prompt(ctx, blocks); e != nil {
				return CompleteResult{}, e
			}
		}
	}
	turn := newTurn(p.Tools, chunk)
	for {
		f, e := s.child.next(ctx)
		if e != nil {
			return CompleteResult{}, e
		}
		if f.Type == "control_request" {
			if e = s.control(ctx, f); e != nil {
				return CompleteResult{}, e
			}
			continue
		}
		if f.Type == "result" && b.onMetadata != nil {
			for _, usage := range f.ModelUsage {
				if usage.ContextWindow > 0 {
					b.onMetadata(p.Model, usage.ContextWindow)
					break
				}
			}
		}
		done, e := turn.consume(s, f)
		if e != nil {
			return CompleteResult{}, e
		}
		if done {
			if ctx.Err() != nil {
				return CompleteResult{}, ctx.Err()
			}
			// Clone request history: callers may reuse their slices for the next turn.
			raw, _ := json.Marshal(p.Messages)
			_ = json.Unmarshal(raw, &s.expected)
			// callers keep text and tool calls only, so reasoning must not count against reuse
			var kept []Block
			for _, block := range turn.emitted {
				if block.Type != "thinking" {
					kept = append(kept, block)
				}
			}
			s.expected = append(s.expected, ModelMessage{Role: "assistant", Content: kept})
			s.toolIDs = nil
			for _, block := range turn.emitted {
				if block.Type == "tool_call" {
					s.toolIDs = append(s.toolIDs, block.ID)
				}
			}
			keep = true
			return CompleteResult{StopReason: turn.stop, Usage: turn.usage.modelUsage()}, nil
		}
	}
}

type tokenUsage struct {
	CacheReadReported  bool `json:"-"`
	CacheWriteReported bool `json:"-"`
	Input              int  `json:"input_tokens"`
	Output             int  `json:"output_tokens"`
	CacheRead          int  `json:"cache_read_input_tokens"`
	CacheCreate        int  `json:"cache_creation_input_tokens"`
}

// Stream deltas may contain only output_tokens. Merge those without losing
// input cache-field presence from message_start.
func (u *tokenUsage) UnmarshalJSON(data []byte) error {
	type plain tokenUsage
	if err := json.Unmarshal(data, (*plain)(u)); err != nil {
		return err
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(data, &fields); err != nil {
		return err
	}
	if v, ok := fields["cache_read_input_tokens"]; ok {
		u.CacheReadReported = string(v) != "null"
		if !u.CacheReadReported {
			u.CacheRead = 0
		}
	}
	if v, ok := fields["cache_creation_input_tokens"]; ok {
		u.CacheWriteReported = string(v) != "null"
		if !u.CacheWriteReported {
			u.CacheCreate = 0
		}
	}
	return nil
}

func (u tokenUsage) modelUsage() ModelUsage {
	return ModelUsage{Input: u.Input + u.CacheRead + u.CacheCreate, Output: u.Output, CacheRead: u.CacheRead, CacheWrite: u.CacheCreate, CacheReadReported: u.CacheReadReported, CacheWriteReported: u.CacheWriteReported}
}

type claudeBlock struct {
	Type     string          `json:"type"`
	ID       string          `json:"id"`
	Name     string          `json:"name"`
	Text     string          `json:"text"`
	Thinking string          `json:"thinking"`
	Input    json.RawMessage `json:"input"`
}
type assistantMessage struct {
	ID         string          `json:"id"`
	Content    []claudeBlock   `json:"content"`
	StopReason string          `json:"stop_reason"`
	Usage      json.RawMessage `json:"usage"`
}
type partialBlock struct {
	block claudeBlock
	json  string
}
type turn struct {
	tools    []ToolSpec
	chunk    func(any) error
	emitted  []Block
	usage    tokenUsage
	stop     string
	toolTurn bool
	calls    map[string]bool
	partial  map[int]*partialBlock
	streamed map[string]string
}

func newTurn(tools []ToolSpec, chunk func(any) error) *turn {
	return &turn{tools: tools, chunk: chunk, stop: "end_turn", calls: map[string]bool{}, partial: map[int]*partialBlock{}, streamed: map[string]string{}}
}
func (t *turn) send(b Block) error {
	if err := t.chunk(b); err != nil {
		return err
	}
	if n := len(t.emitted); n > 0 && t.emitted[n-1].Type == b.Type && (b.Type == "text" || b.Type == "thinking") {
		t.emitted[n-1].Text += b.Text
	} else {
		t.emitted = append(t.emitted, b)
	}
	return nil
}
func (t *turn) emitCall(b claudeBlock) error {
	name := strings.TrimPrefix(b.Name, toolPrefix)
	known := false
	for _, tool := range t.tools {
		if b.Name == toolPrefix+tool.Name {
			known = true
		}
	}
	if b.ID == "" || !strings.HasPrefix(b.Name, toolPrefix) || !toolName.MatchString(name) {
		return rejected("Claude requested a tool outside Mho or omitted its call ID.")
	}
	if !known {
		// Never forward an unavailable tool to the core. The MCP handler (or
		// Claude's own tool lookup) returns a denial; keep reading its reply.
		return nil
	}
	if !t.calls[b.ID] {
		args := b.Input
		if len(args) == 0 {
			args = json.RawMessage(`{}`)
		}
		var value map[string]any
		if json.Unmarshal(args, &value) != nil || value == nil {
			return rejected("Claude sent invalid tool arguments.")
		}
		if err := t.send(Block{Type: "tool_call", ID: b.ID, Name: name, Args: args}); err != nil {
			return err
		}
		t.calls[b.ID] = true
	}
	t.toolTurn = true
	return nil
}
func (t *turn) consume(s *session, f frame) (bool, error) {
	// Tool heartbeats also carry a parent ID; they are not nested model output.
	if f.ParentToolUseID != "" && (f.Type == "assistant" || f.Type == "stream_event" || f.Type == "user") {
		return false, rejected("Claude started an unexpected subagent.")
	}
	switch f.Type {
	case "stream_event":
		var e struct {
			Type         string           `json:"type"`
			Index        int              `json:"index"`
			Message      assistantMessage `json:"message"`
			ContentBlock claudeBlock      `json:"content_block"`
			Delta        struct {
				Type        string `json:"type"`
				Text        string `json:"text"`
				Thinking    string `json:"thinking"`
				PartialJSON string `json:"partial_json"`
				StopReason  string `json:"stop_reason"`
			} `json:"delta"`
			Usage json.RawMessage `json:"usage"`
		}
		if json.Unmarshal(f.Event, &e) != nil {
			return false, unavailable("Claude sent an invalid stream event.")
		}
		switch e.Type {
		case "message_start":
			clear(t.streamed)
			s.messageID = e.Message.ID
			clear(s.results)
			clear(s.seenMessages)
			clear(s.closedMessages)
			t.usage = tokenUsage{}
			if len(e.Message.Usage) > 0 {
				if err := json.Unmarshal(e.Message.Usage, &t.usage); err != nil {
					return false, err
				}
			}
		case "message_delta":
			if len(e.Usage) > 0 {
				if err := json.Unmarshal(e.Usage, &t.usage); err != nil {
					return false, err
				}
			}
			if e.Delta.StopReason != "" {
				t.stop = e.Delta.StopReason
			}
		case "content_block_start":
			if e.ContentBlock.Type == "tool_use" {
				t.partial[e.Index] = &partialBlock{block: e.ContentBlock}
			}
		case "content_block_delta":
			switch e.Delta.Type {
			case "input_json_delta":
				if b := t.partial[e.Index]; b != nil {
					b.json += e.Delta.PartialJSON
					if len(b.json) > maxFrame {
						return false, rejected("Claude tool arguments exceed the message limit.")
					}
				}
			case "text_delta", "thinking_delta":
				kind, text := "text", e.Delta.Text
				if e.Delta.Type == "thinking_delta" {
					kind, text = "thinking", e.Delta.Thinking
				}
				if err := t.send(Block{Type: kind, Text: text}); err != nil {
					return false, err
				}
				t.streamed[kind] += text
			}
		case "content_block_stop":
			if b := t.partial[e.Index]; b != nil {
				delete(t.partial, e.Index)
				if b.json != "" {
					b.block.Input = json.RawMessage(b.json)
				}
				if err := t.emitCall(b.block); err != nil {
					return false, err
				}
			}
		case "message_stop":
			if len(t.partial) != 0 {
				return false, unavailable("Claude stopped before completing its tool arguments.")
			}
			if t.toolTurn {
				s.closedMessages[s.messageID] = true
				t.stop = "tool_use"
				return true, nil
			}
		}
	case "assistant":
		if f.Error != "" {
			return false, claudeError(f.Error)
		}
		if f.Message.ID != "" && s.closedMessages[f.Message.ID] {
			return false, nil
		}
		delivered := f.UUID
		if delivered == "" {
			raw, _ := json.Marshal(f.Message)
			delivered = string(raw)
		}
		if s.seenMessages[delivered] {
			return false, nil
		}
		s.seenMessages[delivered] = true
		for _, b := range f.Message.Content {
			if b.Type == "tool_use" {
				if err := t.emitCall(b); err != nil {
					return false, err
				}
			} else if b.Type == "text" || b.Type == "thinking" {
				full := b.Text
				if b.Type == "thinking" {
					full = b.Thinking
				}
				prior := t.streamed[b.Type]
				if !strings.HasPrefix(full, prior) {
					return false, unavailable("Claude replaced an incomplete answer. Please retry.")
				}
				if len(full) > len(prior) {
					if err := t.send(Block{Type: b.Type, Text: full[len(prior):]}); err != nil {
						return false, err
					}
				}
				delete(t.streamed, b.Type)
			}
		}
		if len(f.Message.Usage) > 0 {
			if err := json.Unmarshal(f.Message.Usage, &t.usage); err != nil {
				return false, err
			}
		}
		if f.Message.StopReason == "tool_use" && t.toolTurn {
			t.stop = "tool_use"
			return true, nil
		}
	case "result":
		if len(t.partial) != 0 {
			return false, unavailable("Claude stopped before completing its tool arguments.")
		}
		if f.IsError {
			return false, claudeError(strings.Join(f.Errors, " ") + " " + f.Result)
		}
		if t.toolTurn {
			t.stop = "tool_use"
		} else if f.StopReason == "max_tokens" || t.stop == "max_tokens" {
			t.stop = "max_tokens"
		} else {
			t.stop = "end_turn"
		}
		if t.usage == (tokenUsage{}) {
			t.usage = f.Usage
		}
		return true, nil
	}
	return false, nil
}
