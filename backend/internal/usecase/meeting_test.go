package usecase_test

import (
	"encoding/json"
	"slices"
	"strings"
	"testing"

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
