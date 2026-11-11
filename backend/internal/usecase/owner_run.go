package usecase

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/yanun0323/Team-Work/internal/adapter"
	"github.com/yanun0323/Team-Work/internal/i18n"
	"github.com/yanun0323/Team-Work/internal/model"
	"github.com/yanun0323/Team-Work/internal/model/enum"
	"github.com/yanun0323/Team-Work/internal/usecase/tools"
)

// ownerRun is one decision of a task's owner: the events it was woken by, and the versions of the task it decides on.
// Its tools run one after another in its goroutine, which alone changes these fields.
type ownerRun struct {
	r                           *run
	taskID, ownerID, wake       string
	spec                        agentSpec
	message                     model.Message
	folder, dir, branch, target string
	plan, control               int
	callID                      string
	calls                       int
	// stale is set once the task moved on under the decision: what is left of it is not done, and its events wait for
	// the next one.
	stale bool
	// completed is set once the decision reported the task done: that report is what the user reads, so the words the
	// decision ends with are not posted again.
	completed bool
}

// launchSaved starts what owner-led tasks have waiting, once what started it is saved: queued steps, and the owner
// when events wait. Call it holding the lock, after a save.
func (e *Engine) launchSaved() bool {
	ids := make([]string, 0, len(e.w.Tasks))
	for id, t := range e.w.Tasks {
		if t.OwnerLed() {
			ids = append(ids, id)
		}
	}
	sort.Strings(ids)
	moved := false
	for _, id := range ids {
		t := e.w.Tasks[id]
		moved = e.dispatchOwner(t) || moved
		moved = e.wakeOwner(t) || moved
	}
	return moved
}

// writerBusy says whether a work step of the task is running or stopping: they share one work tree, so they take
// turns writing to it.
func (e *Engine) writerBusy(t *model.Task) bool {
	for _, s := range e.subsOf(t.ID) {
		n := nodeOf(&t.Workflow, s.NodeID)
		if n != nil && n.Kind != enum.NodeTalk && (e.runs[s.ID] != nil || s.ExecutionState == model.ExecStopping) {
			return true
		}
	}
	return false
}

// dispatchOwner starts the steps the owner dispatched. A paused task starts only meetings called during the pause.
func (e *Engine) dispatchOwner(t *model.Task) bool {
	c := t.Coordination
	if t.Stage != enum.StageRunning || !started(t) || e.taskCost(t) >= e.costLimit(t) || held(c) {
		return false
	}
	moved := false
	for _, s := range e.subsOf(t.ID) {
		if held(c) { // a run that failed to start may have just stopped the rest
			break
		}
		if s.Status != enum.StatusTodo || !current(s) || s.Validity == model.ValidNeedsRevalidation || s.ReplicaID == nil || e.runs[s.ID] != nil {
			continue
		}
		switch s.ExecutionState {
		case model.ExecStopping, model.ExecStopped, model.ExecUncertain:
			continue
		}
		n := nodeOf(&t.Workflow, s.NodeID)
		if n == nil {
			continue
		}
		if t.Paused && (n.Kind != enum.NodeTalk || t.PausedAt == nil || s.CreatedAt < *t.PausedAt) {
			continue
		}
		if n.Kind != enum.NodeTalk && e.writerBusy(t) {
			continue
		}
		if !e.authorized(t, *s.ReplicaID) {
			continue
		}
		s.Status = enum.StatusProgressing
		s.RunGeneration++
		s.ExecutionState = model.ExecRunning
		name := e.replicaName(*s.ReplicaID)
		e.logLine(s, enum.LogSystem, i18n.T("%s 開始工作", name), "start", map[string]any{"name": name})
		if s.StartedAt == nil {
			s.StartedAt = ptr(e.w.Now)
		}
		e.startSub(t, s)
		moved = true
	}
	return moved
}

// wakeOwner has the owner decide on the events waiting, when nothing stops them. One decision at a time.
func (e *Engine) wakeOwner(t *model.Task) bool {
	c := t.Coordination
	key := ownerKey(t.ID)
	if !started(t) || e.runs[key] != nil || c.OwnerState == model.OwnerBlocked || c.OwnerState == model.OwnerFailed || e.closed {
		return false
	}
	switch t.Stage {
	case enum.StageRunning, enum.StageAwaitMerge:
	default:
		return false
	}
	pending := eventsIn(e.logOf(t.ID), eventPending)
	if len(pending) == 0 {
		if c.OwnerState != model.OwnerIdle {
			c.OwnerState = model.OwnerIdle
			return true
		}
		return false
	}
	owner := e.owner(t)
	if owner == nil {
		e.block(t, "owner", model.TaskQuestion{Kind: "approval", Prompt: i18n.T("這個任務的負責人已不在，請選新的負責人")})
		return true
	}
	if e.taskCost(t) >= e.costLimit(t) {
		e.budgetHold(t)
		return true
	}
	spec, err := e.ownerSpec(t, owner)
	if err != nil {
		e.ownerFailed(t, nil, err)
		return true
	}
	if err := e.loadConversation(key); err != nil {
		e.ownerFailed(t, nil, err)
		return true
	}
	if _, err := e.activities(t.ID); err != nil { // the brief ends with the latest of the conversation
		e.ownerFailed(t, nil, err)
		return true
	}
	l := e.editLog(t.ID)
	l.Wakes++
	wake := key + "-" + strconv.Itoa(l.Wakes)
	for _, ev := range pending {
		ev.State, ev.Wake = eventProcessing, wake
		l.Events[ev.ID] = ev
		if ev.OperationID != "" {
			if op, ok := l.Operations[ev.OperationID]; ok && op.Status == model.OpReceived {
				e.setOperation(t, op.ID, model.OpProcessing, nil)
			}
		}
	}
	c.OwnerState = model.OwnerResponding
	msg := userText(e.ownerBrief(t, pending))
	e.w.Conversations[key] = append(e.w.Conversations[key], msg)
	e.dirty[key] = true
	team := e.w.Teams[t.TeamID]
	timeout := time.Duration(team.Settings.TimeoutMin * float64(time.Minute))
	ctx, cancel := context.WithCancel(e.ctx)
	if timeout > 0 {
		ctx, cancel = context.WithTimeout(e.ctx, timeout)
	}
	r := &run{cancel: cancel, replicaID: owner.ID}
	e.runs[key] = r
	in := &ownerRun{r: r, taskID: t.ID, ownerID: owner.ID, wake: wake, spec: spec, message: msg,
		folder: team.Folder, dir: e.worktreeOf(t), branch: t.Branch, target: team.TargetBranch, plan: c.PlanVersion, control: c.ControlVersion}
	e.wg.Add(1)
	go e.runOwner(ctx, in)
	return true
}

// ownerSpec is how the owner is asked: their model and role, told how to lead.
func (e *Engine) ownerSpec(t *model.Task, r *model.Replica) (agentSpec, error) {
	bp := e.w.Blueprints[r.BlueprintID]
	if bp == nil {
		return agentSpec{}, model.Errorf(model.CodeInvalid, "%s 的員工藍圖已不存在，請編輯這位員工，重新選擇藍圖", r.Name)
	}
	spec, err := e.modelSpec(r.Model, r.Effort)
	if err != nil {
		return agentSpec{}, err
	}
	spec.name = r.Name
	spec.allowed = slices.DeleteFunc(slices.Clone(bp.Tools), func(x enum.Tool) bool { return x != enum.ToolReadFile && x != enum.ToolWebSearch })
	team := e.w.Teams[t.TeamID]
	e.readPrompt(team)
	spec.prompt = promptParts{
		rules:  ownerRules + "\n" + languageRule(e.w.Language) + "\n" + dataRule + "\n",
		shared: sharedRules(e.runGlobalPrompt(), team.Prompt),
		role:   e.rolePart(bp),
		memory: memorySection(r),
	}
	return spec, nil
}

// ownerRules are what a task's owner is told. They lead through tools the system checks; they do no step's work.
const ownerRules = "You are the owner of a task: you lead it for the user. Employees do the work, each in a step you dispatch with instructions; you do not edit files or run commands yourself. " +
	"The task's flow is the plan it started from, not a script: dispatch steps that are ready (several at once when they do not depend on each other), review every handoff before anything builds on it, " +
	"answer employees' questions, send work back when it falls short, and change the plan when the work calls for it, within what the user allowed. " +
	"Every change you make is recorded for the user. Whatever goes beyond what the user allowed (other employees, more budget, settings, merging, anything outside the task or destructive) is the user's decision: ask with ask_user, never decide it for them. " +
	"Constraints and decisions that must hold for the rest of the task go in record_task_fact; the formal state at the start of every message is what holds, and read_task_history and read_step show the rest on demand. " +
	"You are woken only by events: the user writing, handoffs, questions, failures, meetings ending and stops. When nothing more can be done until the next one, end your turn with a short message to the user about what happened and what is next; it goes into the task's conversation. " +
	"In what the user reads (messages, reasons, questions, instructions), call employees by their names and steps by theirs, never by ids such as sub-12 or rep-3; ids are for tools. " +
	"When the user pauses the task, only talk: do not dispatch until they resume. When every step that counts is done and accepted, call submit_complete; the user decides about merging. " +
	"Its summary is your report to the user: end your turn after it without repeating it. " +
	"You cannot merge yourself: when the user asks you to merge, call submit_complete with ask_merge, and they get a card that merges with one press. " +
	"Work outside this task, such as a problem found on the way, can go into another task with create_task, but only when the user asked for it or agreed to your proposal; what this task needs goes into its plan instead. " +
	"Never tell the user to do by hand what one of your tools does, and do not offer what no tool of yours does.\n" +
	unseenThinkingRule

// ownerBrief is what the owner reads first each time: the task's formal state, then what woke them.
func (e *Engine) ownerBrief(t *model.Task, events []ownerEvent) string {
	var b strings.Builder
	b.WriteString(e.taskState(t))
	b.WriteString("\n# What woke you\n")
	for _, ev := range events {
		fmt.Fprintf(&b, "- [%s] %s\n", ev.Kind, ev.Text)
	}
	if all, _ := e.activities(t.ID); len(all) > 0 {
		from := max(0, len(all)-10)
		fmt.Fprintf(&b, "\n# Latest in the conversation (%d entries in all; older ones with read_task_history, one in full with read_task_entry)\n", len(all))
		for _, a := range all[from:] {
			b.WriteString(activityLine(a))
		}
	}
	return b.String()
}

func activityLine(a model.TaskActivity) string {
	who := a.From
	if a.Name != "" {
		who = a.Name
	}
	where := ""
	if a.SubID != "" {
		where = " (" + a.SubID + ")"
	}
	text := clip(a.Text, 600)
	if text != a.Text {
		text += " (clipped: read_task_entry " + a.ID + " reads it all)"
	}
	return fmt.Sprintf("- %s #%d %s %s%s: %s%s\n", a.ID, a.Seq, a.Kind, who, where, text, attachmentNote(a.Images, a.Files))
}

// entryPage is how much of one entry read_task_entry gives at a time, in characters.
const entryPage = 20000

func (e *Engine) readEntryTool(in *ownerRun) func(context.Context, string, json.RawMessage) model.ToolResult {
	return func(_ context.Context, _ string, raw json.RawMessage) model.ToolResult {
		var a struct {
			ID     string `json:"activity_id"`
			Offset int    `json:"offset"`
		}
		if err := parseArgs(raw, &a); err != nil {
			return toolError("%s", safeText(err))
		}
		return e.ownerRead(in, func(t *model.Task) model.ToolResult {
			all, err := e.activities(t.ID)
			if err != nil {
				return toolError("%s", safeText(err))
			}
			i := slices.IndexFunc(all, func(x model.TaskActivity) bool { return x.ID == a.ID })
			if i < 0 {
				return toolError("no entry %s in this task", a.ID)
			}
			x := all[i]
			who := x.From
			if x.Name != "" {
				who = x.Name
			}
			var b strings.Builder
			fmt.Fprintf(&b, "%s #%d %s by %s", x.ID, x.Seq, x.Kind, who)
			if x.SubID != "" {
				fmt.Fprintf(&b, ", step run %s", x.SubID)
			}
			if x.QuestionID != "" {
				fmt.Fprintf(&b, ", question %s", x.QuestionID)
			}
			for _, im := range x.Images {
				fmt.Fprintf(&b, "\nAttached image: %s", im.Name)
			}
			for _, f := range x.Files {
				fmt.Fprintf(&b, "\nAttached file: %s, read-only path: %s", f.Name, e.attachmentPath(t.ID, f))
			}
			text := []rune(x.Text)
			from := min(max(a.Offset, 0), len(text))
			to := min(from+entryPage, len(text))
			fmt.Fprintf(&b, "\nText %d-%d of %d characters:\n%s", from, to, len(text), string(text[from:to]))
			if to < len(text) {
				fmt.Fprintf(&b, "\nMore: offset=%d", to)
			}
			return model.ToolResult{Text: b.String()}
		})
	}
}

// taskState is the task's formal state, as the owner reads it: none of it lives only in a summary.
func (e *Engine) taskState(t *model.Task) string {
	c := t.Coordination
	var b strings.Builder
	fmt.Fprintf(&b, "# Task #%d (plan version %d, control version %d)\nTitle: %s\nStage: %s", t.Number, c.PlanVersion, c.ControlVersion, t.Title, t.Stage)
	if t.Paused {
		b.WriteString(", PAUSED by the user: do not dispatch")
	}
	fmt.Fprintf(&b, "\nBudget: %.2f of %.2f USD used\n\n## Description\n%s\n", e.taskCost(t), e.costLimit(t), t.Description)
	if l := e.logOf(t.ID); l != nil && len(l.Brief) > 0 && (l.Brief[0].Title != t.Title || l.Brief[0].Description != t.Description) {
		fmt.Fprintf(&b, "\n## As the user first wrote it\nTitle: %s\n%s\n", l.Brief[0].Title, l.Brief[0].Description)
	}
	if n := len(t.Images) + len(t.Files); n > 0 {
		fmt.Fprintf(&b, "Attachments: %s\n", strings.Trim(attachmentNote(t.Images, t.Files), " "))
	}
	b.WriteString("\n## Allowed\nEmployees you may assign: ")
	for i, id := range c.Authorization.ReplicaIDs {
		if i > 0 {
			b.WriteString(", ")
		}
		fmt.Fprintf(&b, "%s (%s)", e.replicaName(id), id)
	}
	fmt.Fprintf(&b, "\nYou may change the plan: %v\n", c.Authorization.PlanChanges)
	if len(c.Facts) > 0 {
		b.WriteString("\n## Constraints and decisions\n")
		superseded := map[string]bool{}
		for _, f := range c.Facts {
			if f.Supersedes != "" {
				superseded[f.Supersedes] = true
			}
		}
		for _, f := range c.Facts {
			mark := ""
			if superseded[f.ID] {
				mark = " (superseded)"
			}
			fmt.Fprintf(&b, "- %s [%s]%s %s\n", f.ID, f.Kind, mark, f.Text)
		}
	}
	b.WriteString("\n## Plan\n")
	for _, n := range t.Workflow.Nodes {
		names := []string{}
		for _, id := range n.ReplicaIDs {
			names = append(names, e.replicaName(id)+" ("+id+")")
		}
		fmt.Fprintf(&b, "- %s \"%s\" [%s] staff: %s\n  %s\n", n.ID, n.Name, n.Kind, strings.Join(names, ", "), clip(n.Prompt, 400))
	}
	for _, edge := range t.Workflow.Edges {
		fmt.Fprintf(&b, "- %s -> %s %s\n", edge.From, edge.To, edge.Condition)
	}
	b.WriteString("\n## Step runs\n")
	subs := e.subsOf(t.ID)
	if len(subs) == 0 {
		b.WriteString("None yet.\n")
	}
	for _, s := range subs {
		who := ""
		if s.ReplicaID != nil {
			who = e.replicaName(*s.ReplicaID)
		}
		fmt.Fprintf(&b, "- %s step %s by %s: %s", s.ID, s.NodeID, who, s.Status)
		if s.ExecutionState != "" {
			fmt.Fprintf(&b, ", run %s", s.ExecutionState)
		}
		if s.OwnerReview != "" {
			fmt.Fprintf(&b, ", review %s", s.OwnerReview)
		}
		if s.Validity != "" && s.Validity != model.ValidCurrent {
			fmt.Fprintf(&b, ", %s", s.Validity)
		}
		if s.Cancelled {
			b.WriteString(", cancelled")
		}
		if s.Rework != nil {
			fmt.Fprintf(&b, ", redo of %s: %s", s.Rework.From, clip(s.Rework.Reason, 200))
		}
		if s.Handoff != nil {
			fmt.Fprintf(&b, "\n  handoff: %s", clip(s.Handoff.Human.Headline, 300))
		}
		b.WriteString("\n")
	}
	if len(c.Questions) > 0 {
		b.WriteString("\n## Open questions\n")
		for _, q := range c.Questions {
			fmt.Fprintf(&b, "- %s for the %s (%s)", q.ID, q.Audience, q.Kind)
			if q.SubID != "" {
				fmt.Fprintf(&b, " from %s", q.SubID)
			}
			fmt.Fprintf(&b, ": %s\n", clip(q.Prompt, 600))
		}
	}
	return b.String()
}

// runOwner is one decision of the owner. Its goroutine is the engine's, ending with its context.
func (e *Engine) runOwner(ctx context.Context, in *ownerRun) {
	defer e.wg.Done()
	defer in.r.cancel()
	key := ownerKey(in.taskID)
	defer func() {
		e.mu.Lock()
		defer e.mu.Unlock()
		if e.runs[key] == in.r { // it ended without saying how: the events wait for the next decision
			delete(e.runs, key)
			delete(e.live, key)
			if t := e.w.Tasks[in.taskID]; t != nil && t.OwnerLed() {
				e.returnEvents(t, in.wake)
			}
			e.settle()
		}
	}()
	finish := func(fn func(t *model.Task)) {
		e.mu.Lock()
		defer e.mu.Unlock()
		if e.runs[key] != in.r {
			return
		}
		delete(e.runs, key)
		delete(e.live, key)
		t := e.w.Tasks[in.taskID]
		if t == nil || !t.OwnerLed() {
			return
		}
		e.w.Now = e.clock()
		fn(t)
		e.settle()
	}
	if err := e.git.Worktree(ctx, in.folder, in.dir, in.branch, in.target); err != nil {
		if ctx.Err() != nil {
			return
		}
		e.log.Error().Err(err).Str("task", in.taskID).Msg("make work tree")
		finish(func(t *model.Task) {
			e.ownerFailed(t, in, model.Errorf(model.CodeInvalid, "建立 work tree 失敗（分支 %s）", in.branch))
		})
		return
	}
	tr := e.ownerTurn(in)
	tr.req.System = in.spec.prompt.compose("", nil)
	res, err := tr.run(ctx)
	switch {
	case err != nil && ctx.Err() != nil && !errors.Is(ctx.Err(), context.DeadlineExceeded):
		// stopped on purpose; whoever stopped it put the events back
	case err != nil:
		if errors.Is(ctx.Err(), context.DeadlineExceeded) {
			err = model.Errorf(model.CodeUnavailable, "執行逾時")
		}
		finish(func(t *model.Task) { e.ownerFailed(t, in, err) })
	default:
		finish(func(t *model.Task) {
			if in.stale || t.Coordination.OwnerState == model.OwnerBlocked {
				e.returnEvents(t, in.wake)
				return
			}
			if text := strings.TrimSpace(res.Text); text != "" && !in.completed {
				e.addActivity(t, model.TaskActivity{Kind: "message", From: "agent", Text: text, By: in.ownerID, Name: e.replicaName(in.ownerID)})
			}
			e.eventsHandled(t, in.wake)
		})
	}
}

// returnEvents puts a decision's events back in the queue, so the next decision takes them up with what came since.
func (e *Engine) returnEvents(t *model.Task, wake string) {
	l := e.editLog(t.ID)
	for id, ev := range l.Events {
		if ev.State == eventProcessing && ev.Wake == wake {
			ev.State, ev.Wake = eventPending, ""
			l.Events[id] = ev
		}
	}
	if t.Coordination.OwnerState == model.OwnerResponding {
		t.Coordination.OwnerState = model.OwnerQueued
	}
}

// eventsHandled ends a decision: its events are done, and the user's messages in it took effect.
func (e *Engine) eventsHandled(t *model.Task, wake string) {
	l := e.editLog(t.ID)
	for id, ev := range l.Events {
		if ev.State != eventProcessing || ev.Wake != wake {
			continue
		}
		ev.State = eventHandled
		l.Events[id] = ev
		if ev.OperationID != "" {
			if op, ok := l.Operations[ev.OperationID]; ok && (op.Status == model.OpProcessing || op.Status == model.OpReceived || op.Status == model.OpFailed) {
				e.setOperation(t, op.ID, model.OpApplied, nil)
			}
		}
	}
	c := t.Coordination
	if c.OwnerState == model.OwnerResponding {
		c.OwnerState = model.OwnerIdle
	}
	if len(eventsIn(l, eventPending)) > 0 && c.OwnerState == model.OwnerIdle {
		c.OwnerState = model.OwnerQueued
	}
}

// ownerFailed is a decision that failed after the model was tried again: the user can retry it, and until then the
// owner is not woken. Its events stay, for the retry.
func (e *Engine) ownerFailed(t *model.Task, in *ownerRun, err error) {
	failure := &model.OperationError{Code: model.CodeUnavailable, Message: safeText(err)}
	var known *model.Error
	if errors.As(err, &known) {
		failure.Code = known.Code
	}
	l := e.editLog(t.ID)
	retried := ""
	for _, ev := range l.Events {
		// a decision that failed before it began failed for the events still waiting
		mine := in != nil && ev.State == eventProcessing && ev.Wake == in.wake || in == nil && ev.State == eventPending
		if mine && ev.OperationID != "" {
			e.setOperation(t, ev.OperationID, model.OpFailed, failure)
			if l.Operations[ev.OperationID].Kind == "retry" {
				retried = ev.OperationID
			}
		}
	}
	// a retry that failed is retried again; only a new failure needs an operation of its own
	op, ok := l.Operations[retried]
	if !ok {
		op = e.newOperation(t, model.TaskOperation{Kind: "retry", Status: model.OpFailed, Error: failure})
	}
	t.Coordination.OwnerState = model.OwnerFailed
	a := e.systemEvent(t, "ownerFailed", i18n.T("負責人處理失敗：%s", failure.Message), map[string]any{"error": failure.Message}, "")
	e.touchLast(t, a.ID, func(a *model.TaskActivity) { a.OperationID = op.ID })
}

// ownerTurn is the owner's model-and-tools loop: what they read and write is kept in their conversation, and what
// they spend counts towards the task's budget.
func (e *Engine) ownerTurn(in *ownerRun) *turn {
	key := ownerKey(in.taskID)
	list := tools.For(in.spec.allowed, tools.Env{Read: []string{e.attachmentRoot(in.taskID)}, Search: e.search})
	list = append(list, e.ownerTools(in)...)
	list = append(list, funcTool{searchMemorySpec, e.searchMemoryTool(func() *string { return ptr(in.ownerID) })})
	specs := make([]model.ToolSpec, len(list))
	byName := make(map[string]adapter.Tool, len(list))
	for i, tool := range list {
		specs[i] = tool.Spec()
		byName[specs[i].Name] = tool
	}
	record := func(fn func(t *model.Task)) bool {
		e.mu.Lock()
		defer e.mu.Unlock()
		if e.runs[key] != in.r {
			return false
		}
		t := e.w.Tasks[in.taskID]
		if t == nil || !t.OwnerLed() {
			return false
		}
		e.w.Now = e.clock()
		fn(t)
		e.settle()
		return true
	}
	return &turn{
		provider: in.spec.provider,
		req:      model.ModelRequest{Cwd: in.dir, Session: in.wake, Model: in.spec.model, Effort: in.spec.effort, Messages: []model.Message{in.message}, Tools: specs},
		tools:    byName, cwd: in.dir,
		onStart: func() { e.restartLive(key, in.r) },
		onText:  func(text string) { e.addLive(key, in.r, text) },
		onReply: func(reply model.ModelReply) bool {
			goOn := false
			record(func(t *model.Task) {
				e.w.Conversations[key] = append(e.w.Conversations[key], model.Message{Role: enum.RoleAssistant, Content: reply.Content, By: in.ownerID})
				e.dirty[key] = true
				c := t.Coordination
				c.OwnerTokens += tokensUsed(reply.Usage)
				if in.spec.price != nil {
					c.OwnerCostUSD += cost(reply.Usage, *in.spec.price)
				}
				calls := in.calls
				for _, b := range reply.Content {
					if b.Type == enum.BlockToolCall {
						calls++
					}
				}
				switch {
				case e.taskCost(t) >= e.costLimit(t):
					e.budgetHold(t)
				case calls > maxOwnerTools:
					e.block(t, "loop", model.TaskQuestion{Kind: "approval", Prompt: i18n.T("負責人一次處理呼叫太多工具，已停下來等你決定"),
						Options: []model.ReviewOption{{ID: optionContinue, Label: i18n.T("讓負責人繼續")}}})
				default:
					goOn = true
				}
			})
			return goOn
		},
		onTool: func(call model.Block) {
			in.callID = call.ID
			in.calls++
		},
		onResults: func(msg model.Message) {
			record(func(*model.Task) {
				e.w.Conversations[key] = append(e.w.Conversations[key], msg)
				e.dirty[key] = true
			})
		},
	}
}

// ---------- the owner's tools ----------

// ownerChange runs one of the owner's changes as a change of its own: saved before it counts, undone when it cannot be.
// The task must still be as the owner last saw it; once it moved on, the decision stops and starts over with what is new.
// The same call is done once.
func (e *Engine) ownerChange(in *ownerRun, fn func(t *model.Task) (string, error)) model.ToolResult {
	key := ownerKey(in.taskID)
	command := in.wake + ":" + in.callID
	var out model.ToolResult
	err := e.do(func() error {
		if e.runs[key] != in.r {
			out = model.ToolResult{Text: "This decision was stopped.", Stop: true}
			return nil
		}
		t := e.w.Tasks[in.taskID]
		if t == nil || !t.OwnerLed() {
			out = model.ToolResult{Text: "The task is gone.", Stop: true}
			return nil
		}
		l := e.logOf(t.ID)
		if done, ok := l.Commands[command]; ok {
			out = model.ToolResult{Text: done}
			return nil
		}
		c := t.Coordination
		if c.PlanVersion != in.plan || c.ControlVersion != in.control {
			in.stale = true
			out = model.ToolResult{Text: "The task changed since you were woken (the user wrote, paused, resumed or answered). Nothing was done; you will be woken again with what is new.", Stop: true}
			return nil
		}
		text, err := fn(t)
		if err != nil {
			return err
		}
		e.editLog(t.ID).Commands[command] = text
		in.plan, in.control = c.PlanVersion, c.ControlVersion
		out = model.ToolResult{Text: text}
		return nil
	})
	if err != nil {
		return toolError("%s", safeText(err))
	}
	return out
}

// ownerRead reads the task under the lock.
func (e *Engine) ownerRead(in *ownerRun, fn func(t *model.Task) model.ToolResult) model.ToolResult {
	e.mu.Lock()
	defer e.mu.Unlock()
	t := e.w.Tasks[in.taskID]
	if t == nil || !t.OwnerLed() {
		return toolError("the task is gone")
	}
	return fn(t)
}

func parseArgs(raw json.RawMessage, v any) error {
	if err := json.Unmarshal(raw, v); err != nil {
		return model.Errorf(model.CodeInvalid, "參數不正確：%s", err.Error())
	}
	return nil
}

func ownerTool(name, description, schema string, fn func(context.Context, string, json.RawMessage) model.ToolResult) adapter.Tool {
	return funcTool{model.ToolSpec{Name: name, Description: description, Parameters: json.RawMessage(schema)}, fn}
}

func (e *Engine) ownerTools(in *ownerRun) []adapter.Tool {
	return []adapter.Tool{
		ownerTool("read_task", "Read the task's formal state now: plan, step runs, constraints and decisions, open questions.", `{"type":"object","properties":{}}`,
			func(context.Context, string, json.RawMessage) model.ToolResult {
				return e.ownerRead(in, func(t *model.Task) model.ToolResult { return model.ToolResult{Text: e.taskState(t)} })
			}),
		ownerTool("read_task_history", "Read the task's conversation by page, oldest first: the entries before seq before, or the latest.",
			`{"type":"object","properties":{"before":{"type":"integer"},"limit":{"type":"integer","maximum":100}}}`, e.readHistoryTool(in)),
		ownerTool("read_task_entry", "Read one entry of the task's conversation in full, with what was attached, by page of its text.",
			`{"type":"object","properties":{"activity_id":{"type":"string"},"offset":{"type":"integer"}},"required":["activity_id"]}`, e.readEntryTool(in)),
		ownerTool("read_step", "Read a step run in full: its instructions, handoff, open question and log, by page.",
			`{"type":"object","properties":{"sub_id":{"type":"string"},"log_offset":{"type":"integer"}},"required":["sub_id"]}`, e.readStepTool(in)),
		ownerTool("dispatch_step", "Start a step of the plan with your instructions, by an allowed employee (the step's first when left out). "+
			"upstream_ids are accepted runs whose handoffs it builds on. With sub_id, go on with a stopped run instead, adding the instructions.",
			`{"type":"object","properties":{"node_id":{"type":"string"},"replica_id":{"type":"string"},"instructions":{"type":"string"},"upstream_ids":{"type":"array","items":{"type":"string"}},"sub_id":{"type":"string"}},"required":["instructions"]}`,
			e.dispatchTool(in)),
		ownerTool("review_step", "Accept or reject a step run's handoff. Only accepted runs count, and only they can be built on.",
			`{"type":"object","properties":{"sub_id":{"type":"string"},"decision":{"type":"string","enum":["accept","reject"]},"reason":{"type":"string"}},"required":["sub_id","decision"]}`,
			e.reviewTool(in)),
		ownerTool("stop_step", "Stop a step run now. Files it already changed stay as they are.",
			`{"type":"object","properties":{"sub_id":{"type":"string"},"reason":{"type":"string"}},"required":["sub_id","reason"]}`, e.stopTool(in)),
		ownerTool("return_step", "Send a step run back to be redone by the same employee with your reason; runs built on it must be checked again. Nothing is deleted or reverted.",
			`{"type":"object","properties":{"sub_id":{"type":"string"},"reason":{"type":"string"}},"required":["sub_id","reason"]}`, e.returnTool(in)),
		ownerTool("answer_employee", "Answer a question an employee asked you; their step goes on with it.",
			`{"type":"object","properties":{"question_id":{"type":"string"},"answer":{"type":"string"}},"required":["question_id","answer"]}`, e.answerTool(in)),
		ownerTool("hold_meeting", "Call a meeting of 2 to 6 allowed employees on a topic. Each speaks once, reading only; when it ends you get what was said.",
			`{"type":"object","properties":{"topic":{"type":"string"},"replica_ids":{"type":"array","items":{"type":"string"},"minItems":2,"maxItems":6}},"required":["topic","replica_ids"]}`, e.meetingTool(in)),
		ownerTool("revise_plan", "Replace the task's plan with nodes and edges as a flow has them, with your reason: add, skip (remove a step never run) or restaff steps. "+
			"Steps already run stay. Only allowed employees. The shared flow is not changed.",
			`{"type":"object","properties":{"nodes":{"type":"array","items":{"type":"object","properties":{"id":{"type":"string"},"kind":{"type":"string","enum":["work","talk"]},"name":{"type":"string"},"prompt":{"type":"string"},"replica_ids":{"type":"array","items":{"type":"string"}}},"required":["id","name"]}},`+
				`"edges":{"type":"array","items":{"type":"object","properties":{"from":{"type":"string"},"to":{"type":"string"},"condition":{"type":"string"}},"required":["from","to"]}},"reason":{"type":"string"}},"required":["nodes","edges","reason"]}`,
			e.planTool(in)),
		ownerTool(toolAskUser, "Ask the user something only they decide; it waits in the task until they answer, and you are woken with the answer. "+
			"To add employees the user did not allow, give their replica_ids; to ask for more budget, set budget.",
			`{"type":"object","properties":{"prompt":{"type":"string","description":"`+askPromptHow+`"},"options":{"type":"array","items":{"type":"string"}},"replica_ids":{"type":"array","items":{"type":"string"}},"budget":{"type":"boolean"}},"required":["prompt"]}`,
			e.ownerAskTool(in)),
		ownerTool("record_task_fact", "Record a constraint or decision that must hold for the rest of the task, with the conversation entries it comes from. "+
			"To change one, record the new one with supersedes; a constraint from the user changes only with a newer word from the user.",
			`{"type":"object","properties":{"kind":{"type":"string","enum":["constraint","decision"]},"text":{"type":"string"},"source_activity_ids":{"type":"array","items":{"type":"string"}},"supersedes":{"type":"string"}},"required":["kind","text"]}`,
			e.factTool(in)),
		ownerTool("submit_complete", "Say the task is done: every step that counts is done and accepted, and nothing is open. The user then decides about merging. "+
			"summary is your report to the user. Set ask_merge when the user asked you to merge: they get a card that merges with one press.",
			`{"type":"object","properties":{"summary":{"type":"string"},"ask_merge":{"type":"boolean"}},"required":["summary"]}`, e.completeTool(in)),
		ownerTool(toolCreateTask, "Create another task in this company, for work outside this one, only when the user asked for it or agreed to your proposal. "+
			"It waits in to-do until the user starts it, and its conversation is shown in this one. "+taskBranchRule+" "+
			"owner_id is you when left out. Who works its steps is the user's decision: give staff only as they said. If steps have nobody, this fails and lists them; then ask the user with ask_user. "+
			"For a flow this task alone needs, give it in workflow instead of workflow_id; its steps and edges follow a flow's rules.",
			string(createTaskSchema(false)), e.ownerCreateTaskTool(in)),
	}
}

func (e *Engine) readHistoryTool(in *ownerRun) func(context.Context, string, json.RawMessage) model.ToolResult {
	return func(_ context.Context, _ string, raw json.RawMessage) model.ToolResult {
		var a struct {
			Before int `json:"before"`
			Limit  int `json:"limit"`
		}
		if err := parseArgs(raw, &a); err != nil {
			return toolError("%s", safeText(err))
		}
		return e.ownerRead(in, func(t *model.Task) model.ToolResult {
			all, err := e.activities(t.ID)
			if err != nil {
				return toolError("%s", safeText(err))
			}
			if len(all) == 0 {
				return model.ToolResult{Text: "The conversation is empty."}
			}
			limit := a.Limit
			if limit <= 0 || limit > activityMost {
				limit = 30
			}
			end := len(all)
			if a.Before > 0 {
				end = min(a.Before-1, end)
			}
			start := max(0, end-limit)
			var b strings.Builder
			for _, x := range all[start:end] {
				b.WriteString(activityLine(x))
			}
			if start > 0 {
				fmt.Fprintf(&b, "Earlier entries: before=%d\n", start+1)
			}
			return model.ToolResult{Text: b.String()}
		})
	}
}

func (e *Engine) readStepTool(in *ownerRun) func(context.Context, string, json.RawMessage) model.ToolResult {
	return func(_ context.Context, _ string, raw json.RawMessage) model.ToolResult {
		var a struct {
			SubID  string `json:"sub_id"`
			Offset int    `json:"log_offset"`
		}
		if err := parseArgs(raw, &a); err != nil {
			return toolError("%s", safeText(err))
		}
		return e.ownerRead(in, func(t *model.Task) model.ToolResult {
			s := e.w.SubTasks[a.SubID]
			if s == nil || s.TaskID != t.ID {
				return toolError("no step run %s in this task", a.SubID)
			}
			var b strings.Builder
			who := ""
			if s.ReplicaID != nil {
				who = e.replicaName(*s.ReplicaID) + " (" + *s.ReplicaID + ")"
			}
			fmt.Fprintf(&b, "Step run %s of %s by %s: %s, run %s, review %s, %s\nUpstream: %s\nInstructions:\n%s\n",
				s.ID, s.NodeID, who, s.Status, s.ExecutionState, s.OwnerReview, s.Validity, strings.Join(s.UpstreamIDs, ", "), s.Instruction)
			if s.Handoff != nil {
				raw, _ := json.Marshal(s.Handoff)
				fmt.Fprintf(&b, "Handoff: %s\n", raw)
			}
			if s.Talk != nil {
				b.WriteString("Meeting:\n")
				for _, m := range s.Talk.Messages {
					fmt.Fprintf(&b, "- %s: %s\n", e.replicaName(m.By), m.Text)
				}
			}
			const page = 80
			from := min(max(a.Offset, 0), len(s.Log))
			to := min(from+page, len(s.Log))
			fmt.Fprintf(&b, "Log %d-%d of %d:\n", from, to, len(s.Log))
			for _, line := range s.Log[from:to] {
				fmt.Fprintf(&b, "- [%s] %s\n", line.Kind, clip(line.Text, 400))
			}
			if to < len(s.Log) {
				fmt.Fprintf(&b, "More: log_offset=%d\n", to)
			}
			return model.ToolResult{Text: b.String()}
		})
	}
}

// held says whether the user must answer before the task's queued work starts: its cost limit or a loop guard stopped it.
func held(c *model.Coordination) bool {
	return c.OwnerState == model.OwnerBlocked && (c.BlockedReason == "budget" || c.BlockedReason == "loop")
}

// mayDispatch says why the task cannot take new work now, or "".
func (e *Engine) mayDispatch(t *model.Task) error {
	switch {
	case t.Paused:
		return model.Errorf(model.CodeConflict, "任務已暫停，使用者恢復前不能派工")
	case t.Stage != enum.StageRunning:
		return model.Errorf(model.CodeConflict, "這個任務現在不能派工")
	case e.taskCost(t) >= e.costLimit(t):
		return model.Errorf(model.CodeConflict, "費用已達上限")
	case held(t.Coordination):
		return model.Errorf(model.CodeConflict, "任務已停下來等使用者決定，使用者同意前不能派工")
	}
	return nil
}

func (e *Engine) dispatchTool(in *ownerRun) func(context.Context, string, json.RawMessage) model.ToolResult {
	return func(_ context.Context, _ string, raw json.RawMessage) model.ToolResult {
		var a struct {
			NodeID       string   `json:"node_id"`
			ReplicaID    string   `json:"replica_id"`
			Instructions string   `json:"instructions"`
			UpstreamIDs  []string `json:"upstream_ids"`
			SubID        string   `json:"sub_id"`
		}
		if err := parseArgs(raw, &a); err != nil {
			return toolError("%s", safeText(err))
		}
		a.Instructions = strings.TrimSpace(a.Instructions)
		if a.Instructions == "" {
			return toolError("instructions are required")
		}
		return e.ownerChange(in, func(t *model.Task) (string, error) {
			if err := e.mayDispatch(t); err != nil {
				return "", err
			}
			if a.SubID != "" {
				return e.continueRun(t, a.SubID, a.Instructions)
			}
			n := nodeOf(&t.Workflow, a.NodeID)
			if n == nil {
				return "", model.Errorf(model.CodeInvalid, "計畫裡沒有步驟 %s", a.NodeID)
			}
			who := a.ReplicaID
			if who == "" && len(n.ReplicaIDs) > 0 {
				who = n.ReplicaIDs[0]
			}
			if !e.authorized(t, who) {
				return "", model.Errorf("forbidden", "這位員工沒有被授權參與這個任務，要先問使用者")
			}
			for _, o := range e.subsOf(t.ID) {
				if o.NodeID == n.ID && current(o) && o.Status != enum.StatusComplete && o.ExecutionState != model.ExecStopped {
					return "", model.Errorf(model.CodeConflict, "這一步已有進行中的執行")
				}
			}
			upstream, err := e.upstreamOf(t, n, a.UpstreamIDs)
			if err != nil {
				return "", err
			}
			for _, o := range e.subsOf(t.ID) { // what was stopped or turned down of this step no longer counts
				stopped := o.Status != enum.StatusComplete && o.ExecutionState == model.ExecStopped
				rejected := o.Status == enum.StatusComplete && o.OwnerReview == model.ReviewRejected
				if o.NodeID == n.ID && current(o) && (stopped || rejected) {
					o.Validity = model.ValidSuperseded
				}
			}
			s := e.newRun(t, n.ID, who, a.Instructions, upstream)
			name := e.replicaName(who)
			e.systemEvent(t, "dispatched", i18n.T("派工「%s」給 %s", n.Name, name), map[string]any{"step": n.Name, "name": name, "owner": e.replicaName(in.ownerID), "instructions": clip(a.Instructions, 300)}, s.ID)
			return "dispatched " + s.ID, nil
		})
	}
}

// accepted says whether a run's handoff was accepted and still counts, so others may build on it.
func accepted(s *model.SubTask) bool {
	return current(s) && s.Status == enum.StatusComplete && s.OwnerReview == model.ReviewAccepted && s.Validity != model.ValidNeedsRevalidation
}

// upstreamOf is what a run of a step builds on: the accepted runs the owner named, and for each step the plan has
// before it that they did not name, its latest accepted run. A step waits for every step before it, or for one when it
// joins any; leaving one out is a change of the plan, made with revise_plan where the user can see it.
func (e *Engine) upstreamOf(t *model.Task, n *model.WorkflowNode, named []string) ([]string, error) {
	upstream := []string{}
	for _, id := range named {
		u := e.w.SubTasks[id]
		if u == nil || u.TaskID != t.ID || !accepted(u) {
			return nil, model.Errorf(model.CodeInvalid, "上游 %s 不是已接受的有效成果", id)
		}
		if !slices.Contains(upstream, id) {
			upstream = append(upstream, id)
		}
	}
	var before []string
	for _, edge := range t.Workflow.Edges {
		if edge.To == n.ID && !slices.Contains(before, edge.From) {
			before = append(before, edge.From)
		}
	}
	var missing []string
	for _, from := range before {
		if slices.ContainsFunc(upstream, func(id string) bool { return e.w.SubTasks[id].NodeID == from }) {
			continue
		}
		latest := ""
		for _, s := range e.subsOf(t.ID) {
			if s.NodeID == from && accepted(s) {
				latest = s.ID
			}
		}
		if latest == "" {
			missing = append(missing, e.nodeName(t, from))
			continue
		}
		upstream = append(upstream, latest)
	}
	if len(missing) > 0 && (n.Join != enum.JoinAny || len(missing) == len(before)) {
		return nil, model.Errorf(model.CodeConflict, "「%s」要等「%s」的成果被接受才能派工；不做的話先用 revise_plan 調整計畫", n.Name, strings.Join(missing, "、"))
	}
	return upstream, nil
}

// continueRun has a stopped run go on, told what the owner adds.
func (e *Engine) continueRun(t *model.Task, subID, instructions string) (string, error) {
	s := e.w.SubTasks[subID]
	if s == nil || s.TaskID != t.ID {
		return "", model.Errorf(model.CodeNotFound, "找不到子任務")
	}
	if !current(s) || s.Status == enum.StatusComplete || s.ExecutionState != model.ExecStopped || s.Validity == model.ValidNeedsRevalidation {
		return "", model.Errorf(model.CodeConflict, "只有已停止的有效執行可以接著做")
	}
	if s.ReplicaID == nil || !e.authorized(t, *s.ReplicaID) {
		return "", model.Errorf("forbidden", "這位員工沒有被授權參與這個任務，要先問使用者")
	}
	n := nodeOf(&t.Workflow, s.NodeID)
	if n == nil {
		return "", model.Errorf(model.CodeConflict, "目前的計畫已沒有步驟 %s", s.NodeID)
	}
	// the plan may have changed since it stopped: it goes on only on what the current plan has before it
	var kept []string
	for _, id := range s.UpstreamIDs {
		if u := e.w.SubTasks[id]; u != nil && accepted(u) {
			kept = append(kept, id)
		}
	}
	upstream, err := e.upstreamOf(t, n, kept)
	if err != nil {
		return "", err
	}
	if err := e.loadConversation(s.ID); err != nil {
		return "", err
	}
	if conv := e.w.Conversations[s.ID]; len(conv) > 0 {
		e.w.Conversations[s.ID] = append(answerPending(conv, "", ""), userText("The task owner adds:\n"+instructions))
		e.dirty[s.ID] = true
	}
	s.Instruction = strings.TrimSpace(s.Instruction + "\n\n" + instructions)
	s.UpstreamIDs = upstream
	s.PlanVersion = t.Coordination.PlanVersion
	s.ExecutionState = model.ExecQueued
	s.Status = enum.StatusTodo
	name := e.nodeName(t, s.NodeID)
	e.systemEvent(t, "continued", i18n.T("「%s」接著做", name), map[string]any{"step": name}, s.ID)
	return "queued " + s.ID + " to go on", nil
}

func (e *Engine) reviewTool(in *ownerRun) func(context.Context, string, json.RawMessage) model.ToolResult {
	return func(_ context.Context, _ string, raw json.RawMessage) model.ToolResult {
		var a struct {
			SubID    string `json:"sub_id"`
			Decision string `json:"decision"`
			Reason   string `json:"reason"`
		}
		if err := parseArgs(raw, &a); err != nil {
			return toolError("%s", safeText(err))
		}
		return e.ownerChange(in, func(t *model.Task) (string, error) {
			s := e.w.SubTasks[a.SubID]
			if s == nil || s.TaskID != t.ID {
				return "", model.Errorf(model.CodeNotFound, "找不到子任務")
			}
			if !current(s) || s.Status != enum.StatusComplete {
				return "", model.Errorf(model.CodeConflict, "只能審核已交付的有效執行")
			}
			name := e.nodeName(t, s.NodeID)
			switch a.Decision {
			case "accept":
				s.OwnerReview = model.ReviewAccepted
				s.Validity = model.ValidCurrent
				e.systemEvent(t, "accepted", i18n.T("負責人接受「%s」的交付", name), map[string]any{"step": name, "owner": e.replicaName(in.ownerID)}, s.ID)
			case "reject":
				s.OwnerReview = model.ReviewRejected
				e.systemEvent(t, "rejected", i18n.T("負責人不接受「%s」的交付：%s", name, a.Reason), map[string]any{"step": name, "reason": a.Reason, "owner": e.replicaName(in.ownerID)}, s.ID)
			default:
				return "", model.Errorf(model.CodeInvalid, "decision 要是 accept 或 reject")
			}
			return a.Decision + "ed " + s.ID, nil
		})
	}
}

func (e *Engine) stopTool(in *ownerRun) func(context.Context, string, json.RawMessage) model.ToolResult {
	return func(_ context.Context, _ string, raw json.RawMessage) model.ToolResult {
		var a struct {
			SubID  string `json:"sub_id"`
			Reason string `json:"reason"`
		}
		if err := parseArgs(raw, &a); err != nil {
			return toolError("%s", safeText(err))
		}
		return e.ownerChange(in, func(t *model.Task) (string, error) {
			s := e.w.SubTasks[a.SubID]
			if s == nil || s.TaskID != t.ID {
				return "", model.Errorf(model.CodeNotFound, "找不到子任務")
			}
			if s.Status == enum.StatusComplete || s.ExecutionState == model.ExecStopped || s.ExecutionState == model.ExecUncertain {
				return "", model.Errorf(model.CodeConflict, "這一步沒有在執行")
			}
			op := e.newOperation(t, model.TaskOperation{Kind: "stop", Status: model.OpProcessing, SubID: s.ID})
			if e.halt(t, s) {
				op.AffectedSubIDs = []string{s.ID}
			}
			e.editLog(t.ID).Operations[op.ID] = op
			name := e.nodeName(t, s.NodeID)
			e.systemEvent(t, "stopping", i18n.T("負責人停止「%s」：%s", name, a.Reason), map[string]any{"step": name, "reason": a.Reason, "owner": e.replicaName(in.ownerID)}, s.ID)
			e.stopsSettled(t)
			return "stopping " + s.ID + "; you are told once it has stopped", nil
		})
	}
}

func (e *Engine) returnTool(in *ownerRun) func(context.Context, string, json.RawMessage) model.ToolResult {
	return func(_ context.Context, _ string, raw json.RawMessage) model.ToolResult {
		var a struct {
			SubID  string `json:"sub_id"`
			Reason string `json:"reason"`
		}
		if err := parseArgs(raw, &a); err != nil {
			return toolError("%s", safeText(err))
		}
		if strings.TrimSpace(a.Reason) == "" {
			return toolError("reason is required")
		}
		return e.ownerChange(in, func(t *model.Task) (string, error) {
			if err := e.mayDispatch(t); err != nil {
				return "", err
			}
			s := e.w.SubTasks[a.SubID]
			if s == nil || s.TaskID != t.ID || s.ReplicaID == nil {
				return "", model.Errorf(model.CodeNotFound, "找不到子任務")
			}
			if !current(s) {
				return "", model.Errorf(model.CodeConflict, "這次執行已被取代")
			}
			l := e.editLog(t.ID)
			if l.Returns >= MaxSendBacks {
				e.block(t, "loop", model.TaskQuestion{Kind: "approval", Prompt: i18n.T("退回次數已達上限，要讓負責人繼續嗎？"),
					Options: []model.ReviewOption{{ID: optionContinue, Label: i18n.T("讓負責人繼續")}}})
				return "The limit of sending work back is reached; the user was asked whether to go on. Stop here.", nil
			}
			l.Returns++
			redo := e.rework(t, s, strings.TrimSpace(a.Reason), "owner")
			return "sent back; the redo is " + redo.ID, nil
		})
	}
}

func (e *Engine) answerTool(in *ownerRun) func(context.Context, string, json.RawMessage) model.ToolResult {
	return func(_ context.Context, _ string, raw json.RawMessage) model.ToolResult {
		var a struct {
			QuestionID string `json:"question_id"`
			Answer     string `json:"answer"`
		}
		if err := parseArgs(raw, &a); err != nil {
			return toolError("%s", safeText(err))
		}
		if strings.TrimSpace(a.Answer) == "" {
			return toolError("answer is required")
		}
		return e.ownerChange(in, func(t *model.Task) (string, error) {
			q := questionOf(t, a.QuestionID)
			if q == nil {
				return "", model.Errorf(model.CodeNotFound, "找不到這個問題")
			}
			if q.Audience != "owner" {
				return "", model.Errorf("forbidden", "這個問題只有使用者能回答")
			}
			l := e.editLog(t.ID)
			if l.Exchanges >= maxOwnerExchanges {
				e.block(t, "loop", model.TaskQuestion{Kind: "approval", Prompt: i18n.T("負責人與員工來回問答次數已達上限，要讓負責人繼續嗎？"),
					Options: []model.ReviewOption{{ID: optionContinue, Label: i18n.T("讓負責人繼續")}}})
				return "The limit of questions between you and employees is reached; the user was asked whether to go on. Stop here.", nil
			}
			l.Exchanges++
			question := *q
			dropQuestion(t, question.ID)
			s := e.w.SubTasks[question.SubID]
			if s != nil && current(s) && s.Status == enum.StatusReview {
				if err := e.loadConversation(s.ID); err != nil {
					return "", err
				}
				e.w.Conversations[s.ID] = closeCalls(e.w.Conversations[s.ID], "", func(b model.Block) (string, bool, bool) {
					if b.Name == toolAskOwner {
						return "The task owner answered: " + a.Answer, false, true
					}
					return "", false, false
				})
				e.dirty[s.ID] = true
				s.Status = enum.StatusTodo
				s.ExecutionState = model.ExecQueued
			}
			e.addActivity(t, model.TaskActivity{Kind: "message", From: "agent", Text: a.Answer, By: in.ownerID, Name: e.replicaName(in.ownerID), SubID: question.SubID, QuestionID: question.ID})
			return "answered", nil
		})
	}
}

func (e *Engine) meetingTool(in *ownerRun) func(context.Context, string, json.RawMessage) model.ToolResult {
	return func(_ context.Context, _ string, raw json.RawMessage) model.ToolResult {
		var a struct {
			Topic      string   `json:"topic"`
			ReplicaIDs []string `json:"replica_ids"`
		}
		if err := parseArgs(raw, &a); err != nil {
			return toolError("%s", safeText(err))
		}
		a.Topic = strings.TrimSpace(a.Topic)
		if a.Topic == "" {
			return toolError("topic is required")
		}
		return e.ownerChange(in, func(t *model.Task) (string, error) {
			if t.Stage != enum.StageRunning || e.taskCost(t) >= e.costLimit(t) {
				return "", model.Errorf(model.CodeConflict, "這個任務現在不能開會")
			}
			people := []string{}
			for _, id := range a.ReplicaIDs {
				if !e.authorized(t, id) {
					return "", model.Errorf("forbidden", "這位員工沒有被授權參與這個任務，要先問使用者")
				}
				if !slices.Contains(people, id) {
					people = append(people, id)
				}
			}
			if len(people) < 2 || len(people) > maxChatPeople {
				return "", model.Errorf(model.CodeInvalid, "會議要有 2 到 %d 位員工", maxChatPeople)
			}
			e.w.Seq++
			node := model.WorkflowNode{ID: "meeting-" + strconv.Itoa(e.w.Seq), Kind: enum.NodeTalk, Name: clip(a.Topic, 40), Prompt: a.Topic,
				ReplicaIDs: people, Handoff: enum.HandoffAll, Join: enum.JoinAll}
			t.Workflow.Nodes = append(t.Workflow.Nodes, node)
			e.newPlan(t, "meeting: "+a.Topic, "owner")
			s := e.newRun(t, node.ID, people[0], a.Topic, []string{})
			e.systemEvent(t, "meetingCalled", i18n.T("負責人召開會議：%s", node.Name), map[string]any{"topic": a.Topic, "owner": e.replicaName(in.ownerID)}, s.ID)
			return "meeting " + s.ID + " called; you are woken when it ends", nil
		})
	}
}

// newPlan records the plan as it now is: a new version, kept with why it changed.
func (e *Engine) newPlan(t *model.Task, reason, by string) {
	c := t.Coordination
	c.PlanVersion++
	l := e.editLog(t.ID)
	l.Plans = append(l.Plans, planSnapshot{Version: c.PlanVersion, At: e.w.Now, Reason: reason, By: by, Workflow: clone(t.Workflow)})
}

// planChange is what a new plan does to the old one, by step names: steps added and removed, steps whose content
// changed, steps given to someone else ("name：old → new"), and links made and taken away.
type planChange struct {
	Added, Removed, Edited, Restaffed, Linked, Unlinked []string
	// Touched is every step kept that was edited or restaffed, as the owner's record has it.
	Touched []string
}

// planDiff compares a task's plan with the next one; a step already run cannot be removed. Call it holding the lock.
func (e *Engine) planDiff(t *model.Task, from, to *model.Workflow) (planChange, error) {
	var d planChange
	ran := map[string]bool{}
	for _, s := range e.subsOf(t.ID) {
		ran[s.NodeID] = true
	}
	staff := func(ids []string) string {
		names := []string{}
		for _, id := range ids {
			names = append(names, e.replicaName(id))
		}
		if len(names) == 0 {
			return "-"
		}
		return strings.Join(names, "、")
	}
	for _, n := range from.Nodes {
		if nodeOf(to, n.ID) == nil {
			if ran[n.ID] {
				return planChange{}, model.Errorf(model.CodeConflict, "已執行過的步驟「%s」不能移除", n.Name)
			}
			d.Removed = append(d.Removed, n.Name)
		}
	}
	for _, n := range to.Nodes {
		old := nodeOf(from, n.ID)
		if old == nil {
			d.Added = append(d.Added, n.Name)
			continue
		}
		restaffed := !slices.Equal(old.ReplicaIDs, n.ReplicaIDs)
		if restaffed {
			d.Restaffed = append(d.Restaffed, n.Name+"："+staff(old.ReplicaIDs)+" → "+staff(n.ReplicaIDs))
		}
		edited := old.Name != n.Name || old.Prompt != n.Prompt || old.Kind != n.Kind || old.Handoff != n.Handoff || old.Join != n.Join
		if edited {
			d.Edited = append(d.Edited, n.Name)
		}
		if restaffed || old.Name != n.Name || old.Prompt != n.Prompt || old.Kind != n.Kind {
			d.Touched = append(d.Touched, n.Name)
		}
	}
	edgeName := func(w *model.Workflow, edge model.WorkflowEdge) string {
		name := func(id string) string {
			if n := nodeOf(w, id); n != nil {
				return n.Name
			}
			return id
		}
		return name(edge.From) + " → " + name(edge.To)
	}
	has := func(w *model.Workflow, edge model.WorkflowEdge) bool {
		return slices.ContainsFunc(w.Edges, func(x model.WorkflowEdge) bool { return x.From == edge.From && x.To == edge.To })
	}
	for _, edge := range to.Edges {
		if !has(from, edge) {
			d.Linked = append(d.Linked, edgeName(to, edge))
		}
	}
	for _, edge := range from.Edges {
		if !has(to, edge) {
			d.Unlinked = append(d.Unlinked, edgeName(from, edge))
		}
	}
	return d, nil
}

func (e *Engine) planTool(in *ownerRun) func(context.Context, string, json.RawMessage) model.ToolResult {
	return func(_ context.Context, _ string, raw json.RawMessage) model.ToolResult {
		var a struct {
			Nodes []struct {
				ID         string   `json:"id"`
				Kind       string   `json:"kind"`
				Name       string   `json:"name"`
				Prompt     string   `json:"prompt"`
				ReplicaIDs []string `json:"replica_ids"`
			} `json:"nodes"`
			Edges []struct {
				From      string `json:"from"`
				To        string `json:"to"`
				Condition string `json:"condition"`
			} `json:"edges"`
			Reason string `json:"reason"`
		}
		if err := parseArgs(raw, &a); err != nil {
			return toolError("%s", safeText(err))
		}
		if strings.TrimSpace(a.Reason) == "" {
			return toolError("reason is required")
		}
		return e.ownerChange(in, func(t *model.Task) (string, error) {
			if !t.Coordination.Authorization.PlanChanges {
				return "", model.Errorf("forbidden", "使用者沒有允許負責人調整計畫")
			}
			wf := model.Workflow{ID: t.Workflow.ID, Name: t.Workflow.Name}
			if strings.TrimSpace(wf.Name) == "" {
				wf.Name = t.Title
			}
			for _, n := range a.Nodes {
				kind := enum.NodeKind(n.Kind)
				if kind == "" {
					kind = enum.NodeWork
				}
				node := model.WorkflowNode{ID: n.ID, Kind: kind, Name: n.Name, Prompt: n.Prompt, ReplicaIDs: slices.Clone(n.ReplicaIDs), Handoff: enum.HandoffAll, Join: enum.JoinAll}
				if old := nodeOf(&t.Workflow, n.ID); old != nil {
					node.Pos, node.Handoff, node.Join = old.Pos, old.Handoff, old.Join
				}
				for _, id := range node.ReplicaIDs {
					if !e.authorized(t, id) {
						return "", model.Errorf("forbidden", "這位員工沒有被授權參與這個任務，要先問使用者")
					}
				}
				wf.Nodes = append(wf.Nodes, node)
			}
			for i, edge := range a.Edges {
				wf.Edges = append(wf.Edges, model.WorkflowEdge{ID: "e" + strconv.Itoa(i+1), From: edge.From, To: edge.To, Condition: edge.Condition})
			}
			if err := e.checkFlow(&wf); err != nil {
				return "", err
			}
			d, err := e.planDiff(t, &t.Workflow, &wf)
			if err != nil {
				return "", err
			}
			added, removed, restaffed, linked, unlinked := d.Added, d.Removed, d.Restaffed, d.Linked, d.Unlinked
			changed := d.Touched
			t.Workflow.Nodes, t.Workflow.Edges = wf.Nodes, wf.Edges
			e.newPlan(t, a.Reason, "owner")
			version := t.Coordination.PlanVersion
			args := map[string]any{"reason": a.Reason, "version": version, "owner": e.replicaName(in.ownerID), "added": strings.Join(added, "、"), "skipped": strings.Join(removed, "、"),
				"changed": strings.Join(changed, "、"), "restaffed": strings.Join(restaffed, "；"), "linked": strings.Join(linked, "、"), "unlinked": strings.Join(unlinked, "、")}
			text := i18n.T("負責人調整計畫（第 %d 版）：%s", version, a.Reason)
			for _, part := range []struct{ label, value string }{{i18n.T("新增"), args["added"].(string)}, {i18n.T("略過"), args["skipped"].(string)},
				{i18n.T("改派"), args["restaffed"].(string)}, {i18n.T("新增依賴"), args["linked"].(string)}, {i18n.T("移除依賴"), args["unlinked"].(string)}} {
				if part.value != "" {
					text += "\n" + part.label + "：" + part.value
				}
			}
			e.systemEvent(t, "planChanged", text, args, "")
			return fmt.Sprintf("plan version %d", t.Coordination.PlanVersion), nil
		})
	}
}

func (e *Engine) ownerAskTool(in *ownerRun) func(context.Context, string, json.RawMessage) model.ToolResult {
	return func(_ context.Context, _ string, raw json.RawMessage) model.ToolResult {
		var a struct {
			Prompt     string   `json:"prompt"`
			Options    []string `json:"options"`
			ReplicaIDs []string `json:"replica_ids"`
			Budget     bool     `json:"budget"`
		}
		if err := parseArgs(raw, &a); err != nil {
			return toolError("%s", safeText(err))
		}
		if strings.TrimSpace(a.Prompt) == "" {
			return toolError("prompt is required")
		}
		var options []model.ReviewOption
		kind := "question"
		switch {
		case len(a.ReplicaIDs) > 0:
			kind = "approval"
			options = []model.ReviewOption{{ID: optionApprove}, {ID: optionReject}}
		case a.Budget:
			kind = "budget"
			options = []model.ReviewOption{{ID: optionAddBudget}, {ID: optionPause}}
		default:
			labels, refused := askOptions(a.Options, "")
			if refused != nil {
				return *refused
			}
			for i, label := range labels {
				options = append(options, model.ReviewOption{ID: fmt.Sprintf("opt%d", i), Label: label})
			}
		}
		return e.ownerChange(in, func(t *model.Task) (string, error) {
			for _, id := range a.ReplicaIDs {
				if r := e.w.Replicas[id]; r == nil || r.TeamID != t.TeamID {
					return "", model.Errorf(model.CodeInvalid, "指派了不是這間公司的員工")
				}
			}
			act := e.addActivity(t, model.TaskActivity{Kind: "question", From: "agent", Text: a.Prompt, By: in.ownerID, Name: e.replicaName(in.ownerID)})
			q := e.askUserQuestion(t, model.TaskQuestion{ActivityID: act.ID, Prompt: a.Prompt, Options: options, Kind: kind, ReplicaIDs: slices.Clone(a.ReplicaIDs)})
			e.editLogActivityQuestion(t, act.ID, q.ID)
			return "asked as " + q.ID + "; you are woken with the answer", nil
		})
	}
}

func (e *Engine) factTool(in *ownerRun) func(context.Context, string, json.RawMessage) model.ToolResult {
	return func(_ context.Context, _ string, raw json.RawMessage) model.ToolResult {
		var a struct {
			Kind       string   `json:"kind"`
			Text       string   `json:"text"`
			Sources    []string `json:"source_activity_ids"`
			Supersedes string   `json:"supersedes"`
		}
		if err := parseArgs(raw, &a); err != nil {
			return toolError("%s", safeText(err))
		}
		if (a.Kind != "constraint" && a.Kind != "decision") || strings.TrimSpace(a.Text) == "" {
			return toolError("kind (constraint or decision) and text are required")
		}
		return e.ownerChange(in, func(t *model.Task) (string, error) {
			return e.recordFact(t, a.Kind, strings.TrimSpace(a.Text), a.Sources, a.Supersedes)
		})
	}
}

// recordFact keeps a constraint or decision. A constraint the user set changes only with newer words of the user's.
func (e *Engine) recordFact(t *model.Task, kind, text string, sources []string, supersedes string) (string, error) {
	all, err := e.activities(t.ID)
	if err != nil {
		return "", err
	}
	seqOf := map[string]int{}
	fromUser := map[string]bool{}
	for _, a := range all {
		seqOf[a.ID] = a.Seq
		fromUser[a.ID] = a.From == "user"
	}
	for _, id := range sources {
		if seqOf[id] == 0 {
			return "", model.Errorf(model.CodeInvalid, "沒有這則紀錄 %s", id)
		}
	}
	c := t.Coordination
	if supersedes != "" {
		i := slices.IndexFunc(c.Facts, func(f model.TaskFact) bool { return f.ID == supersedes })
		if i < 0 {
			return "", model.Errorf(model.CodeInvalid, "沒有這筆紀錄 %s", supersedes)
		}
		old := c.Facts[i]
		if old.Kind == "constraint" {
			newest := 0
			for _, id := range old.SourceActivityIDs {
				newest = max(newest, seqOf[id])
			}
			allowed := slices.ContainsFunc(sources, func(id string) bool { return fromUser[id] && seqOf[id] > newest })
			if !allowed {
				return "", model.Errorf("forbidden", "使用者訂下的限制只能依使用者更新的說法修改")
			}
		}
	}
	e.w.Seq++
	f := model.TaskFact{ID: "fact-" + strconv.Itoa(e.w.Seq), Kind: kind, Text: text, SourceActivityIDs: orEmpty(sources), Supersedes: supersedes, At: e.w.Now}
	c.Facts = append(c.Facts, f)
	key := "decisionRecorded"
	if kind == "constraint" {
		key = "constraintRecorded"
	}
	e.systemEvent(t, key, text, map[string]any{"text": text}, "")
	return "recorded " + f.ID, nil
}

func (e *Engine) completeTool(in *ownerRun) func(context.Context, string, json.RawMessage) model.ToolResult {
	return func(_ context.Context, _ string, raw json.RawMessage) model.ToolResult {
		var a struct {
			Summary string `json:"summary"`
			Merge   bool   `json:"ask_merge"`
		}
		if err := parseArgs(raw, &a); err != nil {
			return toolError("%s", safeText(err))
		}
		if strings.TrimSpace(a.Summary) == "" {
			return toolError("summary is required")
		}
		return e.ownerChange(in, func(t *model.Task) (string, error) {
			if t.Stage != enum.StageRunning || t.Paused {
				return "", model.Errorf(model.CodeConflict, "這個任務現在不能完成")
			}
			if why := e.unfinished(t, in.wake); why != "" {
				return "", model.Errorf(model.CodeConflict, "%s", why)
			}
			t.Stage = enum.StageAwaitMerge
			said := e.addActivity(t, model.TaskActivity{Kind: "message", From: "agent", Text: strings.TrimSpace(a.Summary), By: in.ownerID, Name: e.replicaName(in.ownerID)})
			e.systemEvent(t, "completed", i18n.T("負責人提交完成，等待使用者決定是否合併"), map[string]any{"owner": e.replicaName(in.ownerID)}, "")
			in.completed = true
			if a.Merge {
				e.askUserQuestion(t, model.TaskQuestion{ActivityID: said.ID, Prompt: i18n.T("要合併這個任務嗎？"), Kind: "merge",
					Options: []model.ReviewOption{{ID: optionMerge, Label: i18n.T("合併")}, {ID: optionNotYet, Label: i18n.T("先不要")}}})
				return "the task waits for the user to merge; they have a card to merge with one press. End your turn without repeating your summary", nil
			}
			e.notice(Event{Type: "notice", Kind: "awaitMerge", TaskID: t.ID})
			return "the task waits for the user to merge. End your turn without repeating your summary", nil
		})
	}
}

// ownerCreateTaskTool lets the owner create another task in the company, as an employee's create_task does. It waits
// in to-do for the user, and a line in this task's conversation says so.
func (e *Engine) ownerCreateTaskTool(in *ownerRun) func(context.Context, string, json.RawMessage) model.ToolResult {
	return func(_ context.Context, _ string, raw json.RawMessage) model.ToolResult {
		var a taskArgs
		if err := parseArgs(raw, &a); err != nil {
			return toolError("%s", safeText(err))
		}
		if (a.WorkflowID == "") == (a.Workflow == nil) {
			return toolError("give either workflow_id, a saved flow, or workflow, a flow for this task alone")
		}
		if a.OwnerID == nil {
			a.OwnerID = ptr(in.ownerID)
		}
		return e.ownerChange(in, func(t *model.Task) (string, error) {
			name := e.replicaName(in.ownerID)
			origin := model.TaskOrigin{Kind: "employee", ID: in.ownerID, Name: name, Depth: 1}
			if t.Origin != nil {
				origin.Depth += t.Origin.Depth
			}
			made, refused, err := e.makeTask(t.TeamID, a, origin)
			if err != nil {
				return "", err
			}
			if refused != "" {
				return "", model.Errorf(model.CodeInvalid, "%s", refused)
			}
			e.systemEvent(t, "taskCreated", i18n.T("%s 開了任務 #%d「%s」", name, made.Number, made.Title),
				map[string]any{"owner": name, "number": made.Number, "title": made.Title, "taskId": made.ID}, "")
			return madeTask(made), nil
		})
	}
}

// unfinished says what keeps an owner-led task from being done, or "". wake is the decision under way, whose events
// do not count.
func (e *Engine) unfinished(t *model.Task, wake string) string {
	any := false
	for _, s := range e.subsOf(t.ID) {
		if !current(s) {
			continue
		}
		any = true
		switch {
		case s.ExecutionState == model.ExecStopping || s.ExecutionState == model.ExecUncertain || e.runs[s.ID] != nil:
			return i18n.T("還有步驟在執行或無法確認")
		case s.Validity == model.ValidNeedsRevalidation:
			return i18n.T("還有成果需要重新確認")
		case s.Status != enum.StatusComplete:
			return i18n.T("還有步驟沒完成")
		case s.OwnerReview == model.ReviewPending:
			return i18n.T("還有交付沒有審核")
		case s.OwnerReview == model.ReviewRejected:
			return i18n.T("「%s」的交付沒有被接受，要退回重做或重新派工", e.nodeName(t, s.NodeID))
		}
	}
	if !any {
		return i18n.T("還沒有任何步驟完成")
	}
	// every step of the plan is done and accepted; one left out is taken out of the plan where the user sees it
	for _, n := range t.Workflow.Nodes {
		if !slices.ContainsFunc(e.subsOf(t.ID), func(s *model.SubTask) bool { return s.NodeID == n.ID && accepted(s) }) {
			return i18n.T("計畫裡的「%s」還沒有被接受的成果；不做的話要先調整計畫", n.Name)
		}
	}
	if slices.ContainsFunc(t.Coordination.Questions, func(q model.TaskQuestion) bool { return q.Kind != "merge" }) {
		return i18n.T("還有問題沒有回答")
	}
	for _, ev := range e.logOf(t.ID).Events {
		if ev.State == eventPending || ev.State == eventProcessing && ev.Wake != wake {
			return i18n.T("還有新訊息沒有處理")
		}
	}
	return ""
}

// ---------- what steps of an owner-led task do differently ----------

const toolAskOwner = "ask_owner"

// askOwnerTool lets an employee ask the task's owner about the work; their step waits for the answer.
func (e *Engine) askOwnerTool(in subRun) adapter.Tool {
	return funcTool{model.ToolSpec{Name: toolAskOwner, Description: "Ask the task's owner about the work, such as what is meant or which way to go; your step waits for the answer. " +
		"What only the user can decide goes to ask_user instead.",
		Parameters: json.RawMessage(`{"type":"object","properties":{"question":{"type":"string"}},"required":["question"]}`)},
		func(_ context.Context, _ string, raw json.RawMessage) model.ToolResult {
			var a struct {
				Question string `json:"question"`
			}
			if err := json.Unmarshal(raw, &a); err != nil || strings.TrimSpace(a.Question) == "" {
				return toolError("question is required")
			}
			e.apply(in, func(t *model.Task, s *model.SubTask) {
				if !t.OwnerLed() {
					return
				}
				who := ""
				if s.ReplicaID != nil {
					who = *s.ReplicaID
				}
				act := e.addActivity(t, model.TaskActivity{Kind: "question", From: "agent", Text: a.Question, By: who, Name: e.replicaName(who), SubID: s.ID, NodeID: s.NodeID})
				e.w.Seq++
				q := model.TaskQuestion{ID: t.ID + "-q" + strconv.Itoa(e.w.Seq), ActivityID: act.ID, Prompt: a.Question, Options: []model.ReviewOption{}, Kind: "question",
					Audience: "owner", SubID: s.ID, PlanVersion: t.Coordination.PlanVersion, CreatedAt: e.w.Now}
				t.Coordination.Questions = append(t.Coordination.Questions, q)
				e.editLogActivityQuestion(t, act.ID, q.ID)
				s.Status = enum.StatusReview
				e.logLine(s, enum.LogSystem, i18n.T("等待負責人回覆"), "askOwner", nil)
				e.addEvent(t, ownerEvent{Kind: evQuestion, SubID: s.ID, QuestionID: q.ID, ActivityID: act.ID,
					Text: "Step run " + s.ID + " (" + s.NodeID + ") asks you (" + q.ID + "): " + a.Question})
			})
			return model.ToolResult{Stop: true}
		}}
}

// handedToOwner is a step of an owner-led task handing off: it waits for the owner's review, and goes nowhere by itself.
func (e *Engine) handedToOwner(t *model.Task, s *model.SubTask) {
	s.OwnerReview = model.ReviewPending
	s.Routed = true
	if l := e.logOf(t.ID); l != nil && l.Failures > 0 {
		e.editLog(t.ID).Failures = 0
	}
	who := ""
	if s.ReplicaID != nil {
		who = *s.ReplicaID
	}
	text := ""
	if s.Handoff != nil {
		text = s.Handoff.Human.Headline
	}
	e.addActivity(t, model.TaskActivity{Kind: "handoff", From: "agent", Text: text, By: who, Name: e.replicaName(who), SubID: s.ID, NodeID: s.NodeID})
	what := "handed off"
	if s.SendBackReason != "" {
		what = "asks to send the work before it back: " + s.SendBackReason + "; it is your call (return_step)"
		s.SendBackReason = ""
	}
	e.addEvent(t, ownerEvent{Kind: evHandoff, Key: "handoff:" + s.ID + ":" + strconv.Itoa(s.RunGeneration), SubID: s.ID,
		Text: "Step run " + s.ID + " (" + s.NodeID + ") by " + e.replicaName(who) + " " + what + ": " + text + ". Review it with review_step."})
}

// failedForOwner is a step of an owner-led task that failed after its retries: it stops, and the owner decides.
func (e *Engine) failedForOwner(t *model.Task, s *model.SubTask, detail string) {
	s.Status = enum.StatusTodo
	s.ExecutionState = model.ExecStopped
	e.logLine(s, enum.LogSystem, detail, "", nil)
	name := e.nodeName(t, s.NodeID)
	e.systemEvent(t, "stepFailed", i18n.T("「%s」重試後仍失敗：%s", name, detail), map[string]any{"step": name, "error": detail}, s.ID)
	e.addEvent(t, ownerEvent{Kind: evFailure, Key: "failed:" + s.ID + ":" + strconv.Itoa(s.Attempts), SubID: s.ID,
		Text: "Step run " + s.ID + " (" + s.NodeID + ") failed after its retries: " + detail + ". Go on with it (dispatch_step with sub_id), dispatch the step again, or tell the user."})
	// runs failing one after another stop the owner dispatching them again until the user says to go on
	l := e.editLog(t.ID)
	l.Failures++
	if l.Failures >= maxOwnerFailures && t.Coordination.OwnerState != model.OwnerBlocked {
		e.block(t, "loop", model.TaskQuestion{Kind: "approval", Prompt: i18n.T("步驟連續失敗 %d 次，已停下來等你決定", l.Failures),
			Options: []model.ReviewOption{{ID: optionContinue, Label: i18n.T("讓負責人繼續")}}})
	}
}

// meetingSays is an employee's words in a meeting the owner called; when everyone has spoken it ends.
func (e *Engine) meetingSays(t *model.Task, s *model.SubTask, by, text string) {
	delete(e.live, s.ID)
	if s.Talk == nil {
		s.Talk = &model.Talk{Messages: []model.ChatMessage{}, Speaker: by}
		people := e.talkPeople(t, s)
		if len(people) > 1 {
			s.Talk.Next = slices.Clone(people[1:])
		}
	}
	s.Talk.ReplyAt = nil
	s.Talk.Messages = append(s.Talk.Messages, model.ChatMessage{At: e.w.Now, From: "agent", Text: text, By: by})
	s.Progress = float64(len(s.Talk.Messages)) / float64(max(1, len(e.talkPeople(t, s))))
	e.logLine(s, enum.LogSay, text, "", nil)
	e.addActivity(t, model.TaskActivity{Kind: "meeting", From: "agent", Text: text, By: by, Name: e.replicaName(by), SubID: s.ID, NodeID: s.NodeID, MeetingID: s.ID})
	if e.nextInTalk(t, s) {
		return
	}
	s.Talk.Ended = "done"
	s.Status = enum.StatusComplete
	s.Progress = 1
	s.EndedAt = ptr(e.w.Now)
	done := []string{}
	for _, m := range s.Talk.Messages {
		done = append(done, e.replicaName(m.By)+": "+m.Text)
	}
	name := e.nodeName(t, s.NodeID)
	s.Handoff = &model.Handoff{
		Agent: model.AgentHandoff{Goal: s.Instruction, Done: done, Outputs: []string{}, Decisions: []string{}, Open: []string{}},
		Human: model.HumanSummary{Headline: i18n.T("會議結束：%s", name), Did: []string{}, Outputs: []string{}},
	}
	s.OwnerReview = model.ReviewPending
	s.Routed = true
	e.systemEvent(t, "meetingEnded", i18n.T("會議結束：%s", name), map[string]any{"topic": name}, s.ID)
	var b strings.Builder
	for _, line := range done {
		b.WriteString("\n- " + clip(line, 2000))
	}
	e.addEvent(t, ownerEvent{Kind: evMeetingEnded, Key: "meeting:" + s.ID, SubID: s.ID, Text: "The meeting " + s.ID + " on \"" + s.Instruction + "\" ended:" + b.String()})
}
