package usecase_test

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/yanun0323/Team-Work/internal/model"
	"github.com/yanun0323/Team-Work/internal/model/enum"
	"github.com/yanun0323/Team-Work/internal/usecase"
)

func wordsOf(msgs []model.Message) string {
	var out strings.Builder
	for _, m := range msgs {
		for _, b := range m.Content {
			out.WriteString(string(m.Role) + ":" + string(b.Type) + ":" + b.Text + "\n")
		}
	}
	return out.String()
}

// A skill named with "$" is picked from everyone's in the chat, so it comes whoever replies first.
func TestMeetingSkillComesFromWhoeverHasIt(t *testing.T) {
	root := t.TempDir()
	dir := filepath.Join(root, "skills", "tdd")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "SKILL.md"), []byte("---\nname: tdd\ndescription: d\n---\n先寫測試"), 0o644); err != nil {
		t.Fatal(err)
	}
	r := newRig(t, func(model.ModelRequest) (model.ModelReply, error) { return say("好"), nil })
	bp, err := r.e.CreateBlueprint(model.Blueprint{Name: "Tester", Skills: []model.SkillPack{{Source: &model.BlueprintSource{Kind: "local", Path: root}}}})
	if err != nil {
		t.Fatal(err)
	}
	bea, err := r.e.Hire(usecase.NewReplica{TeamID: r.team.ID, BlueprintID: bp.ID, Name: "Bea", Model: "fake"})
	if err != nil {
		t.Fatal(err)
	}

	// the chair, who has no such skill, replies first; Bea, who has it, after
	c, err := r.e.CreateChat(usecase.NewChat{TeamID: r.team.ID, ReplicaID: r.owner.ID, Guests: []string{bea.ID}, Text: "用 $tdd", Mentions: []string{r.owner.ID, bea.ID}})
	if err != nil {
		t.Fatal(err)
	}
	r.wait("both", chatDone(c.ID))
	if len(r.fake.seen) != 2 {
		t.Fatalf("%d replies", len(r.fake.seen))
	}
	for i, req := range r.fake.seen {
		if got := wordsOf(req.Messages); strings.Count(got, "先寫測試") != 1 {
			t.Fatalf("reply %d heard %s", i, got)
		}
	}
}

func TestMeetingRepliesInTurn(t *testing.T) {
	var beaID string
	looked := false
	r := newRig(t, func(req model.ModelRequest) (model.ModelReply, error) {
		// Bea tries to ask the user first, which is not hers to do this round; nobody else sees her try
		if beaID != "" && strings.HasSuffix(req.Session, beaID) && !looked {
			looked = true
			return model.ModelReply{Content: []model.Block{{Type: enum.BlockToolCall, ID: "look", Name: "ask_user", Args: json.RawMessage(`{"prompt":"?"}`)}}}, nil
		}
		name, _, _ := strings.Cut(strings.SplitN(req.System+"you are Ada.", "you are ", 2)[1], ".")
		return say(name + " 的意見"), nil
	})
	hire := func(name string) *model.Replica {
		got, err := r.e.Hire(usecase.NewReplica{TeamID: r.team.ID, BlueprintID: r.owner.BlueprintID, Name: name, Model: "fake"})
		if err != nil {
			t.Fatal(err)
		}
		return got
	}
	bea, cy := hire("Bea"), hire("Cy")
	beaID = bea.ID

	c, err := r.e.CreateChat(usecase.NewChat{TeamID: r.team.ID, ReplicaID: r.owner.ID, Guests: []string{bea.ID, cy.ID}, Text: "@All 大家怎麼看", Mentions: []string{bea.ID, cy.ID, r.owner.ID}})
	if err != nil {
		t.Fatal(err)
	}
	r.wait("everyone", chatDone(c.ID))
	// with everyone mentioned everyone replies, the chair last
	var by []string
	for _, m := range r.world().Chats[c.ID].Messages {
		if m.From == "agent" {
			by = append(by, m.By+":"+m.Text)
		}
	}
	if want := []string{bea.ID + ":Bea 的意見", cy.ID + ":Cy 的意見", r.owner.ID + ":Ada 的意見"}; !slices.Equal(by, want) {
		t.Fatalf("%v", by)
	}
	var asked []model.ModelRequest
	for _, req := range r.fake.seen {
		if strings.HasPrefix(req.Session, c.ID) && !strings.Contains(req.Session, "-title") {
			asked = append(asked, req)
		}
	}
	if len(asked) != 4 {
		t.Fatalf("%d requests", len(asked))
	}
	cySaw, adaSaw := wordsOf(asked[2].Messages), wordsOf(asked[3].Messages)
	if !strings.Contains(cySaw, "[Bea] Bea 的意見") || strings.Contains(cySaw, "tool") || strings.Contains(cySaw, "assistant") {
		t.Fatalf("Cy saw\n%s", cySaw)
	}
	if !strings.Contains(adaSaw, "[Cy] Cy 的意見") {
		t.Fatalf("Ada saw\n%s", adaSaw)
	}
	// everyone has the same tools and the round's news comes after what was sent before, so caches hold
	for _, req := range asked[1:] {
		if !slices.Equal(toolNames(req), toolNames(asked[0])) || !slices.Contains(toolNames(req), "ask_user") {
			t.Fatalf("tools differ: %v and %v", toolNames(req), toolNames(asked[0]))
		}
		if strings.Contains(req.System, "(chair)") || strings.Contains(req.System, "Ada may") {
			t.Fatalf("the round is in the system prompt:\n%s", req.System)
		}
		// those after the first are told what came before is a view to check, not a fact to build on
		if !strings.Contains(req.System, "their view, not established fact") || !strings.Contains(req.System, "Do not skip a part because someone else covered it") {
			t.Fatalf("no rule against taking the others on trust:\n%s", req.System)
		}
	}
	if !strings.HasSuffix(cySaw, "[Meeting] In it: Ada (chair), Bea, Cy (you). This round replies, in order: Bea, Cy (you), Ada (chair). This round Ada may act outside the chat.\n") {
		t.Fatalf("Cy saw\n%s", cySaw)
	}
	// only the chair may act outside the chat when nobody is mentioned alone
	if beaTried := wordsOf(asked[1].Messages); !strings.Contains(beaTried, "only Ada may do this") {
		t.Fatalf("Bea could act:\n%s", beaTried)
	}
	if !strings.Contains(wordsOf(asked[3].Messages), "This round you may act") {
		t.Fatalf("Ada could not act:\n%s", adaSaw)
	}

	// with nobody mentioned the chair replies alone
	r.fake.seen = nil
	if err := r.e.SayInChat(c.ID, "那就這樣", nil); err != nil {
		t.Fatal(err)
	}
	r.wait("chair", chatDone(c.ID))
	if m := r.world().Chats[c.ID].Messages; len(r.fake.seen) != 1 || m[len(m)-1].By != r.owner.ID {
		t.Fatalf("%d requests, last by %s", len(r.fake.seen), m[len(m)-1].By)
	}

	// one mentioned alone replies alone, and acts
	r.fake.seen = nil
	if err := r.e.SayInChatTo(c.ID, "@Cy 你呢", nil, nil, []string{cy.ID}); err != nil {
		t.Fatal(err)
	}
	r.wait("Cy", chatDone(c.ID))
	if len(r.fake.seen) != 1 || !strings.HasSuffix(r.fake.seen[0].Session, cy.ID) || !strings.Contains(wordsOf(r.fake.seen[0].Messages), "This round you may act") {
		t.Fatalf("%d requests", len(r.fake.seen))
	}
	// what Cy was sent last round starts this one unchanged, but for the note that moved on
	again := r.fake.seen[0].Messages
	if before := asked[2].Messages; len(again) <= len(before) || wordsOf(again[:len(before)-1]) != wordsOf(before[:len(before)-1]) || again[0].Content[0].Text != before[0].Content[0].Text {
		t.Fatalf("Cy's start changed:\n%s\nthen\n%s", wordsOf(before), wordsOf(again))
	}
	if m := r.world().Chats[c.ID].Messages; m[len(m)-1].By != cy.ID {
		t.Fatalf("%+v", m[len(m)-1])
	}

	// mentioning someone not in it invites them; someone of no company in it cannot be
	dee := hire("Dee")
	if err := r.e.SayInChatTo(c.ID, "@nobody", nil, nil, []string{"nobody"}); err == nil {
		t.Fatal("invited nobody")
	}
	if err := r.e.SayInChatTo(c.ID, "@Dee 你也來", nil, nil, []string{dee.ID}); err != nil {
		t.Fatal(err)
	}
	r.wait("Dee", chatDone(c.ID))
	if g := r.world().Chats[c.ID].Guests; len(g) != 3 || g[2].ReplicaID != dee.ID || g[2].Name != "Dee" {
		t.Fatalf("%+v", g)
	}
	// the chat shows Dee joined after the message that mentions her; those it began with did not join
	joined := r.world().Chats[c.ID]
	said := slices.IndexFunc(joined.Messages, func(m model.ChatMessage) bool { return m.Text == "@Dee 你也來" })
	if len(joined.Joins) != 1 || joined.Joins[0] != (model.ChatJoin{Before: said + 1, ReplicaID: dee.ID, Name: "Dee"}) {
		t.Fatalf("%+v", joined.Joins)
	}

	// another chair sums up from then on
	if err := r.e.SetChatChair(c.ID, bea.ID); err != nil {
		t.Fatal(err)
	}
	got := r.world().Chats[c.ID]
	if got.ReplicaID != bea.ID || got.Name != "Bea" || !slices.ContainsFunc(got.Guests, func(g model.ChatGuest) bool { return g.ReplicaID == r.owner.ID }) {
		t.Fatalf("%+v", got)
	}

	// handed to the chair, it goes on with the chair alone, no one taking over but marked as copied from the meeting
	chair, err := r.e.HandOffChat(c.ID, len(got.Messages)-1, bea.ID)
	if err != nil {
		t.Fatal(err)
	}
	if chair.ReplicaID != bea.ID || len(chair.Guests) != 0 || len(chair.Handoffs) != len(got.Handoffs)+1 || chair.Handoffs[len(got.Handoffs)].ChatID != c.ID {
		t.Fatalf("%+v", chair)
	}
	// handed to one of them, it goes on as their chat alone
	solo, err := r.e.HandOffChat(c.ID, len(got.Messages)-1, cy.ID)
	if err != nil {
		t.Fatal(err)
	}
	if solo.ReplicaID != cy.ID || len(solo.Guests) != 0 {
		t.Fatalf("%+v", solo)
	}
}

func TestMeetingOutlivesItsChair(t *testing.T) {
	r := newRig(t, func(model.ModelRequest) (model.ModelReply, error) { return say("好"), nil })
	bea, err := r.e.Hire(usecase.NewReplica{TeamID: r.team.ID, BlueprintID: r.owner.BlueprintID, Name: "Bea", Model: "fake"})
	if err != nil {
		t.Fatal(err)
	}
	cy, err := r.e.Hire(usecase.NewReplica{TeamID: r.team.ID, BlueprintID: r.owner.BlueprintID, Name: "Cy", Model: "fake"})
	if err != nil {
		t.Fatal(err)
	}
	c, err := r.e.CreateChat(usecase.NewChat{TeamID: r.team.ID, ReplicaID: bea.ID, Text: "@Cy 你先", Mentions: []string{cy.ID}})
	if err != nil {
		t.Fatal(err)
	}
	r.wait("Cy", chatDone(c.ID))
	// the first message's mentions pick who replies, as a later one's do, and those it brings in start the chat
	if got := r.world().Chats[c.ID]; len(got.Messages) != 2 || got.Messages[1].By != cy.ID || len(got.Guests) != 1 || len(got.Joins) != 0 {
		t.Fatalf("%+v", got)
	}
	if err := r.e.Fire(bea.ID, r.owner.ID); err != nil {
		t.Fatal(err)
	}
	got := r.world().Chats[c.ID]
	if got.ReplicaID != cy.ID || len(got.Guests) != 1 || got.Guests[0].ReplicaID != bea.ID || got.Guests[0].Name != "Bea" {
		t.Fatalf("chair %s, guests %+v", got.ReplicaID, got.Guests)
	}
	if err := r.e.SayInChat(c.ID, "還在嗎", nil); err != nil {
		t.Fatal(err)
	}
	r.wait("Cy again", chatDone(c.ID))
}

func TestInviteToChat(t *testing.T) {
	r := newRig(t, func(model.ModelRequest) (model.ModelReply, error) { return say("好"), nil })
	bea, err := r.e.Hire(usecase.NewReplica{TeamID: r.team.ID, BlueprintID: r.owner.BlueprintID, Name: "Bea", Model: "fake"})
	if err != nil {
		t.Fatal(err)
	}
	c, err := r.e.CreateChat(usecase.NewChat{TeamID: r.team.ID, ReplicaID: r.owner.ID, Text: "嗨"})
	if err != nil {
		t.Fatal(err)
	}
	// not while a reply is being written
	if err := r.e.InviteToChat(c.ID, bea.ID); err == nil {
		t.Fatal("invited while replying")
	}
	r.wait("reply", chatDone(c.ID))
	if err := r.e.InviteToChat(c.ID, "nobody"); err == nil {
		t.Fatal("invited nobody")
	}
	if err := r.e.InviteToChat(c.ID, bea.ID); err != nil {
		t.Fatal(err)
	}
	// inviting someone already there changes nothing; the one-to-one chair stays the chair
	if err := r.e.InviteToChat(c.ID, bea.ID); err != nil {
		t.Fatal(err)
	}
	got := r.world().Chats[c.ID]
	if got.ReplicaID != r.owner.ID || len(got.Guests) != 1 || got.Guests[0].ReplicaID != bea.ID {
		t.Fatalf("%+v", got)
	}
	if len(got.Joins) != 1 || got.Joins[0] != (model.ChatJoin{Before: len(got.Messages), ReplicaID: bea.ID, Name: "Bea"}) {
		t.Fatalf("%+v", got.Joins)
	}
	// taking back the chat keeps the line within what is left
	if err := r.e.RewindChat(c.ID, 0); err != nil {
		t.Fatal(err)
	}
	if j := r.world().Chats[c.ID].Joins; j[0].Before != 0 {
		t.Fatalf("%+v", j)
	}
	for i := 2; i < 6; i++ {
		x, err := r.e.Hire(usecase.NewReplica{TeamID: r.team.ID, BlueprintID: r.owner.BlueprintID, Name: "X" + string(rune('0'+i)), Model: "fake"})
		if err != nil {
			t.Fatal(err)
		}
		if err := r.e.InviteToChat(c.ID, x.ID); err != nil {
			t.Fatal(err)
		}
	}
	// six at most
	extra, err := r.e.Hire(usecase.NewReplica{TeamID: r.team.ID, BlueprintID: r.owner.BlueprintID, Name: "Extra", Model: "fake"})
	if err != nil {
		t.Fatal(err)
	}
	if err := r.e.InviteToChat(c.ID, extra.ID); err == nil {
		t.Fatal("seven in a chat")
	}
}

func TestTalkWithSeveralIsAMeeting(t *testing.T) {
	var beaID string
	r := newRig(t, func(req model.ModelRequest) (model.ModelReply, error) {
		if stepOf(req) != "討論" {
			return call("submit_handoff", handoff), nil
		}
		if beaID != "" && strings.HasSuffix(req.Session, beaID) {
			return say("Bea 的意見"), nil
		}
		return say("Ada 的意見"), nil
	})
	bea, err := r.e.Hire(usecase.NewReplica{TeamID: r.team.ID, BlueprintID: r.owner.BlueprintID, Name: "Bea", Model: "fake"})
	if err != nil {
		t.Fatal(err)
	}
	beaID = bea.ID
	wf := *r.flow
	start, end := wf.Nodes[0].ID, wf.Nodes[1].ID
	two := []string{r.owner.ID, bea.ID}
	crowded := slices.Clone(wf.Nodes)
	crowded[0].ReplicaIDs = two
	if err := r.e.SaveWorkflow(wf.ID, model.Workflow{ID: wf.ID, Name: wf.Name, Nodes: crowded, Edges: wf.Edges}); err == nil {
		t.Fatal("a work step with two employees was accepted")
	}
	wf.Nodes = append(wf.Nodes[:1], model.WorkflowNode{ID: "talk", Kind: enum.NodeTalk, Name: "討論", Prompt: usecase.TalkPrompt, ReplicaIDs: two, Handoff: enum.HandoffAll, Join: enum.JoinAll}, wf.Nodes[1])
	wf.Edges = []model.WorkflowEdge{{ID: "1", From: start, To: "talk"}, {ID: "2", From: "talk", To: end}}
	if err := r.e.SaveWorkflow(wf.ID, wf); err != nil {
		t.Fatal(err)
	}
	if _, err := r.e.CreateTask(usecase.NewTask{Legacy: true, TeamID: r.team.ID, Title: "t", WorkflowID: wf.ID, Staff: map[string][]string{start: two}}); err == nil {
		t.Fatal("a task with two employees on a work step was accepted")
	}
	task := r.task(wf.ID)
	w := r.wait("opening", func(w *model.World) bool {
		s := subAt(w, task.ID, "討論")
		return s != nil && s.Review != nil
	})
	s := subAt(w, task.ID, "討論")
	// the chair opens it
	if m := s.Talk.Messages[0]; m.By != r.owner.ID || m.Text != "Ada 的意見" {
		t.Fatalf("opening = %+v", m)
	}
	if err := r.e.SayInTalk(s.ID, "大家怎麼看", []string{"nobody"}); err == nil {
		t.Fatal("a mention of someone not in it was accepted")
	}
	if err := r.e.SayInTalk(s.ID, "大家怎麼看", []string{bea.ID, r.owner.ID}); err != nil {
		t.Fatal(err)
	}
	w = r.wait("round", func(w *model.World) bool {
		x := w.SubTasks[s.ID]
		return len(x.Talk.Messages) == 4 && x.Talk.ReplyAt == nil
	})
	var by []string
	for _, m := range w.SubTasks[s.ID].Talk.Messages[2:] {
		by = append(by, m.By+":"+m.Text)
	}
	if want := []string{bea.ID + ":Bea 的意見", r.owner.ID + ":Ada 的意見"}; !slices.Equal(by, want) {
		t.Fatalf("%v", by)
	}
	var adaSaw string
	for _, req := range r.fake.seen {
		if req.Session == s.ID+"-"+bea.ID && !strings.Contains(wordsOf(req.Messages), "[Meeting] In it: Ada (chair), Bea (you)") {
			t.Fatalf("Bea saw\n%s", wordsOf(req.Messages))
		}
		if req.Session == s.ID+"-"+r.owner.ID {
			adaSaw = wordsOf(req.Messages)
			if !strings.Contains(req.System, "their view, not established fact") {
				t.Fatalf("no rule against taking the others on trust:\n%s", req.System)
			}
		}
	}
	if !strings.Contains(adaSaw, "[Bea] Bea 的意見") {
		t.Fatalf("Ada saw\n%s", adaSaw)
	}
	// with no mention the chair alone replies
	if err := r.e.SayInTalk(s.ID, "好", nil); err != nil {
		t.Fatal(err)
	}
	w = r.wait("chair", func(w *model.World) bool {
		x := w.SubTasks[s.ID]
		return len(x.Talk.Messages) == 6 && x.Talk.ReplyAt == nil
	})
	if m := w.SubTasks[s.ID].Talk.Messages[5]; m.By != r.owner.ID {
		t.Fatalf("reply by %s", m.By)
	}
}

// A server stopping mid-round is not the user stopping it: after the restart the reply cut off says so, to try
// again, and the others still reply.
func TestMeetingGoesOnAfterARestart(t *testing.T) {
	var beaID string
	started, release := make(chan struct{}), make(chan struct{})
	held := false
	r := newRig(t, func(req model.ModelRequest) (model.ModelReply, error) {
		if beaID != "" && strings.HasSuffix(req.Session, "-"+beaID) && !held {
			held = true
			close(started)
			<-release
			return model.ModelReply{}, context.Canceled // as a provider does when the server stops
		}
		name, _, _ := strings.Cut(strings.SplitN(req.System+"you are Ada.", "you are ", 2)[1], ".")
		return say(name + " 的意見"), nil
	})
	hire := func(name string) *model.Replica {
		got, err := r.e.Hire(usecase.NewReplica{TeamID: r.team.ID, BlueprintID: r.owner.BlueprintID, Name: name, Model: "fake"})
		if err != nil {
			t.Fatal(err)
		}
		return got
	}
	bea, cy := hire("Bea"), hire("Cy")
	beaID = bea.ID
	c, err := r.e.CreateChat(usecase.NewChat{TeamID: r.team.ID, ReplicaID: r.owner.ID, Guests: []string{bea.ID, cy.ID}, Text: "@All 大家怎麼看", Mentions: []string{bea.ID, cy.ID, r.owner.ID}})
	if err != nil {
		t.Fatal(err)
	}
	<-started
	closed := make(chan struct{})
	go func() { r.e.Close(); close(closed) }()
	for r.e.ReadChat(c.ID) == nil { // closing refuses changes, then cancels the replies
		time.Sleep(time.Millisecond)
	}
	time.Sleep(20 * time.Millisecond)
	close(release)
	<-closed
	r.store.Close()

	newEngine(t, r)
	w := r.wait("the rest of the round", func(w *model.World) bool {
		c := w.Chats[c.ID]
		return c.ReplyAt == nil && len(c.Messages) == 4
	})
	m := w.Chats[c.ID].Messages
	if m[1].By != bea.ID || m[1].Text != "（伺服器重新啟動，這次回覆中斷了）" || !m[1].Failed {
		t.Fatalf("%+v", m[1])
	}
	if m[2].By != cy.ID || m[2].Text != "Cy 的意見" || m[3].By != r.owner.ID || m[3].Text != "Ada 的意見" {
		t.Fatalf("%+v", m[2:])
	}
}

// A meeting is summed up once anyone in it is near their limit, by the chair's model, for everyone.
func TestMeetingCompactsForWhoeverReadsLeast(t *testing.T) {
	var chat string
	var summedBy []string
	r := newRig(t, func(req model.ModelRequest) (model.ModelReply, error) {
		if strings.Contains(req.System, "Summarize the earlier part") {
			summedBy = append(summedBy, req.Model)
			return say("摘要內容"), nil
		}
		if chat != "" && strings.Contains(wordsOf(req.Messages), "摘要內容") {
			// failing leaves what the summing up counted for the next call
			return model.ModelReply{}, model.Errorf(model.CodeInvalid, "壞了")
		}
		reply := say("好")
		reply.Usage = model.ModelUsage{Input: 150_000, Output: 10} // past 128K's 108,000, short of 1M's 400,000
		return reply, nil
	})
	r.fake.models = []model.ModelSpec{{ID: "big"}}
	if _, err := r.e.AddProvider(context.Background(), usecase.NewProvider{Name: "claude", Kind: enum.ProviderAnthropic, Login: usecase.ProviderLogin{Kind: "apiKey", APIKey: "sk-ant-1234"}}); err != nil {
		t.Fatal(err)
	}
	if err := r.e.UpdateReplica(r.owner.ID, usecase.ReplicaPatch{Model: ptrTo("big")}); err != nil {
		t.Fatal(err)
	}
	bea, err := r.e.Hire(usecase.NewReplica{TeamID: r.team.ID, BlueprintID: r.owner.BlueprintID, Name: "Bea", Model: "fake"})
	if err != nil {
		t.Fatal(err)
	}
	c, err := r.e.CreateChat(usecase.NewChat{TeamID: r.team.ID, ReplicaID: r.owner.ID, Guests: []string{bea.ID}, Text: strings.Repeat("長", 40_000)})
	if err != nil {
		t.Fatal(err)
	}
	r.wait("Ada", chatDone(c.ID))
	r.fake.mu.Lock()
	chat = c.ID
	r.fake.mu.Unlock()
	if err := r.e.SayInChatTo(c.ID, "@Bea 你呢", nil, nil, []string{bea.ID}); err != nil {
		t.Fatal(err)
	}
	r.wait("Bea", chatDone(c.ID))
	got := r.world().Chats[c.ID]
	if got.Compact == nil || !slices.Equal(summedBy, []string{"big"}) {
		t.Fatalf("summed up by %v: %+v", summedBy, got.Compact)
	}
	// counted again from the summary and the words kept, not set to nothing
	if got.Context <= 0 || got.Context >= 108_000 {
		t.Fatalf("context %d", got.Context)
	}
}

// In a meeting each one's round note stays on the words it came with, so their next round starts with their last.
func TestMeetingNoteStaysWhereItWasSent(t *testing.T) {
	t.Parallel()
	r := newRig(t, func(req model.ModelRequest) (model.ModelReply, error) { return say("意見"), nil })
	bea, err := r.e.Hire(usecase.NewReplica{TeamID: r.team.ID, BlueprintID: r.owner.BlueprintID, Name: "Bea", Model: "fake"})
	if err != nil {
		t.Fatal(err)
	}
	c, err := r.e.CreateChat(usecase.NewChat{TeamID: r.team.ID, ReplicaID: r.owner.ID, Guests: []string{bea.ID}, Text: "@All 第一輪", Mentions: []string{bea.ID, r.owner.ID}})
	if err != nil {
		t.Fatal(err)
	}
	r.wait("first round", chatDone(c.ID))
	if err := r.e.SayInChatTo(c.ID, "@All 第二輪", nil, nil, []string{bea.ID, r.owner.ID}); err != nil {
		t.Fatal(err)
	}
	r.wait("second round", func(w *model.World) bool { return w.Chats[c.ID].ReplyAt == nil && len(w.Chats[c.ID].Messages) == 6 })
	for _, who := range []string{bea.ID, r.owner.ID} {
		var asked []model.ModelRequest
		for _, req := range r.fake.seen {
			if req.Session == c.ID+"-"+who {
				asked = append(asked, req)
			}
		}
		if len(asked) != 2 {
			t.Fatalf("%s: %d requests", who, len(asked))
		}
		before := wordsOf(asked[0].Messages) + "assistant:text:意見\n"
		if got := wordsOf(asked[1].Messages); !strings.HasPrefix(got, before) || !strings.Contains(got[len(before):], "[Meeting]") {
			t.Fatalf("%s's second round changed what came before:\n%s\nwas\n%s", who, got, before)
		}
	}
}
