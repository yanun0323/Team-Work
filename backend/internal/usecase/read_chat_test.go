package usecase_test

import (
	"strings"
	"testing"

	"github.com/yanun0323/Team-Work/internal/model"
	"github.com/yanun0323/Team-Work/internal/usecase"
)

// pastChat is a finished chat in the rig's company: the user's message and the reply 好.
func pastChat(t *testing.T, r *rig, text string) *model.Chat {
	t.Helper()
	c, err := r.e.CreateChat(usecase.NewChat{TeamID: r.team.ID, ReplicaID: r.owner.ID, Text: text})
	if err != nil {
		t.Fatal(err)
	}
	r.wait("reply", chatDone(c.ID))
	return c
}

func TestReadChatShowsAnotherChatByID(t *testing.T) {
	t.Parallel()
	r, m := manageRig(t)
	past := pastChat(t, r, "記得把藍色按鈕改成綠色")
	inChat(t, r, m, doing("read_chat", map[string]any{"id": past.ID}))
	res := lastResult(t, r)
	if res.IsError {
		t.Fatalf("%+v", res)
	}
	for _, want := range []string{past.ID, "Messages 1-2 of 2", "user: 記得把藍色按鈕改成綠色", r.owner.Name + ": 好"} {
		if !strings.Contains(res.Text, want) {
			t.Errorf("no %q in %s", want, res.Text)
		}
	}
	if strings.Contains(res.Text, "continue with offset") {
		t.Errorf("all of it fits: %s", res.Text)
	}
}

func TestReadChatPages(t *testing.T) {
	t.Parallel()
	r, m := manageRig(t)
	past := pastChat(t, r, "第一句")
	inChat(t, r, m, doing("read_chat", map[string]any{"id": past.ID, "limit": 1}))
	res := lastResult(t, r)
	if !strings.Contains(res.Text, "Messages 1-1 of 2") || !strings.Contains(res.Text, "第一句") ||
		strings.Contains(res.Text, ": 好") || !strings.Contains(res.Text, "continue with offset 2") {
		t.Fatalf("%+v", res)
	}
	inChat(t, r, m, doing("read_chat", map[string]any{"id": past.ID, "offset": 2}))
	res = lastResult(t, r)
	if !strings.Contains(res.Text, "Messages 2-2 of 2") || strings.Contains(res.Text, "第一句") || !strings.Contains(res.Text, "[2] ") {
		t.Fatalf("%+v", res)
	}
	inChat(t, r, m, doing("read_chat", map[string]any{"id": past.ID, "offset": 9}))
	if res := lastResult(t, r); res.IsError || !strings.Contains(res.Text, "past the end") {
		t.Fatalf("%+v", res)
	}
}

func TestReadChatReadsEveryCompanyAndTheAirport(t *testing.T) {
	t.Parallel()
	r, m := manageRig(t)
	other, err := r.e.CreateTeam(t.Context(), usecase.NewTeam{Name: "別家", Folder: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	stranger, err := r.e.Hire(usecase.NewReplica{TeamID: other.ID, BlueprintID: r.owner.BlueprintID, Name: "Zed", Model: "fake"})
	if err != nil {
		t.Fatal(err)
	}
	theirs, err := r.e.CreateChat(usecase.NewChat{TeamID: other.ID, ReplicaID: stranger.ID, Text: "別家的祕密"})
	if err != nil {
		t.Fatal(err)
	}
	r.wait("theirs", chatDone(theirs.ID))

	// a company's employee reads another company's chat
	inChat(t, r, m, doing("read_chat", map[string]any{"id": theirs.ID}))
	if res := lastResult(t, r); res.IsError || !strings.Contains(res.Text, "別家的祕密") || !strings.Contains(res.Text, "Zed") {
		t.Fatalf("%+v", res)
	}
	for _, args := range []map[string]any{{"id": "chat-999999"}, {"id": " "}} {
		inChat(t, r, m, doing("read_chat", args))
		if res := lastResult(t, r); !res.IsError {
			t.Fatalf("%v: %+v", args, res)
		}
	}

	// the airport's staff read every company's chats
	m.add(doing("read_chat", map[string]any{"id": "#" + theirs.ID}))
	a, err := r.e.CreateAirportChat(usecase.NewAirportChat{Model: "fake", Text: "看"})
	if err != nil {
		t.Fatal(err)
	}
	r.wait("airport", chatDone(a.ID))
	if res := lastResult(t, r); res.IsError || !strings.Contains(res.Text, "別家的祕密") || !strings.Contains(res.Text, "Zed") {
		t.Fatalf("%+v", res)
	}

	// and a company's employee reads the airport's
	inChat(t, r, m, doing("read_chat", map[string]any{"id": a.ID}))
	if res := lastResult(t, r); res.IsError || !strings.Contains(res.Text, "at the airport") || !strings.Contains(res.Text, "看") {
		t.Fatalf("%+v", res)
	}
}
