package usecase_test

import (
	"context"
	"sync"
	"testing"

	"github.com/yanun0323/Team-Work/internal/model"
	"github.com/yanun0323/Team-Work/internal/usecase"
)

func TestReplaceReplicaModelAcrossIsland(t *testing.T) {
	r := newRig(t, nil)
	var provider string
	for id := range r.world().Providers {
		provider = id
	}
	agency, err := r.e.Hire(usecase.NewReplica{TeamID: model.StaffingID, BlueprintID: r.owner.BlueprintID, Name: "Bo", Model: "fake", Effort: "high"})
	if err != nil {
		t.Fatal(err)
	}
	if err := r.e.UpdateReplica(r.owner.ID, usecase.ReplicaPatch{Effort: ptrTo("low")}); err != nil {
		t.Fatal(err)
	}
	// The provider no longer lists the old model.
	r.fake.mu.Lock()
	r.fake.models = []model.ModelSpec{{ID: "new", Thinking: []string{"low"}}, {ID: "other"}}
	r.fake.mu.Unlock()
	if err := r.e.RefreshModels(context.Background(), provider); err != nil {
		t.Fatal(err)
	}
	bystander, err := r.e.Hire(usecase.NewReplica{TeamID: r.team.ID, BlueprintID: r.owner.BlueprintID, Name: "C", Model: "other", Effort: "high"})
	if err != nil {
		t.Fatal(err)
	}
	check := func(id, mod, eff string) {
		t.Helper()
		if got := r.world().Replicas[id]; got.Model != mod || got.Effort != eff {
			t.Fatalf("%s: got %s/%s, want %s/%s", id, got.Model, got.Effort, mod, eff)
		}
	}
	if err := r.e.SetModelsHidden(provider, []string{"new"}, true); err != nil {
		t.Fatal(err)
	}
	if _, err := r.e.ReplaceReplicaModel("fake", "new", nil); err == nil {
		t.Fatal("accepted a hidden destination")
	}
	if err := r.e.SetModelsHidden(provider, []string{"new"}, false); err != nil {
		t.Fatal(err)
	}
	if _, err := r.e.ReplaceReplicaModel("fake", "new", ptrTo("high")); err == nil {
		t.Fatal("accepted unsupported level")
	}
	check(r.owner.ID, "fake", "low")
	check(agency.ID, "fake", "high")
	if n, err := r.e.ReplaceReplicaModel("fake", "new", nil); n != 2 || err != nil {
		t.Fatal(n, err)
	}
	check(r.owner.ID, "new", "low")
	check(agency.ID, "new", "default")
	check(bystander.ID, "other", "high")
	if n, err := r.e.ReplaceReplicaModel("new", "other", ptrTo("medium")); n != 2 || err != nil {
		t.Fatal(n, err)
	}
	check(r.owner.ID, "other", "medium")
	check(agency.ID, "other", "medium")
	check(bystander.ID, "other", "high")
}

func TestReplaceReplicaModelDuringReply(t *testing.T) {
	release := make(chan struct{})
	unblock := sync.OnceFunc(func() { close(release) })
	r := newRig(t, func(req model.ModelRequest) (model.ModelReply, error) { <-release; return say(req.Model), nil })
	defer unblock()
	r.fake.mu.Lock()
	r.fake.models = []model.ModelSpec{{ID: "fake"}, {ID: "new"}}
	r.fake.mu.Unlock()
	for id := range r.world().Providers {
		if err := r.e.RefreshModels(context.Background(), id); err != nil {
			t.Fatal(err)
		}
	}
	c, err := r.e.CreateChat(usecase.NewChat{TeamID: r.team.ID, ReplicaID: r.owner.ID, Text: "第一輪"})
	if err != nil {
		t.Fatal(err)
	}
	if n, err := r.e.ReplaceReplicaModel("fake", "new", nil); n != 1 || err != nil {
		t.Fatal(n, err)
	}
	unblock()
	check := func(want string) {
		t.Helper()
		msgs := r.wait("reply", chatDone(c.ID)).Chats[c.ID].Messages
		if got := msgs[len(msgs)-1].Text; got != want {
			t.Fatalf("reply %q, want %q", got, want)
		}
	}
	check("fake")
	if err := r.e.SayInChat(c.ID, "第二輪", nil); err != nil {
		t.Fatal(err)
	}
	check("new")
}
