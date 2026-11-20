package usecase

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"

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
	t.Parallel()
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

type seqFake struct {
	replies []model.ModelReply
	seen    []model.ModelRequest
}

func (f *seqFake) Complete(_ context.Context, req model.ModelRequest, _ func(string)) (model.ModelReply, error) {
	f.seen = append(f.seen, req)
	r := f.replies[min(len(f.seen), len(f.replies))-1]
	return r, nil
}
func (f *seqFake) Models(context.Context) ([]model.ModelSpec, error) { return nil, nil }

// A model that now and then ends its turn while still thinking (Qwen3.8-Flash-Next sends <|im_end|> inside its
// thought) gives an empty reply. It is asked once more with the same conversation, the empty reply left out of it.
func TestEmptyReplyIsAskedOnceMore(t *testing.T) {
	t.Parallel()
	reasoning := model.Block{Type: enum.BlockReasoning, Raw: json.RawMessage(`{}`), Origin: "chat:x m"}
	empty := model.ModelReply{Content: []model.Block{reasoning}}
	done := model.ModelReply{Content: []model.Block{{Type: enum.BlockText, Text: "done"}}}
	start := []model.Message{{Role: enum.RoleUser, Content: []model.Block{{Type: enum.BlockText, Text: "go"}}}}

	f := &seqFake{replies: []model.ModelReply{empty, done}}
	starts := 0
	tr := &turn{provider: f, onStart: func() { starts++ }, onText: func(string) {}, onReply: func(model.ModelReply) bool { return true },
		req: model.ModelRequest{Messages: start}}
	got, err := tr.run(context.Background())
	if err != nil || got.Text != "done" || len(f.seen) != 2 || starts != 2 {
		t.Fatalf("%+v %v, %d calls, %d starts", got, err, len(f.seen), starts)
	}
	if len(f.seen[1].Messages) != 1 || len(tr.req.Messages) != 2 || tr.req.Messages[1].Content[0].Text != "done" {
		t.Fatalf("the empty reply was kept: %+v / %+v", f.seen[1].Messages, tr.req.Messages)
	}

	// still empty: asked once more only, then given up on
	f = &seqFake{replies: []model.ModelReply{empty}}
	tr = &turn{provider: f, onStart: func() {}, onText: func(string) {}, onReply: func(model.ModelReply) bool { return true }}
	var failure *model.Error
	if _, err := tr.run(context.Background()); !errors.As(err, &failure) || failure.Code != model.CodeUnavailable || len(f.seen) != 2 {
		t.Fatalf("%v after %d calls", err, len(f.seen))
	}

	// a call the user authorized once is not made again
	f = &seqFake{replies: []model.ModelReply{empty, done}}
	tr = &turn{provider: f, noRetry: true, onStart: func() {}, onText: func(string) {}, onReply: func(model.ModelReply) bool { return true }}
	if _, err := tr.run(context.Background()); err == nil || len(f.seen) != 1 {
		t.Fatalf("%v after %d calls", err, len(f.seen))
	}
}

type failFake struct{ tries int }

func (f *failFake) Complete(context.Context, model.ModelRequest, func(string)) (model.ModelReply, error) {
	f.tries++
	return model.ModelReply{}, &model.Error{Code: model.CodeUnavailable, Message: "busy", Status: 503}
}
func (f *failFake) Models(context.Context) ([]model.ModelSpec, error) { return nil, nil }

// A provider down for a while, as Gemini was for about 20 seconds, is waited out for about a minute before the
// reply is given up on.
func TestPassingFailuresAreRetriedForAboutAMinute(t *testing.T) {
	t.Parallel()
	if waited := firstRetryDelay * (1<<modelRetries - 1); waited < time.Minute {
		t.Fatalf("retries give up after %s", waited)
	}
	f := &failFake{}
	tr := &turn{provider: f, onStart: func() {}, onText: func(string) {}}
	if _, err := tr.complete(context.Background()); err == nil || f.tries != modelRetries+1 {
		t.Fatalf("%d tries: %v", f.tries, err)
	}
}
