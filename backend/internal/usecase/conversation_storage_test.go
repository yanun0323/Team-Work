package usecase_test

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/yanun0323/Team-Work/internal/model"
	"github.com/yanun0323/Team-Work/internal/usecase"
)

func TestColdConversationsResumeForkRewindAndRestart(t *testing.T) {
	t.Parallel()
	r := newRig(t, func(req model.ModelRequest) (model.ModelReply, error) {
		raw, _ := json.Marshal(req.Messages)
		if !strings.Contains(string(raw), "original history") {
			t.Error("model lost original history")
		}
		return say("answer"), nil
	})
	c, err := r.e.CreateChat(usecase.NewChat{TeamID: r.team.ID, ReplicaID: r.owner.ID, Text: "original history"})
	if err != nil {
		t.Fatal(err)
	}
	r.wait("reply", chatDone(c.ID))
	r.e.Close()
	newEngine(t, r)
	if err = r.e.SayInChat(c.ID, "second turn", nil); err != nil {
		t.Fatal(err)
	}
	r.wait("second reply", chatDone(c.ID))
	fork, err := r.e.HandOffChat(c.ID, 1, r.owner.ID)
	if err != nil {
		t.Fatal(err)
	}
	if err = r.e.SayInChat(fork.ID, "forked turn", nil); err != nil {
		t.Fatal(err)
	}
	r.wait("fork reply", chatDone(fork.ID))
	if err = r.e.RewindChat(c.ID, 2); err != nil {
		t.Fatal(err)
	}
	r.e.Close()
	newEngine(t, r)
	if err = r.e.SayInChat(c.ID, "replacement turn", nil); err != nil {
		t.Fatal(err)
	}
	r.wait("replacement reply", chatDone(c.ID))
	raw, err := r.store.LoadConversation(context.Background(), c.ID)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(raw), "second turn") || strings.Contains(string(raw), "forked turn") || !strings.Contains(string(raw), "replacement turn") {
		t.Fatal("rewind or fork mixed histories")
	}
	if err = r.e.DeleteChat(fork.ID); err != nil {
		t.Fatal(err)
	}
	if _, err = r.store.LoadConversation(context.Background(), fork.ID); err == nil {
		t.Fatal("cold delete left private history")
	}
	if _, err = r.store.LoadConversation(context.Background(), c.ID); err != nil {
		t.Fatal("fork delete removed original")
	}
}

func TestColdRewindDiskFailureSurvivesUnrelatedSaveAndRestart(t *testing.T) {
	t.Parallel()
	r, disk, reopen := diskRig(t)
	c, err := r.e.CreateChat(usecase.NewChat{TeamID: r.team.ID, ReplicaID: r.owner.ID, Text: "history survives"})
	if err != nil {
		t.Fatal(err)
	}
	r.wait("reply", chatDone(c.ID))
	before, err := r.store.LoadConversation(context.Background(), c.ID)
	if err != nil {
		t.Fatal(err)
	}
	disk.broken.Store(true)
	if err = r.e.RewindChat(c.ID, 0); err == nil {
		t.Fatal("failed rewind accepted")
	}
	disk.broken.Store(false)
	if err = r.e.RenameChat(c.ID, "only metadata"); err != nil {
		t.Fatal(err)
	}
	reopen()
	after, err := r.store.LoadConversation(context.Background(), c.ID)
	if err != nil {
		t.Fatal(err)
	}
	if string(before) != string(after) || len(r.world().Chats[c.ID].Messages) != 2 {
		t.Fatal("failed rewind lost persisted history")
	}
}
