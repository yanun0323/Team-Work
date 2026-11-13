package claude

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"image"
	"image/png"
	"os"
	"strings"
	"testing"

	"github.com/yanun0323/Team-Work/internal/model"
	"github.com/yanun0323/Team-Work/internal/model/enum"
)

func TestToolResultsBecomeTheirOwnMessages(t *testing.T) {
	got := toMessages([]model.Message{
		{Role: enum.RoleUser, Content: []model.Block{{Type: enum.BlockText, Text: "hi"}, {Type: enum.BlockImage, MimeType: "image/png", Data: "x"}}},
		{Role: enum.RoleAssistant, Content: []model.Block{{Type: enum.BlockText, Text: "ok"}, {Type: enum.BlockToolCall, ID: "a", Name: "t", Args: json.RawMessage(`{}`)}, {Type: enum.BlockToolCall, ID: "b", Name: "t", Args: json.RawMessage(`{}`)}}},
		{Role: enum.RoleUser, Content: []model.Block{{Type: enum.BlockToolResult, ID: "a", Text: "1"}, {Type: enum.BlockToolResult, ID: "b", Text: "2", IsError: true}}},
	}, "")
	if len(got) != 4 || got[2].Role != "tool" || got[2].CallID != "a" || got[3].CallID != "b" || !got[3].IsError || got[3].Content[0].Text != "2" {
		t.Fatalf("%+v", got)
	}
	if len(got[1].Content) != 3 || got[1].Content[2].ID != "b" {
		t.Fatalf("%+v", got[1])
	}
}

// the real conversion against a fake Claude Code process, for a whole call and the reply it gives back
func TestCompleteThroughTheChild(t *testing.T) {
	fakeClaude(t)
	c, err := New(nil)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	var text strings.Builder
	reply, err := c.Complete(context.Background(), model.ModelRequest{Cwd: t.TempDir(), Session: "s", Model: "haiku", Effort: "not-a-level", System: "sys",
		Messages: []model.Message{{Role: enum.RoleUser, Content: []model.Block{{Type: enum.BlockText, Text: "hello"}}}}},
		func(s string) { text.WriteString(s) })
	if err != nil {
		t.Fatal(err)
	}
	if len(reply.Content) == 0 || reply.Content[0].Type != enum.BlockText || reply.Content[0].Text != text.String() {
		t.Fatalf("%+v %q", reply, text.String())
	}
	// the child reports no cache writes, so none are claimed
	if reply.Usage.Input == 0 || reply.Usage.CacheWriteKnown || reply.Usage.CacheWrite != 0 {
		t.Fatalf("usage %+v", reply.Usage)
	}
	if ids, err := c.Models(context.Background()); err != nil || len(ids) == 0 {
		t.Fatalf("%v %v", ids, err)
	}
}

func (u ModelUsage) CacheReadKnown() bool  { return u.CacheReadReported }
func (u ModelUsage) CacheWriteKnown() bool { return u.CacheWriteReported }

// Conversations saved before read_file scaled images down still hold large ones; they are scaled on the way out.
func TestLargeImagesInHistoryAreScaledDown(t *testing.T) {
	var buf bytes.Buffer
	png.Encode(&buf, image.NewRGBA(image.Rect(0, 0, 4800, 3000)))
	big := base64.StdEncoding.EncodeToString(buf.Bytes())
	got := toMessages([]model.Message{
		{Role: enum.RoleUser, Content: []model.Block{{Type: enum.BlockImage, MimeType: "image/png", Data: big}}},
		{Role: enum.RoleUser, Content: []model.Block{{Type: enum.BlockToolResult, ID: "a", Text: "Image a.png", MimeType: "image/png", Data: big}}},
	}, "")
	for _, b := range []Block{got[0].Content[0], got[1].Content[1]} {
		raw, _ := base64.StdEncoding.DecodeString(b.Data)
		if cfg, err := png.DecodeConfig(bytes.NewReader(raw)); err != nil || cfg.Width != 2000 || cfg.Height != 1250 || b.MimeType != "image/png" {
			t.Fatalf("%v %+v", err, cfg)
		}
	}
}

func TestTooManyLargeImagesSaysSo(t *testing.T) {
	err := claudeError(`API Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"messages.3.content.0.image.source.base64.data: At least one of the image dimensions exceed max allowed size for many-image requests: 2000 pixels"}}`)
	if err == nil || !strings.Contains(err.Error(), "Claude") || strings.Contains(err.Error(), "installation") {
		t.Fatalf("%v", err)
	}
}

func TestToolResultKeepsItsImage(t *testing.T) {
	got := toMessages([]model.Message{{Role: enum.RoleUser, Content: []model.Block{{Type: enum.BlockToolResult, ID: "a", Text: "Image a.png", MimeType: "image/png", Data: "QUJD"}}}}, "")
	if len(got) != 1 || got[0].Role != "tool" || len(got[0].Content) != 2 || got[0].Content[1].Type != "image" || got[0].Content[1].Data != "QUJD" {
		t.Fatalf("%+v", got)
	}
	history, err := messagesFor(got)
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := json.Marshal(history)
	if !strings.Contains(string(raw), `"media_type":"image/png"`) {
		t.Fatalf("%s", raw)
	}
}

// What a run is told while it works follows a round of tool results; Claude reads it in the history it resumes from.
func TestWordsAfterToolResultsAreInTheResumedHistory(t *testing.T) {
	t.Setenv("CLAUDE_CONFIG_DIR", t.TempDir())
	msgs := toMessages([]model.Message{
		{Role: enum.RoleUser, Content: []model.Block{{Type: enum.BlockText, Text: "do it"}}},
		{Role: enum.RoleAssistant, Content: []model.Block{{Type: enum.BlockToolCall, ID: "a", Name: "run_command", Args: json.RawMessage(`{}`)}}},
		{Role: enum.RoleUser, Content: []model.Block{{Type: enum.BlockToolResult, ID: "a", Text: "ran"}}},
		{Role: enum.RoleUser, Content: []model.Block{{Type: enum.BlockText, Text: "The task owner tells you while you work: use B"}}},
	}, "")
	m, err := makeMirror(CompleteParams{Cwd: t.TempDir(), Model: "haiku", Messages: msgs})
	if err != nil {
		t.Fatal(err)
	}
	defer m.cleanup()
	raw, err := os.ReadFile(m.path)
	if err != nil {
		t.Fatal(err)
	}
	history := string(raw)
	result, said := strings.Index(history, `"tool_use_id":"a"`), strings.Index(history, "use B")
	if result < 0 || said < result || strings.Contains(history, "[no tool result recorded]") {
		t.Fatalf("%s", history)
	}
	if len(m.prompt) != 1 || !strings.Contains(m.prompt[0]["text"].(string), "Continue from the conversation above") {
		t.Fatalf("%+v", m.prompt)
	}
}

// Claude keeps earlier thinking in the start it caches, so a signed thinking block must come back exactly, on the
// live process and in a rebuilt history alike, but only to the model that wrote it.
func TestSignedThinkingGoesBackToTheSameModel(t *testing.T) {
	t.Setenv("CLAUDE_CONFIG_DIR", t.TempDir())
	turn := newTurn([]ToolSpec{{Name: "read"}}, func(any) error { return nil })
	s := &session{results: map[string]object{}, seenMessages: map[string]bool{}, closedMessages: map[string]bool{}}
	for _, line := range []string{
		`{"type":"stream_event","event":{"type":"message_start","message":{"id":"m1"}}}`,
		`{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":"","signature":""}}}`,
		`{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"plan"}}}`,
		`{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"sig-1"}}}`,
		`{"type":"stream_event","event":{"type":"content_block_stop","index":0}}`,
		`{"type":"stream_event","event":{"type":"content_block_start","index":1,"content_block":{"type":"redacted_thinking","data":"secret"}}}`,
		`{"type":"stream_event","event":{"type":"content_block_stop","index":1}}`,
		`{"type":"stream_event","event":{"type":"content_block_delta","index":2,"delta":{"type":"text_delta","text":"ok"}}}`,
		`{"type":"assistant","uuid":"u1","message":{"id":"m1","content":[{"type":"thinking","thinking":"plan","signature":"sig-1"}]}}`,
		`{"type":"assistant","uuid":"u2","message":{"id":"m1","content":[{"type":"redacted_thinking","data":"secret"}]}}`,
		`{"type":"assistant","uuid":"u3","message":{"id":"m1","content":[{"type":"text","text":"ok"}]}}`,
		`{"type":"result","stop_reason":"end_turn"}`,
	} {
		var f frame
		if err := json.Unmarshal([]byte(line), &f); err != nil {
			t.Fatal(err)
		}
		if _, err := turn.consume(s, f); err != nil {
			t.Fatal(err)
		}
	}
	var reply []model.Block
	var kept []Block
	for _, b := range turn.emitted {
		reply = appendReply(reply, b, reasoningOrigin("opus"), func(string) {})
		if b.Type != "thinking" {
			kept = append(kept, b)
		}
	}
	if len(reply) != 3 || reply[0].Type != enum.BlockReasoning || reply[1].Type != enum.BlockReasoning || reply[2].Text != "ok" ||
		string(reply[0].Raw) != `{"signature":"sig-1","thinking":"plan","type":"thinking"}` || string(reply[1].Raw) != `{"data":"secret","type":"redacted_thinking"}` ||
		reply[0].Origin != "claude-code:opus" {
		t.Fatalf("reply %+v", reply)
	}

	// Saved, then sent on: what the engine keeps round-trips through JSON.
	conv := []model.Message{{Role: enum.RoleUser, Content: []model.Block{{Type: enum.BlockText, Text: "hi"}}}, {Role: enum.RoleAssistant, Content: reply}}
	saved, _ := json.Marshal(conv)
	conv = nil
	if err := json.Unmarshal(saved, &conv); err != nil {
		t.Fatal(err)
	}
	conv = append(conv, model.Message{Role: enum.RoleUser, Content: []model.Block{{Type: enum.BlockText, Text: "next"}}})
	p := CompleteParams{Cwd: t.TempDir(), Model: "opus", Messages: toMessages(conv, reasoningOrigin("opus"))}
	live := &session{child: &child{done: make(chan struct{})}, signature: signature(p), expected: []ModelMessage{{Role: "user", Content: []Block{text("hi")}}, {Role: "assistant", Content: kept}}}
	if why := restartReason(live, p); why != "" {
		t.Fatalf("the live process was restarted: %s", why)
	}
	m, err := makeMirror(p)
	if err != nil {
		t.Fatal(err)
	}
	defer m.cleanup()
	history, _ := os.ReadFile(m.path)
	if !strings.Contains(string(history), `{"signature":"sig-1","thinking":"plan","type":"thinking"},{"data":"secret","type":"redacted_thinking"},{"text":"ok","type":"text"}`) {
		t.Fatalf("rebuilt history lost the thinking: %s", history)
	}

	// Another model's, or another provider's, reasoning is never sent.
	for _, origin := range []string{reasoningOrigin("haiku"), "codex:gpt-5"} {
		for _, msg := range toMessages(conv, origin) {
			for _, b := range msg.Content {
				if b.Type == "reasoning" {
					t.Fatalf("%s got reasoning written by opus", origin)
				}
			}
		}
	}
	other := conv[1]
	other.Content = []model.Block{{Type: enum.BlockReasoning, Raw: reply[0].Raw, Origin: "codex:gpt-5"}, {Type: enum.BlockText, Text: "ok"}}
	if got := toMessages([]model.Message{other}, reasoningOrigin("opus")); len(got) != 1 || len(got[0].Content) != 1 || got[0].Content[0].Text != "ok" {
		t.Fatalf("%+v", got)
	}
}

// A turn that fails after Claude reported usage still says what it used, so it is counted, but leaves nothing to act on.
func TestFailedTurnsKeepTheirUsage(t *testing.T) {
	for _, c := range []struct {
		mode        string
		input, read int
		write       int
		writeKnown  bool
	}{{"usage-stream", 9, 4, 2, true}, {"usage-result", 6, 1, 0, false}} {
		fakeClaude(t)
		t.Setenv("MHO_TEST_CLAUDE_FAILURE", c.mode)
		cl, err := New(nil)
		if err != nil {
			t.Fatal(err)
		}
		reply, err := cl.Complete(context.Background(), model.ModelRequest{Cwd: t.TempDir(), Session: "s", Model: "haiku", System: "sys",
			Tools:    []model.ToolSpec{{Name: "read", Parameters: json.RawMessage(`{"type":"object"}`)}},
			Messages: []model.Message{{Role: enum.RoleUser, Content: []model.Block{{Type: enum.BlockText, Text: "hello"}}}}}, func(string) {})
		cl.Close()
		if err == nil || len(reply.Content) != 0 {
			t.Fatalf("%s: %v %+v", c.mode, err, reply.Content)
		}
		if u := reply.Usage; u.Input != c.input || u.CacheRead != c.read || u.CacheWrite != c.write || u.CacheWriteKnown != c.writeKnown || !u.CacheReadKnown {
			t.Fatalf("%s: usage %+v", c.mode, u)
		}
		if strings.Contains(err.Error(), "private") {
			t.Fatalf("%s: %v", c.mode, err)
		}
	}
}
