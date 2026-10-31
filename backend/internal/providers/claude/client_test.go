package claude

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/yanun0323/mho-company/internal/model"
	"github.com/yanun0323/mho-company/internal/model/enum"
)

func TestToolResultsBecomeTheirOwnMessages(t *testing.T) {
	got := toMessages([]model.Message{
		{Role: enum.RoleUser, Content: []model.Block{{Type: enum.BlockText, Text: "hi"}, {Type: enum.BlockImage, MimeType: "image/png", Data: "x"}}},
		{Role: enum.RoleAssistant, Content: []model.Block{{Type: enum.BlockText, Text: "ok"}, {Type: enum.BlockToolCall, ID: "a", Name: "t", Args: json.RawMessage(`{}`)}, {Type: enum.BlockToolCall, ID: "b", Name: "t", Args: json.RawMessage(`{}`)}}},
		{Role: enum.RoleUser, Content: []model.Block{{Type: enum.BlockToolResult, ID: "a", Text: "1"}, {Type: enum.BlockToolResult, ID: "b", Text: "2", IsError: true}}},
	})
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
	c, err := New()
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
	if ids, err := c.Models(context.Background()); err != nil || len(ids) == 0 {
		t.Fatalf("%v %v", ids, err)
	}
}

func (u ModelUsage) CacheReadKnown() bool  { return u.CacheReadReported }
func (u ModelUsage) CacheWriteKnown() bool { return u.CacheWriteReported }

func TestToolResultKeepsItsImage(t *testing.T) {
	got := toMessages([]model.Message{{Role: enum.RoleUser, Content: []model.Block{{Type: enum.BlockToolResult, ID: "a", Text: "Image a.png", MimeType: "image/png", Data: "QUJD"}}}})
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
