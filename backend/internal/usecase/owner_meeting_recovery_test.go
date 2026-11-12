package usecase_test

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/yanun0323/Team-Work/internal/model"
	"github.com/yanun0323/Team-Work/internal/usecase"
)

// idleMeeting is a meeting open after the chair's opening with no one due to speak, as one saved before the floor
// passed on by itself: the chair, reminded, says nothing until the batch is used up, and the meeting is then saved as
// it stood after the opening.
func idleMeeting(t *testing.T) (*rig, *model.Task, *model.SubTask, []*model.Replica) {
	t.Helper()
	r, task, people := meetingRig(t, []string{"Bob"}, func(req model.ModelRequest, _ []*model.Replica, _ string) (model.ModelReply, bool) {
		if isChair(req) && reminded(req) {
			return say(""), true
		}
		if isChair(req) || isMember(req) {
			return say("opening"), true
		}
		return model.ModelReply{}, false
	})
	w := r.wait("idle meeting", meetingIs(task.ID, func(m *model.Meeting) bool { return m.PauseReason == "limit" }))
	if got := speeches(r, task.ID); len(got) != 1 {
		t.Fatalf("%+v", got)
	}
	sub := meetingSub(w, task.ID)
	m := sub.Meeting
	m.State, m.PauseReason, m.SpeakerID, m.CallsInBatch, m.CallsTotal = model.MeetingOpen, "", "", 1, 1
	saveMeetingFixture(t, r, task.ID, sub, nil)
	newEngine(t, r)
	return r, task, meetingSub(r.world(), task.ID), people
}

// reminded says whether the chair is asked again after calling on no one.
func reminded(req model.ModelRequest) bool {
	return strings.Contains(lastText(req), "You mentioned no one")
}

// Save the exact public/private boundary a crashed process could leave, then use the real loader and recovery.
func saveMeetingFixture(t *testing.T, r *rig, taskID string, sub *model.SubTask, queue []map[string]any) {
	t.Helper()
	r.e.Close()
	raw, err := r.store.LoadDoc(context.Background(), "taskLog", taskID)
	if err != nil {
		t.Fatal(err)
	}
	var log map[string]any
	if err := json.Unmarshal(raw, &log); err != nil {
		t.Fatal(err)
	}
	st := log["meetings"].(map[string]any)[sub.ID].(map[string]any)
	st["queue"] = queue
	raw, _ = json.Marshal(log)
	data, _ := json.Marshal(sub)
	if err := r.store.Apply(context.Background(), []model.Doc{{Kind: "subTask", ID: sub.ID, Data: data}, {Kind: "taskLog", ID: taskID, Data: raw}}, nil, nil); err != nil {
		t.Fatal(err)
	}
}

func assertMeetingQuiet(t *testing.T, r *rig, calls int) {
	t.Helper()
	// Exercise settling repeatedly as well as allowing an accidentally launched goroutine to run.
	until := time.Now().Add(80 * time.Millisecond)
	for time.Now().Before(until) {
		_ = r.world()
		if got := len(meetingRequests(r)); got != calls {
			t.Fatalf("unauthorized meeting call: got %d, want %d", got, calls)
		}
		time.Sleep(time.Millisecond)
	}
}

func TestMeetingRestartKeepsPauseCountersAndQueuedMessages(t *testing.T) {
	for _, reason := range []string{"recovery", "limit", "taskPaused"} {
		t.Run(reason, func(t *testing.T) {
			r, task, sub, people := idleMeeting(t)
			m := sub.Meeting
			m.CallsInBatch, m.CallsTotal = 5, 41
			m.Batch = 2
			m.SpeakerID = people[0].ID
			if reason != "recovery" {
				m.State, m.PauseReason, m.SpeakerID = model.MeetingPaused, reason, ""
			}
			if reason == "limit" {
				m.CallsInBatch, m.CallsTotal = 36, 72
			}
			saveMeetingFixture(t, r, task.ID, sub, []map[string]any{{"speaker": people[0].ID}})
			before := len(meetingRequests(r))
			r.setReply(func(req model.ModelRequest) (model.ModelReply, error) {
				if isChair(req) {
					return ownerCall("end_meeting", map[string]any{"summary": "done"}), nil
				}
				return say("bob"), nil
			})
			newEngine(t, r)
			m = meetingSub(r.world(), task.ID).Meeting
			if m.State != model.MeetingPaused || m.PauseReason != reason || m.CallsTotal != sub.Meeting.CallsTotal || m.CallsInBatch != sub.Meeting.CallsInBatch {
				t.Fatalf("recovery lost state: %+v", m)
			}
			assertMeetingQuiet(t, r, before)
			if _, err := r.e.SayToOwner(task.ID, usecase.TaskMessage{RequestID: "queued", Text: "keep this after restart", MeetingID: sub.ID}); err != nil {
				t.Fatal(err)
			}
			if reason != "limit" {
				// paused for any other reason, the user's words wait for them to go on, across a restart
				assertMeetingQuiet(t, r, before)
				r.e.Close()
				newEngine(t, r)
				assertMeetingQuiet(t, r, before)
				m = meetingSub(r.world(), task.ID).Meeting
				in := usecase.MeetingControl{RequestID: "continue", Action: "continue", Revision: m.Revision}
				op, err := r.e.ControlMeeting(task.ID, sub.ID, in)
				if err != nil {
					t.Fatal(err)
				}
				if replay, err := r.e.ControlMeeting(task.ID, sub.ID, in); err != nil || replay.ID != op.ID {
					t.Fatal(replay, err)
				}
			}
			// used up its calls, the user's words go on with it at once, a new batch
			w := r.wait("the chair answering the user", meetingState(task.ID, model.MeetingEnded))
			m = meetingSub(w, task.ID).Meeting
			wantBatch, wantIn := 2, 6
			if reason == "limit" {
				wantBatch, wantIn = 3, 1
			}
			if m.Batch != wantBatch || m.CallsInBatch != wantIn || m.CallsTotal != sub.Meeting.CallsTotal+1 {
				t.Fatalf("counters reset or double granted: %+v", m)
			}
			// the user steered: Bob, due before, gave way to the chair the user's words went to
			reqs := meetingRequests(r)
			if len(reqs) != before+1 || reqs[before].Session != "meeting:"+sub.ID+":"+r.owner.ID || !strings.Contains(sentText(reqs[before]), "keep this after restart") {
				t.Fatal("the user's words were not what went on")
			}
		})
	}
}

func TestMeetingRestartWhileClosingNeedsExplicitSummaryRetry(t *testing.T) {
	for _, started := range []bool{false, true} {
		t.Run(fmt.Sprint(started), func(t *testing.T) {
			r, task, sub, _ := idleMeeting(t)
			sub.Meeting.State, sub.Meeting.ClosingRequested = model.MeetingClosing, true
			sub.Meeting.CallsInBatch, sub.Meeting.CallsTotal = 36, 37
			if started {
				sub.Meeting.SpeakerID = r.owner.ID
			}
			saveMeetingFixture(t, r, task.ID, sub, []map[string]any{{"speaker": r.owner.ID, "summary": true}})
			before := len(meetingRequests(r))
			newEngine(t, r)
			m := meetingSub(r.world(), task.ID).Meeting
			if m.State != model.MeetingSummaryFailed || m.Error == nil || m.PauseReason != "recovery" || m.CallsTotal != 37 {
				t.Fatalf("uncertain conclusion was not held: %+v", m)
			}
			assertMeetingQuiet(t, r, before)
			if _, err := r.e.ControlMeeting(task.ID, sub.ID, usecase.MeetingControl{RequestID: "end-again", Action: "end", Revision: m.Revision}); err == nil {
				t.Fatal("end granted a retry")
			}
			if _, err := r.e.ControlMeeting(task.ID, sub.ID, usecase.MeetingControl{RequestID: "retry", Action: "retrySummary", Revision: m.Revision}); err != nil {
				t.Fatal(err)
			}
			w := r.wait("authorized conclusion", meetingState(task.ID, model.MeetingEnded))
			m = meetingSub(w, task.ID).Meeting
			if m.CallsTotal != 38 || m.CallsInBatch != 36 || m.Batch != 1 {
				t.Fatalf("summary created discussion quota: %+v", m)
			}
		})
	}
}

func TestMeetingUnavailableParticipantNeverUsesTheirReplacement(t *testing.T) {
	r, task, sub, people := idleMeeting(t)
	if err := r.e.Fire(people[0].ID, r.owner.ID); err != nil {
		t.Fatal(err)
	}
	before := len(meetingRequests(r))
	if _, err := r.e.SayToOwner(task.ID, usecase.TaskMessage{RequestID: "ask", MeetingID: sub.ID, Text: "Bob only", Mentions: []string{people[0].ID}}); err != nil {
		t.Fatal(err)
	}
	w := r.wait("participant unavailable", meetingIs(task.ID, func(m *model.Meeting) bool { return m.PauseReason == "participantUnavailable" }))
	m := meetingSub(w, task.ID).Meeting
	if m.Error == nil || m.Error.Code != model.CodeNotFound || m.Participants[1].Name != "Bob" || m.CallsTotal != 1 {
		t.Fatalf("%+v", m)
	}
	if _, err := r.e.ControlMeeting(task.ID, sub.ID, usecase.MeetingControl{RequestID: "continue", Action: "continue", Revision: m.Revision}); err == nil {
		t.Fatal("continued without the original participant")
	}
	assertMeetingQuiet(t, r, before)
	r.e.Close()
	newEngine(t, r)
	assertMeetingQuiet(t, r, before)
	m = meetingSub(r.world(), task.ID).Meeting
	if _, err := r.e.ControlMeeting(task.ID, sub.ID, usecase.MeetingControl{RequestID: "end", Action: "end", Revision: m.Revision}); err != nil {
		t.Fatal(err)
	}
	r.wait("chair can conclude without replacement", meetingState(task.ID, model.MeetingEnded))
}

func TestMeetingSummaryEndAndRetryEachAuthorizeOnlyOneAttempt(t *testing.T) {
	for _, used := range []int{1, 36} {
		for _, failure := range []string{"unavailable", "empty", "other tool", "invalid end"} {
			t.Run(fmt.Sprintf("%d/%s", used, failure), func(t *testing.T) {
				r, task, sub, _ := idleMeeting(t)
				// An exhausted batch must not turn the special summary authorization into discussion quota.
				if used == 36 {
					sub.Meeting.State, sub.Meeting.PauseReason = model.MeetingPaused, "limit"
				}
				sub.Meeting.CallsInBatch, sub.Meeting.CallsTotal = used, used
				saveMeetingFixture(t, r, task.ID, sub, nil)
				r.setReply(func(req model.ModelRequest) (model.ModelReply, error) {
					if !isChair(req) {
						return say("ok"), nil
					}
					switch failure {
					case "unavailable":
						return model.ModelReply{}, model.Errorf(model.CodeUnavailable, "temporary failure")
					case "empty":
						return model.ModelReply{}, nil
					case "other tool":
						return ownerCall("read_file", map[string]any{"path": "missing"}), nil
					default:
						return ownerCall("end_meeting", map[string]any{"summary": " "}), nil
					}
				})
				newEngine(t, r)
				before := len(meetingRequests(r))
				for i, action := range []string{"end", "retrySummary"} {
					m := meetingSub(r.world(), task.ID).Meeting
					in := usecase.MeetingControl{RequestID: action, Action: action, Revision: m.Revision}
					op, err := r.e.ControlMeeting(task.ID, sub.ID, in)
					if err != nil {
						t.Fatal(err)
					}
					w := r.wait("failed summary", func(w *model.World) bool {
						return meetingState(task.ID, model.MeetingSummaryFailed)(w) || len(meetingRequests(r)) > before+i+1
					})
					m = meetingSub(w, task.ID).Meeting
					if m.State != model.MeetingSummaryFailed || m.CallsTotal != used+1+i || m.CallsInBatch != min(36, used+1+i) || m.Batch != 1 {
						t.Fatalf("one authorization did not mean one summary call: %+v", m)
					}
					got, err := r.e.TaskOperation(task.ID, op.ID)
					if err != nil || got.Status != model.OpFailed || got.Error == nil {
						t.Fatal(got, err)
					}
					if replay, err := r.e.ControlMeeting(task.ID, sub.ID, in); err != nil || replay.ID != op.ID || replay.Status != model.OpFailed {
						t.Fatal(replay, err)
					}
					if _, err := r.e.ControlMeeting(task.ID, sub.ID, usecase.MeetingControl{RequestID: "new-end" + action, Action: "end", Revision: m.Revision}); err == nil {
						t.Fatal("new end silently retried summary")
					}
					assertMeetingQuiet(t, r, before+i+1)
				}
			})
		}
	}
}

func TestMeetingCancellationDiscardsLateSpeechButKeepsReceivedUsage(t *testing.T) {
	for _, cancelled := range []bool{false, true} {
		for _, action := range []string{"cancel", "end"} {
			t.Run(fmt.Sprintf("%s/error=%v", action, cancelled), func(t *testing.T) {
				r, task, sub, people := idleMeeting(t)
				entered, release := make(chan struct{}), make(chan struct{})
				var once sync.Once
				defer once.Do(func() { close(release) })
				r.setReply(func(req model.ModelRequest) (model.ModelReply, error) {
					if isMember(req) {
						close(entered)
						<-release
						out := say("late speech must not appear")
						out.Usage = model.ModelUsage{Input: 100, Output: 20}
						if cancelled {
							return out, context.Canceled
						}
						return out, nil
					}
					return say("conclusion"), nil
				})
				if _, err := r.e.SayToOwner(task.ID, usecase.TaskMessage{RequestID: "ask", MeetingID: sub.ID, Text: "question retained", Mentions: []string{people[0].ID}}); err != nil {
					t.Fatal(err)
				}
				<-entered
				if action == "cancel" {
					if _, err := r.e.ControlTask(task.ID, usecase.TaskControl{RequestID: "pause", Action: "pause"}); err != nil {
						t.Fatal(err)
					}
					if err := r.e.CancelTask(task.ID); err != nil {
						t.Fatal(err)
					}
				} else {
					m := meetingSub(r.world(), task.ID).Meeting
					if _, err := r.e.ControlMeeting(task.ID, sub.ID, usecase.MeetingControl{RequestID: "end", Action: "end", Revision: m.Revision}); err != nil {
						t.Fatal(err)
					}
					// The cancelled provider has not returned: no summary call may start yet.
					time.Sleep(30 * time.Millisecond)
					if m := meetingSub(r.world(), task.ID).Meeting; m.CallsTotal != 2 {
						t.Errorf("summary overlapped cancelled call: %+v", m)
					}
				}
				once.Do(func() { close(release) })
				r.wait("received usage charged", func(w *model.World) bool { return w.SubTasks[sub.ID].Tokens == 120 })
				if action == "end" {
					r.wait("conclusion", meetingState(task.ID, model.MeetingEnded))
				}
				r.e.Close() // all provider results have been processed
				s := r.world().SubTasks[sub.ID]
				if math.Abs(s.CostUSD-0.00012) > 1e-10 || s.Tokens != 120 {
					t.Fatalf("received usage lost or duplicated: %+v", s)
				}
				for _, a := range r.activity(task.ID) {
					if strings.Contains(a.Text, "late speech") {
						t.Fatal("late speech published")
					}
				}
				got := speeches(r, task.ID)
				if len(got) != 2 || got[1].Text != "question retained" {
					t.Fatalf("accepted transcript lost: %+v", got)
				}
				newEngine(t, r)
				if s := r.world().SubTasks[sub.ID]; s.Tokens != 120 || math.Abs(s.CostUSD-0.00012) > 1e-10 {
					t.Fatal("accounting not persisted")
				}
			})
		}
	}
}

func TestMeetingShutdownRecoversInterruptedSpeechAndSummary(t *testing.T) {
	for _, summary := range []bool{false, true} {
		t.Run(fmt.Sprint(summary), func(t *testing.T) {
			r, task, sub, people := idleMeeting(t)
			entered := make(chan struct{})
			r.fake.mu.Lock()
			r.fake.replyContext = func(ctx context.Context, req model.ModelRequest) (model.ModelReply, error) {
				if isChair(req) || isMember(req) {
					close(entered)
					<-ctx.Done()
					return model.ModelReply{Usage: model.ModelUsage{Input: 100, Output: 20}}, ctx.Err()
				}
				return say("ok"), nil
			}
			r.fake.mu.Unlock()
			var op model.TaskOperation
			var err error
			if summary {
				op, err = r.e.ControlMeeting(task.ID, sub.ID, usecase.MeetingControl{RequestID: "end", Action: "end", Revision: sub.Meeting.Revision})
			} else {
				_, err = r.e.SayToOwner(task.ID, usecase.TaskMessage{RequestID: "ask", MeetingID: sub.ID, Text: "interrupted question", Mentions: []string{people[0].ID}})
			}
			if err != nil {
				t.Fatal(err)
			}
			<-entered
			r.e.Close()
			before := len(meetingRequests(r))
			r.fake.mu.Lock()
			r.fake.replyContext = nil
			r.fake.mu.Unlock()
			newEngine(t, r)
			s := meetingSub(r.world(), task.ID)
			want := model.MeetingPaused
			if summary {
				want = model.MeetingSummaryFailed
			}
			if s.Meeting.State != want || s.Meeting.PauseReason != "recovery" || s.Meeting.CallsTotal != 2 || s.Tokens != 120 {
				t.Fatalf("shutdown lost uncertainty or usage: %+v, %+v", s.Meeting, s)
			}
			if summary {
				got, err := r.e.TaskOperation(task.ID, op.ID)
				if err != nil || got.Status != model.OpFailed || got.Error == nil {
					t.Fatal(got, err)
				}
			}
			assertMeetingQuiet(t, r, before)
		})
	}
}

func TestMeetingUnavailableModelRequiresRestorationBeforeContinue(t *testing.T) {
	r, task, sub, people := idleMeeting(t)
	var provider string
	for id := range r.world().Providers {
		provider = id
	}
	r.fake.mu.Lock()
	r.fake.models = []model.ModelSpec{{ID: "different-model"}}
	r.fake.mu.Unlock()
	if err := r.e.RefreshModels(context.Background(), provider); err != nil {
		t.Fatal(err)
	}
	before := len(meetingRequests(r))
	if _, err := r.e.SayToOwner(task.ID, usecase.TaskMessage{RequestID: "ask", MeetingID: sub.ID, Text: "wait for original model", Mentions: []string{people[0].ID}}); err != nil {
		t.Fatal(err)
	}
	m := meetingSub(r.world(), task.ID).Meeting
	if m.State != model.MeetingPaused || m.PauseReason != "participantUnavailable" || m.Error == nil {
		t.Fatalf("%+v", m)
	}
	if _, err := r.e.ControlMeeting(task.ID, sub.ID, usecase.MeetingControl{RequestID: "unavailable", Action: "continue", Revision: m.Revision}); err == nil {
		t.Fatal("continued without original model")
	}
	assertMeetingQuiet(t, r, before)
	r.fake.mu.Lock()
	r.fake.models = nil
	r.fake.mu.Unlock()
	if err := r.e.RefreshModels(context.Background(), provider); err != nil {
		t.Fatal(err)
	}
	m = meetingSub(r.world(), task.ID).Meeting
	if m.State != model.MeetingPaused {
		t.Fatal("provider restoration silently resumed meeting")
	}
	if _, err := r.e.ControlMeeting(task.ID, sub.ID, usecase.MeetingControl{RequestID: "restored", Action: "continue", Revision: m.Revision}); err != nil {
		t.Fatal(err)
	}
	r.wait("original participant answered", func(*model.World) bool { return len(speeches(r, task.ID)) >= 3 })
	if got := speeches(r, task.ID)[2]; got.By != people[0].ID {
		t.Fatalf("%+v", got)
	}
	if reqs := meetingRequests(r); reqs[before].Session != "meeting:"+sub.ID+":"+people[0].ID || reqs[before].Model != "fake" {
		t.Fatal("participant/model replaced")
	}
}

func TestMeetingSummaryGrantDoesNotBypassTaskBudget(t *testing.T) {
	r, task, sub, _ := idleMeeting(t)
	sub.Meeting.State, sub.Meeting.PauseReason = model.MeetingPaused, "limit"
	sub.Meeting.CallsInBatch, sub.Meeting.CallsTotal = 36, 36
	saveMeetingFixture(t, r, task.ID, sub, nil)
	newEngine(t, r)
	settings := r.world().Teams[r.team.ID].Settings
	settings.CostLimitUSD = 0.000001
	if err := r.e.UpdateTeam(r.team.ID, usecase.TeamPatch{Settings: &settings}); err != nil {
		t.Fatal(err)
	}
	before := len(meetingRequests(r))
	m := meetingSub(r.world(), task.ID).Meeting
	op, err := r.e.ControlMeeting(task.ID, sub.ID, usecase.MeetingControl{RequestID: "end", Action: "end", Revision: m.Revision})
	if err != nil {
		t.Fatal(err)
	}
	m = meetingSub(r.world(), task.ID).Meeting
	if m.State != model.MeetingPaused || m.PauseReason != "budget" || !m.ClosingRequested || m.CallsTotal != 36 {
		t.Fatalf("budget bypassed: %+v", m)
	}
	got, err := r.e.TaskOperation(task.ID, op.ID)
	if err != nil || got.Status != model.OpFailed {
		t.Fatal(got, err)
	}
	if _, err := r.e.ControlMeeting(task.ID, sub.ID, usecase.MeetingControl{RequestID: "retry", Action: "retrySummary", Revision: m.Revision}); err == nil {
		t.Fatal("retry bypassed budget")
	}
	assertMeetingQuiet(t, r, before)
	settings.CostLimitUSD = 100
	if err := r.e.UpdateTeam(r.team.ID, usecase.TeamPatch{Settings: &settings}); err != nil {
		t.Fatal(err)
	}
	assertMeetingQuiet(t, r, before)
	m = meetingSub(r.world(), task.ID).Meeting
	if _, err := r.e.ControlMeeting(task.ID, sub.ID, usecase.MeetingControl{RequestID: "funded-retry", Action: "retrySummary", Revision: m.Revision}); err != nil {
		t.Fatal(err)
	}
	w := r.wait("funded authorized summary", meetingState(task.ID, model.MeetingEnded))
	if m := meetingSub(w, task.ID).Meeting; m.CallsTotal != 37 || m.CallsInBatch != 36 {
		t.Fatalf("%+v", m)
	}
}

func TestMeetingFailedSpeechCountsEveryRetryAndKeepsUsage(t *testing.T) {
	r, task, sub, people := idleMeeting(t)
	r.setReply(func(req model.ModelRequest) (model.ModelReply, error) {
		if isMember(req) {
			return model.ModelReply{Usage: model.ModelUsage{Input: 100, Output: 20}}, model.Errorf(model.CodeUnavailable, "temporary failure")
		}
		return say("ok"), nil
	})
	if _, err := r.e.SayToOwner(task.ID, usecase.TaskMessage{RequestID: "ask", MeetingID: sub.ID, Text: "retry later", Mentions: []string{people[0].ID}}); err != nil {
		t.Fatal(err)
	}
	w := r.wait("speaker failed after counted retries", meetingIs(task.ID, func(m *model.Meeting) bool { return m.State == model.MeetingPaused && m.PauseReason == "speakerFailed" }))
	s := w.SubTasks[sub.ID]
	if s.Meeting.CallsTotal != 5 || s.Meeting.CallsInBatch != 5 || s.Tokens != 480 || math.Abs(s.CostUSD-0.00048) > 1e-10 {
		t.Fatalf("failed attempts not counted/charged: %+v, %+v", s.Meeting, s)
	}
	before := len(meetingRequests(r))
	r.e.Close()
	newEngine(t, r)
	assertMeetingQuiet(t, r, before)
	r.setReply(func(req model.ModelRequest) (model.ModelReply, error) {
		if isChair(req) {
			return ownerCall("end_meeting", map[string]any{"summary": "done"}), nil
		}
		return say("recovered"), nil
	})
	m := meetingSub(r.world(), task.ID).Meeting
	if _, err := r.e.ControlMeeting(task.ID, sub.ID, usecase.MeetingControl{RequestID: "continue", Action: "continue", Revision: m.Revision}); err != nil {
		t.Fatal(err)
	}
	// Bob answers at last, then hands back to the chair, who ends it
	w = r.wait("failed speaker retried", meetingState(task.ID, model.MeetingEnded))
	if got := speeches(r, task.ID); len(got) != 3 || got[2].Text != "recovered" {
		t.Fatalf("%+v", got)
	}
	if m := meetingSub(w, task.ID).Meeting; m.CallsTotal != 7 || m.Batch != 1 {
		t.Fatalf("failure continuation reset quota: %+v", m)
	}
}
