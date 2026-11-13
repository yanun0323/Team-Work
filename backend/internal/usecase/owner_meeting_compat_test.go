package usecase_test

import (
	"context"
	"encoding/json"
	"fmt"
	"reflect"
	"slices"
	"strings"
	"testing"

	"github.com/yanun0323/Team-Work/internal/model"
	"github.com/yanun0323/Team-Work/internal/model/enum"
	"github.com/yanun0323/Team-Work/internal/usecase"
)

func TestMeetingAllowsSixEmployeesBesidesTheChairButRejectsSeven(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct {
		name       string
		count      int
		duplicates bool
	}{
		{"six", 6, false},
		{"six with repeated employees and chair", 6, true},
		{"seven", 7, false},
		{"seven with repeated employees and chair", 7, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			r := newRig(t, func(model.ModelRequest) (model.ModelReply, error) { return say("idle"), nil })
			wf := *r.flow
			wf.Nodes = slices.Clone(wf.Nodes)
			var ids []string
			for i := 0; i < tc.count; i++ {
				p, err := r.e.Hire(usecase.NewReplica{TeamID: r.team.ID, BlueprintID: r.owner.BlueprintID, Name: fmt.Sprintf("Member %d", i+1), Model: "fake"})
				if err != nil {
					t.Fatal(err)
				}
				ids = append(ids, p.ID)
				// Authorize each employee through an ordinary work step; the old flow's talk limit is unrelated.
				wf.Nodes = append(wf.Nodes, model.WorkflowNode{ID: fmt.Sprintf("work-%d", i), Kind: enum.NodeWork, Name: p.Name,
					ReplicaIDs: []string{p.ID}, Handoff: enum.HandoffAll, Join: enum.JoinAll})
			}
			asked := slices.Clone(ids)
			if tc.duplicates {
				asked = append([]string{r.owner.ID, ids[0]}, asked...)
				asked = append(asked, r.owner.ID, ids[len(ids)-1])
			}
			r.setReply(func(req model.ModelRequest) (model.ModelReply, error) {
				if isOwner(req) && len(req.Messages) == 1 && strings.Contains(sentText(req), "[task_started]") {
					return ownerCall("hold_meeting", map[string]any{"topic": "人數邊界", "replica_ids": asked}), nil
				}
				if isChair(req) && reminded(req) {
					return say(""), nil
				}
				if isChair(req) {
					return say("opening"), nil
				}
				return say("request handled"), nil
			})
			task, err := r.e.CreateTask(usecase.NewTask{TeamID: r.team.ID, Title: "meeting capacity", Workflow: &wf, OwnerID: &r.owner.ID})
			if err != nil {
				t.Fatal(err)
			}
			if err := r.e.ResumeTask(task.ID); err != nil {
				t.Fatal(err)
			}
			r.wait("owner received the tool result", func(w *model.World) bool {
				return w.Tasks[task.ID].Coordination.OwnerState == model.OwnerIdle && hasActivity(r.activity(task.ID), func(a model.TaskActivity) bool { return a.Text == "request handled" })
			})
			var results []model.Block
			for _, req := range ownerRequests(r) {
				last := req.Messages[len(req.Messages)-1]
				for _, b := range last.Content {
					if b.Type == enum.BlockToolResult && b.Name == "hold_meeting" {
						results = append(results, b)
					}
				}
			}
			if len(results) != 1 {
				t.Fatalf("hold_meeting results = %+v", results)
			}
			if tc.count == 7 {
				if !results[0].IsError || results[0].Text != "會議要有負責人加 1 到 6 位員工" {
					t.Fatalf("want the existing capacity error, got %+v", results[0])
				}
				w := r.world()
				if w.Tasks[task.ID].Coordination.ActiveMeetingID != "" || len(w.SubTasks) != 0 || len(meetingRequests(r)) != 0 ||
					!reflect.DeepEqual(w.Tasks[task.ID].Workflow, task.Workflow) || w.Tasks[task.ID].Coordination.PlanVersion != task.Coordination.PlanVersion {
					t.Fatal("rejected meeting changed the plan, created a run, or called a participant")
				}
				return
			}
			if results[0].IsError {
				t.Fatalf("six employees rejected: %+v", results[0])
			}
			// the chair calls on no one, so it is asked again until the batch is used up; no one else speaks
			w := r.wait("chair opened the meeting", meetingIs(task.ID, func(m *model.Meeting) bool { return m.PauseReason == "limit" }))
			s := meetingSub(w, task.ID)
			m := s.Meeting
			var got []string
			for _, p := range m.Participants {
				got = append(got, p.ReplicaID)
			}
			if !slices.Equal(got, append([]string{r.owner.ID}, ids...)) || m.ChairID != r.owner.ID || m.Version != 2 ||
				w.Tasks[task.ID].Coordination.ActiveMeetingID != s.ID || len(w.SubTasks) != 1 || len(w.Chats) != 0 {
				t.Fatalf("wrong participants or meeting: %+v", m)
			}
			if len(speeches(r, task.ID)) != 1 || slices.ContainsFunc(meetingRequests(r), func(req model.ModelRequest) bool { return req.Session != "meeting:"+s.ID+":"+r.owner.ID }) {
				t.Fatal("the chair should open alone")
			}
		})
	}
}

func TestOldOwnerMeetingRestartsAndFinishesWithoutBecomingV2(t *testing.T) {
	t.Parallel()
	r := newRig(t, func(model.ModelRequest) (model.ModelReply, error) { return say("idle"), nil })
	var ids []string
	for _, name := range []string{"Bob", "Carol", "Dave"} {
		p, err := r.e.Hire(usecase.NewReplica{TeamID: r.team.ID, BlueprintID: r.owner.BlueprintID, Name: name, Model: "fake"})
		if err != nil {
			t.Fatal(err)
		}
		ids = append(ids, p.ID)
	}
	wf := *r.flow
	wf.Nodes = append(slices.Clone(wf.Nodes), model.WorkflowNode{ID: "old-meeting", Kind: enum.NodeTalk, Name: "舊會議",
		ReplicaIDs: ids, Handoff: enum.HandoffAll, Join: enum.JoinAll})
	task, err := r.e.CreateTask(usecase.NewTask{TeamID: r.team.ID, Title: "old owner meeting", Workflow: &wf, OwnerID: &r.owner.ID})
	if err != nil {
		t.Fatal(err)
	}
	r.e.Close()

	// A pre-v2 owner-led meeting, saved while Carol was speaking after Bob; Dave is still queued.
	// Use the real documents and loader, not a new-format meeting with its version cleared.
	const subID = "sub-900000"
	now := task.CreatedAt
	task.Paused = false
	task.Coordination.StartedAt = &now
	old := model.ChatMessage{At: now, From: "agent", By: ids[0], Text: "重啟前已保存的 Bob 發言"}
	sub := model.SubTask{ID: subID, TaskID: task.ID, NodeID: "old-meeting", ReplicaID: &ids[0],
		Status: enum.StatusProgressing, ExecutionState: model.ExecRunning, RunGeneration: 1, PlanVersion: task.Coordination.PlanVersion,
		CreatedAt: now, StartedAt: &now, Instruction: "保留舊格式討論", Validity: model.ValidCurrent,
		Talk: &model.Talk{Messages: []model.ChatMessage{old}, Speaker: ids[1], ReplyAt: &now, Next: []string{ids[2]}}}
	activity := model.TaskActivity{ID: task.ID + "-a1", Seq: 1, At: now, Kind: "meeting", From: "agent", By: old.By, Name: "Bob", Text: old.Text,
		SubID: subID, NodeID: sub.NodeID, MeetingID: subID}
	raw, err := r.store.LoadDoc(context.Background(), "taskLog", task.ID)
	if err != nil {
		t.Fatal(err)
	}
	var log map[string]any
	if err := json.Unmarshal(raw, &log); err != nil {
		t.Fatal(err)
	}
	log["activityCount"], log["tail"] = 1, []model.TaskActivity{activity}
	task.Coordination.History = model.ActivityHistory{Count: 1, Version: "1"}
	conv := []model.Message{
		{Role: enum.RoleUser, Content: []model.Block{{Type: enum.BlockText, Text: "舊會議原始背景"}}},
		{Role: enum.RoleAssistant, By: ids[0], Content: []model.Block{{Type: enum.BlockText, Text: old.Text}}},
	}
	var docs []model.Doc
	for _, doc := range []struct {
		kind, id string
		value    any
	}{{"task", task.ID, task}, {"subTask", subID, sub}, {"taskLog", task.ID, log}, {"conv", subID, conv}} {
		data, err := json.Marshal(doc.value)
		if err != nil {
			t.Fatal(err)
		}
		docs = append(docs, model.Doc{Kind: doc.kind, ID: doc.id, Data: data})
	}
	if err := r.store.Apply(context.Background(), docs, nil, nil); err != nil {
		t.Fatal(err)
	}
	r.setReply(func(req model.ModelRequest) (model.ModelReply, error) {
		if isOwner(req) {
			if len(req.Messages) == 1 && strings.Contains(sentText(req), "[user_answer]") {
				return ownerCall("dispatch_step", map[string]any{"sub_id": subID, "instructions": "接著完成舊會議"}), nil
			}
			return say("owner received"), nil
		}
		return say("續跑發言 " + req.Session), nil
	})
	newEngine(t, r)
	w := r.wait("legacy recovery waits for confirmation", func(w *model.World) bool {
		return w.Tasks[task.ID].Coordination.OwnerState == model.OwnerIdle && w.SubTasks[subID].ExecutionState == model.ExecUncertain
	})
	s := w.SubTasks[subID]
	if !w.Tasks[task.ID].OwnerLed() || s.Meeting != nil || s.Talk.Ended != "" || s.Talk.ReplyAt != nil ||
		!reflect.DeepEqual(s.Talk.Messages, []model.ChatMessage{old}) || !slices.Equal(s.Talk.Next, []string{ids[2]}) ||
		w.Tasks[task.ID].Coordination.ActiveMeetingID != "" {
		t.Fatalf("old meeting migrated or lost saved speech/queue: %+v", s)
	}
	for _, req := range r.fake.requests() {
		if !isOwner(req) {
			t.Fatal("interrupted legacy meeting restarted without user confirmation")
		}
	}
	c := w.Tasks[task.ID].Coordination
	i := slices.IndexFunc(c.Questions, func(q model.TaskQuestion) bool { return q.SubID == subID && q.Kind == "recovery" })
	if i < 0 {
		t.Fatal("missing legacy recovery question")
	}
	if _, err := r.e.ControlTask(task.ID, usecase.TaskControl{RequestID: "confirm-old-run", Action: "answer", QuestionID: c.Questions[i].ID,
		OptionID: "confirmStopped", PlanVersion: &c.PlanVersion, ControlVersion: &c.ControlVersion}); err != nil {
		t.Fatal(err)
	}
	w = r.wait("old meeting completed and reported to owner", func(w *model.World) bool {
		return w.SubTasks[subID].Status == enum.StatusComplete && w.Tasks[task.ID].Coordination.OwnerState == model.OwnerIdle &&
			slices.ContainsFunc(ownerRequests(r), func(req model.ModelRequest) bool { return strings.Contains(sentText(req), "[meeting_ended]") })
	})
	// Legacy continuation restarts the assigned employee, then drains Talk.Next. It does not use a v2 chair or summary.
	wantSessions := []string{subID + "-" + ids[0], subID + "-" + ids[2]}
	var sessions []string
	for _, req := range r.fake.requests() {
		if !isOwner(req) {
			sessions = append(sessions, req.Session)
			if isChair(req) || isMember(req) || !strings.Contains(sentText(req), old.Text) || slices.Contains(toolNames(req), "end_meeting") {
				t.Fatal("legacy speech switched to v2 or lost its saved conversation")
			}
		}
	}
	if !slices.Equal(sessions, wantSessions) {
		t.Fatalf("legacy sessions = %v, want %v", sessions, wantSessions)
	}
	wantDone := []string{"Bob: " + old.Text, "Bob: 續跑發言 " + wantSessions[0], "Dave: 續跑發言 " + wantSessions[1]}
	check := func(w *model.World) {
		t.Helper()
		s := w.SubTasks[subID]
		if s.Meeting != nil || s.Talk.Ended != "done" || len(s.Talk.Messages) != 3 || !reflect.DeepEqual(s.Talk.Messages[0], old) ||
			s.Status != enum.StatusComplete || s.EndedAt == nil || s.Progress != 1 || !s.Routed || s.OwnerReview != model.ReviewPending ||
			s.Handoff == nil || !slices.Equal(s.Handoff.Agent.Done, wantDone) || s.Handoff.Human.Headline != "會議結束：舊會議" ||
			w.Tasks[task.ID].Coordination.ActiveMeetingID != "" || len(w.SubTasks) != 1 || len(w.Chats) != 0 {
			t.Fatalf("legacy completion lost or migrated: %+v", s)
		}
		page, err := r.e.MeetingActivity(task.ID, subID, 0, 100, "")
		if err != nil || page.Total != 3 || len(page.Items) != 3 || !reflect.DeepEqual(page.Items[0], activity) {
			t.Fatalf("legacy activity unreadable: %+v, %v", page, err)
		}
		for i, a := range page.Items {
			if a.MeetingVersion != 0 || a.MeetingPart != "" || a.Name+": "+a.Text != wantDone[i] {
				t.Fatalf("wrong legacy activity: %+v", a)
			}
		}
		var ended int
		for _, a := range r.activity(task.ID) {
			if a.Key == "meetingEnded" && a.SubID == subID {
				ended++
			}
		}
		if ended != 1 {
			t.Fatalf("meetingEnded events = %d, want 1", ended)
		}
	}
	check(w)
	var ownerGotTranscript bool
	for _, req := range ownerRequests(r) {
		if strings.Contains(sentText(req), "[meeting_ended]") {
			ownerGotTranscript = true
			for _, line := range wantDone {
				if !strings.Contains(sentText(req), line) {
					t.Fatal("legacy owner no longer gets the complete meeting record")
				}
			}
		}
	}
	if !ownerGotTranscript {
		t.Fatal("owner was not told the old meeting ended")
	}
	r.e.Close()
	newEngine(t, r)
	check(r.world())
}
