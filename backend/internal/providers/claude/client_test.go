package claude

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"image"
	"image/png"
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
	})
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
