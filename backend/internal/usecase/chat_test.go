package usecase_test

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/yanun0323/mho-company/internal/model"
	"github.com/yanun0323/mho-company/internal/usecase"
)

func chatDone(id string) func(*model.World) bool {
	return func(w *model.World) bool { c := w.Chats[id]; return c != nil && c.ReplyAt == nil }
}

func TestChatWorksInTheFolderWithoutTheEmployeesTaskSlot(t *testing.T) {
	calls := 0
	r := newRig(t, func(req model.ModelRequest) (model.ModelReply, error) {
		calls++
		if calls == 1 {
			return call("write_file", map[string]any{"path": "note.txt", "content": "hi"}), nil
		}
		return say("寫好了"), nil
	})
	c, err := r.e.CreateChat(usecase.NewChat{TeamID: r.team.ID, ReplicaID: r.owner.ID, Text: "寫個檔案"})
	if err != nil {
		t.Fatal(err)
	}
	r.wait("reply", chatDone(c.ID))
	if got, err := os.ReadFile(filepath.Join(r.folder, "note.txt")); err != nil || string(got) != "hi" {
		t.Fatalf("%q %v", got, err)
	}
	msgs := r.world().Chats[c.ID].Messages
	if len(msgs) != 3 || msgs[0].From != "user" || msgs[1].From != "tool" || msgs[2].Text != "寫好了" {
		t.Fatalf("%+v", msgs)
	}
	if !strings.Contains(r.fake.seen[0].System, "專案資料夾本身") || r.fake.seen[0].Cwd != r.folder {
		t.Fatalf("%q %q", r.fake.seen[0].System, r.fake.seen[0].Cwd)
	}
	if err := r.e.SayInChat(c.ID, "  "); err == nil {
		t.Fatal("an empty message went through")
	}
}

func TestChatKeepsItsModelAndGoesOnAfterAStop(t *testing.T) {
	release := make(chan struct{})
	first := true
	r := newRig(t, func(req model.ModelRequest) (model.ModelReply, error) {
		if first {
			first = false
			<-release
		}
		return say("好"), nil
	})
	defer func() {
		select {
		case <-release:
		default:
			close(release)
		}
	}()
	c, err := r.e.CreateChat(usecase.NewChat{TeamID: r.team.ID, ReplicaID: r.owner.ID, Text: "嗨"})
	if err != nil {
		t.Fatal(err)
	}
	if err := r.e.SayInChat(c.ID, "插話"); err == nil {
		t.Fatal("spoke while the employee was writing")
	}
	if err := r.e.StopChat(c.ID); err != nil {
		t.Fatal(err)
	}
	close(release)
	if w := r.world(); w.Chats[c.ID].ReplyAt != nil {
		t.Fatal("still writing after the stop")
	}
	if err := r.e.SayInChat(c.ID, "繼續"); err != nil {
		t.Fatal(err)
	}
	r.wait("reply", func(w *model.World) bool {
		m := w.Chats[c.ID].Messages
		return w.Chats[c.ID].ReplyAt == nil && m[len(m)-1].Text == "好"
	})
	if got := r.world().Chats[c.ID]; got.Model != "fake" || got.ReplicaID != r.owner.ID {
		t.Fatalf("%+v", got)
	}
}

func TestChatEndsWithItsCompanyAndOutlivesItsEmployee(t *testing.T) {
	r := newRig(t, func(model.ModelRequest) (model.ModelReply, error) { return say("好"), nil })
	c, err := r.e.CreateChat(usecase.NewChat{TeamID: r.team.ID, ReplicaID: r.owner.ID, Text: "嗨"})
	if err != nil {
		t.Fatal(err)
	}
	r.wait("reply", chatDone(c.ID))
	heir, err := r.e.Hire(usecase.NewReplica{TeamID: r.team.ID, BlueprintID: r.owner.BlueprintID, Name: "Bo", Model: "fake"})
	if err != nil {
		t.Fatal(err)
	}
	if err := r.e.Fire(r.owner.ID, heir.ID); err != nil {
		t.Fatal(err)
	}
	if got := r.world().Chats[c.ID]; got == nil || got.Name != "Ada" {
		t.Fatalf("%+v", got)
	}
	if err := r.e.SayInChat(c.ID, "還在嗎"); err == nil {
		t.Fatal("spoke to someone who left")
	}
	if err := r.e.DeleteTeam(r.team.ID); err != nil {
		t.Fatal(err)
	}
	if len(r.world().Chats) != 0 {
		t.Fatal("the chat outlived its company")
	}
}

func TestChatSurvivesARestartWithoutRepeatingItsWork(t *testing.T) {
	r := newRig(t, func(model.ModelRequest) (model.ModelReply, error) { return say("好"), nil })
	c, err := r.e.CreateChat(usecase.NewChat{TeamID: r.team.ID, ReplicaID: r.owner.ID, Text: "嗨"})
	if err != nil {
		t.Fatal(err)
	}
	r.wait("reply", chatDone(c.ID))
	r.e.Close()
	newEngine(t, r)
	if err := r.e.SayInChat(c.ID, "還記得嗎"); err != nil {
		t.Fatal(err)
	}
	r.wait("second reply", func(w *model.World) bool { return w.Chats[c.ID].ReplyAt == nil && len(w.Chats[c.ID].Messages) == 4 })
	last := r.fake.seen[len(r.fake.seen)-1].Messages
	if len(last) != 3 {
		t.Fatalf("the conversation came back with %d messages", len(last))
	}
}

func TestTaskDraftFromAChat(t *testing.T) {
	r := newRig(t, func(req model.ModelRequest) (model.ModelReply, error) {
		if len(req.Tools) == 0 {
			return say("**做登入**\n\n要有忘記密碼"), nil
		}
		return say("要做登入嗎"), nil
	})
	c, err := r.e.CreateChat(usecase.NewChat{TeamID: r.team.ID, ReplicaID: r.owner.ID, Text: "討論登入"})
	if err != nil {
		t.Fatal(err)
	}
	r.wait("reply", chatDone(c.ID))
	before := len(r.world().Tasks)
	d, err := r.e.ChatTaskDraft(context.Background(), c.ID)
	if err != nil {
		t.Fatal(err)
	}
	if d.Title != "做登入" || d.Description != "要有忘記密碼" {
		t.Fatalf("%+v", d)
	}
	seen := r.fake.seen[len(r.fake.seen)-1].Messages[0].Content[0].Text
	if !strings.Contains(seen, "討論登入") || !strings.Contains(seen, "要做登入嗎") {
		t.Fatal(seen)
	}
	if len(r.world().Tasks) != before {
		t.Fatal("writing a draft made a task")
	}
}

func TestUncommittedChanges(t *testing.T) {
	r := newRig(t, func(model.ModelRequest) (model.ModelReply, error) { return say("好"), nil })
	ctx := context.Background()
	if dirty, err := r.e.Uncommitted(ctx, r.team.ID); err != nil || dirty {
		t.Fatalf("%v %v", dirty, err)
	}
	if err := os.WriteFile(filepath.Join(r.folder, "new.txt"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	if dirty, err := r.e.Uncommitted(ctx, r.team.ID); err != nil || !dirty {
		t.Fatalf("%v %v", dirty, err)
	}
}
