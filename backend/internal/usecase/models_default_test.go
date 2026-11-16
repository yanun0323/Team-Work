package usecase_test

import (
	"context"
	"slices"
	"testing"

	"github.com/yanun0323/Team-Work/internal/model"
)

// A server that reports default among its levels says nothing new: the app offers that level itself, so it is kept
// out of what a provider records, and out of settings files it is saved in.
func TestReportedDefaultLevelIsDropped(t *testing.T) {
	t.Parallel()
	r := newRig(t, func(model.ModelRequest) (model.ModelReply, error) { return say("ok"), nil })
	var id string
	for pid := range r.world().Providers {
		id = pid
	}
	r.fake.mu.Lock()
	r.fake.models = []model.ModelSpec{{ID: "fake", Thinking: []string{"default", "low", "high"}}}
	r.fake.mu.Unlock()
	if err := r.e.RefreshModels(context.Background(), id); err != nil {
		t.Fatal(err)
	}
	if got := r.world().Providers[id].Thinking["fake"]; !slices.Equal(got, []string{"low", "high"}) {
		t.Fatalf("recorded %v", got)
	}
	// the file keeps it out too, and a restart with an older file that has it still starts
	s := readSettings(t, r)
	p := s.Providers[id]
	if slices.Contains(p.Thinking["fake"], model.ThinkingDefault) {
		t.Fatalf("settings file holds default: %v", p.Thinking["fake"])
	}
	p.Thinking["fake"] = []string{"default", "low", "high"}
	s.Providers[id] = p
	writeSettings(t, r, s)
	r.e.Close()
	newEngine(t, r)
	if got := r.world().Providers[id].Thinking["fake"]; slices.Contains(got, model.ThinkingDefault) {
		t.Fatalf("restart kept default: %v", got)
	}
}
