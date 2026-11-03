package usecase_test

import (
	"encoding/json"
	"strings"
	"sync"
	"testing"

	"github.com/yanun0323/Team-Work/internal/model"
	"github.com/yanun0323/Team-Work/internal/usecase"
)

func isTitleRequest(req model.ModelRequest) bool {
	return strings.Contains(req.System, "Name this conversation")
}

func nameChatsWith(t *testing.T, r *rig, modelID string) {
	t.Helper()
	raw, _ := json.Marshal(modelID)
	if err := r.e.UpdatePreferences(map[string]json.RawMessage{"chatTitleModel": raw}); err != nil {
		t.Fatal(err)
	}
}

func TestNewChatIsNamedFromItsFirstMessage(t *testing.T) {
	var mu sync.Mutex
	var titled []model.ModelRequest
	r := newRig(t, func(req model.ModelRequest) (model.ModelReply, error) {
		if isTitleRequest(req) {
			mu.Lock()
			titled = append(titled, req)
			mu.Unlock()
			reply := say("「登入流程」\n")
			reply.Usage = model.ModelUsage{Input: 100, Output: 10}
			return reply, nil
		}
		return say("好"), nil
	})
	nameChatsWith(t, r, r.owner.Model)
	c, err := r.e.CreateChat(usecase.NewChat{TeamID: r.team.ID, ReplicaID: r.owner.ID, Text: "幫我做登入流程"})
	if err != nil {
		t.Fatal(err)
	}
	w := r.wait("title", func(w *model.World) bool { return w.Chats[c.ID].Title != "" && w.Chats[c.ID].ReplyAt == nil })
	if got := w.Chats[c.ID].Title; got != "「登入流程」" {
		t.Fatalf("title %q", got)
	}
	if w.Chats[c.ID].Tokens < 110 {
		t.Fatalf("naming tokens not counted: %d", w.Chats[c.ID].Tokens)
	}
	if err := r.e.SayInChat(c.ID, "再加忘記密碼", nil); err != nil {
		t.Fatal(err)
	}
	r.wait("second reply", chatDone(c.ID))
	mu.Lock()
	defer mu.Unlock()
	if len(titled) != 1 {
		t.Fatalf("named %d times", len(titled))
	}
	if len(titled[0].Tools) != 0 || !strings.Contains(titled[0].Messages[0].Content[0].Text, "幫我做登入流程") || titled[0].Cwd != r.folder {
		t.Fatalf("%+v", titled[0])
	}
}

func TestAirportChatIsNamedToo(t *testing.T) {
	r := newRig(t, func(req model.ModelRequest) (model.ModelReply, error) {
		if isTitleRequest(req) {
			return say("問候"), nil
		}
		return say("您好"), nil
	})
	nameChatsWith(t, r, r.owner.Model)
	c, err := r.e.CreateAirportChat(usecase.NewAirportChat{Model: r.owner.Model, Text: "你好"})
	if err != nil {
		t.Fatal(err)
	}
	r.wait("title", func(w *model.World) bool { return w.Chats[c.ID].Title == "問候" })
}

func TestChatNamingOffSendsNothing(t *testing.T) {
	var mu sync.Mutex
	named := false
	r := newRig(t, func(req model.ModelRequest) (model.ModelReply, error) {
		if isTitleRequest(req) {
			mu.Lock()
			named = true
			mu.Unlock()
		}
		return say("好"), nil
	})
	c, err := r.e.CreateChat(usecase.NewChat{TeamID: r.team.ID, ReplicaID: r.owner.ID, Text: "嗨"})
	if err != nil {
		t.Fatal(err)
	}
	w := r.wait("reply", chatDone(c.ID))
	mu.Lock()
	defer mu.Unlock()
	if named || w.Chats[c.ID].Title != "" {
		t.Fatalf("named while off: %q", w.Chats[c.ID].Title)
	}
}

func TestChatNameMustBeOneLine(t *testing.T) {
	r := newRig(t, func(req model.ModelRequest) (model.ModelReply, error) {
		if isTitleRequest(req) {
			return say("標題\n說明"), nil
		}
		return say("好"), nil
	})
	nameChatsWith(t, r, r.owner.Model)
	c, err := r.e.CreateChat(usecase.NewChat{TeamID: r.team.ID, ReplicaID: r.owner.ID, Text: "嗨"})
	if err != nil {
		t.Fatal(err)
	}
	// the naming answer counts its tokens even when refused, so wait on the reply and a settled world
	w := r.wait("reply", chatDone(c.ID))
	r.e.Close()
	if got := r.world().Chats[c.ID].Title; got != "" {
		t.Fatalf("title %q from %+v", got, w.Chats[c.ID])
	}
}

func TestRenamedChatKeepsItsName(t *testing.T) {
	release := make(chan struct{})
	r := newRig(t, func(req model.ModelRequest) (model.ModelReply, error) {
		if isTitleRequest(req) {
			<-release
			return say("模型取的名字"), nil
		}
		return say("好"), nil
	})
	nameChatsWith(t, r, r.owner.Model)
	c, err := r.e.CreateChat(usecase.NewChat{TeamID: r.team.ID, ReplicaID: r.owner.ID, Text: "嗨"})
	if err != nil {
		t.Fatal(err)
	}
	if err := r.e.RenameChat(c.ID, "  我的\n名字  "); err != nil {
		t.Fatal(err)
	}
	close(release)
	r.e.Close()
	if got := r.world().Chats[c.ID].Title; got != "我的 名字" {
		t.Fatalf("title %q", got)
	}
	if err := r.e.RenameChat("nobody", "x"); err == nil {
		t.Fatal("renamed a chat that is not there")
	}
}

func TestRenameChatRefusesALongName(t *testing.T) {
	r := newRig(t, func(model.ModelRequest) (model.ModelReply, error) { return say("好"), nil })
	c, err := r.e.CreateChat(usecase.NewChat{TeamID: r.team.ID, ReplicaID: r.owner.ID, Text: "嗨"})
	if err != nil {
		t.Fatal(err)
	}
	if err := r.e.RenameChat(c.ID, strings.Repeat("字", 81)); err == nil {
		t.Fatal("took 81 characters")
	}
	if err := r.e.RenameChat(c.ID, ""); err != nil || r.world().Chats[c.ID].Title != "" {
		t.Fatalf("clearing the name: %v", err)
	}
}

func TestPinChat(t *testing.T) {
	r := newRig(t, func(model.ModelRequest) (model.ModelReply, error) { return say("好"), nil })
	c, err := r.e.CreateChat(usecase.NewChat{TeamID: r.team.ID, ReplicaID: r.owner.ID, Text: "嗨"})
	if err != nil {
		t.Fatal(err)
	}
	if err := r.e.PinChat(c.ID, true); err != nil {
		t.Fatal(err)
	}
	at := r.world().Chats[c.ID].PinnedAt
	if at == nil {
		t.Fatal("not pinned")
	}
	if err := r.e.PinChat(c.ID, true); err != nil {
		t.Fatal(err)
	}
	if again := r.world().Chats[c.ID].PinnedAt; again == nil || *again != *at {
		t.Fatalf("pinning again moved it: %v, then %v", *at, again)
	}
	if err := r.e.PinChat(c.ID, false); err != nil || r.world().Chats[c.ID].PinnedAt != nil {
		t.Fatalf("unpinning: %v", err)
	}
	if err := r.e.PinChat("nobody", true); err == nil {
		t.Fatal("pinned a chat that is not there")
	}
}
