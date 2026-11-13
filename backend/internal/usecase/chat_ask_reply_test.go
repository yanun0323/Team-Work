package usecase_test

import (
	"context"
	"encoding/json"
	"slices"
	"strings"
	"testing"

	"github.com/yanun0323/Team-Work/internal/model"
	"github.com/yanun0323/Team-Work/internal/model/enum"
	"github.com/yanun0323/Team-Work/internal/usecase"
)

func TestChatAskUserReplySurvivesRestartAndHandoff(t *testing.T) {
	t.Parallel()
	r, _, reopen := diskRig(t)
	const reply = "放在左下角合適，不會擋住輸入。我建議點一下複製。要哪一種？"
	r.fake.reply = func(model.ModelRequest) (model.ModelReply, error) {
		return call("ask_user", map[string]any{"reply": " \n" + reply + "\n ", "options": []string{"可複製", "只顯示"}}), nil
	}
	c, err := r.e.CreateChat(usecase.NewChat{TeamID: r.team.ID, ReplicaID: r.owner.ID, Text: "ID 放左下角如何？"})
	if err != nil {
		t.Fatal(err)
	}
	r.wait("question", chatDone(c.ID))
	check := func() {
		t.Helper()
		got := r.world().Chats[c.ID]
		if got.Question == nil || !slices.Equal(got.Question.Options, []string{"可複製", "只顯示"}) || len(got.Messages) != 2 || got.Messages[1].Text != reply || got.Messages[1].From != "agent" || got.Messages[1].By != r.owner.ID {
			t.Fatalf("%+v", got)
		}
	}
	check()
	reopen()
	check()

	bea, err := r.e.Hire(usecase.NewReplica{TeamID: r.team.ID, BlueprintID: r.owner.BlueprintID, Name: "Bea", Model: "fake"})
	if err != nil {
		t.Fatal(err)
	}
	fork, err := r.e.HandOffChat(c.ID, 1, bea.ID)
	if err != nil {
		t.Fatal(err)
	}
	r.fake.reply = func(model.ModelRequest) (model.ModelReply, error) { return say("好"), nil }
	if err := r.e.SayInChat(fork.ID, "可複製", nil); err != nil {
		t.Fatal(err)
	}
	r.wait("answer", chatDone(fork.ID))
	seen := r.fake.requests()
	words := wordsOf(seen[len(seen)-1].Messages)
	if strings.Count(words, reply) != 1 || !strings.Contains(words, "[Ada] "+reply) {
		t.Fatalf("colleague did not see the reply once: %s", words)
	}
}

// Already saved questions have text in an assistant block and no reply argument.
func TestLegacyChatQuestionStillLoadsAndAcceptsAnAnswer(t *testing.T) {
	t.Parallel()
	r, _, reopen := diskRig(t)
	c, err := r.e.CreateChat(usecase.NewChat{TeamID: r.team.ID, ReplicaID: r.owner.ID, Text: "開始"})
	if err != nil {
		t.Fatal(err)
	}
	r.wait("reply", chatDone(c.ID))
	old := r.world().Chats[c.ID]
	old.Messages[1].Text = "用哪個？"
	old.Question = &model.ChatQuestion{Options: []string{"甲", "乙"}}
	conv := []model.Message{
		{Role: enum.RoleUser, Content: say("開始").Content},
		{Role: enum.RoleAssistant, By: r.owner.ID, Content: sayAndCall("用哪個？", "ask_user", map[string]any{"options": []string{"甲", "乙"}}).Content},
	}
	chatJSON, _ := json.Marshal(old)
	convJSON, _ := json.Marshal(conv)
	if err := r.store.Apply(context.Background(), []model.Doc{{Kind: "chat", ID: c.ID, Data: chatJSON}, {Kind: "conv", ID: c.ID, Data: convJSON}}, nil, nil); err != nil {
		t.Fatal(err)
	}
	reopen()
	got := r.world().Chats[c.ID]
	if got.Question == nil || got.Messages[1].Text != "用哪個？" {
		t.Fatalf("%+v", got)
	}
	if err := r.e.SayInChat(c.ID, "乙", nil); err != nil {
		t.Fatal(err)
	}
	r.wait("answer", chatDone(c.ID))
	seen := r.fake.requests()
	msgs := seen[len(seen)-1].Messages
	if len(msgs) != 4 || msgs[2].Content[0].Type != enum.BlockToolResult || msgs[2].Content[0].IsError || !strings.Contains(msgs[2].Content[0].Text, "picked") || r.world().Chats[c.ID].Question != nil {
		t.Fatalf("%+v", msgs)
	}
}
