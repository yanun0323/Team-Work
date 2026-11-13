package usecase_test

import (
	"context"
	"slices"
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
