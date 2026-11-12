package usecase_test

import (
	"slices"
	"strings"
	"sync"
	"testing"

	"github.com/yanun0323/Team-Work/internal/model"
	"github.com/yanun0323/Team-Work/internal/usecase"
)

func sessionsOf(r *rig, sub, who string) []model.ModelRequest {
	return slices.DeleteFunc(meetingRequests(r), func(req model.ModelRequest) bool { return req.Session != "meeting:"+sub+":"+who })
}

// Task #60: the chair wrote "@介面設計師" in its reply and no one answered; the user had to call on them.
func TestMeetingPassesTheFloorByNameWithoutTheUser(t *testing.T) {
	r, task, people := meetingRig(t, []string{"介面設計師", "Carol"}, func(req model.ModelRequest, people []*model.Replica, owner string) (model.ModelReply, bool) {
		said := sentText(req)
		switch {
		case isChair(req) && strings.Contains(said, "Carol: 同意"):
			return ownerCall("end_meeting", map[string]any{"summary": "用 A"}), true
		case isChair(req):
			return say("@介面設計師 你回答一下，也問 @Carol"), true
		case isMember(req) && strings.HasSuffix(req.Session, people[0].ID):
			return say("我覺得用 A。@Carol 你同意嗎？"), true
		case isMember(req):
			return say("同意"), true
		}
		return model.ModelReply{}, false
	})
	w := r.wait("the meeting concluded", meetingState(task.ID, model.MeetingEnded))
	s := meetingSub(w, task.ID)
	got := speeches(r, task.ID)
	type line struct {
		by       string
		mentions []string
	}
	var lines []line
	for _, a := range got {
		if a.From == "user" {
			t.Fatalf("the user had to speak: %+v", a)
		}
		lines = append(lines, line{a.By, a.Mentions})
	}
	want := []line{{r.owner.ID, []string{people[0].ID, people[1].ID}}, {people[0].ID, []string{people[1].ID}}, {people[1].ID, nil}}
	if len(lines) != len(want) {
		t.Fatalf("%+v", lines)
	}
	for i := range want {
		if lines[i].by != want[i].by || !slices.Equal(lines[i].mentions, want[i].mentions) {
			t.Fatalf("speech %d: %+v, want %+v", i, lines[i], want[i])
		}
	}
	// Carol, called on by both, answers once
	if n := len(sessionsOf(r, s.ID, people[1].ID)); n != 1 {
		t.Fatalf("Carol was asked %d times", n)
	}
	if s.Meeting.Summary != "用 A" {
		t.Fatalf("%+v", s.Meeting)
	}
	// the note tells everyone how to pass the floor, by the names it gives
	for _, req := range meetingRequests(r) {
		if !strings.Contains(req.System, "write @ and a name from the note") || !strings.Contains(lastText(req), "介面設計師") {
			t.Fatalf("%s\n%s", req.System, lastText(req))
		}
	}
}

func TestMeetingWithNoOneCalledOnGoesBackToTheChairWhoIsAskedAgain(t *testing.T) {
	r, task, people := meetingRig(t, []string{"Bob"}, func(req model.ModelRequest, people []*model.Replica, owner string) (model.ModelReply, bool) {
		said := sentText(req)
		switch {
		case isChair(req) && reminded(req):
			return ownerCall("end_meeting", map[string]any{"summary": "談完了"}), true
		case isChair(req) && strings.Contains(said, "Bob: "):
			return say("大家都說完了，@Ada 我自己整理"), true // only themselves: no one
		case isChair(req):
			// task #60: meeting_ask by the name the note gives, not the id it never gave
			return ownerCall("meeting_ask", map[string]any{"replica_ids": []string{"Bob"}, "text": "Bob 你怎麼看"}), true
		case isMember(req):
			return say("@Nobody 隨便，都可以"), true
		}
		return model.ModelReply{}, false
	})
	w := r.wait("the chair ending it after a reminder", meetingState(task.ID, model.MeetingEnded))
	s := meetingSub(w, task.ID)
	var order []string
	for _, a := range speeches(r, task.ID) {
		order = append(order, a.By+":"+a.Text)
	}
	want := []string{r.owner.ID + ":Bob 你怎麼看", people[0].ID + ":@Nobody 隨便，都可以", r.owner.ID + ":大家都說完了，@Ada 我自己整理"}
	if !slices.Equal(order, want) {
		t.Fatalf("%q", order)
	}
	chair := sessionsOf(r, s.ID, r.owner.ID)
	if len(chair) != 3 || !reminded(chair[2]) || reminded(chair[1]) {
		t.Fatalf("the chair was not asked again: %d calls", len(chair))
	}
	if s.Meeting.CallsTotal != 4 || s.Meeting.Summary != "談完了" {
		t.Fatalf("%+v", s.Meeting)
	}
}

func TestMeetingTheUserSteersAndTheTurnsWaitingGiveWay(t *testing.T) {
	entered, release := make(chan struct{}), make(chan struct{})
	var mu sync.Mutex
	bobCalls := 0
	r, task, people := meetingRig(t, []string{"Bob", "Carol"}, func(req model.ModelRequest, people []*model.Replica, owner string) (model.ModelReply, bool) {
		said := sentText(req)
		bob := isMember(req) && strings.HasSuffix(req.Session, people[0].ID)
		n := 0
		if bob {
			mu.Lock()
			bobCalls++
			n = bobCalls
			mu.Unlock()
		}
		switch {
		case isChair(req) && strings.Contains(said, "回到主題"):
			return ownerCall("end_meeting", map[string]any{"summary": "回到主題了"}), true
		case isChair(req):
			return say("@Bob 先說，再來 @Carol"), true
		case bob && n == 1:
			close(entered)
			<-release
			return ownerCall("read_file", map[string]any{"path": "not-here.txt"}), true
		case bob:
			return say("我問 @Carol"), true
		case isMember(req):
			return say("Carol 不該說話"), true
		}
		return model.ModelReply{}, false
	})
	<-entered
	m := meetingSub(r.world(), task.ID)
	if _, err := r.e.SayToOwner(task.ID, usecase.TaskMessage{RequestID: "steer", Text: "離題了，回到主題", MeetingID: m.ID}); err != nil {
		t.Fatal(err)
	}
	close(release)
	w := r.wait("the chair answering the user", meetingState(task.ID, model.MeetingEnded))
	if n := len(sessionsOf(r, m.ID, people[1].ID)); n != 0 {
		t.Fatalf("Carol spoke %d times after the user steered", n)
	}
	var order []string
	for _, a := range speeches(r, task.ID) {
		order = append(order, a.From+":"+a.Text)
		if a.By == people[0].ID && len(a.Mentions) != 0 {
			t.Fatalf("Bob's call from before the user's words still counted: %+v", a)
		}
	}
	if !slices.Equal(order, []string{"agent:@Bob 先說，再來 @Carol", "user:離題了，回到主題", "agent:我問 @Carol"}) {
		t.Fatalf("%q", order)
	}
	// Bob, at his tools, read the user's words right after their results
	bob := sessionsOf(r, m.ID, people[0].ID)
	if len(bob) != 2 || !strings.Contains(sentText(bob[1]), "The user: 離題了，回到主題") {
		t.Fatalf("Bob did not hear the user while at work")
	}
	if s := meetingSub(w, task.ID); s.Meeting.Summary != "回到主題了" {
		t.Fatalf("%+v", s.Meeting)
	}
}

func TestMeetingTheUserCallsInSomeoneWhoJoins(t *testing.T) {
	r, task, people := meetingRig(t, []string{"Bob", "Carol"}, func(req model.ModelRequest, people []*model.Replica, owner string) (model.ModelReply, bool) {
		switch {
		case isOwner(req) && len(req.Messages) == 1 && strings.Contains(req.Messages[0].Content[0].Text, "[task_started]"):
			return ownerCall("hold_meeting", map[string]any{"topic": "選方案", "replica_ids": []string{people[0].ID}}), true
		case isChair(req) && strings.Contains(sentText(req), "Carol: "):
			return ownerCall("end_meeting", map[string]any{"summary": "Carol 也同意"}), true
		case isChair(req) && reminded(req):
			return say(""), true
		case isChair(req):
			return say("開始"), true
		case isMember(req):
			return say("我是 Carol，我同意"), true
		}
		return model.ModelReply{}, false
	})
	carol := people[1]
	w := r.wait("the batch used up", meetingIs(task.ID, func(m *model.Meeting) bool { return m.PauseReason == "limit" }))
	m := meetingSub(w, task.ID)
	dan, err := r.e.Hire(usecase.NewReplica{TeamID: r.team.ID, BlueprintID: r.world().Replicas[r.owner.ID].BlueprintID, Name: "Dan", Model: "fake"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := r.e.SayToOwner(task.ID, usecase.TaskMessage{RequestID: "dan", Text: "@Dan", MeetingID: m.ID, Mentions: []string{dan.ID}}); err == nil {
		t.Fatal("someone not allowed on the task joined")
	}
	// out of budget, the user's words wait like going on would
	settings := r.world().Teams[r.team.ID].Settings
	limit := settings.CostLimitUSD
	settings.CostLimitUSD = 0.000001
	if err := r.e.UpdateTeam(r.team.ID, usecase.TeamPatch{Settings: &settings}); err != nil {
		t.Fatal(err)
	}
	before := len(meetingRequests(r))
	if _, err := r.e.SayToOwner(task.ID, usecase.TaskMessage{RequestID: "carol", Text: "@Carol 你來說", MeetingID: m.ID, Mentions: []string{carol.ID}}); err != nil {
		t.Fatal(err)
	}
	assertMeetingQuiet(t, r, before)
	w = r.world()
	got := meetingSub(w, task.ID).Meeting
	if got.State != model.MeetingPaused || len(got.Participants) != 3 || got.Participants[2].ReplicaID != carol.ID || got.Participants[2].Name != "Carol" {
		t.Fatalf("%+v", got)
	}
	if !hasActivity(r.activity(task.ID), func(a model.TaskActivity) bool { return a.Key == "meetingJoined" && strings.Contains(a.Text, "Carol") }) {
		t.Fatal("no word of Carol joining")
	}
	settings.CostLimitUSD = limit
	if err := r.e.UpdateTeam(r.team.ID, usecase.TeamPatch{Settings: &settings}); err != nil {
		t.Fatal(err)
	}
	if _, err := r.e.ControlMeeting(task.ID, m.ID, usecase.MeetingControl{RequestID: "go", Action: "continue", Revision: got.Revision}); err != nil {
		t.Fatal(err)
	}
	w = r.wait("Carol answering, then the chair ending it", meetingState(task.ID, model.MeetingEnded))
	asked := sessionsOf(r, m.ID, carol.ID)
	if len(asked) != 1 || !strings.Contains(sentText(asked[0]), "Topic: 選方案") || !strings.Contains(sentText(asked[0]), "開始") ||
		!strings.Contains(sentText(asked[0]), "你來說") || !isMember(asked[0]) {
		t.Fatalf("Carol did not get the meeting so far: %d", len(asked))
	}
	if s := meetingSub(w, task.ID); s.Meeting.Summary != "Carol 也同意" || s.Meeting.Batch != 2 {
		t.Fatalf("%+v", s.Meeting)
	}
}
