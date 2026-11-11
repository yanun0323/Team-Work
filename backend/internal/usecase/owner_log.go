package usecase

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"maps"
	"slices"
	"sort"
	"strconv"

	"github.com/yanun0323/Team-Work/internal/model"
	"github.com/yanun0323/Team-Work/pkg/jsonx"
)

// kindTaskLog is the document an owner-led task keeps apart from what clients get with the world: its whole
// conversation, every operation, the owner's events and what was already done for each request and tool call.
const kindTaskLog = "taskLog"

// Owner events, the only things that wake a task's owner.
const (
	evTaskStarted    = "task_started"
	evUserMessage    = "user_message"
	evHandoff        = "employee_handoff"
	evQuestion       = "employee_question"
	evFailure        = "failure_after_retries"
	evMeetingEnded   = "meeting_ended"
	evStopCompleted  = "stop_completed"
	evReturnComplete = "return_completed"
	evUserAnswer     = "user_answer"
	evResumed        = "resumed"
	evRecovery       = "recovery"
)

// Event states: pending waits for the owner, processing is in the decision under way, handled is done.
const (
	eventPending    = "pending"
	eventProcessing = "processing"
	eventHandled    = "handled"
)

// ownerEvent is one thing the owner has to know about. Key, when set, makes the same thing arrive once.
type ownerEvent struct {
	ID          string  `json:"id"`
	Seq         int     `json:"seq"`
	Kind        string  `json:"kind"`
	Key         string  `json:"key,omitempty"`
	State       string  `json:"state"`
	At          float64 `json:"at"`
	Text        string  `json:"text"`
	SubID       string  `json:"subId,omitempty"`
	OperationID string  `json:"operationId,omitempty"`
	ActivityID  string  `json:"activityId,omitempty"`
	QuestionID  string  `json:"questionId,omitempty"`
	Wake        string  `json:"wake,omitempty"`
}

// requestRecord is what a request id was used for: the same request again gets the same operation back.
type requestRecord struct {
	Fingerprint string `json:"fingerprint"`
	OperationID string `json:"operationId"`
	ActivityID  string `json:"activityId,omitempty"`
}

// planSnapshot is the plan as it was at a version, and why it changed.
type planSnapshot struct {
	Version  int            `json:"version"`
	At       float64        `json:"at"`
	Reason   string         `json:"reason"`
	By       string         `json:"by"`
	Workflow model.Workflow `json:"workflow"`
}

// briefEdit is the task's title and description as the user set them, oldest first; the first is how it began.
type briefEdit struct {
	At          float64 `json:"at"`
	Title       string  `json:"title"`
	Description string  `json:"description"`
}

// taskLog is an owner-led task's private record. Activities, Plans and Brief only grow and their entries never
// change, so a rollback keeps their slices; the maps are copied, and their values are replaced, never changed in place.
type taskLog struct {
	Activities []model.TaskActivity           `json:"activities"`
	Operations map[string]model.TaskOperation `json:"operations"`
	Requests   map[string]requestRecord       `json:"requests"`
	Events     map[string]ownerEvent          `json:"events"`
	EventSeq   int                            `json:"eventSeq"`
	// Commands are the results of the owner's tool calls that changed something, by run and call id.
	Commands map[string]string `json:"commands"`
	Plans    []planSnapshot    `json:"plans"`
	Brief    []briefEdit       `json:"brief"`
	// Exchanges counts questions between the owner and employees and Returns the work sent back since the user last
	// let the owner go on; Wakes counts the owner's decisions.
	Exchanges int `json:"exchanges"`
	Returns   int `json:"returns"`
	Wakes     int `json:"wakes"`
	// PausedSubs are runs a pause stopped, which go on once the user resumes.
	PausedSubs []string `json:"pausedSubs,omitempty"`
}

func newTaskLog() *taskLog {
	return &taskLog{Activities: []model.TaskActivity{}, Operations: map[string]model.TaskOperation{}, Requests: map[string]requestRecord{},
		Events: map[string]ownerEvent{}, Commands: map[string]string{}}
}

// fill makes the maps of a log read from disk usable.
func (l *taskLog) fill() {
	if l.Operations == nil {
		l.Operations = map[string]model.TaskOperation{}
	}
	if l.Requests == nil {
		l.Requests = map[string]requestRecord{}
	}
	if l.Events == nil {
		l.Events = map[string]ownerEvent{}
	}
	if l.Commands == nil {
		l.Commands = map[string]string{}
	}
	if l.Activities == nil {
		l.Activities = []model.TaskActivity{}
	}
}

// snapshot is a copy a failed change goes back to.
func (l *taskLog) snapshot() *taskLog {
	out := *l
	out.Activities = l.Activities[:len(l.Activities):len(l.Activities)]
	out.Plans = l.Plans[:len(l.Plans):len(l.Plans)]
	out.Brief = l.Brief[:len(l.Brief):len(l.Brief)]
	out.PausedSubs = slices.Clone(l.PausedSubs)
	out.Operations, out.Requests, out.Events, out.Commands = maps.Clone(l.Operations), maps.Clone(l.Requests), maps.Clone(l.Events), maps.Clone(l.Commands)
	return &out
}

// snapshotLogs is every log as it is, for a change that fails to go back to.
func (e *Engine) snapshotLogs() (map[string]*taskLog, map[string]bool) {
	out := make(map[string]*taskLog, len(e.taskLogs))
	for id, l := range e.taskLogs {
		out[id] = l.snapshot()
	}
	return out, maps.Clone(e.logDirty)
}

// logOf is a task's log for reading; nil for a task with none.
func (e *Engine) logOf(taskID string) *taskLog { return e.taskLogs[taskID] }

// editLog is a task's log for changing: it is saved with the change.
func (e *Engine) editLog(taskID string) *taskLog {
	l := e.taskLogs[taskID]
	if l == nil {
		l = newTaskLog()
		if e.taskLogs == nil {
			e.taskLogs = map[string]*taskLog{}
		}
		e.taskLogs[taskID] = l
	}
	if e.logDirty == nil {
		e.logDirty = map[string]bool{}
	}
	e.logDirty[taskID] = true
	return l
}

// logDocuments adds the logs to what is saved: changed ones as JSON, the rest by presence alone.
func (e *Engine) logDocuments(docs map[string][]byte) {
	for id, l := range e.taskLogs {
		if e.w.Tasks[id] == nil {
			continue // the task is gone, and its log with it
		}
		key := docKey(kindTaskLog, id)
		if !e.logDirty[id] {
			if old, ok := e.prev[key]; ok {
				docs[key] = old
				continue
			}
		}
		if raw, err := jsonx.Marshal(l); err == nil {
			docs[key] = raw
		}
	}
}

// loadLog reads a task's log from disk.
func (e *Engine) loadLog(d model.Doc) error {
	l := newTaskLog()
	if err := jsonx.Unmarshal(d.Data, l); err != nil {
		return err
	}
	l.fill()
	if e.taskLogs == nil {
		e.taskLogs = map[string]*taskLog{}
	}
	e.taskLogs[d.ID] = l
	return nil
}

// addActivity puts an entry in the task's conversation and returns it.
func (e *Engine) addActivity(t *model.Task, a model.TaskActivity) model.TaskActivity {
	l := e.editLog(t.ID)
	a.Seq = len(l.Activities) + 1
	a.ID = t.ID + "-a" + strconv.Itoa(a.Seq)
	a.At = e.w.Now
	if t.Coordination != nil {
		a.PlanVersion = t.Coordination.PlanVersion
	}
	l.Activities = append(l.Activities, a)
	if t.Coordination != nil {
		t.Coordination.History = model.ActivityHistory{Version: strconv.Itoa(len(l.Activities)), Count: len(l.Activities)}
	}
	return a
}

// systemEvent is a short line in the task's conversation: key and args for clients to translate, text in case they cannot.
func (e *Engine) systemEvent(t *model.Task, key, text string, args map[string]any, subID string) model.TaskActivity {
	a := model.TaskActivity{Kind: "event", From: "system", Text: text, Key: key, Args: args, SubID: subID}
	if s := e.w.SubTasks[subID]; s != nil {
		a.NodeID = s.NodeID
	}
	return e.addActivity(t, a)
}

// addEvent queues something for the owner; one with a key already queued is not queued again.
func (e *Engine) addEvent(t *model.Task, ev ownerEvent) {
	l := e.editLog(t.ID)
	if ev.Key != "" {
		for _, old := range l.Events {
			if old.Key == ev.Key {
				return
			}
		}
	}
	l.EventSeq++
	ev.Seq = l.EventSeq
	ev.ID = t.ID + "-e" + strconv.Itoa(ev.Seq)
	ev.State = eventPending
	ev.At = e.w.Now
	l.Events[ev.ID] = ev
	if c := t.Coordination; c != nil && c.OwnerState == model.OwnerIdle {
		c.OwnerState = model.OwnerQueued
	}
}

// eventsIn lists a log's events in a state, oldest first.
func eventsIn(l *taskLog, state string) []ownerEvent {
	var out []ownerEvent
	if l == nil {
		return out
	}
	for _, ev := range l.Events {
		if ev.State == state {
			out = append(out, ev)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Seq < out[j].Seq })
	return out
}

// newOperation records something asked of the task, saved before anything acts on it.
func (e *Engine) newOperation(t *model.Task, op model.TaskOperation) model.TaskOperation {
	l := e.editLog(t.ID)
	e.w.Seq++
	op.ID = t.ID + "-op" + strconv.Itoa(e.w.Seq)
	op.At, op.UpdatedAt = e.w.Now, e.w.Now
	if op.Status == "" {
		op.Status = model.OpReceived
	}
	l.Operations[op.ID] = op
	e.showOperations(t)
	return op
}

// setOperation moves an operation on. An applied one stays applied, so a late failure cannot undo what took effect.
func (e *Engine) setOperation(t *model.Task, id, status string, failure *model.OperationError) {
	l := e.editLog(t.ID)
	op, ok := l.Operations[id]
	if !ok || op.Status == model.OpApplied && status != model.OpApplied {
		return
	}
	op.Status, op.Error, op.UpdatedAt = status, failure, e.w.Now
	l.Operations[id] = op
	e.showOperations(t)
}

// operationsShown is how many finished operations clients get with the task; open ones all come.
const operationsShown = 20

// showOperations puts the open operations and the latest finished ones on the task.
func (e *Engine) showOperations(t *model.Task) {
	if t.Coordination == nil {
		return
	}
	l := e.logOf(t.ID)
	var open, closed []model.TaskOperation
	for _, op := range l.Operations {
		if op.Status == model.OpReceived || op.Status == model.OpProcessing || op.Status == model.OpUncertain {
			open = append(open, op)
		} else {
			closed = append(closed, op)
		}
	}
	byTime := func(list []model.TaskOperation) {
		sort.Slice(list, func(i, j int) bool {
			if list[i].At != list[j].At {
				return list[i].At < list[j].At
			}
			return list[i].ID < list[j].ID
		})
	}
	byTime(open)
	byTime(closed)
	if len(closed) > operationsShown {
		closed = closed[len(closed)-operationsShown:]
	}
	t.Coordination.Operations = append(append([]model.TaskOperation{}, closed...), open...)
	byTime(t.Coordination.Operations)
}

// fingerprint identifies what a request asked, so a request id used again for something else is refused.
func fingerprint(v any) string {
	raw, _ := json.Marshal(v)
	sum := sha256.Sum256(raw)
	return hex.EncodeToString(sum[:])
}

// replay finds what a request id already did: the operation, or a conflict when it asked something else.
func (e *Engine) replay(t *model.Task, requestID, print string) (*model.TaskOperation, *model.TaskActivity, error) {
	l := e.logOf(t.ID)
	if l == nil {
		return nil, nil, nil
	}
	rec, ok := l.Requests[requestID]
	if !ok {
		return nil, nil, nil
	}
	if rec.Fingerprint != print {
		return nil, nil, model.Errorf(model.CodeConflict, "這個 requestId 已用於另一個請求")
	}
	op := l.Operations[rec.OperationID]
	var act *model.TaskActivity
	if rec.ActivityID != "" {
		if a := activityByID(l, rec.ActivityID); a != nil {
			act = a
		}
	}
	return &op, act, nil
}

func activityByID(l *taskLog, id string) *model.TaskActivity {
	for i := range l.Activities {
		if l.Activities[i].ID == id {
			a := l.Activities[i]
			return &a
		}
	}
	return nil
}
