package usecase

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/yanun0323/Team-Work/internal/adapter"
	"github.com/yanun0323/Team-Work/internal/i18n"
	"github.com/yanun0323/Team-Work/internal/model"
	"github.com/yanun0323/Team-Work/internal/model/enum"
	"github.com/yanun0323/Team-Work/internal/usecase/tools"
)

// Meetings of owner-led tasks (version 2) are held in the task's conversation. The owner chairs; the user and the
// chair call on whom they want, one at a time. Each participant keeps a conversation of their own that only grows:
// the meeting's opening, then what was said since they last spoke, and last a note on who is here and who speaks,
// so what a provider cached of the earlier calls stays usable. Model calls come in batches of meetingBatch: past
// one, the meeting waits for the user.

const (
	meetingVersion = 2
	meetingBatch   = 36
	meetingMost    = 6
	toolMeetingAsk = "meeting_ask"
	toolEndMeeting = "end_meeting"
	meetingSpeech  = "speech"
	meetingSummary = "summary"
)

// Why a meeting waits.
const (
	pauseLimit       = "limit"
	pauseBudget      = "budget"
	pauseTaskPaused  = "taskPaused"
	pauseRecovery    = "recovery"
	pauseFailed      = "speakerFailed"
	pauseUnavailable = "participantUnavailable"
	pauseContext     = "context"
)

// meetingState is a meeting's private record: what was fixed when it opened, who speaks next, and how far each one
// has read. Kept in the task's log; its values are replaced, never changed in place.
type meetingState struct {
	Topic      string                 `json:"topic"`
	Background string                 `json:"background"`
	System     map[string]string      `json:"system"`
	Allowed    map[string][]enum.Tool `json:"allowed"`
	Queue      []meetingTurn          `json:"queue,omitempty"`
	Seen       map[string]int         `json:"seen,omitempty"`
	// Grant is the one call to write the conclusion the user allowed, beyond the batch when it is used up.
	Grant bool   `json:"grant,omitempty"`
	EndOp string `json:"endOp,omitempty"`
}

// meetingTurn is someone due to speak: called on by the user, by the chair, or the chair writing the conclusion.
type meetingTurn struct {
	Speaker string `json:"speaker"`
	ByUser  bool   `json:"byUser,omitempty"`
	Summary bool   `json:"summary,omitempty"`
}

func meetingKey(subID, replicaID string) string { return "meeting:" + subID + ":" + replicaID }

// speaking says whether a conversation is a meeting participant's who is speaking now: it stays in memory meanwhile.
func (e *Engine) speaking(key string) bool {
	rest, ok := strings.CutPrefix(key, "meeting:")
	if !ok {
		return false
	}
	sub, who, _ := strings.Cut(rest, ":")
	r := e.runs[sub]
	return r != nil && r.replicaID == who
}

// meetingOf is a run's meeting, when it is one held in the conversation.
func meetingOf(s *model.SubTask) *model.Meeting {
	if s == nil || s.Meeting == nil || s.Meeting.Version != meetingVersion {
		return nil
	}
	return s.Meeting
}

// stateOf is a copy of a meeting's private record, to change and put back with keepState.
func (e *Engine) stateOf(t *model.Task, id string) meetingState {
	l := e.logOf(t.ID)
	if l == nil {
		return meetingState{}
	}
	st := clone(l.Meetings[id])
	if st.Seen == nil {
		st.Seen = map[string]int{}
	}
	return st
}

func (e *Engine) keepState(t *model.Task, id string, st meetingState) {
	l := e.editLog(t.ID)
	if l.Meetings == nil {
		l.Meetings = map[string]meetingState{}
	}
	l.Meetings[id] = st
}

// meetingBusy says whether the task holds a meeting already, of either kind.
func (e *Engine) meetingBusy(t *model.Task) bool {
	if t.Coordination.ActiveMeetingID != "" {
		return true
	}
	for _, s := range e.subsOf(t.ID) {
		if s.Meeting == nil && s.Talk != nil && s.Talk.Ended == "" && current(s) && s.Status != enum.StatusComplete && s.ExecutionState != model.ExecStopped {
			return true
		}
	}
	return false
}

// meetingPeople checks who a meeting is asked for: allowed employees besides the owner, each once, 1 to meetingMost.
func (e *Engine) meetingPeople(t *model.Task, asked []string) ([]string, error) {
	owner := e.owner(t)
	if owner == nil {
		return nil, model.Errorf(model.CodeConflict, "要先選這個任務的負責人")
	}
	people := []string{}
	for _, id := range asked {
		if id == owner.ID || slices.Contains(people, id) {
			continue
		}
		if !e.authorized(t, id) {
			return nil, model.Errorf("forbidden", "這位員工沒有被授權參與這個任務，要先問使用者")
		}
		people = append(people, id)
	}
	if len(people) < 1 || len(people) > meetingMost {
		return nil, model.Errorf(model.CodeInvalid, "會議要有負責人加 1 到 %d 位員工", meetingMost)
	}
	return people, nil
}

// meetingRules are what everyone in a meeting is told; the chair and the others each get theirs after.
const (
	meetingRules = "You are in a meeting of a task, held in the task's conversation, where the user reads and may speak. " +
		"You only talk and read: you change no files, run nothing, hand off nothing and keep no notes. " +
		"Each message you get ends with a note on who is in the meeting and who speaks now; what others said comes before it, each line starting with who said it. " +
		"Answer in plain words, short and to the point, as yourself. " + othersRule + "\n"
	chairRules = "You chair the meeting as the task's owner. Speak with your reply, call on employees with meeting_ask (they answer in order, then you speak again), " +
		"and close it with end_meeting and its conclusion (what was decided and what is still open) once the topic is settled or the user asks. " +
		"Do not call on everyone after every message: only whom the question needs.\n"
	memberRules = "The task's owner chairs. Answer what you were asked; do not run the meeting.\n"
)

// meetingSpeaker fixes how one participant is asked for the whole meeting: their prompt, with their memory as it is
// now, and the read-only tools of their blueprint.
func (e *Engine) meetingSpeaker(t *model.Task, r *model.Replica, chair bool) (system string, allowed []enum.Tool, p model.MeetingParticipant, err error) {
	bp := e.w.Blueprints[r.BlueprintID]
	if bp == nil {
		return "", nil, p, model.Errorf(model.CodeInvalid, "%s 的員工藍圖已不存在，請編輯這位員工，重新選擇藍圖", r.Name)
	}
	spec, err := e.modelSpec(r.Model, r.Effort)
	if err != nil {
		return "", nil, p, err
	}
	team := e.w.Teams[t.TeamID]
	e.readPrompt(team)
	rules := meetingRules
	if chair {
		rules += chairRules
	} else {
		rules += memberRules
	}
	parts := promptParts{
		rules:  rules + languageRule(e.w.Language) + "\n" + dataRule + "\n" + unseenThinkingRule + "\n",
		shared: sharedRules(e.runGlobalPrompt(), team.Prompt),
		role:   e.rolePart(bp),
		memory: memorySection(r),
	}
	allowed = slices.DeleteFunc(slices.Clone(bp.Tools), func(x enum.Tool) bool { return x != enum.ToolReadFile && x != enum.ToolWebSearch })
	p = model.MeetingParticipant{ReplicaID: r.ID, Name: r.Name, Look: r.Look, Model: spec.model, Effort: spec.effort}
	return parts.compose("", nil), allowed, p, nil
}

// openMeeting makes a run of the task a meeting held in its conversation, the owner chairing. Call it holding the
// lock, in a change that is undone when it fails.
func (e *Engine) openMeeting(t *model.Task, s *model.SubTask, topic, background string, people []string) error {
	if e.meetingBusy(t) {
		return model.Errorf(model.CodeConflict, "這個任務已經在開會，同時只能有一場會議")
	}
	chair := e.owner(t)
	if chair == nil {
		return model.Errorf(model.CodeConflict, "要先選這個任務的負責人")
	}
	st := meetingState{Topic: topic, Background: background, System: map[string]string{}, Allowed: map[string][]enum.Tool{},
		Queue: []meetingTurn{{Speaker: chair.ID}}, Seen: map[string]int{}}
	var participants []model.MeetingParticipant
	for i, id := range append([]string{chair.ID}, people...) {
		r := e.w.Replicas[id]
		if r == nil {
			return model.Errorf(model.CodeNotFound, "找不到員工")
		}
		system, allowed, p, err := e.meetingSpeaker(t, r, i == 0)
		if err != nil {
			return err
		}
		st.System[id], st.Allowed[id] = system, allowed
		participants = append(participants, p)
	}
	s.ReplicaID = ptr(chair.ID)
	s.Meeting = &model.Meeting{Version: meetingVersion, ID: s.ID, Topic: topic, ChairID: chair.ID, Participants: participants,
		State: model.MeetingOpen, Revision: 1, Batch: 1, StartedAt: e.w.Now}
	s.Status = enum.StatusProgressing
	s.ExecutionState = model.ExecRunning
	s.RunGeneration++
	if s.StartedAt == nil {
		s.StartedAt = ptr(e.w.Now)
	}
	e.keepState(t, s.ID, st)
	t.Coordination.ActiveMeetingID = s.ID
	e.systemEvent(t, "meetingCalled", i18n.T("負責人召開會議：%s", topic), map[string]any{"topic": topic, "owner": chair.Name}, s.ID)
	return nil
}

// meetingTranscript is what was said in a meeting, in order: the user's words and everyone's speech, not its
// conclusion and nothing else of the task.
func (e *Engine) meetingTranscript(t *model.Task, id string) ([]model.TaskActivity, error) {
	all, err := e.activities(t.ID)
	if err != nil {
		return nil, err
	}
	var out []model.TaskActivity
	for _, a := range all {
		if a.MeetingID == id && a.MeetingVersion == meetingVersion && a.MeetingPart == meetingSpeech {
			out = append(out, a)
		}
	}
	return out, nil
}

// meetingNote is what changes each time someone speaks: who is here and who speaks now. It goes last in what is
// sent, after everything before it, so nothing already sent changes.
func meetingNote(m *model.Meeting, turn meetingTurn, next []meetingTurn) string {
	name := func(id string) string {
		for _, p := range m.Participants {
			if p.ReplicaID == id {
				n := p.Name
				if id == m.ChairID {
					n += " (chair)"
				}
				if id == turn.Speaker {
					n += " (you)"
				}
				return n
			}
		}
		return id
	}
	here := make([]string, len(m.Participants))
	for i, p := range m.Participants {
		here[i] = name(p.ReplicaID)
	}
	var b strings.Builder
	fmt.Fprintf(&b, "[Meeting note] In it: %s. ", strings.Join(here, ", "))
	switch {
	case turn.Summary:
		b.WriteString("The meeting is ending: write its conclusion now, what was decided and what is still open, as your reply or with end_meeting. Call no other tool.")
	case turn.Speaker == m.ChairID:
		b.WriteString("You speak now, as chair.")
	default:
		b.WriteString("You speak now.")
	}
	var after []string
	for _, x := range next {
		after = append(after, name(x.Speaker))
	}
	if len(after) > 0 {
		fmt.Fprintf(&b, " After you: %s.", strings.Join(after, ", "))
	}
	return b.String()
}

// meetingInput adds to a participant's conversation what they have not read yet and the note, as one new message,
// and returns the conversation to send. Call it holding the lock, with the conversation loaded.
func (e *Engine) meetingInput(t *model.Task, s *model.SubTask, st *meetingState, turn meetingTurn) ([]model.Message, error) {
	m := s.Meeting
	key := meetingKey(s.ID, turn.Speaker)
	conv := e.w.Conversations[key]
	var blocks []model.Block
	if len(conv) == 0 {
		opening := "# Meeting\nTopic: " + st.Topic
		if st.Background != "" {
			opening += "\n\n## Background from the chair\n" + st.Background
		}
		blocks = append(blocks, model.Block{Type: enum.BlockText, Text: opening})
	}
	said, err := e.meetingTranscript(t, s.ID)
	if err != nil {
		return nil, err
	}
	for _, a := range said[min(st.Seen[turn.Speaker], len(said)):] {
		if a.From != "user" && a.By == turn.Speaker {
			continue // their own words are already theirs
		}
		who := a.Name
		if a.From == "user" {
			who = "The user"
		}
		text := who + ": " + a.Text
		if len(a.Mentions) > 0 {
			var to []string
			for _, id := range a.Mentions {
				to = append(to, e.participantName(m, id))
			}
			text += "\n(asks " + strings.Join(to, ", ") + " to answer)"
		}
		for _, f := range a.Files {
			text += "\nAttached file: " + f.Name + ", read-only path: " + e.attachmentPath(t.ID, f)
		}
		for _, im := range a.Images {
			text += "\nAttached image: " + im.Name
		}
		blocks = append(blocks, model.Block{Type: enum.BlockText, Text: text})
	}
	st.Seen[turn.Speaker] = len(said)
	blocks = append(blocks, model.Block{Type: enum.BlockText, Text: meetingNote(m, turn, st.Queue[1:])})
	before := len(conv)
	// calls a reply left open get their results first, in the same message as what follows: the chair's own tools did
	// what they said, anything else was cut off
	conv = closeCalls(slices.Clone(conv), "", func(b model.Block) (string, bool, bool) {
		switch b.Name {
		case toolMeetingAsk:
			return "Asked; what they said follows.", false, true
		case toolEndMeeting:
			return "Not ended: the user wrote since; see below.", false, true
		}
		return "", false, false
	})
	if len(conv) > before {
		last := conv[len(conv)-1]
		last.Content = append(slices.Clone(last.Content), blocks...)
		conv[len(conv)-1] = last
	} else {
		conv = append(conv, model.Message{Role: enum.RoleUser, Content: blocks})
	}
	e.w.Conversations[key] = conv
	e.dirty[key] = true
	return slices.Clone(conv), nil
}

func (e *Engine) participantName(m *model.Meeting, id string) string {
	for _, p := range m.Participants {
		if p.ReplicaID == id {
			return p.Name
		}
	}
	return e.replicaName(id)
}

// launchMeeting has the next one in a task's meeting speak, when nothing holds it. Call it holding the lock.
func (e *Engine) launchMeeting(t *model.Task) bool {
	s := e.w.SubTasks[t.Coordination.ActiveMeetingID]
	m := meetingOf(s)
	if m == nil || e.runs[s.ID] != nil || e.closed || t.Stage != enum.StageRunning {
		return false
	}
	switch {
	case m.State == model.MeetingOpen && !t.Paused:
	case m.State == model.MeetingClosing:
	default:
		return false
	}
	st := e.stateOf(t, s.ID)
	if len(st.Queue) == 0 {
		return false
	}
	turn := st.Queue[0]
	r := e.w.Replicas[turn.Speaker]
	if !model.WorksIn(r, t.TeamID) {
		e.holdMeeting(t, s, pauseUnavailable, &model.OperationError{Code: model.CodeNotFound, Message: i18n.T("與會的員工已不在")})
		return true
	}
	var p model.MeetingParticipant
	for _, x := range m.Participants {
		if x.ReplicaID == turn.Speaker {
			p = x
		}
	}
	spec, err := e.modelSpec(p.Model, p.Effort)
	if err != nil {
		e.holdMeeting(t, s, pauseUnavailable, opError(err))
		return true
	}
	spec.effort = p.Effort
	key := meetingKey(s.ID, turn.Speaker)
	if err := e.loadConversation(key); err != nil {
		e.holdMeeting(t, s, pauseRecovery, opError(err))
		return true
	}
	conv, err := e.meetingInput(t, s, &st, turn)
	if err != nil {
		e.holdMeeting(t, s, pauseRecovery, opError(err))
		return true
	}
	e.keepState(t, s.ID, st)
	m.SpeakerID = turn.Speaker
	m.Revision++
	timeout := time.Duration(e.w.Teams[t.TeamID].Settings.TimeoutMin * float64(time.Minute))
	ctx, cancel := context.WithCancel(e.ctx)
	if timeout > 0 {
		ctx, cancel = context.WithTimeout(e.ctx, timeout)
	}
	rn := &run{cancel: cancel, replicaID: turn.Speaker}
	e.runs[s.ID] = rn
	team := e.w.Teams[t.TeamID]
	in := &meetingRun{r: rn, taskID: t.ID, subID: s.ID, turn: turn, key: key, spec: spec, system: st.System[turn.Speaker],
		allowed: st.Allowed[turn.Speaker], chair: turn.Speaker == m.ChairID, conv: conv,
		folder: team.Folder, dir: e.worktreeOf(t), branch: t.Branch, target: team.TargetBranch}
	e.wg.Add(1)
	go e.runMeeting(ctx, in)
	return true
}

func opError(err error) *model.OperationError {
	out := &model.OperationError{Code: model.CodeUnavailable, Message: safeText(err)}
	var known *model.Error
	if errors.As(err, &known) {
		out.Code = known.Code
	}
	return out
}

// meetingRun is one participant speaking once: a model call and the tools it calls, until they have said it.
type meetingRun struct {
	r                           *run
	taskID, subID, key          string
	turn                        meetingTurn
	spec                        agentSpec
	system                      string
	allowed                     []enum.Tool
	chair                       bool
	conv                        []model.Message
	folder, dir, branch, target string
}

// errMeetingHeld is a call the meeting did not make: it waits for the user, as it says.
var errMeetingHeld = errors.New("meeting held")

// meetingGate counts each call of a meeting before it is made, retries and tool rounds alike.
type meetingGate struct {
	adapter.Provider
	e  *Engine
	in *meetingRun
}

func (g meetingGate) Complete(ctx context.Context, req model.ModelRequest, onText func(string)) (model.ModelReply, error) {
	if err := g.e.meetingCall(g.in); err != nil {
		return model.ModelReply{}, err
	}
	reply, err := g.Provider.Complete(ctx, req, onText)
	// Every attempted call is charged, including failed retries and replies returned after cancellation.
	g.e.meetingUsage(g.in, reply.Usage)
	return reply, err
}

// meetingUsage is independent of the run's authority to publish speech. Providers can return usage with an error.
func (e *Engine) meetingUsage(in *meetingRun, usage model.ModelUsage) {
	e.mu.Lock()
	defer e.mu.Unlock()
	t, s := e.w.Tasks[in.taskID], e.w.SubTasks[in.subID]
	if t == nil || meetingOf(s) == nil {
		return
	}
	s.Tokens += tokensUsed(usage)
	if in.spec.price != nil {
		s.CostUSD += cost(usage, *in.spec.price)
	} else if !in.spec.subscription {
		s.Unpriced = true
	}
	if !s.Meeting.Over() && e.taskCost(t) >= e.costLimit(t) {
		e.budgetHold(t)
	}
	e.settle()
}

// meetingCall counts a call about to be made, saved before it is; when the batch is used up or the budget is, the
// meeting waits for the user instead.
func (e *Engine) meetingCall(in *meetingRun) error {
	held := false
	err := e.do(func() error {
		t, s := e.w.Tasks[in.taskID], e.w.SubTasks[in.subID]
		m := meetingOf(s)
		if e.runs[in.subID] != in.r || in.r.stopping || t == nil || m == nil {
			held = true
			return nil
		}
		if e.taskCost(t) >= e.costLimit(t) {
			e.budgetHold(t)
			held = true
			return nil
		}
		st := e.stateOf(t, s.ID)
		switch {
		case in.turn.Summary && st.Grant:
			st.Grant = false
			e.keepState(t, s.ID, st)
			if m.CallsInBatch < meetingBatch {
				m.CallsInBatch++
			}
		case m.CallsInBatch >= meetingBatch:
			e.meetingLimit(t, s)
			held = true
			return nil
		default:
			m.CallsInBatch++
		}
		m.CallsTotal++
		m.Revision++
		return nil
	})
	if err != nil {
		return err
	}
	if held {
		return errMeetingHeld
	}
	return nil
}

// meetingLimit stops a meeting whose batch of calls is used up; the user says whether it goes on.
func (e *Engine) meetingLimit(t *model.Task, s *model.SubTask) {
	m := s.Meeting
	if m.State == model.MeetingPaused && m.PauseReason == pauseLimit {
		return
	}
	e.holdMeeting(t, s, pauseLimit, nil)
	e.systemEvent(t, "meetingLimitReached", i18n.T("會議「%s」已用完這一輪的 %d 次模型呼叫，等你決定是否繼續", m.Topic, meetingBatch),
		map[string]any{"topic": m.Topic, "limit": meetingBatch}, s.ID)
}

// holdMeeting stops what a meeting is doing; it waits for the user, keeping who was due to speak. A meeting being
// closed goes on with its conclusion through a pause of the task, as it only reads.
func (e *Engine) holdMeeting(t *model.Task, s *model.SubTask, reason string, failure *model.OperationError) {
	m := meetingOf(s)
	if m == nil || m.Over() || m.State == model.MeetingSummaryFailed {
		return
	}
	if m.State == model.MeetingClosing && reason == pauseTaskPaused {
		return
	}
	if m.State == model.MeetingPaused && reason == pauseTaskPaused {
		return
	}
	e.stopRun(s.ID)
	if m.State == model.MeetingClosing {
		m.ClosingRequested = true
	}
	m.State, m.PauseReason, m.SpeakerID, m.Error = model.MeetingPaused, reason, "", failure
	m.Revision++
	st := e.stateOf(t, s.ID)
	if st.EndOp != "" && reason != pauseLimit {
		e.setOperation(t, st.EndOp, model.OpFailed, failure)
		st.EndOp = ""
		e.keepState(t, s.ID, st)
	}
}

// holdMeetings stops the task's meeting with the task: paused or out of budget.
func (e *Engine) holdMeetings(t *model.Task, reason string) {
	if s := e.w.SubTasks[t.Coordination.ActiveMeetingID]; meetingOf(s) != nil {
		e.holdMeeting(t, s, reason, nil)
	}
}

// cancelMeeting ends a meeting with no conclusion: the task was cancelled or its run stopped.
func (e *Engine) cancelMeeting(t *model.Task, s *model.SubTask) {
	m := meetingOf(s)
	if m == nil || m.Over() {
		return
	}
	e.stopRun(s.ID)
	m.State, m.SpeakerID, m.EndedAt = model.MeetingCancelled, "", ptr(e.w.Now)
	m.Revision++
	st := e.stateOf(t, s.ID)
	if st.EndOp != "" {
		e.setOperation(t, st.EndOp, model.OpFailed, &model.OperationError{Code: model.CodeConflict, Message: i18n.T("會議已取消")})
	}
	st.Queue, st.Grant, st.EndOp = nil, false, ""
	e.keepState(t, s.ID, st)
	if t.Coordination.ActiveMeetingID == s.ID {
		t.Coordination.ActiveMeetingID = ""
	}
	if s.Status == enum.StatusProgressing {
		s.Status = enum.StatusTodo
	}
	s.ExecutionState = model.ExecStopped
}

// closeMeeting stops the discussion and has the chair write the conclusion. grant is the one call the user allowed
// for it; without one it counts as any other.
func (e *Engine) closeMeeting(t *model.Task, s *model.SubTask, grant bool, op string) {
	m := s.Meeting
	e.stopRun(s.ID)
	st := e.stateOf(t, s.ID)
	st.Queue = []meetingTurn{{Speaker: m.ChairID, Summary: true}}
	st.Grant = grant
	if op != "" {
		st.EndOp = op
	}
	e.keepState(t, s.ID, st)
	m.State, m.PauseReason, m.SpeakerID, m.Error = model.MeetingClosing, "", "", nil
	m.Revision++
	if e.taskCost(t) >= e.costLimit(t) {
		e.holdMeeting(t, s, pauseBudget, &model.OperationError{Code: model.CodeConflict, Message: i18n.T("費用已達上限")})
	}
}

// endMeeting closes a meeting with the chair's conclusion: the only thing of it the owner's own conversation gets.
func (e *Engine) endMeeting(t *model.Task, s *model.SubTask, summary string) {
	m := s.Meeting
	a := e.addActivity(t, model.TaskActivity{Kind: "meeting", From: "agent", Text: summary, By: m.ChairID, Name: e.participantName(m, m.ChairID),
		SubID: s.ID, NodeID: s.NodeID, MeetingID: s.ID, MeetingVersion: meetingVersion, MeetingPart: meetingSummary})
	m.Summary, m.SummaryActivity, m.State, m.SpeakerID, m.PauseReason, m.Error = summary, a.ID, model.MeetingEnded, "", "", nil
	m.EndedAt = ptr(e.w.Now)
	m.Revision++
	st := e.stateOf(t, s.ID)
	if st.EndOp != "" {
		e.setOperation(t, st.EndOp, model.OpApplied, nil)
	}
	st.Queue, st.Grant, st.EndOp = nil, false, ""
	e.keepState(t, s.ID, st)
	if t.Coordination.ActiveMeetingID == s.ID {
		t.Coordination.ActiveMeetingID = ""
	}
	s.Status, s.Progress, s.ExecutionState = enum.StatusComplete, 1, ""
	s.EndedAt = ptr(e.w.Now)
	s.Handoff = &model.Handoff{
		Agent: model.AgentHandoff{Goal: m.Topic, Done: []string{summary}, Outputs: []string{}, Decisions: []string{}, Open: []string{}},
		Human: model.HumanSummary{Headline: clip(summary, 300), Did: []string{}, Outputs: []string{}},
	}
	s.OwnerReview = model.ReviewPending
	s.Routed = true
	e.systemEvent(t, "meetingEnded", i18n.T("會議結束：%s", m.Topic), map[string]any{"topic": m.Topic}, s.ID)
	e.addEvent(t, ownerEvent{Kind: evMeetingEnded, Key: "meeting:" + s.ID, SubID: s.ID,
		Text: "The meeting " + s.ID + " on \"" + m.Topic + "\" ended. Its conclusion:\n" + summary + "\nReview it with review_step."})
}

// runMeeting is one participant speaking. Its goroutine is the engine's, ending with its context.
func (e *Engine) runMeeting(ctx context.Context, in *meetingRun) {
	defer e.wg.Done()
	defer in.r.cancel()
	finish := func(fn func(t *model.Task, s *model.SubTask)) {
		e.mu.Lock()
		defer e.mu.Unlock()
		if e.runs[in.subID] != in.r {
			return
		}
		delete(e.runs, in.subID)
		delete(e.live, in.subID)
		t, s := e.w.Tasks[in.taskID], e.w.SubTasks[in.subID]
		if t == nil || meetingOf(s) == nil {
			return
		}
		e.w.Now = e.clock()
		if e.closed {
			// Preserve the interrupted speaker for recovery, including a summary in flight.
			e.settle()
			return
		}
		if in.r.stopping {
			e.settle()
			return
		}
		if s.Meeting.SpeakerID == in.turn.Speaker {
			s.Meeting.SpeakerID = ""
		}
		fn(t, s)
		e.settle()
	}
	defer finish(func(*model.Task, *model.SubTask) {}) // ended without saying how: who was due speaks again when allowed
	if err := e.git.Worktree(ctx, in.folder, in.dir, in.branch, in.target); err != nil && ctx.Err() == nil {
		e.log.Error().Err(err).Str("sub", in.subID).Msg("make work tree")
		finish(func(t *model.Task, s *model.SubTask) {
			e.meetingFailed(t, s, in, model.Errorf(model.CodeInvalid, "建立 work tree 失敗（分支 %s）", in.branch))
		})
		return
	}
	tr := e.meetingTurn(in)
	res, err := tr.run(ctx)
	switch {
	case errors.Is(err, errMeetingHeld):
		finish(func(*model.Task, *model.SubTask) {})
	case err != nil && ctx.Err() != nil && !errors.Is(ctx.Err(), context.DeadlineExceeded):
		// stopped on purpose; whoever stopped it moved the meeting on
	case err != nil:
		if errors.Is(ctx.Err(), context.DeadlineExceeded) {
			err = model.Errorf(model.CodeUnavailable, "執行逾時")
		}
		finish(func(t *model.Task, s *model.SubTask) { e.meetingFailed(t, s, in, err) })
	case res.Stopped:
		finish(func(t *model.Task, s *model.SubTask) { e.afterCall(t, s) })
	default:
		finish(func(t *model.Task, s *model.SubTask) { e.meetingSaid(t, s, in, strings.TrimSpace(res.Text)) })
	}
}

// meetingSaid is a participant done speaking: their words go into the conversation, or the conclusion ends it.
func (e *Engine) meetingSaid(t *model.Task, s *model.SubTask, in *meetingRun, text string) {
	m := s.Meeting
	if in.turn.Summary {
		if m.State != model.MeetingClosing {
			return
		}
		if text == "" {
			e.summaryFailed(t, s, &model.OperationError{Code: model.CodeUnavailable, Message: i18n.T("模型沒有回覆內容")})
			return
		}
		e.endMeeting(t, s, text)
		return
	}
	if m.State != model.MeetingOpen {
		return
	}
	st := e.stateOf(t, s.ID)
	if len(st.Queue) > 0 && st.Queue[0] == in.turn {
		st.Queue = st.Queue[1:]
	}
	e.keepState(t, s.ID, st)
	if text != "" {
		e.addActivity(t, model.TaskActivity{Kind: "meeting", From: "agent", Text: text, By: in.turn.Speaker, Name: e.participantName(m, in.turn.Speaker),
			SubID: s.ID, NodeID: s.NodeID, MeetingID: s.ID, MeetingVersion: meetingVersion, MeetingPart: meetingSpeech})
	}
	m.Revision++
	e.afterCall(t, s)
}

// afterCall stops a meeting that used up its batch, before anyone speaks again.
func (e *Engine) afterCall(t *model.Task, s *model.SubTask) {
	if m := s.Meeting; (m.State == model.MeetingOpen || m.State == model.MeetingClosing) && m.CallsInBatch >= meetingBatch {
		st := e.stateOf(t, s.ID)
		if m.State == model.MeetingClosing && st.Grant {
			return
		}
		e.meetingLimit(t, s)
	}
}

func (e *Engine) summaryFailed(t *model.Task, s *model.SubTask, failure *model.OperationError) {
	m := s.Meeting
	e.stopRun(s.ID)
	m.State, m.SpeakerID, m.Error, m.ClosingRequested = model.MeetingSummaryFailed, "", failure, true
	m.Revision++
	st := e.stateOf(t, s.ID)
	if st.EndOp != "" {
		e.setOperation(t, st.EndOp, model.OpFailed, failure)
	}
	st.Queue, st.Grant, st.EndOp = nil, false, ""
	e.keepState(t, s.ID, st)
	e.systemEvent(t, "meetingSummaryFailed", i18n.T("會議「%s」的結論沒有寫成：%s", m.Topic, failure.Message), map[string]any{"topic": m.Topic, "error": failure.Message}, s.ID)
}

// meetingFailed is a call that failed after its retries: the meeting waits for the user, who goes on or ends it.
func (e *Engine) meetingFailed(t *model.Task, s *model.SubTask, in *meetingRun, err error) {
	m := s.Meeting
	failure := opError(err)
	var known *model.Error
	switch {
	case m.State == model.MeetingClosing:
		e.summaryFailed(t, s, failure)
	case m.State != model.MeetingOpen:
	case errors.As(err, &known) && known.Code == model.CodeContextOverflow:
		e.holdMeeting(t, s, pauseContext, failure)
	default:
		name := e.participantName(m, in.turn.Speaker)
		e.holdMeeting(t, s, pauseFailed, failure)
		e.systemEvent(t, "meetingReplyFailed", i18n.T("會議「%s」中 %s 回覆失敗：%s", m.Topic, name, failure.Message),
			map[string]any{"topic": m.Topic, "name": name, "error": failure.Message}, s.ID)
	}
}

// meetingTurn is a participant's model-and-tools loop: read-only tools, and the chair's own, fixed for the meeting.
func (e *Engine) meetingTurn(in *meetingRun) *turn {
	list := tools.For(in.allowed, tools.Env{Read: []string{e.attachmentRoot(in.taskID)}, Search: e.search})
	if in.chair {
		list = append(list,
			ownerTool(toolMeetingAsk, "Call on employees in this meeting: text is what you say to them, and they answer in the order given; then you speak again.",
				`{"type":"object","properties":{"replica_ids":{"type":"array","items":{"type":"string"},"minItems":1},"text":{"type":"string"}},"required":["replica_ids","text"]}`, e.meetingAskTool(in)),
			ownerTool(toolEndMeeting, "End this meeting with its conclusion: what was decided and what is still open. It is what you get back as the task's owner.",
				`{"type":"object","properties":{"summary":{"type":"string"}},"required":["summary"]}`, e.endMeetingTool(in)))
	}
	specs := make([]model.ToolSpec, len(list))
	byName := make(map[string]adapter.Tool, len(list))
	for i, tool := range list {
		specs[i] = tool.Spec()
		byName[specs[i].Name] = tool
	}
	record := func(fn func(t *model.Task, s *model.SubTask)) bool {
		e.mu.Lock()
		defer e.mu.Unlock()
		if e.runs[in.subID] != in.r || in.r.stopping || e.closed {
			return false
		}
		t, s := e.w.Tasks[in.taskID], e.w.SubTasks[in.subID]
		if t == nil || meetingOf(s) == nil {
			return false
		}
		e.w.Now = e.clock()
		fn(t, s)
		e.settle()
		return true
	}
	return &turn{
		provider: meetingGate{Provider: in.spec.provider, e: e, in: in},
		req: model.ModelRequest{Cwd: in.dir, Session: in.key, Model: in.spec.model, Effort: in.spec.effort, System: in.system,
			Messages: in.conv, Tools: specs},
		tools: byName, cwd: in.dir, noRetry: in.turn.Summary,
		onStart: func() { e.restartLive(in.subID, in.r) },
		onText:  func(text string) { e.addLive(in.subID, in.r, text) },
		onReply: func(reply model.ModelReply) bool {
			goOn := false
			record(func(t *model.Task, s *model.SubTask) {
				// Match the turn's raw assistant message exactly, including across tool continuations.
				e.w.Conversations[in.key] = append(e.w.Conversations[in.key], model.Message{Role: enum.RoleAssistant, Content: reply.Content})
				e.dirty[in.key] = true
				if in.turn.Summary {
					// Validate before executing anything: malformed end_meeting must not buy a tool retry.
					calls := 0
					for _, b := range reply.Content {
						if b.Type != enum.BlockToolCall {
							continue
						}
						calls++
						var args struct {
							Summary string `json:"summary"`
						}
						if b.Name != toolEndMeeting || calls > 1 || json.Unmarshal(b.Args, &args) != nil || strings.TrimSpace(args.Summary) == "" {
							e.summaryFailed(t, s, &model.OperationError{Code: model.CodeInvalid, Message: i18n.T("寫結論時不能使用其他工具")})
							return
						}
					}
				}
				own := true // only the chair's own tools may run on the batch's last call, or while concluding
				for _, b := range reply.Content {
					if b.Type == enum.BlockToolCall && b.Name != toolEndMeeting && (in.turn.Summary || b.Name != toolMeetingAsk) {
						own = false
					}
				}
				switch {
				case in.turn.Summary && !own:
					e.summaryFailed(t, s, &model.OperationError{Code: model.CodeInvalid, Message: i18n.T("寫結論時不能使用其他工具")})
				case !own && s.Meeting.CallsInBatch >= meetingBatch:
					e.meetingLimit(t, s)
				default:
					goOn = true
				}
			})
			return goOn
		},
		onTool: func(model.Block) {},
		onResults: func(msg model.Message) {
			record(func(*model.Task, *model.SubTask) {
				e.w.Conversations[in.key] = append(e.w.Conversations[in.key], msg)
				e.dirty[in.key] = true
			})
		},
	}
}

// meetingChange runs a chair's tool under the lock, while their turn is still the meeting's.
func (e *Engine) meetingChange(in *meetingRun, fn func(t *model.Task, s *model.SubTask) (string, error)) model.ToolResult {
	var out string
	err := e.do(func() error {
		t, s := e.w.Tasks[in.taskID], e.w.SubTasks[in.subID]
		if e.runs[in.subID] != in.r || in.r.stopping || t == nil || meetingOf(s) == nil {
			out = "This turn was stopped."
			return nil
		}
		var err error
		out, err = fn(t, s)
		return err
	})
	if err != nil {
		return model.ToolResult{Text: safeText(err), IsError: true, Stop: true}
	}
	return model.ToolResult{Text: out, Stop: true}
}

func (e *Engine) meetingAskTool(in *meetingRun) func(context.Context, string, json.RawMessage) model.ToolResult {
	return func(_ context.Context, _ string, raw json.RawMessage) model.ToolResult {
		var a struct {
			ReplicaIDs []string `json:"replica_ids"`
			Text       string   `json:"text"`
		}
		if err := parseArgs(raw, &a); err != nil {
			return toolError("%s", safeText(err))
		}
		a.Text = strings.TrimSpace(a.Text)
		if a.Text == "" {
			return toolError("text is required")
		}
		var asked []string
		for _, id := range a.ReplicaIDs {
			if !slices.Contains(asked, id) {
				asked = append(asked, id)
			}
		}
		return e.meetingChange(in, func(t *model.Task, s *model.SubTask) (string, error) {
			m := s.Meeting
			if m.State != model.MeetingOpen || in.turn.Summary {
				return "", model.Errorf(model.CodeConflict, "會議正在結束，不能再點名")
			}
			for _, id := range asked {
				if id == m.ChairID || !m.Has(id) {
					return "", model.Errorf(model.CodeInvalid, "只能點名這場會議的與會員工")
				}
			}
			if len(asked) == 0 {
				return "", model.Errorf(model.CodeInvalid, "只能點名這場會議的與會員工")
			}
			e.addActivity(t, model.TaskActivity{Kind: "meeting", From: "agent", Text: a.Text, By: m.ChairID, Name: e.participantName(m, m.ChairID),
				SubID: s.ID, NodeID: s.NodeID, MeetingID: s.ID, MeetingVersion: meetingVersion, MeetingPart: meetingSpeech, Mentions: asked})
			st := e.stateOf(t, s.ID)
			if len(st.Queue) > 0 && st.Queue[0] == in.turn {
				st.Queue = st.Queue[1:]
			}
			// what the user asked meanwhile goes first; the chair's own calls follow
			n := 0
			for n < len(st.Queue) && st.Queue[n].ByUser {
				n++
			}
			chain := []meetingTurn{}
			for _, id := range asked {
				chain = append(chain, meetingTurn{Speaker: id})
			}
			chain = append(chain, meetingTurn{Speaker: m.ChairID})
			st.Queue = slices.Concat(st.Queue[:n], chain, st.Queue[n:])
			e.keepState(t, s.ID, st)
			m.Revision++
			e.afterCall(t, s)
			return "Asked; they answer in order, then you speak again.", nil
		})
	}
}

func (e *Engine) endMeetingTool(in *meetingRun) func(context.Context, string, json.RawMessage) model.ToolResult {
	return func(_ context.Context, _ string, raw json.RawMessage) model.ToolResult {
		var a struct {
			Summary string `json:"summary"`
		}
		if err := parseArgs(raw, &a); err != nil {
			return toolError("%s", safeText(err))
		}
		a.Summary = strings.TrimSpace(a.Summary)
		if a.Summary == "" {
			return toolError("summary is required")
		}
		return e.meetingChange(in, func(t *model.Task, s *model.SubTask) (string, error) {
			m := s.Meeting
			if m.State != model.MeetingOpen && m.State != model.MeetingClosing {
				return "", model.Errorf(model.CodeConflict, "這場會議現在不能結束")
			}
			said, err := e.meetingTranscript(t, s.ID)
			if err != nil {
				return "", err
			}
			st := e.stateOf(t, s.ID)
			// the user wrote after what the chair read: the conclusion must take it in
			if slices.ContainsFunc(said[min(st.Seen[m.ChairID], len(said)):], func(a model.TaskActivity) bool { return a.From == "user" }) {
				if !in.turn.Summary {
					e.closeMeeting(t, s, false, "")
				} else {
					st.Queue = []meetingTurn{{Speaker: m.ChairID, Summary: true}}
					e.keepState(t, s.ID, st)
				}
				return "The user wrote since; you are asked for the conclusion again with what they said.", nil
			}
			e.endMeeting(t, s, a.Summary)
			return "The meeting ended.", nil
		})
	}
}

// ---------- the user in a meeting ----------

// sayInMeeting puts the user's words into the meeting under way: those they mention answer in order, or the chair.
// Call it holding the lock.
func (e *Engine) sayInMeeting(t *model.Task, in TaskMessage, text string, print string) (MessageResult, error) {
	c := t.Coordination
	s := e.w.SubTasks[in.MeetingID]
	m := meetingOf(s)
	if c.ActiveMeetingID == "" || in.MeetingID != c.ActiveMeetingID || m == nil || s.TaskID != t.ID {
		return MessageResult{}, model.Errorf(model.CodeConflict, "這場會議已結束，訊息沒有送出")
	}
	switch m.State {
	case model.MeetingOpen, model.MeetingPaused:
		if m.ClosingRequested {
			return MessageResult{}, model.Errorf(model.CodeConflict, "會議正在結束，不能再發言")
		}
	default:
		return MessageResult{}, model.Errorf(model.CodeConflict, "會議正在結束，不能再發言")
	}
	var mentions []string
	for _, id := range in.Mentions {
		if !m.Has(id) {
			return MessageResult{}, model.Errorf(model.CodeInvalid, "只能指定這場會議的與會者")
		}
		if !slices.Contains(mentions, id) {
			mentions = append(mentions, id)
		}
	}
	if err := e.checkFiles(in.Images, in.Files); err != nil {
		return MessageResult{}, err
	}
	images, err := e.storeImages(in.Images)
	if err != nil {
		return MessageResult{}, err
	}
	if err := e.saveAttachments(t.ID, in.Files); err != nil {
		return MessageResult{}, err
	}
	op := e.newOperation(t, model.TaskOperation{Kind: "message", RequestID: in.RequestID, Status: model.OpApplied, SubID: s.ID})
	a := e.addActivity(t, model.TaskActivity{Kind: "meeting", From: "user", Text: text, Images: images, Files: in.Files, OperationID: op.ID,
		SubID: s.ID, NodeID: s.NodeID, MeetingID: s.ID, MeetingVersion: meetingVersion, MeetingPart: meetingSpeech, Mentions: mentions})
	l := e.editLog(t.ID)
	op.MessageID = a.ID
	l.Operations[op.ID] = op
	e.showOperations(t)
	l.Requests[in.RequestID] = requestRecord{Fingerprint: print, OperationID: op.ID, ActivityID: a.ID}
	answer := mentions
	if len(answer) == 0 {
		answer = []string{m.ChairID}
	}
	st := e.stateOf(t, s.ID)
	n := 0
	if len(st.Queue) > 0 && (m.SpeakerID != "" || m.State == model.MeetingPaused) {
		n = 1 // who speaks now, or was cut off, finishes first
	}
	for n < len(st.Queue) && st.Queue[n].ByUser {
		n++
	}
	var turns []meetingTurn
	for _, id := range answer {
		turns = append(turns, meetingTurn{Speaker: id, ByUser: true})
	}
	st.Queue = slices.Concat(st.Queue[:n], turns, st.Queue[n:])
	e.keepState(t, s.ID, st)
	m.Revision++
	return MessageResult{Operation: op, Activity: a}, nil
}

// MeetingControl is the user going on with a meeting past its pause, ending it, or asking again for its conclusion.
type MeetingControl struct {
	RequestID string `json:"requestId"`
	Action    string `json:"action"`
	Revision  int    `json:"revision"`
}

// ControlMeeting does what the user asked of a task's meeting.
func (e *Engine) ControlMeeting(taskID, meetingID string, in MeetingControl) (model.TaskOperation, error) {
	var out model.TaskOperation
	err := e.do(func() error {
		if err := checkRequestID(in.RequestID); err != nil {
			return err
		}
		t, err := e.ownerTask(taskID)
		if err != nil {
			return err
		}
		s := e.w.SubTasks[meetingID]
		m := meetingOf(s)
		if m == nil || s.TaskID != t.ID {
			return model.Errorf(model.CodeNotFound, "找不到這場會議")
		}
		print := fingerprint([]any{"meeting", meetingID, in.Action, in.Revision})
		if op, _, err := e.replay(t, in.RequestID, print); err != nil || op != nil {
			if op != nil {
				out = *op
			}
			return err
		}
		kinds := map[string]string{"continue": "meetingContinue", "end": "meetingEnd", "retrySummary": "meetingRetrySummary"}
		kind, ok := kinds[in.Action]
		if !ok {
			return model.Errorf(model.CodeInvalid, "不認識的操作")
		}
		if in.Revision < 1 || in.Revision > m.Revision || in.Action != "end" && in.Revision != m.Revision {
			return model.Errorf(model.CodeConflict, "會議已更新，請確認最新狀態再操作")
		}
		var op model.TaskOperation
		switch in.Action {
		case "continue":
			if err := e.mayContinue(t, m); err != nil {
				return err
			}
			op = e.newOperation(t, model.TaskOperation{Kind: kind, RequestID: in.RequestID, Status: model.OpApplied, SubID: s.ID})
			if m.CallsInBatch >= meetingBatch {
				m.Batch++
				m.CallsInBatch = 0
				e.systemEvent(t, "meetingContinued", i18n.T("會議「%s」繼續第 %d 輪", m.Topic, m.Batch), map[string]any{"topic": m.Topic, "batch": m.Batch}, s.ID)
			}
			m.State, m.PauseReason, m.Error = model.MeetingOpen, "", nil
			m.Revision++
		case "end":
			switch {
			case m.Over():
				return model.Errorf(model.CodeConflict, "這場會議已結束")
			case m.State == model.MeetingClosing:
				return model.Errorf(model.CodeConflict, "會議正在結束")
			case m.State == model.MeetingSummaryFailed || m.ClosingRequested:
				return model.Errorf(model.CodeConflict, "結論沒有寫成，請按重試")
			}
			op = e.newOperation(t, model.TaskOperation{Kind: kind, RequestID: in.RequestID, Status: model.OpProcessing, SubID: s.ID})
			m.ClosingRequested = true
			e.closeMeeting(t, s, true, op.ID)
		case "retrySummary":
			if m.State != model.MeetingSummaryFailed && !(m.State == model.MeetingPaused && m.ClosingRequested) {
				return model.Errorf(model.CodeConflict, "這場會議現在不能重試結論")
			}
			if e.taskCost(t) >= e.costLimit(t) {
				return model.Errorf(model.CodeConflict, "費用已達上限")
			}
			op = e.newOperation(t, model.TaskOperation{Kind: kind, RequestID: in.RequestID, Status: model.OpProcessing, SubID: s.ID})
			e.closeMeeting(t, s, true, op.ID)
		}
		e.editLog(t.ID).Requests[in.RequestID] = requestRecord{Fingerprint: print, OperationID: op.ID}
		out = e.logOf(t.ID).Operations[op.ID]
		return nil
	})
	return out, err
}

// mayContinue says why a paused meeting cannot go on now, or nil.
func (e *Engine) mayContinue(t *model.Task, m *model.Meeting) error {
	switch {
	case m.State != model.MeetingPaused:
		return model.Errorf(model.CodeConflict, "這場會議沒有暫停")
	case m.ClosingRequested:
		return model.Errorf(model.CodeConflict, "結論沒有寫成，請按重試")
	case t.Paused:
		return model.Errorf(model.CodeConflict, "任務已暫停，要先繼續任務")
	case e.taskCost(t) >= e.costLimit(t) || held(t.Coordination):
		return model.Errorf(model.CodeConflict, "費用已達上限")
	case m.PauseReason == pauseContext:
		return model.Errorf(model.CodeConflict, "會議內容超過模型能讀的長度，只能結束會議")
	}
	for _, p := range m.Participants {
		if r := e.w.Replicas[p.ReplicaID]; !model.WorksIn(r, t.TeamID) {
			return model.Errorf(model.CodeConflict, "與會的員工已不在")
		}
		if _, err := e.modelSpec(p.Model, p.Effort); err != nil {
			return model.Errorf(model.CodeConflict, "%s", safeText(err))
		}
	}
	return nil
}

// MeetingActivity reads a page of one meeting's words and conclusion, oldest first, by the conversation's seq.
func (e *Engine) MeetingActivity(taskID, meetingID string, before, limit int, version string) (ActivityPage, error) {
	e.mu.Lock()
	defer e.mu.Unlock()
	t, err := e.ownerTask(taskID)
	if err != nil {
		return ActivityPage{}, err
	}
	if s := e.w.SubTasks[meetingID]; s == nil || s.TaskID != t.ID {
		return ActivityPage{}, model.Errorf(model.CodeNotFound, "找不到這場會議")
	}
	if limit == 0 {
		limit = activityDefault
	}
	if limit < 1 || limit > activityMost || before < 0 {
		return ActivityPage{}, model.Errorf(model.CodeInvalid, "分頁參數不正確")
	}
	all, err := e.activities(t.ID)
	if err != nil {
		return ActivityPage{}, err
	}
	var mine []model.TaskActivity
	for _, a := range all {
		if a.Kind == "meeting" && a.MeetingID == meetingID {
			mine = append(mine, a)
		}
	}
	now := "0"
	if len(mine) > 0 {
		now = strconv.Itoa(mine[len(mine)-1].Seq)
	}
	if version != "" && version != now {
		return ActivityPage{}, model.Errorf(model.CodeConflict, "對話已更新，請重新讀取")
	}
	end := len(mine)
	if before > 0 {
		end = 0
		for end < len(mine) && mine[end].Seq < before {
			end++
		}
	}
	start := max(0, end-limit)
	return ActivityPage{Version: now, Total: len(mine), Items: append([]model.TaskActivity{}, mine[start:end]...), HasMore: start > 0}, nil
}

// ownerSees says whether the owner reads an entry of the conversation as theirs: a meeting held in it is theirs only
// by its conclusion, which they are told of.
func ownerSees(a model.TaskActivity) bool {
	return a.MeetingVersion != meetingVersion || a.MeetingPart == meetingSummary
}

// recoverMeeting settles a meeting after a restart: a call under way cannot be known to have finished, so it waits.
func (e *Engine) recoverMeeting(t *model.Task, s *model.SubTask) {
	m := meetingOf(s)
	if m == nil || m.Over() || (m.SpeakerID == "" && m.State != model.MeetingClosing) {
		return
	}
	failure := &model.OperationError{Code: model.CodeUnavailable, Message: i18n.T("伺服器重新啟動，進行中的發言已中斷")}
	if m.State == model.MeetingClosing {
		e.summaryFailed(t, s, failure)
		m.PauseReason = pauseRecovery
		return
	}
	e.holdMeeting(t, s, pauseRecovery, failure)
}
