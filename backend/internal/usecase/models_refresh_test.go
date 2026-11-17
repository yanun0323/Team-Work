package usecase_test

import (
	"context"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/yanun0323/Team-Work/internal/adapter"
	"github.com/yanun0323/Team-Work/internal/model"
	"github.com/yanun0323/Team-Work/internal/model/enum"
	"github.com/yanun0323/Team-Work/internal/usecase"
)

func (r *rig) listed() int {
	r.fake.mu.Lock()
	defer r.fake.mu.Unlock()
	return r.fake.listed
}

// A provider asked a moment ago is left be; one never asked since the start, or asked with a max age of 0, is asked
// again in the background, and what it answers reaches the world.
func TestRefreshStaleModels(t *testing.T) {
	t.Parallel()
	r := newRig(t, func(model.ModelRequest) (model.ModelReply, error) { return say("ok"), nil })
	var provider string
	for id := range r.world().Providers {
		provider = id
	}
	r.fake.mu.Lock()
	r.fake.models = []model.ModelSpec{{ID: "fake"}, {ID: "fake-2"}}
	r.fake.mu.Unlock()
	offers := func(id string) func(*model.World) bool {
		return func(w *model.World) bool { return slices.Contains(w.Providers[provider].Models, id) }
	}

	before := r.listed()
	r.e.RefreshStaleModels(usecase.ModelsFresh) // added just now, so its list is fresh
	time.Sleep(50 * time.Millisecond)
	if r.listed() != before || offers("fake-2")(r.world()) {
		t.Fatal("asked a provider whose models are fresh")
	}

	r.e.RefreshStaleModels(0)
	r.wait("the new model", offers("fake-2"))

	r.e.Close()
	newEngine(t, r)
	r.fake.mu.Lock()
	r.fake.models = []model.ModelSpec{{ID: "fake"}, {ID: "fake-3"}}
	r.fake.mu.Unlock()
	r.e.RefreshStaleModels(usecase.ModelsFresh) // nothing asked since the start
	r.wait("the model put out meanwhile", offers("fake-3"))

	before = r.listed()
	r.e.RefreshStaleModels(usecase.ModelsFresh)
	time.Sleep(50 * time.Millisecond)
	if r.listed() != before {
		t.Fatal("asked again right after")
	}
}

// The length a provider reports for each model is kept with its list and outlives a restart; one it stops reporting
// is dropped.
func TestReportedWindowsAreKept(t *testing.T) {
	t.Parallel()
	r := newRig(t, func(model.ModelRequest) (model.ModelReply, error) { return say("ok"), nil })
	ctx := context.Background()
	var provider string
	for id := range r.world().Providers {
		provider = id
	}
	r.fake.mu.Lock()
	r.fake.models = []model.ModelSpec{{ID: "fake", ContextWindow: 32_768}, {ID: "fake-2"}}
	r.fake.mu.Unlock()
	if err := r.e.RefreshModels(ctx, provider); err != nil {
		t.Fatal(err)
	}
	r.e.Close()
	newEngine(t, r)
	if got := r.world().Providers[provider].Windows; len(got) != 1 || got["fake"] != 32_768 {
		t.Fatalf("after a restart: %v", got)
	}
	r.fake.mu.Lock()
	r.fake.models = []model.ModelSpec{{ID: "fake"}}
	r.fake.mu.Unlock()
	if err := r.e.RefreshModels(ctx, provider); err != nil {
		t.Fatal(err)
	}
	if got := r.world().Providers[provider].Windows; got != nil {
		t.Fatalf("kept one no longer reported: %v", got)
	}
}

// Reading the models again, as on start, marks a subscription whose sign-in is gone, so the Airport offers to sign
// in again before an employee's reply fails on it; a passing failure leaves the sign-in be.
func TestRefreshMarksASignedOutSubscription(t *testing.T) {
	t.Parallel()
	r := newRig(t, func(model.ModelRequest) (model.ModelReply, error) { return say("ok"), nil })
	ctx := context.Background()
	r.fake.mu.Lock()
	r.fake.login = &adapter.LoginFlow{Wait: func(context.Context) error { return nil }, Paste: func(string) error { return nil }}
	r.fake.mu.Unlock()
	p, err := r.e.AddProvider(ctx, usecase.NewProvider{Name: "訂閱", Kind: enum.ProviderAnthropic, Login: usecase.ProviderLogin{Kind: "subscription"}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := r.e.StartLogin(ctx, p.ID, ""); err != nil {
		t.Fatal(err)
	}
	r.wait("signed in", func(w *model.World) bool { return w.Providers[p.ID].Auth.SignedIn })

	r.fake.mu.Lock()
	r.fake.modelsErr = model.Errorf(model.CodeUnavailable, "offline")
	r.fake.mu.Unlock()
	before := r.listed()
	r.e.RefreshStaleModels(0)
	deadline := time.Now().Add(5 * time.Second)
	for r.listed() == before && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	time.Sleep(50 * time.Millisecond)
	if !r.world().Providers[p.ID].Auth.SignedIn {
		t.Fatal("a passing failure signed the subscription out")
	}

	r.fake.mu.Lock()
	r.fake.modelsErr = model.Errorf(model.CodeSignedOut, "Claude Code 還沒登入訂閱")
	r.fake.mu.Unlock()
	r.e.RefreshStaleModels(0)
	r.wait("signed out", func(w *model.World) bool { return !w.Providers[p.ID].Auth.SignedIn })
}

// reportWindow has the one provider of a rig report the length it runs fake at, and returns its id.
func (r *rig) reportWindow(window int) string {
	r.t.Helper()
	var provider string
	for id := range r.world().Providers {
		provider = id
	}
	r.fake.mu.Lock()
	r.fake.models = []model.ModelSpec{{ID: "fake", ContextWindow: window}}
	r.fake.mu.Unlock()
	return provider
}

// A self-hosted server not asked for a while is asked again as a reply starts, as it may run another model under the
// same name now: the chat is then summed up by the length it runs at now.
func TestAReplyGoesByTheLengthTheServerRunsNow(t *testing.T) {
	t.Parallel()
	r := newRig(t, func(req model.ModelRequest) (model.ModelReply, error) {
		if summarizing(req) {
			return say("摘要內容"), nil
		}
		reply := say("好")
		reply.Usage.Input = 30_000
		return reply, nil
	})
	provider := r.reportWindow(200_000)
	if err := r.e.RefreshModels(context.Background(), provider); err != nil {
		t.Fatal(err)
	}
	c, err := r.e.CreateChat(usecase.NewChat{TeamID: r.team.ID, ReplicaID: r.owner.ID, Text: strings.Repeat("長", 40_000)})
	if err != nil {
		t.Fatal(err)
	}
	r.wait("first reply", chatDone(c.ID))
	if r.world().Chats[c.ID].Compact != nil {
		t.Fatal("summed up with room to spare")
	}

	r.reportWindow(32_000)
	r.e.ForgetModelsAsked()
	if err := r.e.SayInChat(c.ID, "下一句", nil); err != nil {
		t.Fatal(err)
	}
	r.wait("second reply", chatDone(c.ID))
	got := r.world()
	if n := got.Providers[provider].Windows["fake"]; n != 32_000 {
		t.Fatalf("length not read again: %d", n)
	}
	if got.Chats[c.ID].Compact == nil {
		t.Fatal("not summed up by the length the server runs at now")
	}
}

// A refusal for a conversation too long has the server asked again at once, however recently it was asked.
func TestATooLongRefusalReadsTheLengthAgain(t *testing.T) {
	t.Parallel()
	r := newRig(t, func(req model.ModelRequest) (model.ModelReply, error) {
		if summarizing(req) {
			return say("摘要內容"), nil
		}
		if len(req.Messages) == 3 && !strings.Contains(req.Messages[0].Content[0].Text, "摘要內容") {
			return model.ModelReply{}, model.Errorf(model.CodeContextOverflow, "太長")
		}
		return say("好"), nil
	})
	provider := r.reportWindow(200_000)
	if err := r.e.RefreshModels(context.Background(), provider); err != nil {
		t.Fatal(err)
	}
	c, err := r.e.CreateChat(usecase.NewChat{TeamID: r.team.ID, ReplicaID: r.owner.ID, Text: strings.Repeat("長", 40_000)})
	if err != nil {
		t.Fatal(err)
	}
	r.wait("first reply", chatDone(c.ID))

	r.reportWindow(32_000) // asked a moment ago, so only the refusal asks again
	if err := r.e.SayInChat(c.ID, "下一句", nil); err != nil {
		t.Fatal(err)
	}
	r.wait("second reply", chatDone(c.ID))
	got := r.world()
	if n := got.Providers[provider].Windows["fake"]; n != 32_000 {
		t.Fatalf("length not read again: %d", n)
	}
	if said := got.Chats[c.ID].Messages; said[len(said)-1].Text != "好" {
		t.Fatalf("it failed anyway: %+v", said[len(said)-1])
	}
}
