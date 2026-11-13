package usecase_test

import (
	"encoding/json"
	"fmt"
	"slices"
	"strings"
	"sync"
	"testing"

	"github.com/yanun0323/Team-Work/internal/model"
	"github.com/yanun0323/Team-Work/internal/model/enum"
	"github.com/yanun0323/Team-Work/internal/semantic"
	"github.com/yanun0323/Team-Work/internal/usecase"
)

func isChair(req model.ModelRequest) bool {
	return strings.Contains(req.System, "You chair the meeting")
}
func isMember(req model.ModelRequest) bool {
	return strings.Contains(req.System, "The task's owner chairs")
}

// lastText is the text of the last block sent.
func lastText(req model.ModelRequest) string {
	m := req.Messages[len(req.Messages)-1]
	return m.Content[len(m.Content)-1].Text
}

func sentText(req model.ModelRequest) string {
	var b strings.Builder
	for _, m := range req.Messages {
		for _, c := range m.Content {
			b.WriteString(c.Text + "\n")
		}
	}
	return b.String()
}

// meetingRig is a task with an owner and employees of the names given; when it starts, the owner calls a meeting with
// them. reply answers what it wants to, with who the employees are.
func meetingRig(t *testing.T, names []string, reply func(req model.ModelRequest, people []*model.Replica, owner string) (model.ModelReply, bool)) (*rig, *model.Task, []*model.Replica) {
	t.Helper()
	return failingMeetingRig(t, names, func(req model.ModelRequest, people []*model.Replica, owner string) (model.ModelReply, bool, error) {
		out, ok := reply(req, people, owner)
		return out, ok, nil
	})
}

// failingMeetingRig is meetingRig whose reply may also fail.
func failingMeetingRig(t *testing.T, names []string, reply func(req model.ModelRequest, people []*model.Replica, owner string) (model.ModelReply, bool, error)) (*rig, *model.Task, []*model.Replica) {
	t.Helper()
	return meetingRigWith(t, names, reply, nil, nil)
}

// meetingRigWith is failingMeetingRig with semantic search given to the engine, and before run on the rig before
// the task is made.
func meetingRigWith(t *testing.T, names []string, reply func(req model.ModelRequest, people []*model.Replica, owner string) (model.ModelReply, bool, error),
	sem *semantic.Service, before func(r *rig)) (*rig, *model.Task, []*model.Replica) {
	t.Helper()
	var people []*model.Replica
	var mu sync.Mutex
	var r *rig
	r = newRigWith(t, func(req model.ModelRequest) (model.ModelReply, error) {
		mu.Lock()
		them := slices.Clone(people)
		mu.Unlock()
		if out, ok, err := reply(req, them, r.owner.ID); ok {
			return out, err
		}
		if isOwner(req) && len(req.Messages) == 1 && strings.Contains(req.Messages[0].Content[0].Text, "[task_started]") {
			ids := []string{}
			for _, p := range them {
				ids = append(ids, p.ID)
			}
			return ownerCall("hold_meeting", map[string]any{"topic": "選方案", "background": "要在 A 和 B 之間選一個", "replica_ids": ids}), nil
		}
		return say("ok"), nil
	}, sem)
	if before != nil {
		before(r)
	}
	ids := []string{}
	for _, name := range names {
		p, err := r.e.Hire(usecase.NewReplica{TeamID: r.team.ID, BlueprintID: r.world().Replicas[r.owner.ID].BlueprintID, Name: name, Model: "fake"})
		if err != nil {
			t.Fatal(err)
		}
		mu.Lock()
		people = append(people, p)
		mu.Unlock()
		ids = append(ids, p.ID)
	}
	staff := map[string][]string{} // the flow's two steps take one each, so the user allowed them on the task
	for i, id := range ids {
		staff[[]string{"end", "start"}[i]] = []string{id}
	}
	task, err := r.e.CreateTask(usecase.NewTask{TeamID: r.team.ID, Title: "t", Description: "任務內容只有負責人知道", WorkflowID: r.flow.ID, OwnerID: &r.owner.ID, Staff: staff})
	if err != nil {
		t.Fatal(err)
	}
	if err := r.e.ResumeTask(task.ID); err != nil {
		t.Fatal(err)
	}
	return r, task, people
}

func meetingSub(w *model.World, taskID string) *model.SubTask {
	for _, s := range w.SubTasks {
		if s.TaskID == taskID && s.Meeting != nil {
			return s
		}
	}
	return nil
}

func meetingIs(taskID string, ok func(m *model.Meeting) bool) func(*model.World) bool {
	return func(w *model.World) bool {
		s := meetingSub(w, taskID)
		return s != nil && ok(s.Meeting)
	}
}

func meetingState(taskID, state string) func(*model.World) bool {
	return meetingIs(taskID, func(m *model.Meeting) bool { return m.State == state })
}

func speeches(r *rig, taskID string) []model.TaskActivity {
	var out []model.TaskActivity
	for _, a := range r.activity(taskID) {
		if a.Kind == "meeting" && a.MeetingPart == "speech" {
			out = append(out, a)
		}
	}
	return out
}

func meetingRequests(r *rig) []model.ModelRequest {
	return slices.DeleteFunc(r.fake.requests(), func(req model.ModelRequest) bool { return !isChair(req) && !isMember(req) })
}

func TestMeetingIsHeldInTheConversationAndOnlyItsConclusionGoesBack(t *testing.T) {
	t.Parallel()
	r, task, people := meetingRig(t, []string{"Bob"}, func(req model.ModelRequest, people []*model.Replica, owner string) (model.ModelReply, bool) {
		switch {
		case isChair(req) && !strings.Contains(sentText(req), "Bob: "):
			return ownerCall("meeting_ask", map[string]any{"replica_ids": []string{people[0].ID}, "text": "Bob 你怎麼看"}), true
		case isChair(req):
			return ownerCall("end_meeting", map[string]any{"summary": "結論：用 A"}), true
		case isMember(req):
			return say("我覺得用 A 比較好"), true
		case isOwner(req) && strings.Contains(sentText(req), "[meeting_ended]"):
			return say("收到結論"), true
		}
		return model.ModelReply{}, false
	})
	bob := people[0]
	r.wait("the owner's word on the conclusion", func(*model.World) bool {
		return hasActivity(r.activity(task.ID), func(a model.TaskActivity) bool { return a.Text == "收到結論" })
	})
	w := r.world()
	s := meetingSub(w, task.ID)
	if s.Meeting.State != model.MeetingEnded || s.Meeting.Summary != "結論：用 A" || w.Tasks[task.ID].Coordination.ActiveMeetingID != "" {
		t.Fatalf("%+v", s.Meeting)
	}
	if len(s.Meeting.Participants) != 2 || s.Meeting.Participants[0].ReplicaID != r.owner.ID || s.Meeting.ChairID != r.owner.ID {
		t.Fatalf("%+v", s.Meeting.Participants)
	}
	if len(w.Chats) != 0 {
		t.Fatal("the meeting opened a chat of its own")
	}
	var said []string
	for _, a := range r.activity(task.ID) {
		if a.Kind == "meeting" {
			if a.MeetingVersion != 2 || a.MeetingID != s.ID {
				t.Fatalf("%+v", a)
			}
			said = append(said, a.By+"/"+a.MeetingPart+"/"+a.Text)
		}
	}
	want := []string{r.owner.ID + "/speech/Bob 你怎麼看", bob.ID + "/speech/我覺得用 A 比較好", r.owner.ID + "/summary/結論：用 A"}
	if !slices.Equal(said, want) {
		t.Fatalf("%q", said)
	}
	for _, req := range r.fake.requests() {
		switch {
		case isOwner(req):
			if strings.Contains(sentText(req), "我覺得用 A 比較好") || strings.Contains(sentText(req), "Bob 你怎麼看") {
				t.Fatal("the owner's own conversation got the meeting's words")
			}
		case isMember(req):
			for _, name := range toolNames(req) {
				if !slices.Contains([]string{"read_file", "web_search"}, name) {
					t.Fatalf("a participant could use %s", name)
				}
			}
			if strings.Contains(sentText(req), "任務內容只有負責人知道") || !strings.Contains(sentText(req), "Topic: 選方案") ||
				!strings.Contains(sentText(req), "要在 A 和 B 之間選一個") {
				t.Fatal(sentText(req))
			}
		case isChair(req):
			names := toolNames(req)
			if !slices.Contains(names, "meeting_ask") || !slices.Contains(names, "end_meeting") || slices.Contains(names, "dispatch_step") || slices.Contains(names, "remember") {
				t.Fatalf("%v", names)
			}
		}
	}
	woke := false
	for _, req := range ownerRequests(r) {
		woke = woke || strings.Contains(sentText(req), "結論：用 A")
	}
	if !woke {
		t.Fatal("the owner was not told the conclusion")
	}
}

// sent is a request as it went out, each message encoded on its own.
type sent struct {
	fixed    string
	messages []string
}

func TestMeetingSendsEachSpeakerWhatTheyWereSentBeforeAndTheNoteLast(t *testing.T) {
	t.Parallel()
	var mu sync.Mutex
	bySession := map[string][]sent{}
	r, task, people := meetingRig(t, []string{"Bob", "Carol"}, func(req model.ModelRequest, people []*model.Replica, owner string) (model.ModelReply, bool) {
		if !isChair(req) && !isMember(req) {
			return model.ModelReply{}, false
		}
		fixed, _ := json.Marshal([]any{req.System, req.Tools, req.Model, req.Effort, req.Cwd})
		var msgs []string
		for _, m := range req.Messages {
			raw, _ := json.Marshal(m)
			msgs = append(msgs, string(raw))
		}
		mu.Lock()
		bySession[req.Session] = append(bySession[req.Session], sent{string(fixed), msgs})
		n := len(bySession[req.Session])
		mu.Unlock()
		reply := say(fmt.Sprintf("%s 第 %d 次", req.Session, n))
		switch {
		case isChair(req) && n == 4:
			reply = ownerCall("end_meeting", map[string]any{"summary": "說完了"})
		case isChair(req):
			// each round passes the floor on by name: Bob, then Carol, then back to the chair
			reply = say(fmt.Sprintf("%s 第 %d 次，@Bob 和 @Carol 說說", req.Session, n))
		case strings.HasSuffix(req.Session, ":"+people[0].ID) && n == 2: // Bob's second round includes a tool call
			reply = ownerCall("read_file", map[string]any{"path": "nothing-here.txt"})
		}
		reply.Content = append([]model.Block{{Type: enum.BlockReasoning, Raw: json.RawMessage(fmt.Sprintf(`{"n":%d}`, n)), Origin: "fake"}}, reply.Content...)
		return reply, true
	})
	r.wait("the chair's opening", func(*model.World) bool { return len(speeches(r, task.ID)) >= 1 })
	r.e.Remember(people[0].ID, "一則新的記憶")
	w := r.wait("three rounds", meetingState(task.ID, model.MeetingEnded))
	m := meetingSub(w, task.ID)
	all := []string{r.owner.ID, people[0].ID, people[1].ID}
	got := speeches(r, task.ID)
	if len(got) != 9 {
		t.Fatalf("%+v", got)
	}
	for i, a := range got {
		if a.By != all[i%3] {
			t.Fatalf("speech %d: got %s, want %s", i, a.By, all[i%3])
		}
		if i%3 == 0 && !slices.Equal(a.Mentions, all[1:]) {
			t.Fatalf("the chair's call was not recorded: %+v", a)
		}
	}
	mu.Lock()
	defer mu.Unlock()
	if len(bySession) != 3 {
		t.Fatalf("sessions: %v", len(bySession))
	}
	// Chair: opening + 3 rounds. Bob: 3 rounds + one tool continuation. Carol: 3 rounds.
	wantCalls := map[string]int{r.owner.ID: 4, people[0].ID: 4, people[1].ID: 3}
	for id, want := range wantCalls {
		session := "meeting:" + m.ID + ":" + id
		reqs := bySession[session]
		if len(reqs) != want {
			t.Fatalf("%s: %d requests, want %d", session, len(reqs), want)
		}
		for i := 1; i < len(reqs); i++ {
			before, now := reqs[i-1], reqs[i]
			if before.fixed != now.fixed {
				t.Fatalf("%s: what is fixed changed between calls %d and %d", session, i, i+1)
			}
			if len(now.messages) <= len(before.messages) || !slices.Equal(before.messages, now.messages[:len(before.messages)]) {
				t.Fatalf("%s: call %d does not start with all of call %d:\n%q\n%q", session, i+1, i, before.messages, now.messages)
			}
		}
	}
	toolResults, reasoning := 0, 0
	for _, req := range meetingRequests(r) {
		for _, msg := range req.Messages {
			for _, block := range msg.Content {
				if block.Type == enum.BlockToolResult {
					toolResults++
				}
				if block.Type == enum.BlockReasoning && block.Origin == "fake" && len(block.Raw) > 0 {
					reasoning++
				}
			}
		}
		if last := lastText(req); last != "" && !strings.HasPrefix(last, "[Meeting note]") && req.Messages[len(req.Messages)-1].Content[0].Type != enum.BlockToolResult {
			t.Fatalf("the note is not last: %q", last)
		}
	}
	if toolResults == 0 || reasoning == 0 {
		t.Fatal("tool/reasoning preservation was not exercised")
	}
	for _, a := range r.activity(task.ID) {
		if strings.Contains(a.Text, "[Meeting note]") {
			t.Fatalf("a note went into the conversation: %+v", a)
		}
	}
}

func TestMeetingStopsAtItsBatchAndGoesOnOnlyWhenTheUserSays(t *testing.T) {
	t.Parallel()
	r, task, _ := meetingRig(t, []string{"Bob"}, func(req model.ModelRequest, people []*model.Replica, owner string) (model.ModelReply, bool) {
		switch {
		case isChair(req) && strings.Contains(lastText(req), "write its conclusion"):
			return say("最後結論"), true
		case isChair(req):
			return ownerCall("meeting_ask", map[string]any{"replica_ids": []string{people[0].ID}, "text": "再說一次"}), true
		case isMember(req):
			return say("好"), true
		}
		return model.ModelReply{}, false
	})
	w := r.wait("the batch used up", meetingIs(task.ID, func(m *model.Meeting) bool { return m.State == model.MeetingPaused && m.PauseReason == "limit" }))
	m := meetingSub(w, task.ID).Meeting
	if m.CallsInBatch != 36 || m.CallsTotal != 36 || len(meetingRequests(r)) != 36 {
		t.Fatalf("%+v, %d calls", m, len(meetingRequests(r)))
	}
	if _, err := r.e.ControlMeeting(task.ID, m.ID, usecase.MeetingControl{RequestID: "c1", Action: "continue", Revision: m.Revision - 1}); err == nil {
		t.Fatal("an old screen let the meeting go on")
	}
	op, err := r.e.ControlMeeting(task.ID, m.ID, usecase.MeetingControl{RequestID: "c2", Action: "continue", Revision: m.Revision})
	if err != nil || op.Kind != "meetingContinue" || op.Status != model.OpApplied {
		t.Fatal(op, err)
	}
	if again, err := r.e.ControlMeeting(task.ID, m.ID, usecase.MeetingControl{RequestID: "c2", Action: "continue", Revision: m.Revision}); err != nil || again.ID != op.ID {
		t.Fatal(again, err)
	}
	w = r.wait("the second batch used up", meetingIs(task.ID, func(m *model.Meeting) bool { return m.Batch == 2 && m.State == model.MeetingPaused }))
	m = meetingSub(w, task.ID).Meeting
	if m.CallsTotal != 72 {
		t.Fatalf("%+v", m)
	}
	end, err := r.e.ControlMeeting(task.ID, m.ID, usecase.MeetingControl{RequestID: "e1", Action: "end", Revision: m.Revision})
	if err != nil || end.Kind != "meetingEnd" {
		t.Fatal(end, err)
	}
	w = r.wait("the conclusion", meetingState(task.ID, model.MeetingEnded))
	m = meetingSub(w, task.ID).Meeting
	if m.Summary != "最後結論" || m.CallsTotal != 73 || len(meetingRequests(r)) != 73 {
		t.Fatalf("%+v", m)
	}
	if op, err := r.e.TaskOperation(task.ID, end.ID); err != nil || op.Status != model.OpApplied {
		t.Fatal(op, err)
	}
	keys := []string{}
	for _, a := range r.activity(task.ID) {
		keys = append(keys, a.Key)
	}
	if !slices.Contains(keys, "meetingLimitReached") || !slices.Contains(keys, "meetingContinued") || !slices.Contains(keys, "meetingEnded") {
		t.Fatalf("%v", keys)
	}
}

func TestMeetingTakesTheUsersWordsAndRefusesWhatDoesNotBelong(t *testing.T) {
	t.Parallel()
	var mu sync.Mutex
	var results []string
	r, task, people := meetingRig(t, []string{"Bob"}, func(req model.ModelRequest, people []*model.Replica, owner string) (model.ModelReply, bool) {
		switch {
		case isChair(req) && reminded(req):
			return say(""), true
		case isChair(req):
			return say("主持人回答"), true
		case isMember(req):
			return say("Bob 回答"), true
		case isOwner(req) && len(req.Messages) == 1 && strings.Contains(req.Messages[0].Content[0].Text, "[task_started]"):
			return ownerCall("hold_meeting", map[string]any{"topic": "空的", "replica_ids": []string{}}), true
		case isOwner(req) && req.Messages[len(req.Messages)-1].Content[0].Type == enum.BlockToolResult:
			last := req.Messages[len(req.Messages)-1].Content[0]
			mu.Lock()
			results = append(results, fmt.Sprint(last.IsError, " ", last.Text))
			n := len(results)
			mu.Unlock()
			switch n {
			case 1:
				return ownerCall("hold_meeting", map[string]any{"topic": "選方案", "replica_ids": []string{people[0].ID, owner}}), true
			case 2:
				return ownerCall("hold_meeting", map[string]any{"topic": "再一場", "replica_ids": []string{people[0].ID}}), true
			}
			return say("ok"), true
		}
		return model.ModelReply{}, false
	})
	r.wait("the opening", func(*model.World) bool { return len(speeches(r, task.ID)) == 1 })
	r.wait("the owner done", func(*model.World) bool {
		mu.Lock()
		defer mu.Unlock()
		return len(results) == 3
	})
	if !strings.HasPrefix(results[0], "true") || !strings.HasPrefix(results[1], "false") || !strings.HasPrefix(results[2], "true") {
		t.Fatalf("%q", results)
	}
	m := meetingSub(r.world(), task.ID)
	if _, err := r.e.SayToOwner(task.ID, usecase.TaskMessage{RequestID: "x1", Text: "給負責人"}); err == nil {
		t.Fatal("words for the owner went past the meeting")
	}
	if _, err := r.e.SayToOwner(task.ID, usecase.TaskMessage{RequestID: "x2", Text: "hi", MeetingID: m.ID, Mentions: []string{"rep-999"}}); err == nil {
		t.Fatal("someone not in the meeting was asked")
	}
	if _, err := r.e.SayToOwner(task.ID, usecase.TaskMessage{RequestID: "x3", Text: "hi", MeetingID: "sub-999"}); err == nil {
		t.Fatal("words went to a meeting not under way")
	}
	if _, err := r.e.SayToOwner(task.ID, usecase.TaskMessage{RequestID: "x4", Text: "大家好", MeetingID: m.ID}); err != nil {
		t.Fatal(err)
	}
	r.wait("the chair answering", func(*model.World) bool { return len(speeches(r, task.ID)) == 3 })
	again, err := r.e.SayToOwner(task.ID, usecase.TaskMessage{RequestID: "x4", Text: "大家好", MeetingID: m.ID})
	if err != nil || again.Activity.Text != "大家好" {
		t.Fatal(again, err)
	}
	if _, err := r.e.SayToOwner(task.ID, usecase.TaskMessage{RequestID: "x5", Text: "Bob 呢", MeetingID: m.ID, Mentions: []string{people[0].ID}}); err != nil {
		t.Fatal(err)
	}
	// Bob hands back to the chair, as he calls on no one
	r.wait("Bob answering", func(*model.World) bool { return len(speeches(r, task.ID)) == 6 })
	got := speeches(r, task.ID)
	order := []string{}
	for _, a := range got {
		order = append(order, a.Text)
	}
	if !slices.Equal(order, []string{"主持人回答", "大家好", "主持人回答", "Bob 呢", "Bob 回答", "主持人回答"}) {
		t.Fatalf("%q", order)
	}
	page, err := r.e.MeetingActivity(task.ID, m.ID, 0, 2, "")
	if err != nil || page.Total != 6 || len(page.Items) != 2 || !page.HasMore || page.Items[0].Text != "Bob 回答" {
		t.Fatal(page, err)
	}
	older, err := r.e.MeetingActivity(task.ID, m.ID, page.Items[0].Seq, 10, page.Version)
	if err != nil || len(older.Items) != 4 || older.HasMore {
		t.Fatal(older, err)
	}
	if _, err := r.e.MeetingActivity(task.ID, m.ID, 0, 10, "1"); err == nil {
		t.Fatal("a stale page was read")
	}
}

func TestPausingTheTaskPausesItsMeeting(t *testing.T) {
	t.Parallel()
	r, task, _, _ := idleMeeting(t)
	if _, err := r.e.ControlTask(task.ID, usecase.TaskControl{RequestID: "p", Action: "pause"}); err != nil {
		t.Fatal(err)
	}
	w := r.wait("the meeting paused", meetingIs(task.ID, func(m *model.Meeting) bool { return m.PauseReason == "taskPaused" }))
	m := meetingSub(w, task.ID).Meeting
	if _, err := r.e.ControlMeeting(task.ID, m.ID, usecase.MeetingControl{RequestID: "c", Action: "continue", Revision: m.Revision}); err == nil {
		t.Fatal("the meeting went on in a paused task")
	}
	if _, err := r.e.SayToOwner(task.ID, usecase.TaskMessage{RequestID: "q", Text: "排隊", MeetingID: m.ID}); err != nil {
		t.Fatal(err)
	}
	task = r.world().Tasks[task.ID]
	if _, err := r.e.ControlTask(task.ID, usecase.TaskControl{RequestID: "r", Action: "resume", PlanVersion: &task.Coordination.PlanVersion, ControlVersion: &task.Coordination.ControlVersion}); err != nil {
		t.Fatal(err)
	}
	m = meetingSub(r.world(), task.ID).Meeting
	if m.State != model.MeetingPaused || len(speeches(r, task.ID)) != 2 {
		t.Fatalf("%+v", m)
	}
	if _, err := r.e.ControlMeeting(task.ID, m.ID, usecase.MeetingControl{RequestID: "c2", Action: "continue", Revision: m.Revision}); err != nil {
		t.Fatal(err)
	}
	r.wait("the chair answering what waited", func(*model.World) bool { return len(speeches(r, task.ID)) == 3 })
}

func TestAFlowsTalkStepIsAMeetingTheOwnerChairs(t *testing.T) {
	t.Parallel()
	var mu sync.Mutex
	steps := 0
	r, task, _ := meetingRig(t, []string{"Bob"}, func(req model.ModelRequest, people []*model.Replica, owner string) (model.ModelReply, bool) {
		switch {
		case isChair(req) && !strings.Contains(sentText(req), "Bob: "):
			return ownerCall("meeting_ask", map[string]any{"replica_ids": []string{people[0].ID}, "text": "請說"}), true
		case isChair(req):
			return ownerCall("end_meeting", map[string]any{"summary": "討論完了"}), true
		case isMember(req):
			return say("我說完了"), true
		case !isOwner(req):
			return model.ModelReply{}, false
		}
		mu.Lock()
		defer mu.Unlock()
		steps++
		switch steps {
		case 1:
			return ownerCall("revise_plan", map[string]any{"reason": "要先討論", "edges": []map[string]any{{"from": "start", "to": "end"}},
				"nodes": []map[string]any{{"id": "start", "name": "整理需求"}, {"id": "end", "name": "驗收"},
					{"id": "talk", "kind": "talk", "name": "討論", "replica_ids": []string{owner, people[0].ID}}}}), true
		case 2:
			return ownerCall("dispatch_step", map[string]any{"node_id": "talk", "instructions": "只要知道這一句"}), true
		}
		return say("ok"), true
	})
	w := r.wait("the meeting's conclusion", meetingState(task.ID, model.MeetingEnded))
	s := meetingSub(w, task.ID)
	if s.NodeID != "talk" || s.Meeting.Topic != "討論" || s.Meeting.ChairID != r.owner.ID || len(s.Meeting.Participants) != 2 || s.Talk != nil {
		t.Fatalf("%+v %+v", s, s.Meeting)
	}
	for _, req := range meetingRequests(r) {
		if isMember(req) && !strings.Contains(sentText(req), "只要知道這一句") {
			t.Fatal(sentText(req))
		}
	}
}
