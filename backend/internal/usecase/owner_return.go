package usecase

import (
	"fmt"
	"slices"
	"strings"
	"time"

	"github.com/yanun0323/Team-Work/internal/i18n"
	"github.com/yanun0323/Team-Work/internal/model"
	"github.com/yanun0323/Team-Work/internal/model/enum"
)

// returnWait is how long a send-back waits for the runs built on it to hand off before the user is asked.
var returnWait = 5 * time.Minute

// optionReturnNow and optionWaitMore answer the card a send-back gives when the runs built on it take too long.
const (
	optionReturnNow = "returnNow"
	optionWaitMore  = "waitMore"
)

// wrapUpSays is what a run built on a run being sent back is told, as it reads it.
const wrapUpSays = "The system tells you: the work this run builds on (%s, step %s) is being sent back to be redone, because: %s\n" +
	"Stop here. Do not start anything new: commit what is there and call submit_handoff now, saying what you did, what you " +
	"found and what is left undone, so the redo and whoever checks it again can use it."

// windingUp says whether a run built on one being sent back is still working, so it can be told to hand off and waited
// for. One queued, stopped, waiting for an answer or in a meeting would not hand off by itself.
func (e *Engine) windingUp(t *model.Task, s *model.SubTask) bool {
	n := nodeOf(&t.Workflow, s.NodeID)
	return current(s) && n != nil && n.Kind != enum.NodeTalk && e.runs[s.ID] != nil &&
		s.Status == enum.StatusProgressing && s.ExecutionState != model.ExecStopping
}

// returning is the send-back of run subID waiting for the runs built on it, or nil.
func (e *Engine) returning(t *model.Task, subID string) *pendingReturn {
	l := e.logOf(t.ID)
	if l == nil {
		return nil
	}
	for i := range l.Returning {
		if l.Returning[i].SubID == subID {
			return &l.Returning[i]
		}
	}
	return nil
}

// ownerReturn is return_step: run s is sent back at once when nothing built on it is still working; otherwise what is
// working is told to hand off now, and s is sent back once it has. Call it holding the lock.
func (e *Engine) ownerReturn(t *model.Task, s *model.SubTask, reason string) string {
	name := e.nodeName(t, s.NodeID)
	var wait, names []string
	for _, id := range e.dependents(t, s) {
		d := e.w.SubTasks[id]
		switch {
		case e.windingUp(t, d):
			wait = append(wait, id)
			names = append(names, e.nodeName(t, d.NodeID))
		case d.ExecutionState == model.ExecQueued:
			e.halt(t, d) // it has not started: nothing of it to keep
		}
	}
	if len(wait) == 0 {
		redo := e.rework(t, s, reason, "owner")
		return "sent back; the redo is " + redo.ID
	}
	l := e.editLog(t.ID)
	steps := strings.Join(names, "、")
	act := e.systemEvent(t, "returnWaiting", i18n.T("等「%s」交接後退回「%s」重做：%s", steps, name, reason),
		map[string]any{"steps": steps, "step": name, "reason": reason}, s.ID)
	steers := slices.Clone(l.Steers)
	for _, id := range wait {
		steers = append(steers, pendingSteer{SubID: id, Text: fmt.Sprintf(wrapUpSays, s.ID, name, reason), ActivityID: act.ID, At: e.w.Now, System: true})
	}
	l.Steers = steers
	l.Returning = append(slices.Clone(l.Returning), pendingReturn{SubID: s.ID, Reason: reason, Waiting: wait, Since: e.w.Now})
	e.returnTimer(t.ID, s.ID, 0)
	return fmt.Sprintf("Runs built on %s are still working (%s): they were told to hand off now, and %s is sent back once they have; "+
		"if that takes over %d minutes the user is asked. Their handoffs will need checking again. Do not dispatch %s meanwhile.",
		s.ID, strings.Join(wait, ", "), s.ID, int(returnWait/time.Minute), s.NodeID)
}

func (e *Engine) returnTimer(taskID, subID string, gen int) {
	time.AfterFunc(returnWait, func() { e.returnTimedOut(taskID, subID, gen) })
}

// returnTimedOut asks the user whether to stop what a send-back still waits for.
func (e *Engine) returnTimedOut(taskID, subID string, gen int) {
	_ = e.do(func() error {
		t := e.w.Tasks[taskID]
		if t == nil {
			return nil
		}
		p := e.returning(t, subID)
		if p == nil || p.Gen != gen || p.QuestionID != "" {
			return nil
		}
		var names []string
		for _, id := range p.Waiting {
			if d := e.w.SubTasks[id]; d != nil && e.windingUp(t, d) {
				names = append(names, e.nodeName(t, d.NodeID))
			}
		}
		steps, name, minutes := strings.Join(names, "、"), e.nodeName(t, e.w.SubTasks[subID].NodeID), int(returnWait/time.Minute)
		text := i18n.T("等「%s」交接已超過 %d 分鐘，要立刻停掉並退回「%s」嗎？", steps, minutes, name)
		a := e.systemEvent(t, "returnWaitLong", text, map[string]any{"steps": steps, "step": name, "minutes": minutes}, subID)
		q := e.askUserQuestion(t, model.TaskQuestion{ActivityID: a.ID, Prompt: text, Kind: "approval", SubID: subID,
			Options: []model.ReviewOption{{ID: optionReturnNow, Label: i18n.T("立刻停掉並退回")}, {ID: optionWaitMore, Label: i18n.T("再等 %d 分鐘", minutes)}}})
		e.editLog(t.ID).Returning = e.withReturn(t, subID, func(p *pendingReturn) { p.QuestionID = q.ID })
		return nil
	})
}

// withReturn is the task's waiting send-backs with the one of subID changed by fn.
func (e *Engine) withReturn(t *model.Task, subID string, fn func(p *pendingReturn)) []pendingReturn {
	out := slices.Clone(e.logOf(t.ID).Returning)
	for i := range out {
		if out[i].SubID == subID {
			out[i].Waiting = slices.Clone(out[i].Waiting)
			fn(&out[i])
		}
	}
	return out
}

// answerReturn is the user's answer to the card of a send-back that waited too long. Call it holding the lock.
func (e *Engine) answerReturn(t *model.Task, questionID, option string) {
	l := e.logOf(t.ID)
	if l == nil {
		return
	}
	for _, p := range l.Returning {
		if p.QuestionID != questionID {
			continue
		}
		if option == optionReturnNow {
			e.sendBackNow(t, p)
			return
		}
		e.editLog(t.ID).Returning = e.withReturn(t, p.SubID, func(p *pendingReturn) { p.Gen++; p.QuestionID = "" })
		e.returnTimer(t.ID, p.SubID, p.Gen+1)
		return
	}
}

// settleReturns sends back each waiting send-back of the task that has nothing left working on it, or every one when
// now is set: the user paused, the budget ran out, or the server started again. Call it holding the lock.
func (e *Engine) settleReturns(t *model.Task, now bool) {
	l := e.logOf(t.ID)
	if l == nil || len(l.Returning) == 0 {
		return
	}
	for _, p := range slices.Clone(l.Returning) {
		working := slices.ContainsFunc(p.Waiting, func(id string) bool {
			d := e.w.SubTasks[id]
			return d != nil && e.windingUp(t, d)
		})
		if now || !working {
			e.sendBackNow(t, p)
		}
	}
}

// sendBackNow ends a send-back's wait: what still works is stopped, and the run is sent back.
func (e *Engine) sendBackNow(t *model.Task, p pendingReturn) {
	l := e.editLog(t.ID)
	l.Returning = slices.DeleteFunc(slices.Clone(l.Returning), func(o pendingReturn) bool { return o.SubID == p.SubID })
	l.Steers = slices.DeleteFunc(slices.Clone(l.Steers), func(o pendingSteer) bool { return o.System && slices.Contains(p.Waiting, o.SubID) })
	if p.QuestionID != "" {
		dropQuestion(t, p.QuestionID)
	}
	s := e.w.SubTasks[p.SubID]
	if s == nil || !current(s) {
		return
	}
	redo := e.rework(t, s, p.Reason, "owner")
	e.addEvent(t, ownerEvent{Kind: evReturnComplete, Key: "returned:" + s.ID, SubID: s.ID,
		Text: "Step run " + s.ID + " (" + s.NodeID + ") is sent back now; the redo is " + redo.ID + ". " +
			"What " + strings.Join(p.Waiting, ", ") + " handed off before is kept, and needs checking again (read_step)."})
}

// dropReturn forgets a waiting send-back without sending it back: the user sends the run back themselves.
func (e *Engine) dropReturn(t *model.Task, subID string) {
	p := e.returning(t, subID)
	if p == nil {
		return
	}
	waiting, qid := p.Waiting, p.QuestionID
	l := e.editLog(t.ID)
	l.Returning = slices.DeleteFunc(slices.Clone(l.Returning), func(o pendingReturn) bool { return o.SubID == subID })
	l.Steers = slices.DeleteFunc(slices.Clone(l.Steers), func(o pendingSteer) bool { return o.System && slices.Contains(waiting, o.SubID) })
	if qid != "" {
		dropQuestion(t, qid)
	}
}

// returningNode says which waiting send-back keeps step nodeID from being dispatched, or "".
func (e *Engine) returningNode(t *model.Task, nodeID string) string {
	l := e.logOf(t.ID)
	if l == nil {
		return ""
	}
	for _, p := range l.Returning {
		if s := e.w.SubTasks[p.SubID]; s != nil && s.NodeID == nodeID {
			return p.SubID
		}
	}
	return ""
}
