package usecase

import (
	"maps"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/yanun0323/Team-Work/internal/i18n"
	"github.com/yanun0323/Team-Work/internal/model"
	"github.com/yanun0323/Team-Work/internal/model/enum"
)

// Owner-led tasks. The flow is the plan the task starts from; the owner, an employee working through checked tools,
// dispatches each step with instructions, reviews every handoff, answers employees and reports to the user in the
// task's conversation. The user can pause, send a step back and answer what only they may decide; those take effect
// without waiting for the owner.

const (
	// maxOwnerExchanges bounds the questions passed between the owner and employees with nobody else stepping in.
	maxOwnerExchanges = 8
	// maxOwnerTools bounds the tools one decision of the owner calls.
	maxOwnerTools = 32
	// maxOwnerFailures bounds the runs that fail one after another, whoever dispatched them again.
	maxOwnerFailures = 3
	// optionContinue lets the owner go on past a limit; optionAddBudget and optionPause answer a budget question.
	optionContinue  = "continue"
	optionAddBudget = "addBudget"
	optionPause     = "pauseTask"
	optionStopped   = "confirmStopped"
	optionRedo      = "redo"
	// optionMerge and optionNotYet answer the card the owner gives when the user asks to merge.
	optionMerge  = "merge"
	optionNotYet = "notYet"
)

// stopWait is how long a stopped run may take to end before what it did is called uncertain.
var stopWait = 30 * time.Second

func ownerKey(taskID string) string { return "owner:" + taskID }

// owner is the employee leading a task, when they still work at its company.
func (e *Engine) owner(t *model.Task) *model.Replica {
	if t.OwnerID == nil {
		return nil
	}
	if r := e.w.Replicas[*t.OwnerID]; r != nil && r.TeamID == t.TeamID {
		return r
	}
	return nil
}

// lead makes a new task one its owner leads. Who the plan names and the owner are who the user allowed to work on it.
func (e *Engine) lead(t *model.Task) {
	t.Orchestration = model.OrchestrationOwner
	t.Coordination = &model.Coordination{PlanVersion: 1, ControlVersion: 1, OwnerState: model.OwnerIdle,
		Authorization: model.TaskAuthorization{ReplicaIDs: e.staffOf(t), PlanChanges: true},
		Facts:         []model.TaskFact{}, Questions: []model.TaskQuestion{}, Operations: []model.TaskOperation{}}
	l := e.editLog(t.ID)
	l.Brief = append(l.Brief, briefEdit{At: e.w.Now, Title: t.Title, Description: t.Description})
	l.Plans = append(l.Plans, planSnapshot{Version: 1, At: e.w.Now, Reason: "initial plan", By: "user", Workflow: clone(t.Workflow)})
	t.Coordination.History = model.ActivityHistory{Version: "0", Count: 0}
}

// staffOf is everyone a task's plan names, and its owner.
func (e *Engine) staffOf(t *model.Task) []string {
	out := []string{}
	add := func(id string) {
		if id != "" && !slices.Contains(out, id) {
			out = append(out, id)
		}
	}
	if t.OwnerID != nil {
		add(*t.OwnerID)
	}
	for _, n := range t.Workflow.Nodes {
		for _, id := range n.ReplicaIDs {
			add(id)
		}
	}
	return out
}

// authorized says whether the user allowed an employee on the task, and they still work at its company.
func (e *Engine) authorized(t *model.Task, id string) bool {
	r := e.w.Replicas[id]
	return r != nil && r.TeamID == t.TeamID && slices.Contains(t.Coordination.Authorization.ReplicaIDs, id)
}

// started says whether an owner-led task was ever started.
func started(t *model.Task) bool { return t.Coordination != nil && t.Coordination.StartedAt != nil }

// current says whether a run's result still counts.
func current(s *model.SubTask) bool {
	return !s.Cancelled && s.Validity != model.ValidSuperseded
}

// running says whether a step has a run working, or about to.
func (e *Engine) running(s *model.SubTask) bool {
	return e.runs[s.ID] != nil || s.ExecutionState == model.ExecStopping
}

// replicaName is an employee's name, or "" when they are gone.
func (e *Engine) replicaName(id string) string {
	if r := e.w.Replicas[id]; r != nil {
		return r.Name
	}
	return ""
}

func (e *Engine) nodeName(t *model.Task, id string) string {
	if n := nodeOf(&t.Workflow, id); n != nil {
		return n.Name
	}
	return id
}

// ---------- stopping runs ----------

// halt stops a step's run. It returns true when the run still has to end: it is stopping until it does, and nothing
// it reports meanwhile counts. Call it holding the lock.
func (e *Engine) halt(t *model.Task, s *model.SubTask) bool {
	if e.runs[s.ID] != nil {
		e.stopRun(s.ID)
		s.ExecutionState = model.ExecStopping
		if s.Status == enum.StatusProgressing {
			s.Status = enum.StatusTodo
		}
		if s.Talk != nil {
			s.Talk.ReplyAt, s.Talk.Next = nil, nil
		}
		id, gen := s.ID, s.RunGeneration
		time.AfterFunc(stopWait, func() { e.stopTimedOut(id, gen) })
		return true
	}
	if s.ExecutionState == model.ExecStopping {
		return true
	}
	if s.Status == enum.StatusProgressing {
		s.Status = enum.StatusTodo
	}
	if s.ExecutionState == model.ExecQueued || s.ExecutionState == model.ExecRunning || (s.Status == enum.StatusTodo && s.ExecutionState == "") {
		s.ExecutionState = model.ExecStopped
	}
	return false
}

// stopTimedOut calls a run that did not end in time uncertain: what it did cannot be known, so the user checks.
func (e *Engine) stopTimedOut(subID string, gen int) {
	_ = e.do(func() error {
		s := e.w.SubTasks[subID]
		if s == nil || s.ExecutionState != model.ExecStopping || s.RunGeneration != gen {
			return nil
		}
		t := e.w.Tasks[s.TaskID]
		e.markUncertain(t, s)
		e.stopsSettled(t)
		return nil
	})
}

// markUncertain is a run nobody can say finished or not. Work waits until the user says what to do.
func (e *Engine) markUncertain(t *model.Task, s *model.SubTask) {
	s.ExecutionState = model.ExecUncertain
	if s.Status == enum.StatusProgressing {
		s.Status = enum.StatusTodo
	}
	name := e.nodeName(t, s.NodeID)
	text := i18n.T("無法確認「%s」的執行是否已結束；停止不會還原已改的檔案或外部操作，請確認現況", name)
	a := e.systemEvent(t, "uncertain", text, map[string]any{"step": name}, s.ID)
	e.askUserQuestion(t, model.TaskQuestion{ActivityID: a.ID, Prompt: text, Kind: "recovery", SubID: s.ID,
		Options: []model.ReviewOption{{ID: optionStopped, Label: i18n.T("已確認停止")}, {ID: optionRedo, Label: i18n.T("重做這一步")}}})
	e.addEvent(t, ownerEvent{Kind: evRecovery, Key: "uncertain:" + s.ID + ":" + strconv.Itoa(s.RunGeneration), SubID: s.ID,
		Text: "The run of step " + s.NodeID + " (" + s.ID + ") could not be confirmed stopped; the user was asked to check."})
}

// subExited is a run ending: one being stopped is now stopped. Call it holding the lock.
func (e *Engine) subExited(subID string, gen int) {
	s := e.w.SubTasks[subID]
	if s == nil || e.runs[subID] != nil {
		return
	}
	t := e.w.Tasks[s.TaskID]
	if t == nil || !t.OwnerLed() {
		return
	}
	switch {
	case s.ExecutionState == model.ExecStopping && s.RunGeneration == gen:
		s.ExecutionState = model.ExecStopped
		e.logLine(s, enum.LogSystem, i18n.T("已停止"), "stopped", nil)
		e.requeuePaused(t)
		e.stopsSettled(t)
	case s.ExecutionState == model.ExecRunning && s.RunGeneration == gen:
		s.ExecutionState = ""
	}
}

// stopsSettled finishes the operations that were waiting for runs to stop, and those left uncertain once the user
// said what became of the runs.
func (e *Engine) stopsSettled(t *model.Task) {
	l := e.logOf(t.ID)
	if l == nil {
		return
	}
	for _, id := range slices.Sorted(maps.Keys(l.Operations)) {
		op := l.Operations[id]
		if op.Status != model.OpProcessing && op.Status != model.OpUncertain || (op.Kind != "pause" && op.Kind != "return" && op.Kind != "stop") {
			continue
		}
		waiting, unsure := false, false
		for _, id := range op.AffectedSubIDs {
			if s := e.w.SubTasks[id]; s != nil {
				waiting = waiting || s.ExecutionState == model.ExecStopping
				unsure = unsure || s.ExecutionState == model.ExecUncertain
			}
		}
		if waiting {
			continue
		}
		if unsure {
			if op.Status != model.OpUncertain {
				e.setOperation(t, op.ID, model.OpUncertain, nil)
			}
			continue
		}
		e.setOperation(t, op.ID, model.OpApplied, nil)
		e.stopDone(t, op)
	}
}

// stopDone tells the conversation and the owner that what was stopped has stopped.
func (e *Engine) stopDone(t *model.Task, op model.TaskOperation) {
	switch op.Kind {
	case "pause":
		e.systemEvent(t, "paused", i18n.T("任務已暫停，執行中的工作已停止"), nil, "")
		if len(op.AffectedSubIDs) > 0 {
			e.addEvent(t, ownerEvent{Kind: evStopCompleted, Key: "stop:" + op.ID, OperationID: op.ID,
				Text: "The user paused the task; every run has stopped. Do not dispatch until the user resumes. Files already changed stay as they are."})
		}
	case "return":
		e.addEvent(t, ownerEvent{Kind: evReturnComplete, Key: "return:" + op.ID, OperationID: op.ID, SubID: op.SubID,
			Text: "The user sent step run " + op.SubID + " back; the runs it affected have stopped and a redo is queued for when the user resumes."})
	case "stop":
		e.addEvent(t, ownerEvent{Kind: evStopCompleted, Key: "stop:" + op.ID, OperationID: op.ID, SubID: op.SubID,
			Text: "Step run " + op.SubID + " has stopped."})
	}
}

// requeuePaused puts the runs a pause or the budget stopped back in the queue, once the task may go on.
func (e *Engine) requeuePaused(t *model.Task) {
	if t.Paused || t.Coordination.OwnerState == model.OwnerBlocked && t.Coordination.BlockedReason == "budget" {
		return
	}
	l := e.logOf(t.ID)
	if l == nil || len(l.PausedSubs) == 0 {
		return
	}
	var left []string
	for _, id := range l.PausedSubs {
		s := e.w.SubTasks[id]
		switch {
		case s == nil || !current(s) || s.Validity == model.ValidNeedsRevalidation || s.Status == enum.StatusComplete:
		case s.ExecutionState == model.ExecStopped:
			s.ExecutionState = model.ExecQueued
		default:
			left = append(left, id)
		}
	}
	if !slices.Equal(left, l.PausedSubs) {
		e.editLog(t.ID).PausedSubs = left
	}
}

// holdAll stops every run of the task, keeping them to go on later; it returns those still ending.
func (e *Engine) holdAll(t *model.Task) []string {
	var affected []string
	for _, s := range e.subsOf(t.ID) {
		if !current(s) || s.Status == enum.StatusComplete {
			continue
		}
		active := e.runs[s.ID] != nil || s.ExecutionState == model.ExecQueued || s.ExecutionState == model.ExecRunning || s.ExecutionState == model.ExecStopping
		if !active {
			continue
		}
		if e.halt(t, s) {
			affected = append(affected, s.ID)
		}
		l := e.editLog(t.ID)
		if !slices.Contains(l.PausedSubs, s.ID) {
			l.PausedSubs = append(l.PausedSubs, s.ID)
		}
	}
	return affected
}

// ---------- questions ----------

// askUserQuestion opens a question only the user answers, fixed where they see it until they do.
func (e *Engine) askUserQuestion(t *model.Task, q model.TaskQuestion) model.TaskQuestion {
	e.w.Seq++
	q.ID = t.ID + "-q" + strconv.Itoa(e.w.Seq)
	q.Audience = "user"
	q.PlanVersion = t.Coordination.PlanVersion
	q.CreatedAt = e.w.Now
	if q.Options == nil {
		q.Options = []model.ReviewOption{}
	}
	t.Coordination.Questions = append(t.Coordination.Questions, q)
	e.notice(Event{Type: "notice", Kind: "review", TaskID: t.ID, SubID: q.SubID})
	return q
}

func questionOf(t *model.Task, id string) *model.TaskQuestion {
	for i := range t.Coordination.Questions {
		if t.Coordination.Questions[i].ID == id {
			return &t.Coordination.Questions[i]
		}
	}
	return nil
}

// reopen takes a task waiting to be merged back to work: what was concluded has to be confirmed again, so a card to
// merge it is gone.
func reopen(t *model.Task) {
	t.Stage = enum.StageRunning
	t.Coordination.Questions = slices.DeleteFunc(slices.Clone(t.Coordination.Questions), func(q model.TaskQuestion) bool { return q.Kind == "merge" })
}

func dropQuestion(t *model.Task, id string) {
	t.Coordination.Questions = slices.DeleteFunc(slices.Clone(t.Coordination.Questions), func(q model.TaskQuestion) bool { return q.ID == id })
}

// openQuestion says whether a question of a kind waits for the user.
func openQuestion(t *model.Task, kind string) bool {
	return slices.ContainsFunc(t.Coordination.Questions, func(q model.TaskQuestion) bool { return q.Audience == "user" && q.Kind == kind })
}

// block stops the owner deciding until the user answers why.
func (e *Engine) block(t *model.Task, reason string, q model.TaskQuestion) {
	c := t.Coordination
	if c.OwnerState == model.OwnerBlocked && c.BlockedReason == reason {
		return
	}
	c.OwnerState, c.BlockedReason = model.OwnerBlocked, reason
	a := e.systemEvent(t, "blocked."+reason, q.Prompt, nil, q.SubID)
	q.ActivityID = a.ID
	e.askUserQuestion(t, q)
}

// unblock lets the owner decide again.
func (e *Engine) unblock(t *model.Task) {
	c := t.Coordination
	c.OwnerState, c.BlockedReason = model.OwnerIdle, ""
	if len(eventsIn(e.logOf(t.ID), eventPending)) > 0 {
		c.OwnerState = model.OwnerQueued
	}
}

// budgetHold stops an owner-led task's work at its cost limit and asks the user.
func (e *Engine) budgetHold(t *model.Task) {
	if openQuestion(t, "budget") {
		return
	}
	e.holdAll(t)
	e.block(t, "budget", model.TaskQuestion{Kind: "budget", Prompt: i18n.T("費用達到上限，已停止這個任務的工作"),
		Options: []model.ReviewOption{{ID: optionAddBudget}, {ID: optionPause}}})
}

// mirrorReview shows what a step of an owner-led task asks the user among the task's questions; the answer goes back
// to the step as a review answer would.
func (e *Engine) mirrorReview(t *model.Task, s *model.SubTask) {
	r := s.Review
	kind := "question"
	if r.Kind == enum.ReviewChange {
		kind = "approval"
	}
	who := ""
	if s.ReplicaID != nil {
		who = *s.ReplicaID
	}
	prompt := r.Prompt
	if prompt == "" && r.Change != nil {
		prompt = i18n.T("要修改「%s」嗎？", r.Change.Name)
	}
	a := e.addActivity(t, model.TaskActivity{Kind: "question", From: "agent", Text: prompt, By: who, Name: e.replicaName(who), SubID: s.ID, NodeID: s.NodeID})
	q := e.askUserQuestion(t, model.TaskQuestion{ActivityID: a.ID, Prompt: prompt, Options: r.Options, Kind: kind, SubID: s.ID, Change: r.Change})
	e.editLogActivityQuestion(t, a.ID, q.ID)
	e.addEvent(t, ownerEvent{Kind: evQuestion, SubID: s.ID, QuestionID: q.ID, ActivityID: a.ID,
		Text: "Step run " + s.ID + " (" + s.NodeID + ") asked the user, who alone answers: " + prompt})
}

// editLogActivityQuestion ties a question to the entry that asked it. The entry is new, so it is still the last one.
func (e *Engine) editLogActivityQuestion(t *model.Task, activityID, questionID string) {
	e.touchLast(t, activityID, func(a *model.TaskActivity) { a.QuestionID = questionID })
}

// ---------- starting, pausing, resuming ----------

// beginOwner starts an owner-led task, or resumes it. Call it holding the lock.
func (e *Engine) beginOwner(t *model.Task) error {
	c := t.Coordination
	if t.Stage != enum.StageRunning || !t.Paused {
		return model.Errorf(model.CodeConflict, "這個任務沒有暫停")
	}
	if e.owner(t) == nil {
		return model.Errorf(model.CodeInvalid, "要先選這個任務的負責人")
	}
	if !started(t) {
		if len(t.Workflow.Nodes) == 0 {
			return model.Errorf(model.CodeInvalid, "任務流程沒有步驟")
		}
		c.StartedAt = ptr(e.w.Now)
		t.Paused, t.PausedAt, t.PausedStatus = false, nil, ""
		c.ControlVersion++
		name := e.owner(t).Name
		e.systemEvent(t, "started", i18n.T("任務開始，由 %s 負責", name), map[string]any{"name": name}, "")
		e.addEvent(t, ownerEvent{Kind: evTaskStarted, Key: "started", Text: "The user started the task. Read the plan, dispatch the first steps with instructions, and tell the user what you plan."})
		return nil
	}
	for _, s := range e.subsOf(t.ID) {
		if s.ExecutionState == model.ExecStopping {
			return model.Errorf(model.CodeConflict, "還有工作正在停止，確認停止後才能繼續")
		}
		if s.ExecutionState == model.ExecUncertain && current(s) {
			return model.Errorf(model.CodeConflict, "有無法確認的執行，請先回答確認問題")
		}
	}
	if openQuestion(t, "budget") || openQuestion(t, "recovery") {
		return model.Errorf(model.CodeConflict, "要先回答費用或確認問題才能繼續")
	}
	if t.PausedAt != nil {
		e.w.Tutorial.Learn("pause")
	}
	t.Paused, t.PausedAt, t.PausedStatus = false, nil, ""
	c.ControlVersion++
	e.requeuePaused(t)
	e.systemEvent(t, "resumed", i18n.T("任務繼續"), nil, "")
	e.addEvent(t, ownerEvent{Kind: evResumed, Text: "The user resumed the task. Steps stopped by the pause are queued again."})
	return nil
}

// pauseOwner pauses an owner-led task at once: nothing new is dispatched and every run stops. It returns the runs
// still ending.
func (e *Engine) pauseOwner(t *model.Task) []string {
	t.PausedStatus = e.statusOf(t)
	t.Paused = true
	t.PausedAt = ptr(e.w.Now)
	t.Coordination.ControlVersion++
	return e.holdAll(t)
}

// ---------- reading ----------

// ActivityPage is a page of an owner-led task's conversation.
type ActivityPage struct {
	Version string               `json:"version"`
	Total   int                  `json:"total"`
	Items   []model.TaskActivity `json:"items"`
	HasMore bool                 `json:"hasMore"`
}

// activityDefault and activityMost are how many entries a page has when not asked, and at most.
const (
	activityDefault = 50
	activityMost    = 100
)

// ownerTask is an owner-led task, or the error for one that is not.
func (e *Engine) ownerTask(id string) (*model.Task, error) {
	t, err := e.taskOf(id)
	if err != nil {
		return nil, err
	}
	if !t.OwnerLed() {
		return nil, model.Errorf(model.CodeConflict, "這是舊制任務，沒有負責人對話")
	}
	return t, nil
}

// TaskActivity reads a page of a task's conversation, oldest first: the entries before seq before, or the latest.
// A version that is no longer the conversation's is a conflict, so a client drops a page that went stale.
func (e *Engine) TaskActivity(id string, before, limit int, version string) (ActivityPage, error) {
	e.mu.Lock()
	defer e.mu.Unlock()
	t, err := e.ownerTask(id)
	if err != nil {
		return ActivityPage{}, err
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
	now := strconv.Itoa(len(all))
	if version != "" && version != now {
		return ActivityPage{}, model.Errorf(model.CodeConflict, "對話已更新，請重新讀取")
	}
	end := len(all)
	if before > 0 {
		end = min(before-1, len(all))
	}
	start := max(0, end-limit)
	return ActivityPage{Version: now, Total: len(all), Items: slices.Clone(all[start:end]), HasMore: start > 0}, nil
}

// TaskActivityEntry reads one entry of a task's conversation.
func (e *Engine) TaskActivityEntry(id, activityID string) (model.TaskActivity, error) {
	e.mu.Lock()
	defer e.mu.Unlock()
	t, err := e.ownerTask(id)
	if err != nil {
		return model.TaskActivity{}, err
	}
	a, err := e.activityByID(t.ID, activityID)
	if err != nil {
		return model.TaskActivity{}, err
	}
	if a == nil {
		return model.TaskActivity{}, model.Errorf(model.CodeNotFound, "找不到這則紀錄")
	}
	return *a, nil
}

// TaskOperation reads where an operation got to, for a client that lost track of it.
func (e *Engine) TaskOperation(id, operationID string) (model.TaskOperation, error) {
	e.mu.Lock()
	defer e.mu.Unlock()
	t, err := e.ownerTask(id)
	if err != nil {
		return model.TaskOperation{}, err
	}
	if l := e.logOf(t.ID); l != nil {
		if op, ok := l.Operations[operationID]; ok {
			return op, nil
		}
	}
	return model.TaskOperation{}, model.Errorf(model.CodeNotFound, "找不到這個操作")
}

// ---------- the user's messages and controls ----------

// TaskMessage is the user writing to a task's owner.
type TaskMessage struct {
	RequestID string             `json:"requestId"`
	Text      string             `json:"text"`
	Images    []model.Attachment `json:"images"`
	Files     []model.Attachment `json:"files"`
	// Mentions, ReplicaID and SubID are refused: everything the user writes goes to the owner.
	Mentions  []string `json:"mentions,omitempty"`
	ReplicaID string   `json:"replicaId,omitempty"`
	SubID     string   `json:"subId,omitempty"`
}

// MessageResult is what writing to the owner made.
type MessageResult struct {
	Operation model.TaskOperation `json:"operation"`
	Activity  model.TaskActivity  `json:"activity"`
}

func checkRequestID(id string) error {
	if id == "" || len(id) > 128 {
		return model.Errorf(model.CodeInvalid, "requestId 要有 1 到 128 個字元")
	}
	return nil
}

// SayToOwner gives the owner a message from the user. It counts as received once saved; the owner takes it up next.
func (e *Engine) SayToOwner(id string, in TaskMessage) (MessageResult, error) {
	var out MessageResult
	err := e.do(func() error {
		if err := checkRequestID(in.RequestID); err != nil {
			return err
		}
		t, err := e.ownerTask(id)
		if err != nil {
			return err
		}
		if len(in.Mentions) > 0 || in.ReplicaID != "" || in.SubID != "" {
			return model.Errorf(model.CodeInvalid, "訊息只能寫給負責人")
		}
		print := fingerprint([]any{"message", in.Text, in.Images, in.Files})
		op, act, err := e.replay(t, in.RequestID, print)
		if err != nil {
			return err
		}
		if op != nil {
			out.Operation = *op
			if act != nil {
				out.Activity = *act
			}
			return nil
		}
		text := strings.TrimSpace(in.Text)
		if text == "" && len(in.Images) == 0 && len(in.Files) == 0 {
			return model.Errorf(model.CodeInvalid, "訊息是空的")
		}
		switch t.Stage {
		case enum.StageRunning, enum.StageAwaitMerge:
		default:
			return model.Errorf(model.CodeConflict, "這個任務已結束，不能再留言")
		}
		if err := e.checkFiles(in.Images, in.Files); err != nil {
			return err
		}
		images, err := e.storeImages(in.Images)
		if err != nil {
			return err
		}
		if err := e.saveAttachments(t.ID, in.Files); err != nil {
			return err
		}
		if t.Stage == enum.StageAwaitMerge { // what was concluded has to be confirmed again
			reopen(t)
		}
		t.Coordination.ControlVersion++
		operation := e.newOperation(t, model.TaskOperation{Kind: "message", RequestID: in.RequestID})
		a := e.addActivity(t, model.TaskActivity{Kind: "message", From: "user", Text: text, Images: images, Files: in.Files, OperationID: operation.ID})
		l := e.editLog(t.ID)
		operation.MessageID = a.ID
		l.Operations[operation.ID] = operation
		e.showOperations(t)
		l.Requests[in.RequestID] = requestRecord{Fingerprint: print, OperationID: operation.ID, ActivityID: a.ID}
		e.addEvent(t, ownerEvent{Kind: evUserMessage, OperationID: operation.ID, ActivityID: a.ID, Text: "The user wrote (" + a.ID + "): " + text + attachmentNote(images, in.Files)})
		out = MessageResult{Operation: operation, Activity: a}
		return nil
	})
	return out, err
}

func attachmentNote(images, files []model.Attachment) string {
	if len(images)+len(files) == 0 {
		return ""
	}
	names := []string{}
	for _, a := range append(slices.Clone(images), files...) {
		names = append(names, a.Name)
	}
	return " [attached: " + strings.Join(names, ", ") + "]"
}

// TaskControl is what the user does to an owner-led task: pause, resume, return a step, retry the owner, or answer.
type TaskControl struct {
	RequestID      string `json:"requestId"`
	Action         string `json:"action"`
	PlanVersion    *int   `json:"planVersion,omitempty"`
	ControlVersion *int   `json:"controlVersion,omitempty"`
	SubID          string `json:"subId,omitempty"`
	Reason         string `json:"reason,omitempty"`
	OperationID    string `json:"operationId,omitempty"`
	QuestionID     string `json:"questionId,omitempty"`
	OptionID       string `json:"optionId,omitempty"`
	Note           string `json:"note,omitempty"`
}

// ControlTask does what the user asked. Pause needs no version, so an old screen can always stop the work; the rest
// are refused when the task moved on since the user saw it.
func (e *Engine) ControlTask(id string, in TaskControl) (model.TaskOperation, error) {
	var out model.TaskOperation
	change := e.do
	if e.answerWritesSettings(id, in) {
		change = e.doSettings
	}
	err := change(func() error {
		if err := checkRequestID(in.RequestID); err != nil {
			return err
		}
		t, err := e.ownerTask(id)
		if err != nil {
			return err
		}
		asked := in
		asked.RequestID = ""
		print := fingerprint(asked)
		if op, _, err := e.replay(t, in.RequestID, print); err != nil || op != nil {
			if op != nil {
				out = *op
			}
			return err
		}
		if !slices.Contains([]string{"pause", "resume", "return", "retry", "answer"}, in.Action) {
			return model.Errorf(model.CodeInvalid, "不認識的操作")
		}
		c := t.Coordination
		if in.Action != "pause" {
			if in.PlanVersion == nil || in.ControlVersion == nil {
				return model.Errorf(model.CodeInvalid, "要附上 planVersion 與 controlVersion")
			}
			if *in.PlanVersion != c.PlanVersion || *in.ControlVersion != c.ControlVersion {
				return model.Errorf(model.CodeConflict, "任務已更新，請確認最新狀態再操作")
			}
		}
		var op model.TaskOperation
		switch in.Action {
		case "pause":
			op, err = e.controlPause(t, in)
		case "resume":
			op, err = e.controlResume(t, in)
		case "return":
			op, err = e.controlReturn(t, in)
		case "retry":
			op, err = e.controlRetry(t, in)
		case "answer":
			op, err = e.controlAnswer(t, in)
		default:
			return model.Errorf(model.CodeInvalid, "不認識的操作")
		}
		if err != nil {
			return err
		}
		e.editLog(t.ID).Requests[in.RequestID] = requestRecord{Fingerprint: print, OperationID: op.ID}
		out = e.logOf(t.ID).Operations[op.ID]
		return nil
	})
	return out, err
}

// answerWritesSettings says whether an answer agrees to a change of settings, which goes through what guards them.
func (e *Engine) answerWritesSettings(id string, in TaskControl) bool {
	if in.Action != "answer" || in.OptionID != optionApprove {
		return false
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	t := e.w.Tasks[id]
	if t == nil || !t.OwnerLed() {
		return false
	}
	q := questionOf(t, in.QuestionID)
	return q != nil && q.Change != nil
}

func (e *Engine) controlPause(t *model.Task, in TaskControl) (model.TaskOperation, error) {
	if t.Stage != enum.StageRunning || t.Paused {
		return model.TaskOperation{}, model.Errorf(model.CodeConflict, "這個任務現在不能暫停")
	}
	if !started(t) {
		return model.TaskOperation{}, model.Errorf(model.CodeConflict, "這個任務還沒開始")
	}
	op := e.newOperation(t, model.TaskOperation{Kind: "pause", RequestID: in.RequestID, Status: model.OpProcessing})
	affected := e.pauseOwner(t)
	op.AffectedSubIDs = affected
	e.editLog(t.ID).Operations[op.ID] = op
	e.stopsSettled(t)
	return op, nil
}

func (e *Engine) controlResume(t *model.Task, in TaskControl) (model.TaskOperation, error) {
	if err := e.beginOwner(t); err != nil {
		return model.TaskOperation{}, err
	}
	return e.newOperation(t, model.TaskOperation{Kind: "resume", RequestID: in.RequestID, Status: model.OpApplied}), nil
}

// controlReturn sends a step's run back: the task pauses at once, the run and what was built on it stop, the run no
// longer counts and what came from it waits to be checked again, and a redo of it waits for the user to resume.
// Nothing is deleted or reverted.
func (e *Engine) controlReturn(t *model.Task, in TaskControl) (model.TaskOperation, error) {
	reason := strings.TrimSpace(in.Reason)
	if reason == "" {
		return model.TaskOperation{}, model.Errorf(model.CodeInvalid, "退回要寫理由")
	}
	s := e.w.SubTasks[in.SubID]
	if s == nil || s.TaskID != t.ID {
		return model.TaskOperation{}, model.Errorf(model.CodeNotFound, "找不到子任務")
	}
	if !current(s) || t.Stage != enum.StageRunning && t.Stage != enum.StageAwaitMerge || !started(t) {
		return model.TaskOperation{}, model.Errorf(model.CodeConflict, "這一步現在不能退回")
	}
	if t.Stage == enum.StageAwaitMerge {
		reopen(t)
	}
	op := e.newOperation(t, model.TaskOperation{Kind: "return", RequestID: in.RequestID, Status: model.OpProcessing, SubID: s.ID})
	affected := []string{}
	if !t.Paused {
		affected = e.pauseOwner(t)
	} else {
		t.Coordination.ControlVersion++
	}
	e.rework(t, s, reason, "user") // the redo goes once the user resumes
	l := e.editLog(t.ID)
	l.PausedSubs = slices.DeleteFunc(l.PausedSubs, func(id string) bool { return id == s.ID })
	for _, id := range e.dependents(t, s) {
		if d := e.w.SubTasks[id]; d != nil && e.running(d) && !slices.Contains(affected, id) {
			affected = append(affected, id)
		}
	}
	if e.running(s) && !slices.Contains(affected, s.ID) {
		affected = append(affected, s.ID)
	}
	op.AffectedSubIDs = affected
	l.Operations[op.ID] = op
	e.stopsSettled(t)
	return op, nil
}

// rework makes a step's run no longer count, marks what was built on it to be checked again, and queues a redo by
// the same employee with the same instructions and the reason. by is user or owner.
func (e *Engine) rework(t *model.Task, s *model.SubTask, reason, by string) *model.SubTask {
	e.halt(t, s)
	s.Validity = model.ValidSuperseded
	if s.OwnerReview == model.ReviewPending {
		s.OwnerReview = model.ReviewRejected
	}
	e.logLine(s, enum.LogHuman, i18n.T("退回：%s", reason), "", nil)
	for _, id := range e.dependents(t, s) {
		d := e.w.SubTasks[id]
		e.halt(t, d)
		if d.Validity != model.ValidSuperseded {
			d.Validity = model.ValidNeedsRevalidation
		}
	}
	redo := e.newRun(t, s.NodeID, *s.ReplicaID, s.Instruction, slices.Clone(s.UpstreamIDs))
	redo.ParentID = s.ParentID
	redo.Rework = &model.Rework{From: s.ID, Reason: reason}
	name := e.nodeName(t, s.NodeID)
	key, args := "returnedByUser", map[string]any{"step": name, "reason": reason}
	if by == "owner" {
		key = "returnedByOwner"
		if o := e.owner(t); o != nil {
			args["owner"] = o.Name
		}
	}
	e.systemEvent(t, key, i18n.T("退回「%s」重做：%s", name, reason), args, redo.ID)
	return redo
}

// dependents are the runs built on a run: those its handoff went into, and theirs, still counting.
func (e *Engine) dependents(t *model.Task, s *model.SubTask) []string {
	seen := map[string]bool{s.ID: true}
	var out []string
	for changed := true; changed; {
		changed = false
		for _, o := range e.subsOf(t.ID) {
			if seen[o.ID] || !current(o) {
				continue
			}
			if slices.ContainsFunc(o.UpstreamIDs, func(id string) bool { return seen[id] }) {
				seen[o.ID] = true
				out = append(out, o.ID)
				changed = true
			}
		}
	}
	return out
}

// newRun queues a run of a step of an owner-led task, dispatched on the current plan.
func (e *Engine) newRun(t *model.Task, nodeID, replicaID, instruction string, upstream []string) *model.SubTask {
	s := &model.SubTask{
		ID: e.uid("sub"), TaskID: t.ID, NodeID: nodeID, UpstreamIDs: upstream, ReplicaID: ptr(replicaID), Status: enum.StatusTodo,
		CreatedAt: e.w.Now, RoutedTo: []string{}, ArrivedAt: e.w.Now, Log: []model.LogLine{},
		PlanVersion: t.Coordination.PlanVersion, Instruction: instruction, Validity: model.ValidCurrent, ExecutionState: model.ExecQueued,
	}
	if len(upstream) > 0 {
		s.ParentID = ptr(upstream[0])
	}
	e.w.SubTasks[s.ID] = s
	e.logLine(s, enum.LogSystem, i18n.T("已排入佇列"), "queued", nil)
	return s
}

func (e *Engine) controlRetry(t *model.Task, in TaskControl) (model.TaskOperation, error) {
	l := e.logOf(t.ID)
	op, ok := l.Operations[in.OperationID]
	if !ok {
		return model.TaskOperation{}, model.Errorf(model.CodeNotFound, "找不到這個操作")
	}
	if op.Status != model.OpFailed || t.Coordination.OwnerState != model.OwnerFailed {
		return model.TaskOperation{}, model.Errorf(model.CodeConflict, "只有失敗的負責人處理可以重試")
	}
	// the failure is what is retried: it is applied once the owner's next decision is, or fails again to be retried again
	edit := e.editLog(t.ID)
	op.RequestID, op.Status, op.Error, op.UpdatedAt = in.RequestID, model.OpProcessing, nil, e.w.Now
	edit.Operations[op.ID] = op
	for id, ev := range edit.Events {
		if ev.State == eventHandled {
			continue
		}
		ev.State, ev.Wake = eventPending, ""
		edit.Events[id] = ev
		if o, ok := edit.Operations[ev.OperationID]; ok && o.Status == model.OpFailed {
			o.Status, o.Error, o.UpdatedAt = model.OpProcessing, nil, e.w.Now
			edit.Operations[o.ID] = o
		}
	}
	e.showOperations(t)
	e.addEvent(t, ownerEvent{Kind: evUserAnswer, OperationID: op.ID, Text: "The user asked you to try again after your last decision failed."})
	t.Coordination.OwnerState = model.OwnerQueued
	return op, nil
}

// controlAnswer is the user answering one of the task's questions. The answer binds to that question alone.
func (e *Engine) controlAnswer(t *model.Task, in TaskControl) (model.TaskOperation, error) {
	q := questionOf(t, in.QuestionID)
	if q == nil || q.Audience != "user" {
		return model.TaskOperation{}, model.Errorf(model.CodeConflict, "這個問題已回答或不存在")
	}
	question := *q
	var option *model.ReviewOption
	for i := range question.Options {
		if question.Options[i].ID == in.OptionID {
			option = &question.Options[i]
		}
	}
	if option == nil {
		return model.TaskOperation{}, model.Errorf(model.CodeInvalid, "沒有這個選項")
	}
	note := strings.TrimSpace(in.Note)
	label := option.Label
	if label == "" {
		label = option.ID
	}
	op := e.newOperation(t, model.TaskOperation{Kind: "answer", RequestID: in.RequestID, Status: model.OpApplied, SubID: question.SubID})
	text := label
	if note != "" {
		text += "：" + note
	}
	a := e.addActivity(t, model.TaskActivity{Kind: "message", From: "user", Text: text, QuestionID: question.ID, OperationID: op.ID, SubID: question.SubID})
	dropQuestion(t, question.ID)
	t.Coordination.ControlVersion++
	tell := "The user answered question " + question.ID + " (" + question.Prompt + "): " + text
	if question.Kind == "merge" && in.OptionID == optionMerge {
		// merging is the user's own press; the owner has nothing more to decide
		if err := e.startMerge(t); err != nil {
			return model.TaskOperation{}, err
		}
		return op, nil
	}
	switch {
	case question.SubID != "" && question.Kind != "recovery":
		s := e.w.SubTasks[question.SubID]
		if s != nil && s.Review != nil {
			if err := e.resolveReview(s.ID, in.OptionID, note); err != nil {
				return model.TaskOperation{}, err
			}
			if s.Status == enum.StatusTodo && current(s) {
				s.ExecutionState = model.ExecQueued
			}
		}
	case question.Kind == "budget":
		if in.OptionID == optionAddBudget {
			t.BudgetBonus += e.w.Teams[t.TeamID].Settings.CostLimitUSD * 0.5
			e.unblock(t)
			e.requeuePaused(t)
		} else {
			e.unblock(t)
			if !t.Paused && t.Stage == enum.StageRunning {
				e.pauseOwner(t)
			}
		}
	case question.Kind == "recovery":
		s := e.w.SubTasks[question.SubID]
		if s != nil && s.ExecutionState == model.ExecUncertain {
			s.ExecutionState = model.ExecStopped
			if in.OptionID == optionRedo && current(s) {
				e.rework(t, s, i18n.T("使用者要求重做無法確認的執行"), "user")
			}
			e.stopsSettled(t)
		}
	case in.OptionID == optionContinue:
		l := e.editLog(t.ID)
		l.Exchanges, l.Returns, l.Failures = 0, 0, 0
		e.unblock(t)
	case question.Kind == "approval" && len(question.ReplicaIDs) > 0:
		if in.OptionID == optionApprove {
			for _, id := range question.ReplicaIDs {
				if r := e.w.Replicas[id]; r != nil && r.TeamID == t.TeamID && !slices.Contains(t.Coordination.Authorization.ReplicaIDs, id) {
					t.Coordination.Authorization.ReplicaIDs = append(t.Coordination.Authorization.ReplicaIDs, id)
				}
			}
			e.systemEvent(t, "staffAllowed", i18n.T("使用者同意加入員工"), nil, "")
		}
	}
	e.addEvent(t, ownerEvent{Kind: evUserAnswer, OperationID: op.ID, ActivityID: a.ID, QuestionID: question.ID, SubID: question.SubID, Text: tell})
	return op, nil
}

// ---------- after a restart ----------

// recoverOwners settles owner-led tasks after a restart: a decision under way goes back to waiting, a run that was
// working cannot be known to have finished, and one that was stopping has stopped with the server.
func (e *Engine) recoverOwners() {
	for _, t := range e.w.Tasks {
		if !t.OwnerLed() {
			continue
		}
		if l := e.logOf(t.ID); l != nil {
			for _, ev := range eventsIn(l, eventProcessing) {
				ev.State, ev.Wake = eventPending, ""
				e.editLog(t.ID).Events[ev.ID] = ev
			}
		}
		c := t.Coordination
		if c.OwnerState == model.OwnerResponding {
			c.OwnerState = model.OwnerIdle
			if len(eventsIn(e.logOf(t.ID), eventPending)) > 0 {
				c.OwnerState = model.OwnerQueued
			}
		}
		for _, s := range e.subsOf(t.ID) {
			busy := s.Status == enum.StatusProgressing || s.ExecutionState == model.ExecRunning || (s.Talk != nil && s.Talk.ReplyAt != nil)
			switch {
			case s.ExecutionState == model.ExecStopping:
				s.ExecutionState = model.ExecStopped
				if s.Status == enum.StatusProgressing {
					s.Status = enum.StatusTodo
				}
			case busy && current(s) && s.Status != enum.StatusComplete:
				if s.Talk != nil {
					s.Talk.ReplyAt = nil
				}
				e.markUncertain(t, s)
			}
		}
		e.stopsSettled(t)
	}
}
