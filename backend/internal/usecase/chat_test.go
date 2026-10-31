package usecase_test

import (
	"context"
	"encoding/base64"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/yanun0323/mho-company/internal/model"
	"github.com/yanun0323/mho-company/internal/model/enum"
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
	if err := r.e.SayInChat(c.ID, "  ", nil); err == nil {
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
	if err := r.e.SayInChat(c.ID, "插話", nil); err == nil {
		t.Fatal("spoke while the employee was writing")
	}
	if err := r.e.StopChat(c.ID); err != nil {
		t.Fatal(err)
	}
	close(release)
	if w := r.world(); w.Chats[c.ID].ReplyAt != nil {
		t.Fatal("still writing after the stop")
	}
	if err := r.e.SayInChat(c.ID, "繼續", nil); err != nil {
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
	if err := r.e.SayInChat(c.ID, "還在嗎", nil); err == nil {
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
	if err := r.e.SayInChat(c.ID, "還記得嗎", nil); err != nil {
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

// drain takes the delta events waiting on a subscription, as what the screen would be showing.
func drain(events <-chan usecase.Event, id string) string {
	shown := ""
	for {
		select {
		case ev := <-events:
			if ev.SubID != id {
				continue
			}
			switch ev.Type {
			case "delta":
				shown += ev.Text
			case "deltaReset":
				shown = ""
			}
		default:
			return shown
		}
	}
}

func TestChatPassesOnItsReplyAsItIsWritten(t *testing.T) {
	r := newRig(t, func(model.ModelRequest) (model.ModelReply, error) { return say("逐字回覆"), nil })
	_, events, cancel, err := r.e.Subscribe()
	if err != nil {
		t.Fatal(err)
	}
	defer cancel()
	c, err := r.e.CreateChat(usecase.NewChat{TeamID: r.team.ID, ReplicaID: r.owner.ID, Text: "嗨"})
	if err != nil {
		t.Fatal(err)
	}
	r.wait("reply", chatDone(c.ID))
	if got := drain(events, c.ID); got != "逐字回覆" {
		t.Fatalf("shown %q", got)
	}
}

func TestChatTextFromAFailedTryIsTakenBack(t *testing.T) {
	calls := 0
	r := newRig(t, func(model.ModelRequest) (model.ModelReply, error) {
		calls++
		if calls == 1 {
			return say("寫到一半"), model.Errorf(model.CodeUnavailable, "斷線")
		}
		return say("完整回覆"), nil
	})
	_, events, cancel, err := r.e.Subscribe()
	if err != nil {
		t.Fatal(err)
	}
	defer cancel()
	c, err := r.e.CreateChat(usecase.NewChat{TeamID: r.team.ID, ReplicaID: r.owner.ID, Text: "嗨"})
	if err != nil {
		t.Fatal(err)
	}
	r.wait("reply", chatDone(c.ID))
	if got := drain(events, c.ID); got != "完整回覆" {
		t.Fatalf("shown %q", got)
	}
}

func TestChatConnectingMidReplySeesWhatIsWrittenSoFar(t *testing.T) {
	r := newRig(t, func(model.ModelRequest) (model.ModelReply, error) { return say("前半段"), nil })
	got := make(chan string, 1)
	var id string
	r.fake.midway = func() {
		_, events, cancel, err := r.e.Subscribe()
		if err != nil {
			t.Error(err)
		}
		defer cancel()
		got <- drain(events, id)
	}
	r.fake.mu.Lock() // holds the reply until id is known
	c, err := r.e.CreateChat(usecase.NewChat{TeamID: r.team.ID, ReplicaID: r.owner.ID, Text: "嗨"})
	if err != nil {
		t.Fatal(err)
	}
	id = c.ID
	r.fake.mu.Unlock()
	if s := <-got; s != "前半段" {
		t.Fatalf("shown %q", s)
	}
	r.wait("reply", chatDone(c.ID))
	// once it is a message, nobody connecting gets it a second time
	r.fake.midway = nil
	_, events, cancel, err := r.e.Subscribe()
	if err != nil {
		t.Fatal(err)
	}
	defer cancel()
	if s := drain(events, c.ID); s != "" {
		t.Fatalf("left over %q", s)
	}
}

func TestDiscussionPassesOnItsWordsButWorkStepsStayQuiet(t *testing.T) {
	r := newRig(t, func(req model.ModelRequest) (model.ModelReply, error) {
		if stepOf(req) == "討論" {
			return say("想問你一件事"), nil
		}
		return model.ModelReply{Content: append(say("工作中的旁白").Content, call("submit_handoff", handoff).Content...)}, nil
	})
	wf := *r.flow
	start, end := wf.Nodes[0].ID, wf.Nodes[1].ID
	wf.Nodes = append(wf.Nodes[:1], model.WorkflowNode{ID: "talk", Kind: enum.NodeTalk, Name: "討論", Prompt: usecase.TalkPrompt, ReplicaIDs: []string{r.owner.ID}, Assignment: enum.AssignFirstAvailable, Handoff: enum.HandoffAll, Join: enum.JoinAll}, wf.Nodes[1])
	wf.Edges = []model.WorkflowEdge{{ID: "1", From: start, To: "talk"}, {ID: "2", From: "talk", To: end}}
	if err := r.e.SaveWorkflow(wf.ID, wf); err != nil {
		t.Fatal(err)
	}
	_, events, cancel, err := r.e.Subscribe()
	if err != nil {
		t.Fatal(err)
	}
	defer cancel()
	task := r.task(wf.ID)
	w := r.wait("discussion", func(w *model.World) bool {
		s := subAt(w, task.ID, "討論")
		return s != nil && s.Review != nil
	})
	shown := map[string]string{}
	for len(events) > 0 {
		if ev := <-events; ev.Type == "delta" {
			shown[ev.SubID] += ev.Text
		}
	}
	if s := subAt(w, task.ID, "討論"); len(shown) != 1 || shown[s.ID] != "想問你一件事" {
		t.Fatalf("shown %v", shown)
	}
}

func TestToolImageReachesTheNextModelCall(t *testing.T) {
	png := append([]byte("\x89PNG\r\n\x1a\n"), make([]byte, 16)...)
	var image model.Block
	done := false
	r := newRig(t, func(req model.ModelRequest) (model.ModelReply, error) {
		last := req.Messages[len(req.Messages)-1]
		if last.Content[0].Type == enum.BlockToolResult {
			image, done = last.Content[0], true
			return say("看到了"), nil
		}
		return call("read_file", map[string]any{"path": "shot.png"}), nil
	})
	if err := os.WriteFile(filepath.Join(r.folder, "shot.png"), png, 0o644); err != nil {
		t.Fatal(err)
	}
	bp := *r.world().Blueprints[r.owner.BlueprintID]
	if !slices.Contains(bp.Tools, enum.ToolReadFile) {
		bp.Tools = append(bp.Tools, enum.ToolReadFile)
		if err := r.e.SaveBlueprint(bp.ID, bp); err != nil {
			t.Fatal(err)
		}
	}
	c, err := r.e.CreateChat(usecase.NewChat{TeamID: r.team.ID, ReplicaID: r.owner.ID, Text: "看圖"})
	if err != nil {
		t.Fatal(err)
	}
	r.wait("reply", chatDone(c.ID))
	if !done || image.MimeType != "image/png" || image.Data != base64.StdEncoding.EncodeToString(png) || image.IsError {
		t.Fatalf("%+v", image)
	}
}

const pngURL = "data:image/png;base64,iVBORw0KGgo="

func TestChatMessageCarriesPicturesToTheModel(t *testing.T) {
	var seen model.Message
	r := newRig(t, func(req model.ModelRequest) (model.ModelReply, error) {
		seen = req.Messages[len(req.Messages)-1]
		return say("看到了"), nil
	})
	c, err := r.e.CreateChat(usecase.NewChat{TeamID: r.team.ID, ReplicaID: r.owner.ID, Images: []model.Attachment{{Name: "a.png", URL: pngURL}}})
	if err != nil {
		t.Fatal(err)
	}
	r.wait("reply", chatDone(c.ID))
	if len(seen.Content) != 1 || seen.Content[0].Type != enum.BlockImage || seen.Content[0].MimeType != "image/png" {
		t.Fatalf("%+v", seen)
	}
	if m := r.world().Chats[c.ID].Messages[0]; len(m.Images) != 1 || m.Images[0].URL != pngURL {
		t.Fatalf("%+v", m)
	}
	for _, bad := range [][]model.Attachment{
		{{URL: "data:image/bmp;base64,AAAA"}},
		{{URL: "data:image/png;base64,***"}},
		{{URL: "https://example.com/a.png"}},
		slices.Repeat([]model.Attachment{{URL: pngURL}}, 7),
	} {
		if err := r.e.SayInChat(c.ID, "x", bad); err == nil {
			t.Fatalf("took %.40v", bad)
		}
	}
	if err := r.e.SayInChat(c.ID, " ", nil); err == nil {
		t.Fatal("took an empty message")
	}
}

func TestRewindTakesBackTheMessageAndAllAfterIt(t *testing.T) {
	var seen []model.Message
	count := 0
	r := newRig(t, func(req model.ModelRequest) (model.ModelReply, error) {
		seen, count = req.Messages, count+1
		if count == 1 { // tool results also come as the user's; they must not be taken for messages
			return call("no_such_tool", map[string]any{}), nil
		}
		return say("回覆"), nil
	})
	c, err := r.e.CreateChat(usecase.NewChat{TeamID: r.team.ID, ReplicaID: r.owner.ID, Text: "第一句"})
	if err != nil {
		t.Fatal(err)
	}
	r.wait("first", chatDone(c.ID))
	if err := r.e.SayInChat(c.ID, "第二句", nil); err != nil {
		t.Fatal(err)
	}
	r.wait("second", chatDone(c.ID))
	msgs := r.world().Chats[c.ID].Messages
	second := slices.IndexFunc(msgs, func(m model.ChatMessage) bool { return m.Text == "第二句" })

	for _, bad := range []int{-1, 1, len(msgs)} { // 1 is the tool's line
		if err := r.e.RewindChat(c.ID, bad); err == nil {
			t.Fatalf("rewound to %d", bad)
		}
	}
	if err := r.e.RewindChat(c.ID, second); err != nil {
		t.Fatal(err)
	}
	if got := r.world().Chats[c.ID].Messages; len(got) != second {
		t.Fatalf("%+v", got)
	}
	if err := r.e.SayInChat(c.ID, "改過的第二句", nil); err != nil {
		t.Fatal(err)
	}
	r.wait("edited", chatDone(c.ID))
	var said []string
	for _, m := range seen {
		for _, b := range m.Content {
			if m.Role == enum.RoleUser && b.Type == enum.BlockText {
				said = append(said, b.Text)
			}
		}
	}
	if !slices.Equal(said, []string{"第一句", "改過的第二句"}) {
		t.Fatalf("the model heard %q", said)
	}

	// back to the very start: the chat stays, and goes on
	if err := r.e.RewindChat(c.ID, 0); err != nil {
		t.Fatal(err)
	}
	if err := r.e.SayInChat(c.ID, "重新開始", nil); err != nil {
		t.Fatal(err)
	}
	r.wait("again", chatDone(c.ID))
	if len(seen) != 1 {
		t.Fatalf("%+v", seen)
	}
}

func TestRewindStopsAReplyBeingWritten(t *testing.T) {
	release := make(chan struct{})
	r := newRig(t, func(model.ModelRequest) (model.ModelReply, error) {
		<-release
		return say("太晚了"), nil
	})
	defer close(release)
	c, err := r.e.CreateChat(usecase.NewChat{TeamID: r.team.ID, ReplicaID: r.owner.ID, Text: "嗨"})
	if err != nil {
		t.Fatal(err)
	}
	if err := r.e.RewindChat(c.ID, 0); err != nil {
		t.Fatal(err)
	}
	if got := r.world().Chats[c.ID]; got.ReplyAt != nil || len(got.Messages) != 0 {
		t.Fatalf("%+v", got)
	}
}
