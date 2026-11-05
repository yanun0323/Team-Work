package usecase_test

import (
	"context"
	"encoding/base64"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"

	"github.com/yanun0323/Team-Work/internal/adapter"
	"github.com/yanun0323/Team-Work/internal/model"
	"github.com/yanun0323/Team-Work/internal/model/enum"
	"github.com/yanun0323/Team-Work/internal/usecase"
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
	if !strings.Contains(r.fake.seen[0].System, "project folder itself") || r.fake.seen[0].Cwd != r.folder {
		t.Fatalf("%q %q", r.fake.seen[0].System, r.fake.seen[0].Cwd)
	}
	if err := r.e.SayInChat(c.ID, "  ", nil); err == nil {
		t.Fatal("an empty message went through")
	}
}

func TestChatMessageBringsTheSkillItNames(t *testing.T) {
	root := t.TempDir()
	for name, body := range map[string]string{"tdd": "先寫測試", "other": "別的做法"} {
		dir := filepath.Join(root, "skills", name)
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
		content := "---\nname: " + name + "\ndescription: 說明 " + name + "\n---\n" + body
		if err := os.WriteFile(filepath.Join(dir, "SKILL.md"), []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	r := newRig(t, func(model.ModelRequest) (model.ModelReply, error) { return say("好"), nil })
	bp := *r.world().Blueprints[r.owner.BlueprintID]
	bp.Skills = []model.SkillPack{{Source: &model.BlueprintSource{Kind: "local", Path: root}, Exclude: []string{"other"}}}
	if err := r.e.SaveBlueprint(bp.ID, bp); err != nil {
		t.Fatal(err)
	}

	skills, err := r.e.ReplicaSkills(context.Background(), r.owner.ID)
	if err != nil || len(skills) != 1 || skills[0].Name != "tdd" || skills[0].Description != "說明 tdd" {
		t.Fatalf("%+v %v", skills, err)
	}

	c, err := r.e.CreateChat(usecase.NewChat{TeamID: r.team.ID, ReplicaID: r.owner.ID, Text: "用 $tdd，順便 $tdd $other $nope"})
	if err != nil {
		t.Fatal(err)
	}
	r.wait("reply", chatDone(c.ID))
	said := func(req model.ModelRequest, at int) string {
		var b strings.Builder
		for _, block := range req.Messages[at].Content {
			b.WriteString(block.Text + "\n")
		}
		return b.String()
	}
	first := said(r.fake.seen[0], 0)
	if strings.Count(first, "先寫測試") != 1 || strings.Contains(first, "別的做法") {
		t.Fatalf("%s", first)
	}
	if got := r.world().Chats[c.ID].Messages[0].Text; strings.Contains(got, "先寫測試") {
		t.Fatalf("the instructions show in the chat: %s", got)
	}

	// it stays with its message, and does not come along with later ones
	if err := r.e.SayInChat(c.ID, "繼續", nil); err != nil {
		t.Fatal(err)
	}
	r.wait("second reply", func(w *model.World) bool { return w.Chats[c.ID].ReplyAt == nil && len(w.Chats[c.ID].Messages) == 4 })
	last := r.fake.seen[len(r.fake.seen)-1]
	if !strings.Contains(said(last, 0), "先寫測試") || strings.Contains(said(last, 2), "先寫測試") {
		t.Fatalf("%+v", last.Messages)
	}

	// taking the message back takes its skill too
	if err := r.e.RewindChat(c.ID, 0); err != nil {
		t.Fatal(err)
	}
	if err := r.e.SayInChat(c.ID, "沒有技能", nil); err != nil {
		t.Fatal(err)
	}
	r.wait("third reply", func(w *model.World) bool { return w.Chats[c.ID].ReplyAt == nil && len(w.Chats[c.ID].Messages) == 2 })
	if got := said(r.fake.seen[len(r.fake.seen)-1], 0); strings.Contains(got, "先寫測試") {
		t.Fatalf("%s", got)
	}
}

func TestAttachedFileNamesNoSkill(t *testing.T) {
	root := t.TempDir()
	dir := filepath.Join(root, "skills", "tdd")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "SKILL.md"), []byte("---\nname: tdd\n---\n先寫測試"), 0o644); err != nil {
		t.Fatal(err)
	}
	r := newRig(t, func(model.ModelRequest) (model.ModelReply, error) { return say("好"), nil })
	bp := *r.world().Blueprints[r.owner.BlueprintID]
	bp.Skills = []model.SkillPack{{Source: &model.BlueprintSource{Kind: "local", Path: root}, Exclude: []string{}}}
	if err := r.e.SaveBlueprint(bp.ID, bp); err != nil {
		t.Fatal(err)
	}
	file := model.Attachment{Name: "a.txt", URL: "data:text/plain;base64," + base64.StdEncoding.EncodeToString([]byte("價格 $tdd 元"))}
	c, err := r.e.CreateChat(usecase.NewChat{TeamID: r.team.ID, ReplicaID: r.owner.ID, Text: "看附件", Files: []model.Attachment{file}})
	if err != nil {
		t.Fatal(err)
	}
	r.wait("reply", chatDone(c.ID))
	for _, block := range r.fake.seen[0].Messages[0].Content {
		if strings.Contains(block.Text, "先寫測試") {
			t.Fatalf("%s", block.Text)
		}
	}
}

func TestTaskStepKnowsWhatHashMeans(t *testing.T) {
	r := newRig(t, func(model.ModelRequest) (model.ModelReply, error) { return call("submit_handoff", handoff), nil })
	task := r.task(r.flow.ID)
	r.wait("await merge", stage(task.ID, enum.StageAwaitMerge))
	if got := r.fake.seen[0].System; !strings.Contains(got, "#path") {
		t.Fatalf("%s", got)
	}
}

func TestChatAskUserWaitsForTheNextMessage(t *testing.T) {
	calls := 0
	r := newRig(t, func(model.ModelRequest) (model.ModelReply, error) {
		calls++
		if calls == 1 {
			return sayAndCall("用哪個？", "ask_user", map[string]any{"options": []string{"甲", " ", "乙", "甲"}}), nil
		}
		return say("好"), nil
	})
	c, err := r.e.CreateChat(usecase.NewChat{TeamID: r.team.ID, ReplicaID: r.owner.ID, Text: "開始"})
	if err != nil {
		t.Fatal(err)
	}
	r.wait("question", func(w *model.World) bool { c := w.Chats[c.ID]; return c.ReplyAt == nil && c.Question != nil })
	got := r.world().Chats[c.ID]
	if !slices.Equal(got.Question.Options, []string{"甲", "乙"}) || len(got.Messages) != 2 || got.Messages[1].From != "agent" || got.Messages[1].Text != "用哪個？" {
		t.Fatalf("%+v %+v", got.Question, got.Messages)
	}
	if calls != 1 {
		t.Fatalf("went on without an answer: %d calls", calls)
	}

	if err := r.e.SayInChat(c.ID, "乙", nil); err != nil {
		t.Fatal(err)
	}
	r.wait("reply", func(w *model.World) bool { c := w.Chats[c.ID]; return c.ReplyAt == nil && len(c.Messages) == 4 })
	if r.world().Chats[c.ID].Question != nil {
		t.Fatal("the question stayed open")
	}
	seen := r.fake.seen[len(r.fake.seen)-1].Messages
	if n := len(seen); n != 4 || seen[2].Content[0].Type != enum.BlockToolResult || seen[2].Content[0].IsError || seen[3].Content[0].Text != "乙" {
		t.Fatalf("%+v", seen)
	}

	// taking the answer back leaves the chat where it can go on, counted right past the tool's result
	if err := r.e.RewindChat(c.ID, 2); err != nil {
		t.Fatal(err)
	}
	if err := r.e.SayInChat(c.ID, "甲", nil); err != nil {
		t.Fatal(err)
	}
	r.wait("reply again", func(w *model.World) bool { c := w.Chats[c.ID]; return c.ReplyAt == nil && len(c.Messages) == 4 })
	seen = r.fake.seen[len(r.fake.seen)-1].Messages
	if n := len(seen); n != 4 || seen[3].Content[0].Text != "甲" {
		t.Fatalf("%+v", seen)
	}
}

// Typing instead of picking an option is a new message, not an answer: the employee is told so, and is not left
// thinking the user chose.
func TestTypingInsteadOfPickingIsANewMessage(t *testing.T) {
	calls := 0
	r := newRig(t, func(model.ModelRequest) (model.ModelReply, error) {
		calls++
		if calls == 1 {
			return sayAndCall("用哪個？", "ask_user", map[string]any{"options": []string{"甲", "乙"}}), nil
		}
		return say("好"), nil
	})
	c, err := r.e.CreateChat(usecase.NewChat{TeamID: r.team.ID, ReplicaID: r.owner.ID, Text: "開始"})
	if err != nil {
		t.Fatal(err)
	}
	r.wait("question", func(w *model.World) bool { c := w.Chats[c.ID]; return c.ReplyAt == nil && c.Question != nil })
	if err := r.e.SayInChat(c.ID, "哪個比較快？", nil); err != nil {
		t.Fatal(err)
	}
	r.wait("reply", func(w *model.World) bool { c := w.Chats[c.ID]; return c.ReplyAt == nil && len(c.Messages) == 4 })
	if r.world().Chats[c.ID].Question != nil {
		t.Fatal("the question stayed open")
	}
	seen := r.fake.seen[len(r.fake.seen)-1].Messages
	if n := len(seen); n != 4 || seen[2].Content[0].Type != enum.BlockToolResult || seen[3].Content[0].Text != "哪個比較快？" {
		t.Fatalf("%+v", seen)
	}
	// nor nudged to ask the same choice again
	if got := seen[2].Content[0].Text; strings.Contains(got, "answered") || !strings.Contains(got, "did not pick") || strings.Contains(got, "ask again") {
		t.Fatalf("told the model the user answered: %q", got)
	}
}

// In a chat the user answers ask_user by picking, so a question with nothing to pick is sent back to be asked in words.
func TestChatAskUserNeedsOptions(t *testing.T) {
	calls := 0
	r := newRig(t, func(model.ModelRequest) (model.ModelReply, error) {
		calls++
		if calls == 1 {
			return sayAndCall("API Key 是什麼？", "ask_user", map[string]any{}), nil
		}
		return say("API Key 是什麼？"), nil
	})
	c, err := r.e.CreateChat(usecase.NewChat{TeamID: r.team.ID, ReplicaID: r.owner.ID, Text: "開始"})
	if err != nil {
		t.Fatal(err)
	}
	r.wait("reply", chatDone(c.ID))
	if q := r.world().Chats[c.ID].Question; q != nil {
		t.Fatalf("asked with nothing to pick: %+v", q)
	}
	seen := r.fake.seen[len(r.fake.seen)-1].Messages
	if last := seen[len(seen)-1].Content[0]; !last.IsError || !strings.Contains(last.Text, "options") {
		t.Fatalf("%+v", last)
	}
}

// ask_user only puts options under what the reply says, so a reply cannot be a choice alone: the question, and any
// answer the user asked for, are written out first. Text from an earlier turn of the same reply counts; text from
// before the user's last message does not.
func TestChatAskUserNeedsTheReplyWrittenFirst(t *testing.T) {
	calls := 0
	r := newRig(t, func(model.ModelRequest) (model.ModelReply, error) {
		calls++
		switch calls {
		case 1:
			return say("好"), nil
		case 2, 3: // options with nothing written in this reply
			return call("ask_user", map[string]any{"options": []string{"甲", "乙"}}), nil
		case 4:
			return sayAndCall("每層是 4 倍。", "no_such_tool", map[string]any{}), nil
		default:
			return call("ask_user", map[string]any{"options": []string{"甲", "乙"}}), nil
		}
	})
	c, err := r.e.CreateChat(usecase.NewChat{TeamID: r.team.ID, ReplicaID: r.owner.ID, Text: "開始"})
	if err != nil {
		t.Fatal(err)
	}
	r.wait("first reply", chatDone(c.ID))
	if err := r.e.SayInChat(c.ID, "每層是多少？", nil); err != nil {
		t.Fatal(err)
	}
	r.wait("question", func(w *model.World) bool { c := w.Chats[c.ID]; return c.ReplyAt == nil && c.Question != nil })
	if calls != 5 {
		t.Fatalf("%d calls", calls)
	}
	refused := r.fake.seen[2].Messages
	if last := refused[len(refused)-1].Content[0]; !last.IsError || !strings.Contains(last.Text, "reply") {
		t.Fatalf("%+v", last)
	}
	got := r.world().Chats[c.ID]
	texts := []string{}
	for _, m := range got.Messages[2:] {
		texts = append(texts, m.From+":"+m.Text)
	}
	if !slices.Equal(got.Question.Options, []string{"甲", "乙"}) || !slices.Equal(texts, []string{"user:每層是多少？", "agent:每層是 4 倍。", "tool:no_such_tool {}"}) {
		t.Fatalf("%+v %q", got.Question, texts)
	}
}

func sayAndCall(text, name string, args any) model.ModelReply {
	reply := call(name, args)
	reply.Content = append([]model.Block{{Type: enum.BlockText, Text: text}}, reply.Content...)
	return reply
}

func TestSearchFilesTakesInWhatGitIgnores(t *testing.T) {
	r := newRig(t, func(model.ModelRequest) (model.ModelReply, error) { return say("好"), nil })
	for name, body := range map[string]string{".gitignore": "secret.txt\nbuild/\n", "secret.txt": "x", "build/out.bin": "x", "notes/plan.md": "x"} {
		path := filepath.Join(r.folder, name)
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	found, err := r.e.SearchFiles(context.Background(), r.team.ID, "notes/")
	if err != nil || len(found) != 1 || found[0].Path != "notes/plan.md" || found[0].Ignored {
		t.Fatalf("%+v %v", found, err)
	}
	// what git ignores can still be mentioned, marked as ignored, but .git itself is not offered
	for query, want := range map[string]string{"secret": "secret.txt", "build/": "build/out.bin"} {
		if found, _ := r.e.SearchFiles(context.Background(), r.team.ID, query); len(found) != 1 || found[0].Path != want || !found[0].Ignored {
			t.Fatalf("%q: %+v", query, found)
		}
	}
	// a folder only "build/" names is marked as well
	top, _ := r.e.SearchFiles(context.Background(), r.team.ID, "")
	marks := map[string]bool{}
	for _, f := range top {
		marks[f.Path] = f.Ignored
	}
	if !marks["build"] || marks["notes"] || !marks["secret.txt"] {
		t.Fatalf("%+v", top)
	}
	if found, _ := r.e.SearchFiles(context.Background(), r.team.ID, ".git/"); len(found) != 0 {
		t.Fatalf("%+v", found)
	}
	// and the repo's own listing still keeps to its ignore rules
	out, err := exec.Command("git", "-C", r.folder, "status", "--porcelain", "--untracked-files=all").Output()
	if err != nil || strings.Contains(string(out), "secret.txt") || strings.Contains(string(out), "build/") {
		t.Fatalf("%s %v", out, err)
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
	if err := r.e.StopChat(c.ID); err != nil {
		t.Fatal(err)
	}
	close(release)
	if w := r.world(); w.Chats[c.ID].ReplyAt != nil {
		t.Fatal("still writing after the stop")
	}
	// the chat says the reply stopped, as a reply to try again
	if m := r.world().Chats[c.ID].Messages; len(m) != 2 || m[1].Text != "（已停止回覆）" || !m[1].Failed || m[1].By != r.owner.ID {
		t.Fatalf("%+v", m)
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
	if system := r.fake.seen[len(r.fake.seen)-1].System; !strings.Contains(system, "separate work tree") || !strings.Contains(system, "should not say how to commit") ||
		!strings.Contains(system, "not yet committed") || !strings.Contains(system, "relative to the project folder") {
		t.Fatalf("the draft is not told how a task runs: %s", system)
	}
	seen := r.fake.seen[len(r.fake.seen)-1].Messages[0].Content[0].Text
	if !strings.Contains(seen, "討論登入") || !strings.Contains(seen, "要做登入嗎") {
		t.Fatal(seen)
	}
	if len(r.world().Tasks) != before {
		t.Fatal("writing a draft made a task")
	}
}

// The app's line that a reply did not come is not part of what the draft is written from.
func TestTaskDraftLeavesOutFailedReplies(t *testing.T) {
	r := newRig(t, func(req model.ModelRequest) (model.ModelReply, error) {
		if len(req.Tools) == 0 {
			return say("**做登入**"), nil
		}
		return model.ModelReply{}, model.Errorf(model.CodeInvalid, "壞了")
	})
	c, err := r.e.CreateChat(usecase.NewChat{TeamID: r.team.ID, ReplicaID: r.owner.ID, Text: "討論登入"})
	if err != nil {
		t.Fatal(err)
	}
	w := r.wait("failed reply", chatDone(c.ID))
	if m := w.Chats[c.ID].Messages; !m[len(m)-1].Failed {
		t.Fatalf("%+v", m)
	}
	if _, err := r.e.ChatTaskDraft(context.Background(), c.ID); err != nil {
		t.Fatal(err)
	}
	seen := r.fake.seen[len(r.fake.seen)-1].Messages[0].Content[0].Text
	if !strings.Contains(seen, "討論登入") || strings.Contains(seen, "壞了") || strings.Contains(seen, "Employee") {
		t.Fatal(seen)
	}
}

func TestChatCountsTokensWithoutCacheReads(t *testing.T) {
	r := newRig(t, func(model.ModelRequest) (model.ModelReply, error) {
		reply := say("**做登入**")
		reply.Usage = model.ModelUsage{Input: 1000, Output: 50, CacheRead: 600}
		return reply, nil
	})
	c, err := r.e.CreateChat(usecase.NewChat{TeamID: r.team.ID, ReplicaID: r.owner.ID, Text: "嗨"})
	if err != nil {
		t.Fatal(err)
	}
	r.wait("reply", chatDone(c.ID))
	if got := r.world().Chats[c.ID].Tokens; got != 450 {
		t.Fatalf("tokens = %d", got)
	}
	if _, err := r.e.ChatTaskDraft(context.Background(), c.ID); err != nil {
		t.Fatal(err)
	}
	if got := r.world().Chats[c.ID].Tokens; got != 900 {
		t.Fatalf("tokens after the draft = %d", got)
	}
	fork, err := r.e.HandOffChat(c.ID, 1, c.ReplicaID)
	if err != nil {
		t.Fatal(err)
	}
	if fork.Tokens != 0 {
		t.Fatalf("fork tokens = %d", fork.Tokens)
	}
	if err := r.e.RewindChat(c.ID, 0); err != nil {
		t.Fatal(err)
	}
	if got := r.world().Chats[c.ID].Tokens; got != 900 {
		t.Fatalf("tokens after the rewind = %d", got)
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
	wf.Nodes = append(wf.Nodes[:1], model.WorkflowNode{ID: "talk", Kind: enum.NodeTalk, Name: "討論", Prompt: usecase.TalkPrompt, ReplicaIDs: []string{r.owner.ID}, Handoff: enum.HandoffAll, Join: enum.JoinAll}, wf.Nodes[1])
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
	// a whole 1x1 PNG: read_file refuses images it cannot decode
	png, _ := base64.StdEncoding.DecodeString("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==")
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

func TestEmployeesWriteInTheLanguagePicked(t *testing.T) {
	r := newRig(t, func(model.ModelRequest) (model.ModelReply, error) { return say("好"), nil })
	said := func(text string) string {
		t.Helper()
		c, err := r.e.CreateChat(usecase.NewChat{TeamID: r.team.ID, ReplicaID: r.owner.ID, Text: text})
		if err != nil {
			t.Fatal(err)
		}
		r.wait("reply", chatDone(c.ID))
		return r.fake.seen[len(r.fake.seen)-1].System
	}
	if got := said("嗨"); !strings.Contains(got, "user reads in Traditional Chinese") {
		t.Fatalf("zh is the default: %s", got)
	}
	if r.world().Language != model.LanguageZh {
		t.Fatal(r.world().Language)
	}
	if err := r.e.SetLanguage("fr"); err == nil {
		t.Fatal("an unknown language went through")
	}
	_, events, cancel, err := r.e.Subscribe()
	if err != nil {
		t.Fatal(err)
	}
	defer cancel()
	if err := r.e.SetLanguage(model.LanguageEn); err != nil {
		t.Fatal(err)
	}
	for ev := range events {
		if ev.Type == "language" {
			if ev.Language != model.LanguageEn {
				t.Fatalf("connected clients were told: %+v", ev)
			}
			break
		}
	}
	if got := said("hi"); !strings.Contains(got, "user reads in English") || strings.Contains(got, "Traditional Chinese") {
		t.Fatalf("en: %s", got)
	}
	r.e.Close()
	newEngine(t, r)
	if r.world().Language != model.LanguageEn {
		t.Fatalf("not kept over a restart: %s", r.world().Language)
	}
	c, err := r.e.CreateChat(usecase.NewChat{TeamID: r.team.ID, ReplicaID: r.owner.ID, Text: "draft"})
	if err != nil {
		t.Fatal(err)
	}
	r.wait("reply", chatDone(c.ID))
	if _, err := r.e.ChatTaskDraft(context.Background(), c.ID); err != nil {
		t.Fatal(err)
	}
	if got := r.fake.seen[len(r.fake.seen)-1].System; !strings.Contains(got, "user reads in English") {
		t.Fatalf("draft: %s", got)
	}
}

func TestTaskStepsAreToldTheLanguage(t *testing.T) {
	r := newRig(t, func(req model.ModelRequest) (model.ModelReply, error) { return call("submit_handoff", handoff), nil })
	if err := r.e.SetLanguage(model.LanguageEn); err != nil {
		t.Fatal(err)
	}
	r.task(r.flow.ID)
	r.wait("first step", func(*model.World) bool {
		r.fake.mu.Lock()
		defer r.fake.mu.Unlock()
		return len(r.fake.seen) > 0
	})
	r.fake.mu.Lock()
	defer r.fake.mu.Unlock()
	if got := r.fake.seen[0].System; !strings.Contains(got, "user reads in English") || strings.Contains(got, "# 這一步") {
		t.Fatalf("%s", got)
	}
}

func TestMessagesFollowTheLanguage(t *testing.T) {
	r := newRig(t, func(model.ModelRequest) (model.ModelReply, error) { return say("ok"), nil })
	if err := r.e.SayInChat("nobody", "hi", nil); err == nil || err.Error() != "找不到對話" {
		t.Fatalf("%v", err)
	}
	if err := r.e.SetLanguage(model.LanguageEn); err != nil {
		t.Fatal(err)
	}
	if err := r.e.SayInChat("nobody", "hi", nil); err == nil || err.Error() != "Chat not found" {
		t.Fatalf("%v", err)
	}
	// a restart keeps it
	r.e.Close()
	newEngine(t, r)
	if err := r.e.DeleteBlueprint("preset-architect"); err == nil || !strings.Contains(err.Error(), "Built-in") {
		t.Fatalf("%v", err)
	}
}

func TestForkCopiesUpToTheMessageAndGoesOnByItself(t *testing.T) {
	var mu sync.Mutex
	heard := map[string][]model.Message{}
	replies := 0
	r := newRig(t, func(req model.ModelRequest) (model.ModelReply, error) {
		mu.Lock()
		defer mu.Unlock()
		heard[req.Session] = req.Messages
		replies++
		if replies == 1 { // tool results also come as the user's; they must not be taken for messages
			return call("no_such_tool", map[string]any{}), nil
		}
		return say("回覆"), nil
	})
	c, err := r.e.CreateChat(usecase.NewChat{TeamID: r.team.ID, ReplicaID: r.owner.ID, Text: "第一句",
		Files: []model.Attachment{{Name: "a.txt", URL: "data:text/plain;base64,aGk="}}})
	if err != nil {
		t.Fatal(err)
	}
	r.wait("first", chatDone(c.ID))
	if err := r.e.SayInChat(c.ID, "第二句", nil); err != nil {
		t.Fatal(err)
	}
	r.wait("second", chatDone(c.ID))
	msgs := r.world().Chats[c.ID].Messages
	tool := slices.IndexFunc(msgs, func(m model.ChatMessage) bool { return m.From == "tool" })
	second := slices.IndexFunc(msgs, func(m model.ChatMessage) bool { return m.Text == "第二句" })
	reply := second - 1 // the employee's bubble that ends the first reply

	for _, bad := range []int{-1, tool, len(msgs)} {
		if _, err := r.e.HandOffChat(c.ID, bad, c.ReplicaID); err == nil {
			t.Fatalf("forked at %d", bad)
		}
	}
	// from a user's message: the copy ends there, unanswered, and nothing runs
	atSecond, err := r.e.HandOffChat(c.ID, second, c.ReplicaID)
	if err != nil {
		t.Fatal(err)
	}
	if atSecond.ID == c.ID || len(atSecond.Messages) != second+1 || atSecond.ReplyAt != nil {
		t.Fatalf("%+v", atSecond)
	}
	// from an employee's: it ends with that reply
	atReply, err := r.e.HandOffChat(c.ID, reply, c.ReplicaID)
	if err != nil {
		t.Fatal(err)
	}
	if len(atReply.Messages) != second {
		t.Fatalf("%+v", atReply.Messages)
	}
	if err := r.e.SayInChat(atReply.ID, "分支", nil); err != nil {
		t.Fatal(err)
	}
	r.wait("the fork", chatDone(atReply.ID))

	mu.Lock()
	var said []string
	var attached string
	for _, m := range heard[atReply.ID] {
		for _, b := range m.Content {
			if m.Role == enum.RoleUser && b.Type == enum.BlockText {
				if strings.HasPrefix(b.Text, "Attached file") {
					attached = b.Text
				} else {
					said = append(said, b.Text)
				}
			}
		}
	}
	mu.Unlock()
	if !slices.Equal(said, []string{"第一句", "分支"}) {
		t.Fatalf("the model heard %q", said)
	}
	// the copy has its own attachment, and the model is told where
	own := filepath.Join(r.data, "cache", "attachments", atReply.ID)
	if !strings.Contains(attached, own) || strings.Contains(attached, c.ID) {
		t.Fatal(attached)
	}
	found, _ := filepath.Glob(filepath.Join(own, "*", "a.txt"))
	if len(found) != 1 {
		t.Fatalf("%v", found)
	}
	// the original did not move
	if got := r.world().Chats[c.ID].Messages; !slices.EqualFunc(got, msgs, func(a, b model.ChatMessage) bool { return a.Text == b.Text }) {
		t.Fatalf("%+v", got)
	}
}

func TestForkKeepsAnOpenQuestion(t *testing.T) {
	release := make(chan struct{})
	first := true
	r := newRig(t, func(req model.ModelRequest) (model.ModelReply, error) {
		if first {
			first = false
			<-release
			return sayAndCall("哪個？", "ask_user", map[string]any{"options": []string{"甲", "乙"}}), nil
		}
		return say("好"), nil
	})
	c, err := r.e.CreateChat(usecase.NewChat{TeamID: r.team.ID, ReplicaID: r.owner.ID, Text: "問我"})
	if err != nil {
		t.Fatal(err)
	}
	close(release)
	r.wait("the question", chatDone(c.ID))
	asked := len(r.world().Chats[c.ID].Messages) - 1
	fork, err := r.e.HandOffChat(c.ID, asked, c.ReplicaID)
	if err != nil {
		t.Fatal(err)
	}
	if fork.Question == nil || !slices.Equal(fork.Question.Options, []string{"甲", "乙"}) {
		t.Fatalf("%+v", fork.Question)
	}
	if err := r.e.SayInChat(fork.ID, "甲", nil); err != nil {
		t.Fatal(err)
	}
	r.wait("the answer", chatDone(fork.ID))
	if got := r.world().Chats[fork.ID].Messages; got[len(got)-1].Text != "好" {
		t.Fatalf("%+v", got)
	}
}

func TestForkWhileReplyingLeavesTheReplyRunning(t *testing.T) {
	release := make(chan struct{})
	var mu sync.Mutex
	heard := map[string][]model.Message{}
	replies := 0
	r := newRig(t, func(req model.ModelRequest) (model.ModelReply, error) {
		mu.Lock()
		heard[req.Session] = req.Messages
		replies++
		n := replies
		mu.Unlock()
		switch n {
		case 2: // the second reply says something, calls a tool, and is still going when the fork is made
			reply := call("no_such_tool", map[string]any{})
			reply.Content = append([]model.Block{{Type: enum.BlockText, Text: "寫到一半"}}, reply.Content...)
			return reply, nil
		case 3:
			<-release
			return say("原本的寫完了"), nil
		}
		return say("回覆"), nil
	})
	defer func() {
		select {
		case <-release:
		default:
			close(release)
		}
	}()
	c, err := r.e.CreateChat(usecase.NewChat{TeamID: r.team.ID, ReplicaID: r.owner.ID, Text: "第一句"})
	if err != nil {
		t.Fatal(err)
	}
	r.wait("first", chatDone(c.ID))
	if err := r.e.SayInChat(c.ID, "第二句", nil); err != nil {
		t.Fatal(err)
	}
	r.wait("the tool call", func(w *model.World) bool {
		mu.Lock()
		defer mu.Unlock()
		return replies == 3 && w.Chats[c.ID].ReplyAt != nil
	})
	msgs := r.world().Chats[c.ID].Messages
	second := slices.IndexFunc(msgs, func(m model.ChatMessage) bool { return m.Text == "第二句" })
	writing := slices.IndexFunc(msgs, func(m model.ChatMessage) bool { return m.Text == "寫到一半" })
	if writing < 0 {
		t.Fatalf("%+v", msgs)
	}
	// the reply being written has no end yet
	if _, err := r.e.HandOffChat(c.ID, writing, c.ReplicaID); err == nil {
		t.Fatal("forked inside the unfinished reply")
	}
	// the message it answers can be forked, unanswered, with nothing of the reply
	atSaid, err := r.e.HandOffChat(c.ID, second, c.ReplicaID)
	if err != nil {
		t.Fatal(err)
	}
	if atSaid.ReplyAt != nil || len(atSaid.Messages) != second+1 {
		t.Fatalf("%+v", atSaid)
	}
	// so can the reply before it
	atEarlier, err := r.e.HandOffChat(c.ID, second-1, c.ReplicaID)
	if err != nil || len(atEarlier.Messages) != second {
		t.Fatalf("%+v %v", atEarlier, err)
	}
	if r.world().Chats[c.ID].ReplyAt == nil {
		t.Fatal("the fork stopped the original")
	}
	close(release)
	r.wait("the original", chatDone(c.ID))
	if got := r.world().Chats[c.ID].Messages; got[len(got)-1].Text != "原本的寫完了" {
		t.Fatalf("%+v", got)
	}
	// the copy goes on by itself, and the model never hears the unfinished reply
	if err := r.e.SayInChat(atEarlier.ID, "分支", nil); err != nil {
		t.Fatal(err)
	}
	r.wait("the fork", chatDone(atEarlier.ID))
	mu.Lock()
	defer mu.Unlock()
	for _, m := range heard[atEarlier.ID] {
		for _, b := range m.Content {
			if b.Text == "寫到一半" || b.Text == "第二句" {
				t.Errorf("the fork heard %q", b.Text)
			}
		}
	}
}

func TestChatReplyStaysUnreadUntilRead(t *testing.T) {
	r := newRig(t, func(req model.ModelRequest) (model.ModelReply, error) { return say("好"), nil })
	c, err := r.e.CreateChat(usecase.NewChat{TeamID: r.team.ID, ReplicaID: r.owner.ID, Text: "嗨"})
	if err != nil {
		t.Fatal(err)
	}
	if c.Unread {
		t.Fatal("the user's own message counted as unread")
	}
	r.wait("reply", chatDone(c.ID))
	if !r.world().Chats[c.ID].Unread {
		t.Fatal("the reply is not unread")
	}
	if err := r.e.ReadChat(c.ID); err != nil {
		t.Fatal(err)
	}
	if r.world().Chats[c.ID].Unread {
		t.Fatal("still unread after reading")
	}
	if err := r.e.ReadChat("nope"); err == nil {
		t.Fatal("read a chat that does not exist")
	}
}

func TestChatFailureIsUnread(t *testing.T) {
	r := newRig(t, func(req model.ModelRequest) (model.ModelReply, error) { return model.ModelReply{}, context.Canceled })
	c, err := r.e.CreateChat(usecase.NewChat{TeamID: r.team.ID, ReplicaID: r.owner.ID, Text: "嗨"})
	if err != nil {
		t.Fatal(err)
	}
	r.wait("failure", chatDone(c.ID))
	if !r.world().Chats[c.ID].Unread {
		t.Fatal("the failure is not unread")
	}
}

const summarySign = "Summarize the earlier part"

func summarizing(req model.ModelRequest) bool { return strings.Contains(req.System, summarySign) }

func TestChatCompactsOnceItReadsTooMuch(t *testing.T) {
	var last model.ModelRequest
	replies := 0
	r := newRig(t, func(req model.ModelRequest) (model.ModelReply, error) {
		if summarizing(req) {
			return model.ModelReply{Content: []model.Block{{Type: enum.BlockText, Text: "摘要內容"}}, Usage: model.ModelUsage{Input: 700, Output: 300}}, nil
		}
		last, replies = req, replies+1
		reply := say("好")
		reply.Usage = model.ModelUsage{Input: 200_000, Output: 10}
		return reply, nil
	})
	c, err := r.e.CreateChat(usecase.NewChat{TeamID: r.team.ID, ReplicaID: r.owner.ID, Text: strings.Repeat("長", 40_000)})
	if err != nil {
		t.Fatal(err)
	}
	r.wait("first reply", chatDone(c.ID))
	before := r.world().Chats[c.ID].Tokens
	if err := r.e.SayInChat(c.ID, "下一句", nil); err != nil {
		t.Fatal(err)
	}
	r.wait("second reply", func(w *model.World) bool {
		r.fake.mu.Lock()
		defer r.fake.mu.Unlock()
		return replies == 2 && w.Chats[c.ID].ReplyAt == nil
	})
	if len(last.Messages) != 3 || !strings.Contains(last.Messages[0].Content[0].Text, "摘要內容") || last.Messages[2].Content[0].Text != "下一句" {
		t.Fatalf("%+v", last.Messages)
	}
	got := r.world().Chats[c.ID]
	if got.Compact == nil || got.Tokens != before+200_010+1_000 {
		t.Fatalf("the summary's tokens must count: %+v, %d after %d", got.Compact, got.Tokens, before)
	}
	// taking back what the summary covers takes the summary too
	if err := r.e.RewindChat(c.ID, 0); err != nil {
		t.Fatal(err)
	}
	if r.world().Chats[c.ID].Compact != nil {
		t.Fatal("a summary of what was taken back stayed")
	}
}

func TestChatCompactsWhenTheModelSaysItIsTooLong(t *testing.T) {
	var last model.ModelRequest
	r := newRig(t, func(req model.ModelRequest) (model.ModelReply, error) {
		if summarizing(req) {
			return say("摘要內容"), nil
		}
		if len(req.Messages) == 3 && req.Messages[0].Content[0].Text != "" && !strings.Contains(req.Messages[0].Content[0].Text, "摘要內容") {
			return model.ModelReply{}, model.Errorf(model.CodeContextOverflow, "太長")
		}
		last = req
		return say("好"), nil
	})
	c, err := r.e.CreateChat(usecase.NewChat{TeamID: r.team.ID, ReplicaID: r.owner.ID, Text: strings.Repeat("長", 40_000)})
	if err != nil {
		t.Fatal(err)
	}
	r.wait("first reply", chatDone(c.ID))
	if err := r.e.SayInChat(c.ID, "下一句", nil); err != nil {
		t.Fatal(err)
	}
	r.wait("second reply", chatDone(c.ID))
	got := r.world().Chats[c.ID]
	if got.Compact == nil || !strings.Contains(last.Messages[0].Content[0].Text, "摘要內容") {
		t.Fatalf("%+v", got.Messages)
	}
	if said := got.Messages[len(got.Messages)-1]; said.Text != "好" {
		t.Fatalf("it failed anyway: %+v", said)
	}
}

func TestChatKeepsAToolResultWithItsCall(t *testing.T) {
	var last model.ModelRequest
	calls := 0
	r := newRig(t, func(req model.ModelRequest) (model.ModelReply, error) {
		if summarizing(req) {
			return say("摘要內容"), nil
		}
		last = req
		calls++
		if calls <= 2 {
			reply := call("read_file", map[string]any{"path": "nope.txt"})
			reply.Usage.Input = 200_000
			return reply, nil
		}
		return say("好"), nil
	})
	c, err := r.e.CreateChat(usecase.NewChat{TeamID: r.team.ID, ReplicaID: r.owner.ID, Text: strings.Repeat("長", 40_000)})
	if err != nil {
		t.Fatal(err)
	}
	r.wait("reply", chatDone(c.ID))
	if r.world().Chats[c.ID].Compact == nil {
		t.Fatal("did not compact during the turn")
	}
	for i, m := range last.Messages {
		if i > 0 && m.Role == enum.RoleUser && m.Content[0].Type == enum.BlockToolResult && last.Messages[i-1].Role != enum.RoleAssistant {
			t.Fatalf("a result lost its call: %+v", last.Messages)
		}
	}
}

func TestChatRemembersAndForgets(t *testing.T) {
	step := 0
	r := newRig(t, func(req model.ModelRequest) (model.ModelReply, error) {
		step++
		switch step {
		case 1:
			return call("remember", map[string]any{"text": " 測試要加 -race "}), nil
		case 2:
			return call("forget", map[string]any{"id": "nope"}), nil
		case 3:
			return call("forget", map[string]any{"id": "old"}), nil
		}
		return say("記下了"), nil
	})
	memory := []model.MemoryEntry{{ID: "old", Text: "用 npm", Source: "work", At: 86400}}
	if err := r.e.UpdateReplica(r.owner.ID, usecase.ReplicaPatch{Memory: &memory}); err != nil {
		t.Fatal(err)
	}
	c, err := r.e.CreateChat(usecase.NewChat{TeamID: r.team.ID, ReplicaID: r.owner.ID, Text: "記住要加 -race，npm 那條不對了"})
	if err != nil {
		t.Fatal(err)
	}
	w := r.wait("reply", chatDone(c.ID))
	got := w.Replicas[r.owner.ID].Memory
	if len(got) != 1 || got[0].Text != "測試要加 -race" || got[0].Source != "chat" || got[0].TaskID != "" {
		t.Fatalf("memory = %+v", got)
	}
	if !strings.Contains(r.fake.seen[0].System, "Use remember") {
		t.Fatalf("system: %s", r.fake.seen[0].System)
	}
	rejected := false
	for _, b := range r.fake.seen[2].Messages[len(r.fake.seen[2].Messages)-1].Content {
		rejected = rejected || (b.Type == enum.BlockToolResult && b.IsError)
	}
	if !rejected {
		t.Fatal("forgetting an unknown note did not fail")
	}
}

func TestAirportChatRunsWithoutACompany(t *testing.T) {
	var got model.ModelRequest
	r := newRig(t, func(req model.ModelRequest) (model.ModelReply, error) {
		got = req
		return say("您好"), nil
	})
	m := r.owner.Model
	c, err := r.e.CreateAirportChat(usecase.NewAirportChat{Model: m, Text: "你好"})
	if err != nil {
		t.Fatal(err)
	}
	w := r.wait("reply", chatDone(c.ID))
	chat := w.Chats[c.ID]
	if !chat.AtAirport() || !chat.Unread || chat.Effort != model.ThinkingDefault || chat.Messages[1].Text != "您好" {
		t.Fatalf("%+v", chat)
	}
	if info, err := os.Stat(got.Cwd); err != nil || !info.IsDir() || filepath.Base(got.Cwd) != "airport" {
		t.Fatalf("cwd %q: %v", got.Cwd, err)
	}
	if !strings.Contains(got.System, "airport's service staff") || !strings.Contains(got.System, "# Your role\nYou are the airport staff of Team Work") {
		t.Fatalf("system: %s", got.System)
	}
	names := []string{}
	for _, tool := range got.Tools {
		names = append(names, tool.Name)
	}
	for _, want := range []string{"read_file", "write_file", "run_command", "ask_user"} {
		if !slices.Contains(names, want) {
			t.Fatalf("no %s in %v", want, names)
		}
	}
	if slices.Contains(names, "remember") || slices.Contains(names, "forget") {
		t.Fatalf("airport staff keep no memory: %v", names)
	}
	if slices.Contains(names, "read_terminal") {
		t.Fatalf("the airport has no terminal: %v", names)
	}
	if _, err := r.e.ChatTaskDraft(context.Background(), c.ID); err == nil {
		t.Fatal("an airport chat has no company to make a task in")
	}
	if err := r.e.ReadChat(c.ID); err != nil {
		t.Fatal(err)
	}
	if r.world().Chats[c.ID].Unread {
		t.Fatal("still unread")
	}
	fork, err := r.e.HandOffChat(c.ID, 1, c.ReplicaID)
	if err != nil || !fork.AtAirport() || fork.Effort != chat.Effort {
		t.Fatalf("%+v %v", fork, err)
	}
	if err := r.e.DeleteTeam(r.team.ID); err != nil {
		t.Fatal(err)
	}
	if r.world().Chats[c.ID] == nil {
		t.Fatal("an airport chat belongs to no company")
	}
}

func TestAirportChatRefusesAModelNobodyOffers(t *testing.T) {
	r := newRig(t, func(model.ModelRequest) (model.ModelReply, error) { return say("x"), nil })
	if _, err := r.e.CreateAirportChat(usecase.NewAirportChat{Model: "nobody", Text: "你好"}); err == nil {
		t.Fatal("no provider offers it")
	}
	if _, err := r.e.CreateAirportChat(usecase.NewAirportChat{Model: r.owner.Model, Effort: "nonsense", Text: "你好"}); err == nil {
		t.Fatal("the model has no such level")
	}
}

func TestOnlyAirportChatsChangeModelBetweenReplies(t *testing.T) {
	release := make(chan struct{})
	var mu sync.Mutex
	used := []string{}
	r := newRig(t, func(req model.ModelRequest) (model.ModelReply, error) {
		<-release
		mu.Lock()
		defer mu.Unlock()
		used = append(used, req.Model)
		return say("好"), nil
	})
	first := r.owner.Model
	other := "other"
	r.fake.models = []model.ModelSpec{{ID: other}}
	if _, err := r.e.AddProvider(context.Background(), usecase.NewProvider{Name: "q", Kind: enum.ProviderCompatible, Login: usecase.ProviderLogin{Kind: "apiKey", APIKey: "sk-secret-5678"}}); err != nil {
		t.Fatal(err)
	}
	c, err := r.e.CreateAirportChat(usecase.NewAirportChat{Model: first, Text: "一"})
	if err != nil {
		t.Fatal(err)
	}
	if err := r.e.SetChatMind(c.ID, other, ""); err == nil {
		t.Fatal("a reply is being written")
	}
	release <- struct{}{}
	r.wait("first reply", chatDone(c.ID))
	if err := r.e.SetChatMind(c.ID, other, ""); err != nil {
		t.Fatal(err)
	}
	if err := r.e.SetChatMind(c.ID, "nobody", ""); err == nil {
		t.Fatal("no provider offers it")
	}
	if err := r.e.SayInChat(c.ID, "二", nil); err != nil {
		t.Fatal(err)
	}
	release <- struct{}{}
	r.wait("second reply", chatDone(c.ID))
	mu.Lock()
	if !slices.Equal(used, []string{first, other}) {
		t.Fatalf("%v", used)
	}
	mu.Unlock()
	company, err := r.e.CreateChat(usecase.NewChat{TeamID: r.team.ID, ReplicaID: r.owner.ID, Text: "三"})
	if err != nil {
		t.Fatal(err)
	}
	if err := r.e.SetChatMind(company.ID, other, ""); err == nil {
		t.Fatal("a company's chat stays on its model")
	}
	close(release)
}

// userWords is what the user said in a request, in order; tool results do not count.
func userWords(req model.ModelRequest) []string {
	var said []string
	for _, m := range req.Messages {
		if m.Role == enum.RoleUser && len(m.Content) > 0 && m.Content[0].Type == enum.BlockText {
			said = append(said, m.Content[0].Text)
		}
	}
	return said
}

func TestChatQueuesWhatIsSaidWhileReplyingAndSendsItAfter(t *testing.T) {
	release := make(chan struct{})
	first := true
	r := newRig(t, func(req model.ModelRequest) (model.ModelReply, error) {
		if first {
			first = false
			<-release
		}
		return say("好"), nil
	})
	c, err := r.e.CreateChat(usecase.NewChat{TeamID: r.team.ID, ReplicaID: r.owner.ID, Text: "一"})
	if err != nil {
		t.Fatal(err)
	}
	for _, text := range []string{"二", "三"} {
		if err := r.e.SayInChat(c.ID, text, nil); err != nil {
			t.Fatal(err)
		}
	}
	if got := r.world().Chats[c.ID]; len(got.Queue) != 2 || got.Queue[0].Text != "二" || len(got.Messages) != 1 {
		t.Fatalf("%+v %+v", got.Queue, got.Messages)
	}
	close(release)
	w := r.wait("queue sent", func(w *model.World) bool {
		c := w.Chats[c.ID]
		return c.ReplyAt == nil && len(c.Queue) == 0 && len(c.Messages) == 6
	})
	var said []string
	for _, m := range w.Chats[c.ID].Messages {
		said = append(said, m.Text)
	}
	if !slices.Equal(said, []string{"一", "好", "二", "好", "三", "好"}) {
		t.Fatalf("%q", said)
	}
	if got := userWords(r.fake.seen[len(r.fake.seen)-1]); !slices.Equal(got, []string{"一", "二", "三"}) {
		t.Fatalf("%q", got)
	}
}

func TestChatSteerGoesRightAfterTheToolCall(t *testing.T) {
	release := make(chan struct{})
	calls := 0
	r := newRig(t, func(req model.ModelRequest) (model.ModelReply, error) {
		calls++
		if calls == 1 {
			<-release
			return call("no_such_tool", map[string]any{}), nil
		}
		return say("好"), nil
	})
	c, err := r.e.CreateChat(usecase.NewChat{TeamID: r.team.ID, ReplicaID: r.owner.ID, Text: "開始"})
	if err != nil {
		t.Fatal(err)
	}
	for _, text := range []string{"排隊", "轉向"} {
		if err := r.e.SayInChat(c.ID, text, nil); err != nil {
			t.Fatal(err)
		}
	}
	steer := r.world().Chats[c.ID].Queue[1].ID
	if err := r.e.SteerChat(c.ID, steer); err != nil {
		t.Fatal(err)
	}
	if q := r.world().Chats[c.ID].Queue; q[0].ID != steer || !q[0].Steer || q[1].Steer {
		t.Fatalf("%+v", q)
	}
	close(release)
	w := r.wait("all sent", func(w *model.World) bool {
		c := w.Chats[c.ID]
		return c.ReplyAt == nil && len(c.Queue) == 0 && len(c.Messages) == 6
	})
	var said []string
	for _, m := range w.Chats[c.ID].Messages {
		said = append(said, m.From+":"+m.Text)
	}
	if said[2] != "user:轉向" || said[3] != "agent:好" || said[4] != "user:排隊" {
		t.Fatalf("%q", said)
	}
	// the steer came in the same reply, right after the tool's result
	second := r.fake.seen[1].Messages
	if n := len(second); n != 4 || second[2].Content[0].Type != enum.BlockToolResult || second[3].Content[0].Text != "轉向" {
		t.Fatalf("%+v", second)
	}
	// and counts as the user's message, so it can be taken back
	if err := r.e.RewindChat(c.ID, 2); err != nil {
		t.Fatal(err)
	}
	if got := r.world().Chats[c.ID].Messages; len(got) != 2 {
		t.Fatalf("%+v", got)
	}
}

func TestChatQueueWaitsAfterAStopUntilSteeredOrTakenBack(t *testing.T) {
	release := make(chan struct{})
	first := true
	r := newRig(t, func(req model.ModelRequest) (model.ModelReply, error) {
		if first {
			first = false
			<-release
		}
		return say("好"), nil
	})
	c, err := r.e.CreateChat(usecase.NewChat{TeamID: r.team.ID, ReplicaID: r.owner.ID, Text: "一"})
	if err != nil {
		t.Fatal(err)
	}
	for _, text := range []string{"二", "三"} {
		if err := r.e.SayInChat(c.ID, text, nil); err != nil {
			t.Fatal(err)
		}
	}
	if err := r.e.StopChat(c.ID); err != nil {
		t.Fatal(err)
	}
	close(release)
	q := r.world().Chats[c.ID].Queue
	if len(q) != 2 {
		t.Fatalf("%+v", q)
	}
	if err := r.e.UnqueueChat(c.ID, q[0].ID); err != nil {
		t.Fatal(err)
	}
	if err := r.e.SteerChat(c.ID, q[0].ID); err == nil {
		t.Fatal("steered a message no longer queued")
	}
	// with nothing being written, a steer goes now
	if err := r.e.SteerChat(c.ID, q[1].ID); err != nil {
		t.Fatal(err)
	}
	// after the line that the reply stopped
	w := r.wait("steered", func(w *model.World) bool { c := w.Chats[c.ID]; return c.ReplyAt == nil && len(c.Messages) == 4 })
	if got := w.Chats[c.ID]; len(got.Queue) != 0 || got.Messages[2].Text != "三" {
		t.Fatalf("%+v %+v", got.Queue, got.Messages)
	}
}

func TestHandOffChatGoesOnWithAnotherEmployee(t *testing.T) {
	r := newRig(t, func(model.ModelRequest) (model.ModelReply, error) { return say("好"), nil })
	bea, err := r.e.Hire(usecase.NewReplica{TeamID: r.team.ID, BlueprintID: r.owner.BlueprintID, Name: "Bea", Model: "fake"})
	if err != nil {
		t.Fatal(err)
	}
	c, err := r.e.CreateChat(usecase.NewChat{TeamID: r.team.ID, ReplicaID: r.owner.ID, Text: "第一句"})
	if err != nil {
		t.Fatal(err)
	}
	r.wait("first", chatDone(c.ID))
	if err := r.e.SayInChat(c.ID, "第二句", nil); err != nil {
		t.Fatal(err)
	}
	r.wait("second", chatDone(c.ID))
	second := slices.IndexFunc(r.world().Chats[c.ID].Messages, func(m model.ChatMessage) bool { return m.Text == "第二句" })

	if _, err := r.e.HandOffChat(c.ID, second, "nobody"); err == nil {
		t.Fatal("handed to nobody")
	}
	// from the user's message: Bea answers it, taking over before it
	got, err := r.e.HandOffChat(c.ID, second, bea.ID)
	if err != nil {
		t.Fatal(err)
	}
	want := []model.ChatHandoff{{Before: second, ReplicaID: r.owner.ID, Name: "Ada"}}
	if got.ReplicaID != bea.ID || got.Name != "Bea" || !slices.Equal(got.Handoffs, want) || got.ReplyAt != nil {
		t.Fatalf("%+v", got)
	}
	if err := r.e.SayInChat(got.ID, "第三句", nil); err != nil {
		t.Fatal(err)
	}
	r.wait("Bea", chatDone(got.ID))
	if system := r.fake.seen[len(r.fake.seen)-1].System; !strings.Contains(system, "The replies to the user's message 1 came from Ada.") {
		t.Fatalf("%s", system)
	}
	// taking back everything Ada said leaves the chat Bea's from the start
	if err := r.e.RewindChat(got.ID, 0); err != nil {
		t.Fatal(err)
	}
	if h := r.world().Chats[got.ID].Handoffs; len(h) != 1 || h[0].Before != 0 {
		t.Fatalf("%+v", h)
	}

	// once Ada has left, her chat can still go to someone else, but not to her
	if err := r.e.Fire(r.owner.ID, bea.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := r.e.HandOffChat(c.ID, second, r.owner.ID); err == nil {
		t.Fatal("handed to someone who left")
	}
	if _, err := r.e.HandOffChat(c.ID, second, bea.ID); err != nil {
		t.Fatal(err)
	}
}

// A reply that failed because the subscription was signed out says which provider to sign in to, and once
// signed in again the same employee tries it again from the user's message, with no new message.
func TestChatRetriesAFailedReplyAfterSigningInAgain(t *testing.T) {
	signedOut := true
	r := newRig(t, func(model.ModelRequest) (model.ModelReply, error) {
		if signedOut {
			return model.ModelReply{}, model.Errorf(model.CodeSignedOut, "ChatGPT 的登入已失效，請重新登入")
		}
		return say("好了"), nil
	})
	ctx := context.Background()
	r.fake.mu.Lock()
	r.fake.models = []model.ModelSpec{{ID: "plan-model"}}
	r.fake.login = &adapter.LoginFlow{Wait: func(context.Context) error { return nil }, Paste: func(string) error { return nil }}
	r.fake.mu.Unlock()
	p, err := r.e.AddProvider(ctx, usecase.NewProvider{Name: "訂閱", Kind: enum.ProviderOpenAI, Login: usecase.ProviderLogin{Kind: "subscription"}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := r.e.StartLogin(ctx, p.ID, ""); err != nil {
		t.Fatal(err)
	}
	r.wait("signed in", func(w *model.World) bool { return w.Providers[p.ID].Auth.SignedIn })
	worker, err := r.e.Hire(usecase.NewReplica{TeamID: r.team.ID, BlueprintID: r.owner.BlueprintID, Name: "Bo", Model: "plan-model"})
	if err != nil {
		t.Fatal(err)
	}
	c, err := r.e.CreateChat(usecase.NewChat{TeamID: r.team.ID, ReplicaID: worker.ID, Text: "你好"})
	if err != nil {
		t.Fatal(err)
	}
	w := r.wait("failed", func(w *model.World) bool {
		msgs := w.Chats[c.ID].Messages
		return w.Chats[c.ID].ReplyAt == nil && len(msgs) == 2 && msgs[1].Failed
	})
	if got := w.Chats[c.ID].Messages[1]; got.SignedOut != p.ID || got.By != worker.ID {
		t.Fatalf("%+v", got)
	}

	r.fake.mu.Lock()
	signedOut = false
	r.fake.mu.Unlock()
	if _, err := r.e.StartLogin(ctx, p.ID, ""); err != nil {
		t.Fatal(err)
	}
	r.wait("signed in again", func(w *model.World) bool { return w.Providers[p.ID].Auth.SignedIn })
	if err := r.e.RetryChat(c.ID); err != nil {
		t.Fatal(err)
	}
	w = r.wait("reply", chatDone(c.ID))
	msgs := w.Chats[c.ID].Messages
	if len(msgs) != 2 || msgs[0].Text != "你好" || msgs[1].Text != "好了" || msgs[1].Failed {
		t.Fatalf("%+v", msgs)
	}
	if err := r.e.RetryChat(c.ID); err == nil {
		t.Fatal("retried a reply that came")
	}
}

// Simplified Chinese, Japanese and Korean reach what the backend says and the built-in flows, and survive a restart.
func TestOtherLanguagesReachMessagesAndPresets(t *testing.T) {
	r := newRig(t, func(model.ModelRequest) (model.ModelReply, error) { return say("ok"), nil })
	for _, c := range []struct{ code, notFound, flow string }{
		{model.LanguageZhHans, "找不到对话", "功能开发"},
		{model.LanguageJa, "チャットが見つかりません", "機能開発"},
		{model.LanguageKo, "채팅을 찾을 수 없습니다", "기능 개발"},
	} {
		if err := r.e.SetLanguage(c.code); err != nil {
			t.Fatal(err)
		}
		if err := r.e.SayInChat("nobody", "hi", nil); err == nil || err.Error() != c.notFound {
			t.Errorf("%s: %v", c.code, err)
		}
		if got := presetFlowOf(t, r.world(), "preset-feature").Name; got != c.flow {
			t.Errorf("%s: %s", c.code, got)
		}
	}
	r.e.Close()
	newEngine(t, r)
	if r.world().Language != model.LanguageKo || presetFlowOf(t, r.world(), "preset-feature").Name != "기능 개발" {
		t.Fatalf("not kept over a restart: %s", r.world().Language)
	}
}
