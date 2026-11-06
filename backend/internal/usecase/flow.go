package usecase

import (
	"fmt"
	"slices"
	"strings"

	"github.com/yanun0323/Team-Work/internal/i18n"
	"github.com/yanun0323/Team-Work/internal/model"
	"github.com/yanun0323/Team-Work/internal/model/enum"
)

// MaxSendBacks is how many times a task's work is sent back; after that every step hands on.
const MaxSendBacks = 2

func (e *Engine) subsOf(taskID string) []*model.SubTask {
	var out []*model.SubTask
	for _, s := range e.w.SubTasks {
		if s.TaskID == taskID {
			out = append(out, s)
		}
	}
	return sortedSubs(out)
}

// isLive: still has work to do or a handoff to make.
func isLive(s *model.SubTask) bool {
	return !s.Cancelled && !(s.Status == enum.StatusComplete && s.Routed)
}

func talking(s *model.SubTask) bool {
	return s.Review != nil && s.Review.Kind == enum.ReviewTalk && s.Talk != nil && s.Talk.Ended == ""
}

func (e *Engine) taskCost(t *model.Task) float64 {
	sum := t.CostCarry
	for _, s := range e.subsOf(t.ID) {
		sum += s.CostUSD
	}
	return sum
}

func (e *Engine) taskTokens(t *model.Task) int {
	sum := t.TokensCarry
	for _, s := range e.subsOf(t.ID) {
		sum += s.Tokens
	}
	return sum
}

func (e *Engine) costLimit(t *model.Task) float64 {
	return e.w.Teams[t.TeamID].Settings.CostLimitUSD + t.BudgetBonus
}

func (e *Engine) logLine(s *model.SubTask, kind enum.LogKind, text, key string, args map[string]any) {
	s.Log = append(s.Log, model.LogLine{At: e.w.Now, Kind: kind, Text: text, Key: key, Args: args})
}

func (e *Engine) remember(replicaID *string, text, source, taskID string) bool {
	if replicaID == nil || e.w.Replicas[*replicaID] == nil {
		return false
	}
	r := e.w.Replicas[*replicaID]
	for _, m := range r.Memory {
		if m.Text == text {
			return false
		}
	}
	r.Memory = append([]model.MemoryEntry{{ID: e.uid("mem"), Text: text, Source: source, At: e.w.Now, TaskID: taskID}}, r.Memory...)
	return true
}

// forget drops one note and says what it read, so the log keeps a way back.
func (e *Engine) forget(replicaID *string, id string) (string, bool) {
	if replicaID == nil || e.w.Replicas[*replicaID] == nil {
		return "", false
	}
	r := e.w.Replicas[*replicaID]
	i := slices.IndexFunc(r.Memory, func(m model.MemoryEntry) bool { return m.ID == id })
	if i < 0 {
		return "", false
	}
	text := r.Memory[i].Text
	r.Memory = slices.Delete(slices.Clone(r.Memory), i, i+1)
	return text, true
}

// memorySearchLimit is how many notes one search returns at most.
const memorySearchLimit = 20

// searchMemory finds the notes holding any of the query's words, ignoring case: those holding more words first, then
// the newest.
func searchMemory(notes []model.MemoryEntry, query string) string {
	words := strings.Fields(strings.ToLower(query))
	type hit struct {
		note  model.MemoryEntry
		score int
	}
	var hits []hit
	for _, m := range notes {
		text, score := strings.ToLower(m.Text), 0
		for _, w := range words {
			if strings.Contains(text, w) {
				score++
			}
		}
		if score > 0 {
			hits = append(hits, hit{m, score})
		}
	}
	if len(hits) == 0 {
		return "No notes match."
	}
	slices.SortStableFunc(hits, func(a, b hit) int { return b.score - a.score })
	var b strings.Builder
	for _, h := range hits[:min(len(hits), memorySearchLimit)] {
		b.WriteString(memoryLine(h.note))
	}
	if len(hits) > memorySearchLimit {
		fmt.Fprintf(&b, "%d more match; narrow the search.\n", len(hits)-memorySearchLimit)
	}
	return b.String()
}

func (e *Engine) spawn(t *model.Task, nodeID string, upstream []string, parent *string, waiting bool, round int) *model.SubTask {
	s := &model.SubTask{
		ID: e.uid("sub"), TaskID: t.ID, NodeID: nodeID, ParentID: parent, UpstreamIDs: upstream, Status: enum.StatusTodo,
		CreatedAt: e.w.Now, RoutedTo: []string{}, ArrivedAt: e.w.Now, Waiting: waiting, Round: round, Log: []model.LogLine{},
	}
	e.w.SubTasks[s.ID] = s
	if waiting {
		e.logLine(s, enum.LogSystem, i18n.T("等待其他上游完成"), "joinWaiting", nil)
	} else {
		e.release(t, s)
	}
	return s
}

// release queues a sub-task.
func (e *Engine) release(_ *model.Task, s *model.SubTask) {
	s.Waiting = false
	e.logLine(s, enum.LogSystem, i18n.T("已排入佇列"), "queued", nil)
}

// step moves everything along as far as it goes, without waiting on anyone.
func (e *Engine) step() {
	for e.routeAll() || e.checkJoins() {
	}
	for _, t := range e.w.Tasks {
		if t.Stage == enum.StageMerging {
			e.stepMerge(t)
		}
	}
	e.dispatch()
	for _, t := range e.w.Tasks {
		if t.Stage != enum.StageRunning || t.Paused {
			continue
		}
		var live, any bool
		for _, s := range e.w.SubTasks {
			if s.TaskID == t.ID && !s.Cancelled {
				any = true
				live = live || isLive(s)
			}
		}
		if any && !live {
			t.Stage = enum.StageAwaitMerge
			e.notice(Event{Type: "notice", Kind: "awaitMerge", TaskID: t.ID})
		}
	}
}

func (e *Engine) routeAll() bool {
	moved := false
	all := make([]*model.SubTask, 0, len(e.w.SubTasks))
	for _, s := range e.w.SubTasks {
		all = append(all, s)
	}
	for _, s := range sortedSubs(all) {
		t := e.w.Tasks[s.TaskID]
		if !s.Cancelled && s.Status == enum.StatusComplete && !s.Routed && t.Stage == enum.StageRunning && !t.Paused {
			moved = e.route(t, s) || moved
		}
	}
	return moved
}

func (e *Engine) groupOf(t *model.Task, s *model.SubTask) []*model.SubTask {
	if s.Group == "" {
		return []*model.SubTask{s}
	}
	var out []*model.SubTask
	for _, o := range e.subsOf(t.ID) {
		if o.Group == s.Group && !o.Cancelled {
			out = append(out, o)
		}
	}
	return out
}

func (e *Engine) route(t *model.Task, s *model.SubTask) bool {
	if s.Group != "" && s.Group != s.ID {
		return false // the lead routes for the whole group
	}
	members := e.groupOf(t, s)
	for _, m := range members {
		if m.Status != enum.StatusComplete {
			return false
		}
	}
	wf := &t.Workflow
	node := nodeOf(wf, s.NodeID)
	outs := outEdges(wf, node.ID)
	if s.SendBackReason != "" {
		e.sendBack(t, s, members, s.SendBackReason)
		return true
	}
	targets := s.RoutedTo
	if len(targets) == 0 && len(outs) > 0 {
		if node.Handoff == enum.HandoffPickOne && len(outs) > 1 {
			options := make([]model.ReviewOption, len(outs))
			for i, edge := range outs {
				options[i] = model.ReviewOption{ID: edge.To, Label: nodeOf(wf, edge.To).Name, Detail: edge.Condition}
			}
			e.openReview(t, s, model.Review{Kind: enum.ReviewPickRoute, Options: options})
			return true
		}
		for _, edge := range outs {
			targets = append(targets, edge.To)
		}
	}
	s.RoutedTo = targets
	for _, m := range members {
		m.Routed = true
	}
	for _, to := range targets {
		e.arrive(t, to, members)
	}
	return true
}

// maySendBack: a step the flow lets send work back, and only while it can (see canSendBack), never a start or a
// discussion, and never more than MaxSendBacks times a task. A flow from before the switch existed lets its last
// step and a step that was itself sent back.
func (e *Engine) maySendBack(t *model.Task, s *model.SubTask) bool {
	wf := &t.Workflow
	n := nodeOf(wf, s.NodeID)
	if n == nil || n.Kind != enum.NodeWork || len(s.UpstreamIDs) == 0 {
		return false
	}
	if n.SendBack != nil {
		if !*n.SendBack || !canSendBack(wf, n.ID) {
			return false
		}
	} else if len(outEdges(wf, n.ID)) > 0 && s.Rework == nil {
		return false
	}
	rounds := 0
	for _, o := range e.subsOf(t.ID) {
		if o.SentBack != nil && (o.Group == "" || o.Group == o.ID) {
			rounds++
		}
	}
	return rounds < MaxSendBacks
}

// sendBack has every step that fed this run work again, by the same employee when it can.
func (e *Engine) sendBack(t *model.Task, s *model.SubTask, members []*model.SubTask, reason string) {
	wf := &t.Workflow
	before := map[string]*model.SubTask{}
	var to, names []string
	for _, id := range s.UpstreamIDs {
		u := e.w.SubTasks[id]
		if u != nil && !u.Cancelled && (u.Group == "" || u.Group == u.ID) && before[u.NodeID] == nil {
			before[u.NodeID] = u
			to = append(to, u.NodeID)
			names = append(names, nodeOf(wf, u.NodeID).Name)
		}
	}
	joined := strings.Join(names, "、")
	for _, m := range members {
		m.Routed = true
		m.SendBackReason = ""
		m.SentBack = &model.SentBack{To: to, Reason: reason}
		if m.Handoff != nil {
			m.Handoff.Human.Headline = i18n.T("退回 %s：%s", joined, reason)
		}
		e.logLine(m, enum.LogSystem, i18n.T("退回 %s 重做：%s", joined, reason), "sentBack", map[string]any{"nodes": joined, "reason": reason})
	}
	from := nodeOf(wf, s.NodeID).Name
	for _, nodeID := range to {
		u := before[nodeID]
		redo := e.spawn(t, nodeID, slices.Clone(u.UpstreamIDs), ptr(s.ID), false, s.Round+1)
		if u.ReplicaID != nil && e.w.Replicas[*u.ReplicaID] != nil {
			redo.ReplicaID = ptr(*u.ReplicaID)
		}
		for _, r := range e.groupOf(t, redo) {
			r.Rework = &model.Rework{From: s.ID, Reason: reason}
			r.RoutedTo = slices.Clone(u.RoutedTo)
			e.logLine(r, enum.LogSystem, i18n.T("%s 退回重做：%s", from, reason), "reworkFrom", map[string]any{"node": from, "reason": reason})
		}
	}
}

func (e *Engine) arrive(t *model.Task, nodeID string, from []*model.SubTask) {
	wf := &t.Workflow
	fromIDs := make([]string, len(from))
	round := 0
	for i, s := range from {
		fromIDs[i] = s.ID
		round = max(round, s.Round)
	}
	lead := from[0]
	if len(inEdges(wf, nodeID)) <= 1 {
		e.spawn(t, nodeID, fromIDs, ptr(lead.ID), false, round)
		return
	}
	node := nodeOf(wf, nodeID)
	// a join gathers the arrivals of one round; work sent back arrives again in a later one
	var existing *model.SubTask
	for _, s := range e.subsOf(t.ID) {
		if s.NodeID == nodeID && !s.Cancelled && (s.Group == "" || s.Group == s.ID) && s.Round == round {
			existing = s
			break
		}
	}
	if node.Join == enum.JoinAny {
		if existing != nil {
			return // the join already started with the first arrival
		}
		started := e.spawn(t, nodeID, fromIDs, ptr(lead.ID), false, round)
		for _, o := range e.subsOf(t.ID) {
			if isLive(o) && o.ID != started.ID && o.Group != started.ID && !slices.Contains(fromIDs, o.ID) && feedsOnly(wf, o.NodeID, nodeID) {
				e.cancelSub(o, i18n.T("匯合節點已開始，取消這個分支"), "joinCancelled")
			}
		}
		return
	}
	if existing != nil {
		existing.UpstreamIDs = append(existing.UpstreamIDs, fromIDs...)
		existing.ParentID = e.commonAncestor(existing.UpstreamIDs)
		existing.ArrivedAt = e.w.Now
		name := nodeOf(wf, lead.NodeID).Name
		e.logLine(existing, enum.LogSystem, i18n.T("收到 %s 的交接", name), "joinArrived", map[string]any{"node": name})
		return
	}
	s := e.spawn(t, nodeID, fromIDs, ptr(lead.ID), true, round)
	s.ParentID = e.commonAncestor(fromIDs)
}

func (e *Engine) checkJoins() bool {
	moved := false
	for _, s := range e.w.SubTasks {
		t := e.w.Tasks[s.TaskID]
		if !s.Waiting || s.Cancelled || t.Stage != enum.StageRunning || t.Paused {
			continue
		}
		pending := false
		for _, o := range e.subsOf(t.ID) {
			if isLive(o) && o.NodeID != s.NodeID && canReach(&t.Workflow, o.NodeID, s.NodeID) {
				pending = true
				break
			}
		}
		if !pending {
			e.logLine(s, enum.LogSystem, i18n.T("所有會執行到的上游都已完成"), "joinReady", nil)
			e.release(t, s)
			moved = true
		}
	}
	return moved
}

// commonAncestor: join sub-tasks hang under the nearest sub-task shared by all their upstreams.
func (e *Engine) commonAncestor(ids []string) *string {
	chain := func(id string) []string {
		var out []string
		for cur := &id; cur != nil && e.w.SubTasks[*cur] != nil; cur = e.w.SubTasks[*cur].ParentID {
			out = append(out, *cur)
		}
		return out
	}
	chains := make([][]string, len(ids))
	for i, id := range ids {
		chains[i] = chain(id)
	}
	for _, id := range chains[0] {
		shared := true
		for _, c := range chains {
			shared = shared && slices.Contains(c, id)
		}
		if shared {
			return ptr(id)
		}
	}
	return nil
}

func (e *Engine) cancelSub(sub *model.SubTask, text, key string) {
	for _, s := range e.subsOf(sub.TaskID) {
		if s.ID == sub.ID || (sub.Group != "" && s.Group == sub.Group) {
			e.stopRun(s.ID)
			s.Cancelled = true
			s.Review = nil
			e.logLine(s, enum.LogSystem, text, key, nil)
		}
	}
}

func (e *Engine) dispatch() {
	var ready []*model.SubTask
	for _, s := range e.w.SubTasks {
		t := e.w.Tasks[s.TaskID]
		if s.Status == enum.StatusTodo && !s.Cancelled && !s.Waiting && t.Stage == enum.StageRunning && !t.Paused && e.taskCost(t) < e.costLimit(t) {
			ready = append(ready, s)
		}
	}
	for _, s := range sortedSubs(ready) {
		t := e.w.Tasks[s.TaskID]
		id := ""
		if s.ReplicaID != nil {
			id = *s.ReplicaID
		} else {
			// the step's employee; on a discussion held by several, the first, who chairs it
			for _, r := range nodeOf(&t.Workflow, s.NodeID).ReplicaIDs {
				if e.w.Replicas[r] != nil {
					id = r
					break
				}
			}
		}
		if id == "" || e.w.Replicas[id] == nil {
			continue
		}
		s.ReplicaID = ptr(id)
		s.Status = enum.StatusProgressing
		name := e.w.Replicas[id].Name
		e.logLine(s, enum.LogSystem, i18n.T("%s 開始工作", name), "start", map[string]any{"name": name})
		if s.StartedAt == nil {
			s.StartedAt = ptr(e.w.Now)
		}
		e.startSub(t, s)
	}
}

func (e *Engine) openReview(t *model.Task, s *model.SubTask, r model.Review) {
	r.From, r.At = s.Status, e.w.Now
	if r.Options == nil {
		r.Options = []model.ReviewOption{}
	}
	s.Review = &r
	s.Status = enum.StatusReview
	e.logLine(s, enum.LogSystem, i18n.T("等待使用者審核"), "review."+string(r.Kind), nil)
	e.notice(Event{Type: "notice", Kind: "review", TaskID: t.ID, SubID: s.ID})
}

// fail ends a run that went wrong: it tries again up to the company's limit, then asks the user.
func (e *Engine) fail(t *model.Task, s *model.SubTask, reason, detail string) {
	s.Attempts++
	limit := e.w.Teams[t.TeamID].Settings.Retries
	key := "retryError"
	if reason == "timeout" {
		key = "retryTimeout"
	}
	if s.Attempts <= limit {
		e.logLine(s, enum.LogSystem, i18n.T("%s，自動重試 %d/%d", detail, s.Attempts, limit), key, map[string]any{"n": s.Attempts, "max": limit})
		s.Status = enum.StatusTodo
		return
	}
	e.logLine(s, enum.LogSystem, detail, "", nil)
	e.openReview(t, s, model.Review{Kind: enum.ReviewFailed, Reason: reason, Prompt: detail, Options: []model.ReviewOption{{ID: "retry"}, {ID: "skip"}}})
}

func (e *Engine) taskOf(id string) (*model.Task, error) {
	t := e.w.Tasks[id]
	if t == nil {
		return nil, model.Errorf(model.CodeNotFound, "找不到任務")
	}
	return t, nil
}

func (e *Engine) subOf(id string) (*model.SubTask, *model.Task, error) {
	s := e.w.SubTasks[id]
	if s == nil {
		return nil, nil, model.Errorf(model.CodeNotFound, "找不到子任務")
	}
	return s, e.w.Tasks[s.TaskID], nil
}

// statusOf is a task's status on the board.
func (e *Engine) statusOf(t *model.Task) enum.Status {
	if t.Paused && t.PausedStatus != "" {
		return t.PausedStatus
	}
	switch t.Stage {
	case enum.StageDone:
		return enum.StatusComplete
	case enum.StageAwaitMerge:
		return enum.StatusReview
	case enum.StageMerging:
		return enum.StatusProgressing
	}
	seen := map[enum.Status]bool{}
	count := 0
	for _, s := range e.subsOf(t.ID) {
		if !s.Cancelled {
			seen[s.Status] = true
			count++
		}
	}
	switch {
	case count == 0, len(seen) == 1 && seen[enum.StatusTodo]:
		return enum.StatusTodo
	case seen[enum.StatusReview], len(seen) == 1 && seen[enum.StatusComplete]:
		return enum.StatusReview
	}
	return enum.StatusProgressing
}

// ---------- what the user does ----------

// NewTask is what a task is made from. Workflow, when given, is a flow of the task's own, written for it alone, and
// WorkflowID is ignored.
type NewTask struct {
	TeamID      string              `json:"teamId"`
	Title       string              `json:"title"`
	Description string              `json:"description"`
	WorkflowID  string              `json:"workflowId"`
	Workflow    *model.Workflow     `json:"workflow,omitempty"`
	Staff       map[string][]string `json:"staff"`
	OwnerID     *string             `json:"ownerId"`
	Images      []model.Attachment  `json:"images"`
	Files       []model.Attachment  `json:"files"`
	// ChatID is the company chat the user made the task from; it shows under the chat's last message.
	ChatID string `json:"chatId"`
	// Origin is set when an employee makes the task; a request cannot claim one.
	Origin *model.TaskOrigin `json:"-"`
}

func (e *Engine) CreateTask(in NewTask) (*model.Task, error) {
	var out *model.Task
	err := e.do(func() error {
		var err error
		out, err = e.createTask(in)
		return err
	})
	return out, err
}

// staffFlow settles who works each step of a new task. Call it holding the lock.
func (e *Engine) staffFlow(t *model.Task, staff map[string][]string, ownerID *string) {
	for i := range t.Workflow.Nodes {
		if picked, ok := staff[t.Workflow.Nodes[i].ID]; ok {
			t.Workflow.Nodes[i].ReplicaIDs = slices.Clone(picked)
		}
	}
	e.localize(&t.Workflow, e.w.Language)
	e.keepOwnStaff(t)
	t.OwnerID = ownerID
}

// createTask makes a task that waits in 待辦 until the user starts it with ResumeTask: it is paused, with no PausedAt.
// Call it holding the lock, inside a change.
func (e *Engine) createTask(in NewTask) (*model.Task, error) {
	var out *model.Task
	err := func() error {
		if e.w.Teams[in.TeamID] == nil {
			return model.Errorf(model.CodeNotFound, "找不到公司")
		}
		if strings.TrimSpace(in.Title) == "" {
			return model.Errorf(model.CodeInvalid, "任務要有標題")
		}
		wf, workflowID, err := e.taskFlow(in)
		if err != nil {
			return err
		}
		if in.OwnerID != nil {
			if r := e.w.Replicas[*in.OwnerID]; r == nil || r.TeamID != in.TeamID {
				return model.Errorf(model.CodeInvalid, "負責人不是這間公司的員工")
			}
		}
		number := 1
		for _, t := range e.w.Tasks {
			if t.TeamID == in.TeamID {
				number = max(number, t.Number+1)
			}
		}
		if err := e.checkFiles(in.Images, in.Files); err != nil {
			return err
		}
		images, err := e.storeImages(in.Images)
		if err != nil {
			return err
		}
		if images == nil {
			images = []model.Attachment{}
		}
		t := &model.Task{
			ID: e.uid("task"), TeamID: in.TeamID, Number: number, Title: strings.TrimSpace(in.Title), Description: in.Description, Images: images, Files: in.Files,
			WorkflowID: workflowID, Workflow: *wf, CreatedAt: e.w.Now, Stage: enum.StageRunning, Branch: fmt.Sprintf("task/%d", number), Origin: in.Origin,
		}
		e.staffFlow(t, in.Staff, in.OwnerID)
		if name := crowdedStep(&t.Workflow); name != "" {
			return model.Errorf(model.CodeInvalid, "工作步驟「%s」只能有一位員工", name)
		}
		for _, n := range t.Workflow.Nodes {
			if !slices.ContainsFunc(n.ReplicaIDs, func(r string) bool { return e.w.Replicas[r] != nil }) {
				return model.Errorf(model.CodeInvalid, "節點「%s」沒有指派員工", n.Name)
			}
		}
		if err := e.saveAttachments(t.ID, t.Files); err != nil {
			return err
		}
		t.Paused, t.PausedStatus = true, enum.StatusTodo
		e.w.Tasks[t.ID] = t
		e.pinToChat(in, t.ID)
		e.start(t)
		out = clone(t)
		return nil
	}()
	return out, err
}

// taskFlow is the copy of a flow a new task runs on, and the blueprint it names: the task's own flow, checked as a
// blueprint would be and naming none, or else a copy of the blueprint. Call it holding the lock.
func (e *Engine) taskFlow(in NewTask) (*model.Workflow, string, error) {
	if in.Workflow != nil {
		wf := clone(in.Workflow)
		wf.ID = ""
		settleStarts(wf)
		if err := e.checkFlow(wf); err != nil {
			return nil, "", err
		}
		return wf, "", nil
	}
	wf := e.w.Workflows[in.WorkflowID]
	if wf == nil {
		return nil, "", model.Errorf(model.CodeNotFound, "找不到任務藍圖")
	}
	if e.workflowHidden(in.WorkflowID) {
		return nil, "", model.Errorf(model.CodeInvalid, "這個任務藍圖已隱藏")
	}
	return clone(wf), in.WorkflowID, nil
}

// pinToChat shows a task made in a chat under the message it came from: the create_task line when an employee made
// it (the first one since the user last spoke that has no task yet), else the chat's last message. Call it holding the lock.
func (e *Engine) pinToChat(in NewTask, taskID string) {
	byTool := in.Origin != nil && (in.Origin.Kind == "chat" || in.Origin.Kind == "airport")
	chatID := in.ChatID
	if byTool {
		chatID = in.Origin.ID
	}
	c := e.w.Chats[chatID]
	if c == nil || len(c.Messages) == 0 || (!byTool && c.TeamID != in.TeamID) {
		return
	}
	at := len(c.Messages) - 1
	if byTool {
		if i := toolLineOf(c, toolCreateTask, func(m model.ChatMessage) bool { return len(m.Tasks) == 0 }); i >= 0 {
			at = i
		}
	}
	c.Messages[at].Tasks = append(c.Messages[at].Tasks, taskID)
}

// pinMade shows a blueprint, flow or provider an employee created in a chat under the line of the tool that made it,
// else under the chat's last message. Call it holding the lock.
func (e *Engine) pinMade(chatID, tool, kind, id string) {
	c := e.w.Chats[chatID]
	if c == nil || len(c.Messages) == 0 {
		return
	}
	at := toolLineOf(c, tool, func(m model.ChatMessage) bool { return len(m.Made) == 0 })
	if at < 0 {
		at = len(c.Messages) - 1
	}
	c.Messages[at].Made = append(c.Messages[at].Made, model.Made{Kind: kind, ID: id})
}

// toolLineOf is the first line of the tool since the user last spoke that free says has nothing pinned yet, or -1.
func toolLineOf(c *model.Chat, tool string, free func(model.ChatMessage) bool) int {
	at := -1
	for i := len(c.Messages) - 1; i >= 0 && c.Messages[i].From != "user"; i-- {
		m := c.Messages[i]
		if name, _, _ := strings.Cut(m.Text, " "); m.From == "tool" && strings.HasSuffix(name, tool) && free(m) {
			at = i
		}
	}
	return at
}

// start sets off every step a task's flow starts with; each gets the task as it is.
func (e *Engine) start(t *model.Task) {
	for _, n := range startsOf(&t.Workflow) {
		e.spawn(t, n.ID, []string{}, nil, false, 0)
	}
}

// TaskPatch changes a task; a nil field stays. Steps left out of Staff keep who they have.
type TaskPatch struct {
	Title       *string             `json:"title"`
	Description *string             `json:"description"`
	Staff       map[string][]string `json:"staff"`
	OwnerID     *string             `json:"ownerId"`
}

// UpdateTask edits a task. A run under way keeps what it was told; later steps see the change.
func (e *Engine) UpdateTask(id string, p TaskPatch) error {
	return e.do(func() error { return e.updateTask(id, p) })
}

// updateTask refuses before changing anything, as nothing takes back a change that fails halfway. Call it holding the lock.
func (e *Engine) updateTask(id string, p TaskPatch) error {
	t, err := e.taskOf(id)
	if err != nil {
		return err
	}
	if p.Title != nil && strings.TrimSpace(*p.Title) == "" {
		return model.Errorf(model.CodeInvalid, "任務要有標題")
	}
	if p.OwnerID != nil {
		if r := e.w.Replicas[*p.OwnerID]; r == nil || r.TeamID != t.TeamID {
			return model.Errorf(model.CodeInvalid, "負責人不是這間公司的員工")
		}
	}
	for nodeID, staff := range p.Staff {
		if nodeOf(&t.Workflow, nodeID) == nil {
			return model.Errorf(model.CodeInvalid, "這個任務沒有節點 %s", nodeID)
		}
		for _, r := range staff {
			if rep := e.w.Replicas[r]; rep == nil || rep.TeamID != t.TeamID {
				return model.Errorf(model.CodeInvalid, "指派了不是這間公司的員工")
			}
		}
	}
	next := model.Task{OwnerID: t.OwnerID, Workflow: clone(t.Workflow)}
	for i := range next.Workflow.Nodes {
		if staff, ok := p.Staff[next.Workflow.Nodes[i].ID]; ok {
			next.Workflow.Nodes[i].ReplicaIDs = slices.Clone(staff)
		}
	}
	owner := t.OwnerID
	if p.OwnerID != nil {
		owner = p.OwnerID
	}
	next.OwnerID = owner
	if name := crowdedStep(&next.Workflow); name != "" {
		return model.Errorf(model.CodeInvalid, "工作步驟「%s」只能有一位員工", name)
	}
	for nodeID := range p.Staff {
		n := nodeOf(&next.Workflow, nodeID)
		if !slices.ContainsFunc(n.ReplicaIDs, func(r string) bool { return e.w.Replicas[r] != nil }) {
			return model.Errorf(model.CodeInvalid, "節點「%s」沒有指派員工", n.Name)
		}
	}
	if p.Title != nil {
		t.Title = strings.TrimSpace(*p.Title)
	}
	if p.Description != nil {
		t.Description = *p.Description
	}
	t.OwnerID, t.Workflow = next.OwnerID, next.Workflow
	return nil
}

// ResolveReview is the user's reply to a sub-task waiting on them: an option with a note; a question can
// also be answered in words alone.
func (e *Engine) ResolveReview(subID, optionID, note string) error {
	resolve := func() error {
		if err := e.resolveReview(subID, optionID, note); err != nil {
			return err
		}
		e.w.Tutorial.Learn("review")
		return nil
	}
	if e.resolvesChange(subID, optionID) {
		return e.doSettings(resolve)
	}
	return e.do(resolve)
}

// resolvesChange says whether this answer writes settings, and so has to go through what guards them.
func (e *Engine) resolvesChange(subID, optionID string) bool {
	e.mu.Lock()
	defer e.mu.Unlock()
	s := e.w.SubTasks[subID]
	return s != nil && s.Review != nil && s.Review.Kind == enum.ReviewChange && optionID == optionApprove
}

func (e *Engine) resolveReview(subID, optionID, note string) error {
	s, t, err := e.subOf(subID)
	if err != nil {
		return err
	}
	r := s.Review
	if r == nil || r.Kind == enum.ReviewTalk {
		return model.Errorf(model.CodeConflict, "這個子任務沒有在等回覆")
	}
	note = strings.TrimSpace(note)
	var option *model.ReviewOption
	for i := range r.Options {
		if r.Options[i].ID == optionID {
			option = &r.Options[i]
		}
	}
	if option == nil && !(r.Kind == enum.ReviewQuestion && optionID == "" && note != "") {
		return model.Errorf(model.CodeInvalid, "沒有這個選項")
	}
	label := note
	if option != nil {
		label = option.Label
		if label == "" {
			label = optionID
		}
	}
	s.Review = nil
	switch {
	case r.Kind == enum.ReviewChange && optionID == optionApprove:
		e.logLine(s, enum.LogHuman, i18n.T("同意修改"), "", nil)
	case r.Kind == enum.ReviewChange:
		e.logLine(s, enum.LogHuman, i18n.T("拒絕修改"), "", nil)
	case option == nil:
		e.logLine(s, enum.LogHuman, note, "", nil)
	case note != "":
		e.logLine(s, enum.LogHuman, label+"："+note, "", nil)
	default:
		e.logLine(s, enum.LogHuman, label, "", nil)
	}
	switch r.Kind {
	case enum.ReviewQuestion:
		s.Status = enum.StatusTodo
		if option == nil { // words alone are a new message, not an answer
			e.w.Conversations[s.ID] = append(answerPending(e.w.Conversations[s.ID], askSkipped, ""), userText(note))
			e.dirty[s.ID] = true
			break
		}
		answer := label
		if note != "" {
			answer += "（" + note + "）"
		}
		e.w.Conversations[s.ID] = answerPending(e.w.Conversations[s.ID], askPicked+answer, answer)
		e.dirty[s.ID] = true
	case enum.ReviewPickRoute:
		s.Status = enum.StatusComplete
		s.RoutedTo = []string{optionID}
		if s.Handoff != nil {
			reason := note
			if reason == "" {
				reason = "The user chose"
			}
			s.Handoff.Agent.Next = &model.NextStep{NodeID: optionID, Reason: reason}
		}
	case enum.ReviewFailed:
		if optionID == "skip" {
			s.Status = enum.StatusComplete
			s.Skipped = true
			s.EndedAt = ptr(e.w.Now)
			s.Handoff = &model.Handoff{
				Agent: model.AgentHandoff{Goal: t.Title, Done: []string{}, Outputs: []string{}, Decisions: []string{"The user skipped this step"}, Open: []string{"This step produced nothing"}},
				Human: model.HumanSummary{Headline: i18n.T("此節點已略過，沒有產出。"), Did: []string{}, Outputs: []string{}},
			}
		} else {
			s.Status = enum.StatusTodo
			s.Attempts = 0
		}
	case enum.ReviewChange:
		s.Status = enum.StatusTodo
		text, isError := e.settleChange(r.Change, optionID == optionApprove, note)
		e.w.Conversations[s.ID] = answerChange(e.w.Conversations[s.ID], text, isError)
		e.dirty[s.ID] = true
	case enum.ReviewBudget:
		s.Status = enum.StatusTodo
		if optionID == "addBudget" {
			t.BudgetBonus += e.w.Teams[t.TeamID].Settings.CostLimitUSD * 0.5
		} else {
			e.pause(t)
		}
	}
	if t.Paused {
		t.PausedStatus = enum.StatusProgressing
		if e.statusOf(&model.Task{ID: t.ID, Stage: t.Stage}) == enum.StatusReview {
			t.PausedStatus = enum.StatusReview
		}
	}
	return nil
}

func (e *Engine) pause(t *model.Task) {
	t.PausedStatus = e.statusOf(t)
	t.Paused = true
	t.PausedAt = ptr(e.w.Now)
	for _, s := range e.subsOf(t.ID) {
		if s.Status == enum.StatusProgressing {
			e.stopRun(s.ID)
			s.Status = enum.StatusTodo
			e.logLine(s, enum.LogSystem, i18n.T("任務已暫停，中斷工作"), "paused", nil)
		}
	}
}

func (e *Engine) PauseTask(id string) error {
	return e.do(func() error {
		t, err := e.taskOf(id)
		if err != nil {
			return err
		}
		if t.Stage != enum.StageRunning || t.Paused {
			return model.Errorf(model.CodeConflict, "這個任務現在不能暫停")
		}
		e.pause(t)
		return nil
	})
}

func (e *Engine) ResumeTask(id string) error {
	return e.do(func() error {
		t, err := e.taskOf(id)
		if err != nil {
			return err
		}
		if !t.Paused {
			return model.Errorf(model.CodeConflict, "這個任務沒有暫停")
		}
		// a task that was never started has no PausedAt; starting it is not the pause lesson
		if t.PausedAt != nil {
			e.w.Tutorial.Learn("pause")
		}
		t.Paused, t.PausedAt, t.PausedStatus = false, nil, ""
		return nil
	})
}

func (e *Engine) CancelTask(id string) error {
	return e.do(func() error {
		t, err := e.taskOf(id)
		if err != nil {
			return err
		}
		if !t.Paused {
			return model.Errorf(model.CodeConflict, "任務要先暫停才能取消")
		}
		e.stopTask(t)
		return nil
	})
}

// stopTask cancels a task and throws away its branch and work tree.
func (e *Engine) stopTask(t *model.Task) {
	t.Stage = enum.StageCancelled
	t.Paused, t.PausedAt, t.PausedStatus = false, nil, ""
	t.DoneAt = ptr(e.w.Now)
	for _, s := range e.subsOf(t.ID) {
		e.stopRun(s.ID)
		if isLive(s) {
			s.Cancelled = true
			s.Review = nil
			e.logLine(s, enum.LogSystem, i18n.T("任務已取消"), "cancelled", nil)
		}
	}
	e.removeTree(t)
}

func (e *Engine) removeTree(t *model.Task) {
	e.removeOutputs(t.ID)
	team := e.w.Teams[t.TeamID]
	if team == nil {
		return
	}
	if err := e.git.Remove(e.ctx, team.Folder, e.worktreeOf(t), t.Branch); err != nil {
		e.log.Error().Err(err).Str("task", t.ID).Msg("remove work tree")
	}
}

func (e *Engine) dropSubs(t *model.Task) {
	for _, s := range e.subsOf(t.ID) {
		e.stopRun(s.ID)
		delete(e.w.SubTasks, s.ID)
		delete(e.w.Conversations, s.ID)
		delete(e.dirty, s.ID)
	}
}

// keepOwnStaff drops anyone from a task's steps who does not work at its company.
func (e *Engine) keepOwnStaff(t *model.Task) {
	for i := range t.Workflow.Nodes {
		n := &t.Workflow.Nodes[i]
		n.ReplicaIDs = slices.DeleteFunc(slices.Clone(n.ReplicaIDs), func(id string) bool {
			r := e.w.Replicas[id]
			return r == nil || r.TeamID != t.TeamID
		})
	}
}

// ChangeWorkflow discards all progress and runs a paused task again on another flow.
func (e *Engine) ChangeWorkflow(id, workflowID string) error {
	return e.do(func() error {
		t, err := e.taskOf(id)
		if err != nil {
			return err
		}
		wf := e.w.Workflows[workflowID]
		if wf == nil {
			return model.Errorf(model.CodeNotFound, "找不到任務藍圖")
		}
		if workflowID != t.WorkflowID && e.workflowHidden(workflowID) {
			return model.Errorf(model.CodeInvalid, "這個任務藍圖已隱藏")
		}
		if !t.Paused {
			return model.Errorf(model.CodeConflict, "任務要先暫停才能更換任務藍圖")
		}
		t.CostCarry = e.taskCost(t)
		t.TokensCarry = e.taskTokens(t)
		e.dropSubs(t)
		e.removeTree(t)
		t.WorkflowID, t.Workflow = workflowID, clone(*wf)
		e.localize(&t.Workflow, e.w.Language)
		e.keepOwnStaff(t)
		t.Paused, t.PausedAt, t.PausedStatus = false, nil, ""
		e.start(t)
		return nil
	})
}

func (e *Engine) DeleteTask(id string) error {
	return e.do(func() error {
		t, err := e.taskOf(id)
		if err != nil {
			return err
		}
		e.stopRun("merge:" + id)
		e.dropSubs(t)
		e.removeTree(t)
		delete(e.w.Tasks, id)
		return nil
	})
}

// lastReview is the run a task ended with: of the runs of its last steps, the one that finished last. With several
// last steps, one with a step before it comes first, so that returning the task has somewhere to send it.
func (e *Engine) lastReview(t *model.Task) *model.SubTask {
	var best *model.SubTask
	for _, s := range e.subsOf(t.ID) {
		if !s.Cancelled && (s.Group == "" || s.Group == s.ID) && s.Status == enum.StatusComplete && len(outEdges(&t.Workflow, s.NodeID)) == 0 {
			if best != nil && len(best.UpstreamIDs) > 0 && len(s.UpstreamIDs) == 0 {
				continue
			}
			if best != nil && len(best.UpstreamIDs) == 0 && len(s.UpstreamIDs) > 0 {
				best = s
				continue
			}
			if best == nil || (s.EndedAt != nil && best.EndedAt != nil && *s.EndedAt >= *best.EndedAt) {
				best = s
			}
		}
	}
	return best
}

// MergeTask has the owner (or whoever did the last step) merge the work tree into the target branch.
func (e *Engine) MergeTask(id string) error {
	return e.do(func() error {
		t, err := e.taskOf(id)
		if err != nil {
			return err
		}
		if t.Stage != enum.StageAwaitMerge {
			return model.Errorf(model.CodeConflict, "這個任務現在不能合併")
		}
		by := t.OwnerID
		if by == nil || e.w.Replicas[*by] == nil {
			by = nil
			if last := e.lastReview(t); last != nil {
				by = last.ReplicaID
			}
		}
		t.Stage = enum.StageMerging
		var earlier []model.LogLine // of a merge that failed
		if t.Merge != nil {
			earlier = t.Merge.Log
		}
		t.Merge = &model.Merge{ReplicaID: by, Log: append(earlier, model.LogLine{At: e.w.Now, Kind: enum.LogHuman, Text: i18n.T("合併")})}
		return nil
	})
}

// ReturnTask sends a task waiting to be merged back, with feedback: the steps before its last step (see lastReview)
// run again. It does not depend on the step letting work be sent back.
func (e *Engine) ReturnTask(id, feedback string) error {
	return e.do(func() error {
		t, err := e.taskOf(id)
		if err != nil {
			return err
		}
		if t.Stage != enum.StageAwaitMerge {
			return model.Errorf(model.CodeConflict, "這個任務現在不能退回")
		}
		reason := strings.TrimSpace(feedback)
		if reason == "" {
			return model.Errorf(model.CodeInvalid, "退回要寫理由")
		}
		review := e.lastReview(t)
		if review == nil || len(review.UpstreamIDs) == 0 {
			return model.Errorf(model.CodeConflict, "沒有可以退回的步驟")
		}
		e.logLine(review, enum.LogHuman, i18n.T("退回：%s", reason), "", nil)
		t.Stage = enum.StageRunning
		e.sendBack(t, review, e.groupOf(t, review), reason)
		return nil
	})
}

// SayInTalk is the user writing in an open discussion. Those it mentions answer, in that order; with none, the
// chair alone does. "@All" comes as everyone mentioned, the chair last.
func (e *Engine) SayInTalk(subID, text string, mentions []string) error {
	return e.do(func() error {
		s, t, err := e.subOf(subID)
		if err != nil {
			return err
		}
		text = strings.TrimSpace(text)
		if text == "" {
			return model.Errorf(model.CodeInvalid, "訊息是空的")
		}
		if !talking(s) || s.Talk.ReplyAt != nil {
			return model.Errorf(model.CodeConflict, "現在不能在這裡發言")
		}
		people := e.talkPeople(t, s)
		if len(people) == 0 {
			return model.Errorf(model.CodeInvalid, "討論裡沒有人可以回覆")
		}
		var speakers []string
		for _, id := range mentions {
			if !slices.Contains(people, id) {
				return model.Errorf(model.CodeInvalid, "這個討論裡沒有這位員工")
			}
			if !slices.Contains(speakers, id) {
				speakers = append(speakers, id)
			}
		}
		if len(speakers) == 0 {
			speakers = people[:1]
		}
		s.Talk.Messages = append(s.Talk.Messages, model.ChatMessage{At: e.w.Now, From: "user", Text: text, Mentions: slices.Clone(mentions)})
		e.logLine(s, enum.LogHuman, text, "", nil)
		e.w.Conversations[s.ID] = append(answerPending(e.w.Conversations[s.ID], "", ""), userText(text))
		e.dirty[s.ID] = true
		s.Talk.Next = speakers[1:]
		e.startTalkReply(t, s, speakers[0])
		return nil
	})
}

// EndTalk ends a discussion: continue hands on what was settled, back sends the work back, stop cancels the task.
func (e *Engine) EndTalk(subID string, end model.TalkEnd) error {
	return e.do(func() error {
		s, t, err := e.subOf(subID)
		if err != nil {
			return err
		}
		if !talking(s) {
			return model.Errorf(model.CodeConflict, "這個討論已經結束")
		}
		wf := &t.Workflow
		node := nodeOf(wf, s.NodeID)
		outs := outEdges(wf, node.ID)
		end.Reason = strings.TrimSpace(end.Reason)
		switch end.Kind {
		case "continue":
			if node.Handoff == enum.HandoffPickOne && len(outs) > 1 && !slices.ContainsFunc(outs, func(x model.WorkflowEdge) bool { return x.To == end.To }) {
				return model.Errorf(model.CodeInvalid, "要選一個下一步")
			}
		case "back":
			if end.Reason == "" || len(s.UpstreamIDs) == 0 {
				return model.Errorf(model.CodeInvalid, "退回要寫理由，而且要有上一步")
			}
		case "stop":
		default:
			return model.Errorf(model.CodeInvalid, "不認識的結束方式")
		}
		e.stopRun(s.ID)
		var said []string
		lastAgent := ""
		for _, m := range s.Talk.Messages {
			if m.From == "user" {
				said = append(said, m.Text)
			} else {
				lastAgent = m.Text
			}
		}
		s.Talk.Ended, s.Talk.ReplyAt, s.Talk.Next, s.Review = end.Kind, nil, nil, nil
		s.Status = enum.StatusComplete
		s.EndedAt = ptr(e.w.Now)
		if end.Kind == "stop" {
			e.logLine(s, enum.LogHuman, i18n.T("結束討論：停止任務"), "", nil)
			e.stopTask(t)
			return nil
		}
		decisions := make([]string, len(said))
		for i, x := range said {
			decisions[i] = "User: " + x
		}
		did := decisions
		if len(did) == 0 {
			did = []string{i18n.T("使用者沒有補充，照原計畫進行")}
		}
		done := []string{}
		if lastAgent != "" {
			done = []string{lastAgent}
		}
		s.Handoff = &model.Handoff{
			Agent: model.AgentHandoff{Goal: t.Title, Done: done, Outputs: []string{}, Decisions: decisions, Open: []string{}},
			Human: model.HumanSummary{Headline: i18n.T("討論結束：%s", node.Name), Did: did, Outputs: []string{}},
		}
		if end.Kind == "back" {
			e.logLine(s, enum.LogHuman, i18n.T("結束討論：退回（%s）", end.Reason), "", nil)
			e.sendBack(t, s, []*model.SubTask{s}, end.Reason)
			return nil
		}
		if end.To != "" && nodeOf(wf, end.To) != nil {
			s.RoutedTo = []string{end.To}
			s.Handoff.Agent.Next = &model.NextStep{NodeID: end.To, Reason: "The user chose after the discussion"}
			e.logLine(s, enum.LogHuman, i18n.T("結束討論：繼續，交給 %s", nodeOf(wf, end.To).Name), "", nil)
		} else {
			e.logLine(s, enum.LogHuman, i18n.T("結束討論：繼續"), "", nil)
		}
		return nil
	})
}
