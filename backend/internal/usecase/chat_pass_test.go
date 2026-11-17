package usecase_test

import (
	"slices"
	"strings"
	"sync"
	"testing"

	"github.com/yanun0323/Team-Work/internal/model"
	"github.com/yanun0323/Team-Work/internal/usecase"
)

func TestMeetingPassesBackForUnfinishedWork(t *testing.T) {
	t.Parallel()
	var ada, bea string
	n := 0
	r := newRig(t, func(req model.ModelRequest) (model.ModelReply, error) {
		n++
		switch n {
		case 1:
			return say("等 @Ada 確認"), nil
		case 2, 3, 4, 5:
			target := bea
			if n%2 == 1 {
				target = ada
			}
			return call("pass_to_colleague", map[string]string{"replica_id": target, "message": "請核對選項"}), nil
		}
		return say("選項已核對，謝謝 @Ada"), nil
	})
	b, err := r.e.Hire(usecase.NewReplica{TeamID: r.team.ID, BlueprintID: r.owner.BlueprintID, Name: "Bea", Model: "fake"})
	if err != nil {
		t.Fatal(err)
	}
	ada, bea = r.owner.ID, b.ID
	c, err := r.e.CreateChat(usecase.NewChat{TeamID: r.team.ID, ReplicaID: ada, Text: "請合作", Mentions: []string{bea, ada}})
	if err != nil {
		t.Fatal(err)
	}
	r.wait("relay", chatDone(c.ID))
	var by []string
	for _, m := range r.world().Chats[c.ID].Messages {
		if m.From == "agent" {
			by = append(by, m.By)
		}
	}
	if !slices.Equal(by, []string{bea, ada, bea, ada, bea, ada}) {
		t.Fatalf("speakers: %v", by)
	}
	req := r.fake.requests()[2]
	if !strings.Contains(wordsOf(req.Messages), "[Ada] @Bea 請核對選項") || !strings.Contains(wordsOf(req.Messages), "This round Ada may act outside the chat") {
		t.Fatal(wordsOf(req.Messages))
	}
}

func TestMeetingRefusesPassOutOfTurnOrOutsideChat(t *testing.T) {
	t.Parallel()
	var ada, stranger string
	n := 0
	r := newRig(t, func(req model.ModelRequest) (model.ModelReply, error) {
		n++
		switch n {
		case 1, 3:
			return call("pass_to_colleague", map[string]string{"replica_id": ada, "message": "請接手"}), nil
		case 4:
			return call("pass_to_colleague", map[string]string{"replica_id": stranger, "message": "請接手"}), nil
		}
		return say("完成"), nil
	})
	hire := func(name string) string {
		b, err := r.e.Hire(usecase.NewReplica{TeamID: r.team.ID, BlueprintID: r.owner.BlueprintID, Name: name, Model: "fake"})
		if err != nil {
			t.Fatal(err)
		}
		return b.ID
	}
	ada, stranger = r.owner.ID, hire("Cy")
	bea := hire("Bea")
	c, err := r.e.CreateChat(usecase.NewChat{TeamID: r.team.ID, ReplicaID: ada, Text: "依序回答", Mentions: []string{bea, ada}})
	if err != nil {
		t.Fatal(err)
	}
	r.wait("finished", chatDone(c.ID))
	seen := r.fake.requests()
	if len(seen) != 5 || !strings.Contains(wordsOf(seen[1].Messages), "remaining speakers") || !strings.Contains(wordsOf(seen[3].Messages), "one other current participant") || !strings.Contains(wordsOf(seen[4].Messages), "one other current participant") {
		t.Fatalf("unexpected calls: %+v", seen)
	}
	got := r.world().Chats[c.ID]
	if len(got.Guests) != 1 || len(got.Messages) != 3 || got.Messages[1].By != bea || got.Messages[2].By != ada {
		t.Fatal(got.Messages)
	}
}

func TestMeetingUserPreemptsPass(t *testing.T) {
	for _, action := range []string{"queue", "steer", "stop"} {
		t.Run(action, func(t *testing.T) {
			t.Parallel()
			release := make(chan struct{})
			unblock := sync.OnceFunc(func() { close(release) })
			defer unblock()
			var bea string
			n := 0
			r := newRig(t, func(req model.ModelRequest) (model.ModelReply, error) {
				n++
				if n == 1 {
					<-release
					if action == "steer" {
						return call("no_such_tool", map[string]string{}), nil
					}
				}
				if n == 1 || action == "steer" && n == 2 {
					return call("pass_to_colleague", map[string]string{"replica_id": bea, "message": "請接手"}), nil
				}
				return say("照新指示"), nil
			})
			b, err := r.e.Hire(usecase.NewReplica{TeamID: r.team.ID, BlueprintID: r.owner.BlueprintID, Name: "Bea", Model: "fake"})
			if err != nil {
				t.Fatal(err)
			}
			bea = b.ID
			c, err := r.e.CreateChat(usecase.NewChat{TeamID: r.team.ID, ReplicaID: r.owner.ID, Guests: []string{bea}, Text: "先回答"})
			if err != nil {
				t.Fatal(err)
			}
			if action == "stop" {
				err = r.e.StopChat(c.ID)
			} else {
				err = r.e.SayInChat(c.ID, "先別交接", nil)
				if err == nil && action == "steer" {
					err = r.e.SteerChat(c.ID, r.world().Chats[c.ID].Queue[0].ID)
				}
			}
			if err != nil {
				t.Fatal(err)
			}
			unblock()
			r.wait("finished", chatDone(c.ID))
			got := r.world().Chats[c.ID]
			for _, m := range got.Messages {
				if m.By == bea || strings.Contains(m.Text, "請接手") {
					t.Fatal(got.Messages)
				}
			}
			last := got.Messages[len(got.Messages)-1]
			if action == "stop" && !last.Failed || action != "stop" && last.Text != "照新指示" {
				t.Fatal(got.Messages)
			}
		})
	}
}
