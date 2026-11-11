package usecase_test

import (
	"slices"
	"testing"
	"time"

	"github.com/yanun0323/Team-Work/internal/model"
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
