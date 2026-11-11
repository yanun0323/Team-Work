package usecase

import (
	"context"
	"encoding/json"
	"errors"
	"testing"

	"github.com/yanun0323/Team-Work/internal/model"
	"github.com/yanun0323/Team-Work/internal/model/enum"
)

type replyFake struct{ reply model.ModelReply }

func (f replyFake) Complete(context.Context, model.ModelRequest, func(string)) (model.ModelReply, error) {
	return f.reply, nil
}
func (f replyFake) Models(context.Context) ([]model.ModelSpec, error) { return nil, nil }

// A reply that holds only the provider's reasoning says nothing and calls nothing, so it is no reply at all.
func TestReasoningAloneIsNoReply(t *testing.T) {
	reasoning := model.Block{Type: enum.BlockReasoning, Raw: json.RawMessage(`{"type":"reasoning","encrypted_content":"e"}`), Origin: "codex:m"}
	for _, c := range []struct {
		content []model.Block
		empty   bool
	}{{nil, true}, {[]model.Block{reasoning}, true}, {[]model.Block{reasoning, {Type: enum.BlockText, Text: "done"}}, false}} {
		replied := false
		tr := &turn{provider: replyFake{model.ModelReply{Content: c.content}}, onStart: func() {}, onText: func(string) {},
			onReply: func(model.ModelReply) bool { replied = true; return true }}
		got, err := tr.run(context.Background())
		var failure *model.Error
		if empty := errors.As(err, &failure) && failure.Code == model.CodeUnavailable; empty != c.empty || replied == c.empty {
			t.Fatalf("%+v: err %v, replied %v", c.content, err, replied)
		}
		if !c.empty && (err != nil || got.Text != "done" || len(tr.req.Messages) != 1 || len(tr.req.Messages[0].Content) != 2) {
			t.Fatalf("%+v %v %+v", got, err, tr.req.Messages)
		}
	}
}
