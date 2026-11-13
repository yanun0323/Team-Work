package usecase_test

import (
	"encoding/json"
	"testing"

	"github.com/yanun0323/Team-Work/internal/usecase"
)

func TestChatRenameCacheSurvivesDiskFailureAndRestart(t *testing.T) {
	t.Parallel()
	r, disk, reopen := diskRig(t)
	c, err := r.e.CreateChat(usecase.NewChat{TeamID: r.team.ID, ReplicaID: r.owner.ID, Text: "history remains"})
	if err != nil {
		t.Fatal(err)
	}
	r.wait("reply", chatDone(c.ID))
	messages, _ := json.Marshal(r.world().Chats[c.ID].Messages)
	if err := r.e.RenameChat(c.ID, "saved"); err != nil {
		t.Fatal(err)
	}
	disk.broken.Store(true)
	if err := r.e.RenameChat(c.ID, "unsaved"); err == nil {
		t.Fatal("rename succeeded on a full disk")
	}
	if r.world().Chats[c.ID].Title != "saved" {
		t.Fatal("failed rename changed world")
	}
	disk.broken.Store(false)
	if err := r.e.RenameChat(c.ID, "retry"); err != nil {
		t.Fatal(err)
	}
	reopen() // exercise the cache installed from disk, not just from a new chat
	if err := r.e.PinChat(c.ID, true); err != nil {
		t.Fatal(err)
	}
	reopen()
	got := r.world().Chats[c.ID]
	if got.Title != "retry" || got.PinnedAt == nil {
		t.Fatal("changes were not persisted")
	}
	after, _ := json.Marshal(got.Messages)
	if string(messages) != string(after) {
		t.Fatal("history changed during metadata updates")
	}
}
