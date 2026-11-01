package usecase

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"time"

	"github.com/yanun0323/mho-company/internal/adapter"
	"github.com/yanun0323/mho-company/internal/i18n"
	"github.com/yanun0323/mho-company/internal/model"
	"github.com/yanun0323/mho-company/internal/model/enum"
	"github.com/yanun0323/mho-company/internal/usecase/tools"
)

const (
	modelRetries = 3
	maxNudges    = 2
	// maxModelCalls bounds one run, so a model going round in circles ends up with the user.
	maxModelCalls = 200
	toolAskUser   = "ask_user"
	nudgeText     = "You have not handed off. If done, call submit_handoff. If the user must decide, call ask_user. Otherwise keep working."
)

var retryDelay = time.Second

// turn is the model-and-tools loop: it calls the model and runs what it asks for until the model only
// talks, a tool stops the run, or a callback does.
type turn struct {
	provider adapter.Provider
	req      model.ModelRequest
	tools    map[string]adapter.Tool
	cwd      string
	// onStart comes before each try at the model, so a retry's text does not pile up on the last try's.
	onStart func()
	onText  func(string)
	// onReply records a reply and says whether to go on.
	onReply func(model.ModelReply) bool
	// onTool records that a tool is about to run, and onResults its results.
	onTool    func(model.Block)
	onResults func(model.Message)
}

// turnResult is how a turn ended: Stopped by a tool or callback, or with the model's Text and no tool calls.
type turnResult struct {
	Stopped bool
	Text    string
}

func (t *turn) complete(ctx context.Context) (model.ModelReply, error) {
	delay := retryDelay
	for attempt := 0; ; attempt++ {
		t.onStart()
		reply, err := t.provider.Complete(ctx, t.req, t.onText)
		var failure *model.Error
		if err == nil || ctx.Err() != nil || !errors.As(err, &failure) || failure.Code != model.CodeUnavailable || attempt == modelRetries {
			return reply, err
		}
		select {
		case <-time.After(delay):
		case <-ctx.Done():
			return reply, ctx.Err()
		}
		delay *= 2
	}
}

func (t *turn) run(ctx context.Context) (turnResult, error) {
	for call := 0; call < maxModelCalls; call++ {
		reply, err := t.complete(ctx)
		if err != nil {
			return turnResult{}, err
		}
		if len(reply.Content) == 0 {
			return turnResult{}, model.Errorf(model.CodeUnavailable, "模型沒有回覆內容")
		}
		t.req.Messages = append(t.req.Messages, model.Message{Role: enum.RoleAssistant, Content: reply.Content})
		if !t.onReply(reply) {
			return turnResult{Stopped: true}, nil
		}
		var text strings.Builder
		var results []model.Block
		stopped := false
		for _, b := range reply.Content {
			if b.Type == enum.BlockText {
				text.WriteString(b.Text)
			}
			if b.Type != enum.BlockToolCall || stopped {
				continue
			}
			t.onTool(b)
			tool := t.tools[b.Name]
			result := model.ToolResult{Text: "unknown tool " + b.Name, IsError: true}
			if tool != nil {
				result = tool.Run(ctx, t.cwd, b.Args)
			}
			if ctx.Err() != nil {
				return turnResult{}, ctx.Err()
			}
			if result.Stop {
				stopped = true
				continue
			}
			results = append(results, model.Block{Type: enum.BlockToolResult, ID: b.ID, Name: b.Name, Text: result.Text, IsError: result.IsError, MimeType: result.MimeType, Data: result.Data})
		}
		if stopped {
			return turnResult{Stopped: true}, nil
		}
		if len(results) == 0 {
			if reply.Truncated {
				return turnResult{}, model.Errorf(model.CodeUnavailable, "模型的回覆太長被截斷")
			}
			return turnResult{Text: text.String()}, nil
		}
		msg := model.Message{Role: enum.RoleUser, Content: results}
		t.req.Messages = append(t.req.Messages, msg)
		t.onResults(msg)
	}
	return turnResult{}, model.Errorf(model.CodeUnavailable, "模型呼叫超過 %d 次仍沒有結束", maxModelCalls)
}

// funcTool is a tool made from a function, for what only the engine can do.
type funcTool struct {
	spec model.ToolSpec
	fn   func(ctx context.Context, cwd string, args json.RawMessage) model.ToolResult
}

func (f funcTool) Spec() model.ToolSpec { return f.spec }
func (f funcTool) Run(ctx context.Context, cwd string, args json.RawMessage) model.ToolResult {
	return f.fn(ctx, cwd, args)
}

// agentSpec is what a run needs from the world, copied under the lock so it can work outside it.
type agentSpec struct {
	provider adapter.Provider
	price    *model.ModelPrice
	model    string
	effort   string
	system   string
	allowed  []enum.Tool
	packs    []packRoot
	// own is the repo the blueprint's prompt is read from, when it has none written down
	own  *model.BlueprintSource
	name string
	// subscription: paid by plan, not by token, so the cost limit has nothing to count
	subscription bool
}

// packRoot is a skill pack as read at run time.
type packRoot struct {
	source  model.BlueprintSource
	include []string
	exclude []string
}

// providerFor finds who offers a model; the oldest provider wins, so the answer never changes by chance.
func (e *Engine) providerFor(modelID string) *model.ModelProvider {
	var found *model.ModelProvider
	for _, p := range e.w.Providers {
		if slices.Contains(p.Models, modelID) && (found == nil || len(p.ID) < len(found.ID) || (len(p.ID) == len(found.ID) && p.ID < found.ID)) {
			found = p
		}
	}
	return found
}

func (e *Engine) buildSpec(t *model.Task, node *model.WorkflowNode, r *model.Replica) (agentSpec, error) {
	bp := e.w.Blueprints[r.BlueprintID]
	if bp == nil {
		return agentSpec{}, model.Errorf(model.CodeInvalid, "找不到 %s 的藍圖", r.Name)
	}
	p := e.providerFor(r.Model)
	if p == nil {
		return agentSpec{}, model.Errorf(model.CodeInvalid, "沒有模型供應商提供 %s", r.Model)
	}
	provider, err := e.providers.For(*p, e.secrets[p.ID])
	if err != nil {
		return agentSpec{}, err
	}
	var own *model.BlueprintSource
	if bp.Source.Kind == "git" && bp.Prompt == "" {
		own = ptr(bp.Source)
	}
	// the default sends no level, and neither does one the model turned out not to take
	effort := ""
	if r.Effort != model.ThinkingDefault && e.takesEffort(r.Model, r.Effort) {
		effort = r.Effort
	}
	spec := agentSpec{own: own, provider: provider, model: r.Model, effort: effort, name: r.Name, allowed: slices.Clone(bp.Tools), subscription: p.Auth.Kind != "apiKey"}
	if price, ok := p.Prices[r.Model]; ok {
		spec.price = &price
	}
	if node != nil {
		team := e.w.Teams[t.TeamID]
		e.readPrompt(team)
		spec.system = composePrompt(t, team, node, bp, r, e.w.Language)
	}
	spec.packs = packsOf(bp)
	return spec, nil
}

func packsOf(bp *model.Blueprint) []packRoot {
	var packs []packRoot
	for _, pack := range bp.Skills {
		source := bp.Source
		if pack.Source != nil {
			source = *pack.Source
		}
		packs = append(packs, packRoot{source: source, include: pack.Include, exclude: pack.Exclude})
	}
	return packs
}

// loadSkills finds the skills of a blueprint's packs; one that cannot be read is reported and left out. The same
// skill in several packs, as agent folders often share them, counts once: the first pack's. A skill's own folder is
// a root too, because it may be a link to somewhere outside its pack.
func (e *Engine) loadSkills(ctx context.Context, packs []packRoot) (found []skill, roots []string, problems []string) {
	seen := map[string]bool{}
	for _, p := range packs {
		root := ""
		switch p.source.Kind {
		case "local":
			root = expandHome(p.source.Path)
		case "git":
			dir, err := e.git.Fetch(ctx, p.source.Repo, p.source.Commit)
			if err != nil {
				problems = append(problems, i18n.T("技能來源 %s 讀取失敗", p.source.Repo))
				continue
			}
			root = dir
		default:
			continue
		}
		roots = append(roots, root)
		for _, s := range skillsIn(root, p.include, p.exclude) {
			if !seen[s.name] {
				seen[s.name] = true
				found = append(found, s)
				roots = append(roots, filepath.Dir(s.path))
			}
		}
	}
	return found, roots, problems
}

// repoPrompt is the AGENTS.md of the repo a blueprint comes from. Nothing there, or a repo out of reach, is no
// failure: the employee works without it, as they do for skills.
func (e *Engine) repoPrompt(ctx context.Context, in subRun) string {
	if in.spec.own == nil {
		return ""
	}
	prompt, err := e.ownPrompt(ctx, in.spec.own)
	if err != nil {
		e.apply(in, func(_ *model.Task, s *model.SubTask) {
			e.logLine(s, enum.LogSystem, i18n.T("藍圖來源 %s 讀取失敗", in.spec.own.Repo), "", nil)
		})
	}
	return prompt
}

// ownPrompt reads the role a blueprint keeps in its repo. A repo without one has nothing to add.
func (e *Engine) ownPrompt(ctx context.Context, own *model.BlueprintSource) (string, error) {
	dir, err := e.git.Fetch(ctx, own.Repo, own.Commit)
	if err != nil {
		return "", err
	}
	raw, err := os.ReadFile(filepath.Join(dir, "AGENTS.md"))
	if err != nil {
		return "", nil
	}
	return "\n# Your role\n" + string(raw) + "\n", nil
}

// startSub starts a run for a sub-task just dispatched. Call it holding the lock.
func (e *Engine) startSub(t *model.Task, s *model.SubTask) {
	node := nodeOf(&t.Workflow, s.NodeID)
	r := e.w.Replicas[*s.ReplicaID]
	spec, err := e.buildSpec(t, node, r)
	if err != nil {
		// nothing would wake a retry, and the same settings would fail the same way: ask the user now
		s.Attempts = e.w.Teams[t.TeamID].Settings.Retries
		e.fail(t, s, "error", safeText(err))
		return
	}
	conv := e.w.Conversations[s.ID]
	if len(conv) == 0 {
		conv = []model.Message{e.firstMessage(t, s)}
	} else {
		conv = answerPending(conv, "")
		if conv[len(conv)-1].Role == enum.RoleAssistant {
			conv = append(conv, userText("Please continue."))
		}
	}
	e.w.Conversations[s.ID] = conv
	e.dirty[s.ID] = true
	e.launch(t, s, spec, r.ID, slices.Clone(conv))
}

// startTalkReply has the employee answer in a discussion. Call it holding the lock.
func (e *Engine) startTalkReply(t *model.Task, s *model.SubTask) {
	r := e.w.Replicas[*s.ReplicaID]
	if r == nil {
		return
	}
	spec, err := e.buildSpec(t, nodeOf(&t.Workflow, s.NodeID), r)
	if err != nil {
		e.talkFailed(s, safeText(err))
		return
	}
	s.Talk.ReplyAt = ptr(e.w.Now)
	e.launch(t, s, spec, r.ID, slices.Clone(e.w.Conversations[s.ID]))
}

func (e *Engine) talkFailed(s *model.SubTask, detail string) {
	s.Talk.ReplyAt = nil
	text := i18n.T("（回覆失敗：%s）", detail)
	s.Talk.Messages = append(s.Talk.Messages, model.ChatMessage{At: e.w.Now, From: "agent", Text: text})
	e.logLine(s, enum.LogSystem, text, "", nil)
}

// launch registers a run and starts its goroutine, which the engine owns: it ends with its context.
func (e *Engine) launch(t *model.Task, s *model.SubTask, spec agentSpec, replicaID string, conv []model.Message) {
	e.stopRun(s.ID)
	timeout := time.Duration(e.w.Teams[t.TeamID].Settings.TimeoutMin * float64(time.Minute))
	ctx, cancel := context.WithCancel(e.ctx)
	if timeout > 0 {
		ctx, cancel = context.WithTimeout(e.ctx, timeout)
	}
	r := &run{cancel: cancel, replicaID: replicaID}
	e.runs[s.ID] = r
	in := subRun{r: r, subID: s.ID, taskID: t.ID, spec: spec, conv: conv, talk: nodeOf(&t.Workflow, s.NodeID).Kind == enum.NodeTalk,
		folder: e.w.Teams[t.TeamID].Folder, dir: e.worktreeOf(t), branch: t.Branch, target: e.w.Teams[t.TeamID].TargetBranch,
		label: fmt.Sprintf("#%d %s", t.Number, nodeOf(&t.Workflow, s.NodeID).Name)}
	e.wg.Add(1)
	go e.runSub(ctx, in)
}

func (e *Engine) stopRun(id string) {
	if r := e.runs[id]; r != nil {
		delete(e.runs, id)
		r.cancel()
		if _, ok := e.live[id]; ok {
			delete(e.live, id)
			e.publish(Event{Type: "deltaReset", SubID: id})
		}
	}
}

// safeText is an error's text when it is meant to be shown; other errors stay in the server's log.
func safeText(err error) string {
	var failure *model.Error
	if errors.As(err, &failure) {
		return failure.Message
	}
	return i18n.T("執行時發生內部錯誤")
}

type subRun struct {
	r                           *run
	subID, taskID               string
	spec                        agentSpec
	conv                        []model.Message
	talk                        bool
	folder, dir, branch, target string
	label                       string
}

// apply changes the world for a run, unless the run was stopped or replaced meanwhile.
func (e *Engine) apply(in subRun, fn func(t *model.Task, s *model.SubTask)) bool {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.runs[in.subID] != in.r {
		return false
	}
	s, t := e.w.SubTasks[in.subID], e.w.Tasks[in.taskID]
	if s == nil || t == nil {
		return false
	}
	e.w.Now = e.clock()
	fn(t, s)
	e.settle()
	return true
}

func (e *Engine) runSub(ctx context.Context, in subRun) {
	defer e.wg.Done()
	defer in.r.cancel()
	defer func() {
		e.mu.Lock()
		defer e.mu.Unlock()
		if e.runs[in.subID] == in.r {
			delete(e.runs, in.subID)
			delete(e.live, in.subID)
			e.settle()
		}
	}()

	failed := func(reason, detail string) {
		e.apply(in, func(t *model.Task, s *model.SubTask) {
			if talking(s) {
				e.talkFailed(s, detail)
				return
			}
			e.fail(t, s, reason, detail)
		})
	}
	stop := func(err error) {
		switch {
		case errors.Is(ctx.Err(), context.DeadlineExceeded):
			failed("timeout", i18n.T("執行逾時"))
		case ctx.Err() != nil: // stopped on purpose; whoever stopped it has moved the sub-task on
		default:
			var known *model.Error
			if !errors.As(err, &known) {
				e.log.Error().Err(err).Str("sub", in.subID).Msg("run failed")
			}
			failed("error", safeText(err))
		}
	}
	if err := e.git.Worktree(ctx, in.folder, in.dir, in.branch, in.target); err != nil {
		e.log.Error().Err(err).Str("sub", in.subID).Msg("make work tree")
		stop(model.Errorf(model.CodeInvalid, "建立 work tree 失敗（分支 %s）", in.branch))
		return
	}
	skills, roots, problems := e.loadSkills(ctx, in.spec.packs)
	if ctx.Err() != nil {
		stop(ctx.Err())
		return
	}
	for _, p := range problems {
		e.apply(in, func(_ *model.Task, s *model.SubTask) { e.logLine(s, enum.LogSystem, p, "", nil) })
	}

	t := e.subTurn(in, roots)
	t.req.System += e.repoPrompt(ctx, in) + skillsPrompt(skills) + "\n" + mentionRule + "\n"
	calls := 0
	t.onReply = e.onSubReply(in, t, &calls)

	for nudges := 0; ; nudges++ {
		res, err := t.run(ctx)
		if err != nil {
			stop(err)
			return
		}
		if res.Stopped {
			return
		}
		if in.talk {
			e.apply(in, func(tk *model.Task, s *model.SubTask) { e.talkSays(tk, s, res.Text) })
			return
		}
		if nudges == maxNudges {
			failed("error", i18n.T("員工沒有交接就停下來了"))
			return
		}
		msg := userText(nudgeText)
		t.req.Messages = append(t.req.Messages, msg)
		if !e.apply(in, func(_ *model.Task, s *model.SubTask) {
			e.w.Conversations[s.ID] = append(e.w.Conversations[s.ID], msg)
			e.dirty[s.ID] = true
		}) {
			return
		}
	}
}

// talkSays is the employee's words in a discussion: the opening, which starts it, or a reply.
func (e *Engine) talkSays(t *model.Task, s *model.SubTask, text string) {
	if s.Talk == nil {
		delete(e.live, s.ID)
		s.Talk = &model.Talk{Messages: []model.ChatMessage{}}
		s.Progress = 1
		s.Talk.Messages = append(s.Talk.Messages, model.ChatMessage{At: e.w.Now, From: "agent", Text: text})
		e.logLine(s, enum.LogSay, text, "", nil)
		e.openReview(t, s, model.Review{Kind: enum.ReviewTalk})
		return
	}
	delete(e.live, s.ID)
	s.Talk.ReplyAt = nil
	s.Talk.Messages = append(s.Talk.Messages, model.ChatMessage{At: e.w.Now, From: "agent", Text: text})
	e.logLine(s, enum.LogSay, text, "", nil)
}

func (e *Engine) subTurn(in subRun, roots []string) *turn {
	allowed := in.spec.allowed
	if in.talk { // a discussion changes nothing; it only reads
		allowed = slices.DeleteFunc(slices.Clone(allowed), func(x enum.Tool) bool { return x == enum.ToolWriteFile || x == enum.ToolRunCommand })
	}
	list := tools.For(allowed, append(roots, e.attachmentRoot(in.taskID)))
	if !in.talk {
		list = append(list, e.agentTools(in)...)
	}
	specs := make([]model.ToolSpec, len(list))
	byName := make(map[string]adapter.Tool, len(list))
	for i, tool := range list {
		specs[i] = tool.Spec()
		byName[specs[i].Name] = tool
	}
	return &turn{
		provider: in.spec.provider,
		req:      model.ModelRequest{Cwd: in.dir, Session: in.subID, Model: in.spec.model, Effort: in.spec.effort, System: in.spec.system, Messages: in.conv, Tools: specs},
		tools:    byName, cwd: in.dir,
		onStart: func() {
			if in.talk {
				e.restartLive(in.subID, in.r)
			}
		},
		onText: func(text string) {
			if in.talk {
				e.addLive(in.subID, in.r, text)
			}
		},
		onTool: func(call model.Block) {
			e.apply(in, func(_ *model.Task, s *model.SubTask) {
				e.logLine(s, enum.LogTool, call.Name+" "+clip(string(call.Args), 200), "", nil)
			})
		},
		onResults: func(msg model.Message) {
			e.apply(in, func(_ *model.Task, s *model.SubTask) {
				e.w.Conversations[s.ID] = append(e.w.Conversations[s.ID], msg)
				e.dirty[s.ID] = true
			})
		},
	}
}

// restartLive empties what the employee of a chat or discussion is writing, for a new try at the model.
func (e *Engine) restartLive(id string, r *run) {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.runs[id] != r {
		return
	}
	delete(e.live, id)
	e.publish(Event{Type: "deltaReset", SubID: id})
}

// addLive passes on what is being written. It is kept until it becomes a message, for whoever connects meanwhile.
func (e *Engine) addLive(id string, r *run, text string) {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.runs[id] != r {
		return
	}
	e.live[id] += text
	e.publish(Event{Type: "delta", SubID: id, Text: text})
}

func clip(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n]) + "…"
}

// onSubReply records a reply and its cost; reaching the task's limit stops everyone on it and asks the user.
func (e *Engine) onSubReply(in subRun, tr *turn, calls *int) func(model.ModelReply) bool {
	return func(reply model.ModelReply) bool {
		*calls++
		goOn := false
		e.apply(in, func(t *model.Task, s *model.SubTask) {
			e.w.Conversations[s.ID] = append(e.w.Conversations[s.ID], model.Message{Role: enum.RoleAssistant, Content: reply.Content})
			e.dirty[s.ID] = true
			if !talking(s) {
				s.Progress = min(0.95, float64(*calls)/float64(*calls+4))
			}
			for _, b := range reply.Content {
				if b.Type == enum.BlockText && !in.talk {
					e.logLine(s, enum.LogSay, b.Text, "", nil)
				}
			}
			if in.spec.price != nil {
				s.CostUSD += cost(reply.Usage, *in.spec.price)
			} else if !in.spec.subscription && !s.Unpriced {
				s.Unpriced = true
				e.logLine(s, enum.LogSystem, i18n.T("模型 %s 沒有設定價格，費用不列入上限", in.spec.model), "", nil)
			}
			goOn = true
			if !talking(s) && e.taskCost(t) >= e.costLimit(t) {
				for _, o := range e.subsOf(t.ID) {
					if o.ID != s.ID && o.Status == enum.StatusProgressing {
						e.stopRun(o.ID)
						o.Status = enum.StatusTodo
						e.logLine(o, enum.LogSystem, i18n.T("費用達到上限，暫停執行"), "budgetHold", nil)
					}
				}
				e.openReview(t, s, model.Review{Kind: enum.ReviewBudget, Options: []model.ReviewOption{{ID: "addBudget"}, {ID: "pauseTask"}}})
				goOn = false
			}
		})
		return goOn
	}
}

func cost(u model.ModelUsage, p model.ModelPrice) float64 {
	fresh := max(u.Input-u.CacheRead, 0)
	return (float64(fresh)*p.Input + float64(u.Output)*p.Output + float64(u.CacheRead)*p.CacheRead) / 1e6
}

// agentTools are what every working employee has, beyond what the blueprint allows.
func (e *Engine) agentTools(in subRun) []adapter.Tool {
	handoffSchema := `{"type":"object","properties":{` +
		`"goal":{"type":"string"},"done":{"type":"array","items":{"type":"string"}},"outputs":{"type":"array","items":{"type":"string"},"description":"Files changed. Each item is the file's path from the repo root, then ' — ' and what it is, for example: docs/spec.md — the spec"},` +
		`"decisions":{"type":"array","items":{"type":"string"}},"open":{"type":"array","items":{"type":"string"}},` +
		`"next_node":{"type":"string","description":"When picking one next step: its id. Empty leaves the choice to the user."},"next_reason":{"type":"string"},` +
		`"headline":{"type":"string","description":"One sentence for the user: the conclusion"},"did":{"type":"array","items":{"type":"string"},"description":"For the user: what was done"},"ask":{"type":"string","description":"For the user: anything they need to decide"},` +
		`"learned":{"type":"array","items":{"type":"string"},"description":"Optional, and most steps have none: project conventions, pitfalls or user preferences that later tasks need. Not task progress or one-off decisions."}` +
		`},"required":["goal","done","headline","did"]}`
	out := []adapter.Tool{
		funcTool{model.ToolSpec{Name: "submit_handoff", Description: "Finish this step: commit the work and hand off to the next step.", Parameters: json.RawMessage(handoffSchema)}, e.submitHandoff(in)},
		funcTool{model.ToolSpec{Name: toolAskUser, Description: "Stop and ask the user to decide. Work resumes with their answer.",
			Parameters: json.RawMessage(`{"type":"object","properties":{"prompt":{"type":"string"},"options":{"type":"array","items":{"type":"string"}}},"required":["prompt"]}`)}, e.askUser(in)},
		funcTool{model.ToolSpec{Name: "remember", Description: "Keep something useful for later tasks in this company: project conventions, pitfalls, the user's preferences. Not task progress.",
			Parameters: json.RawMessage(`{"type":"object","properties":{"text":{"type":"string"}},"required":["text"]}`)}, e.rememberTool(in)},
		funcTool{model.ToolSpec{Name: "forget", Description: "Remove a note from your memory by its id, because it is wrong or out of date.",
			Parameters: json.RawMessage(`{"type":"object","properties":{"id":{"type":"string"}},"required":["id"]}`)}, e.forgetTool(in)},
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	if s, t := e.w.SubTasks[in.subID], e.w.Tasks[in.taskID]; s != nil && t != nil && e.maySendBack(t, s) {
		out = append(out, funcTool{model.ToolSpec{Name: "send_back", Description: "The work does not pass: commit what is here and send it back to the steps before this one, to redo.",
			Parameters: json.RawMessage(`{"type":"object","properties":{"reason":{"type":"string"}},"required":["reason"]}`)}, e.sendBackTool(in)})
	}
	return out
}

func toolError(format string, args ...any) model.ToolResult {
	return model.ToolResult{Text: fmt.Sprintf(format, args...), IsError: true}
}

func (e *Engine) submitHandoff(in subRun) func(context.Context, string, json.RawMessage) model.ToolResult {
	return func(ctx context.Context, cwd string, raw json.RawMessage) model.ToolResult {
		var a struct {
			Goal       string   `json:"goal"`
			Done       []string `json:"done"`
			Outputs    []string `json:"outputs"`
			Decisions  []string `json:"decisions"`
			Open       []string `json:"open"`
			NextNode   string   `json:"next_node"`
			NextReason string   `json:"next_reason"`
			Headline   string   `json:"headline"`
			Did        []string `json:"did"`
			Ask        string   `json:"ask"`
			Learned    []string `json:"learned"`
		}
		if err := json.Unmarshal(raw, &a); err != nil || strings.TrimSpace(a.Goal) == "" || strings.TrimSpace(a.Headline) == "" {
			return toolError("goal and headline are required")
		}
		// checked before committing, so a wrong id costs nothing
		badNext := false
		e.mu.Lock()
		if t := e.w.Tasks[in.taskID]; t != nil && a.NextNode != "" {
			if s := e.w.SubTasks[in.subID]; s != nil {
				badNext = !slices.ContainsFunc(outEdges(&t.Workflow, s.NodeID), func(x model.WorkflowEdge) bool { return x.To == a.NextNode })
			}
		}
		e.mu.Unlock()
		if badNext {
			return toolError("%s is not a next step of this one", a.NextNode)
		}
		commit, err := e.git.Commit(ctx, cwd, in.spec.name, in.label+": "+a.Headline)
		if err != nil {
			e.log.Warn().Err(err).Str("sub", in.subID).Msg("commit handoff")
			return toolError("commit failed: %v; fix it and call submit_handoff again", err)
		}
		e.apply(in, func(t *model.Task, s *model.SubTask) {
			h := &model.Handoff{Commit: commit,
				Agent: model.AgentHandoff{Goal: a.Goal, Done: orEmpty(a.Done), Outputs: orEmpty(a.Outputs), Decisions: orEmpty(a.Decisions), Open: orEmpty(a.Open)},
				Human: model.HumanSummary{Headline: a.Headline, Did: orEmpty(a.Did), Outputs: orEmpty(a.Outputs), Ask: a.Ask},
			}
			if a.NextNode != "" && len(s.RoutedTo) == 0 {
				s.RoutedTo = []string{a.NextNode}
				h.Agent.Next = &model.NextStep{NodeID: a.NextNode, Reason: a.NextReason}
			}
			s.Handoff = h
			for _, text := range a.Learned {
				e.keepNote(t, s, text)
			}
			e.finish(t, s, commit)
		})
		return model.ToolResult{Stop: true}
	}
}

func (e *Engine) finish(_ *model.Task, s *model.SubTask, commit string) {
	s.Status = enum.StatusComplete
	s.Progress = 1
	s.EndedAt = ptr(e.w.Now)
	e.logLine(s, enum.LogSystem, i18n.T("完成，commit %s", commit), "done", map[string]any{"commit": commit})
}

func orEmpty(items []string) []string {
	if items == nil {
		return []string{}
	}
	return items
}

func (e *Engine) askUser(in subRun) func(context.Context, string, json.RawMessage) model.ToolResult {
	return func(_ context.Context, _ string, raw json.RawMessage) model.ToolResult {
		var a struct {
			Prompt  string   `json:"prompt"`
			Options []string `json:"options"`
		}
		if err := json.Unmarshal(raw, &a); err != nil || strings.TrimSpace(a.Prompt) == "" {
			return toolError("prompt is required")
		}
		e.apply(in, func(t *model.Task, s *model.SubTask) {
			options := make([]model.ReviewOption, len(a.Options))
			for i, label := range a.Options {
				options[i] = model.ReviewOption{ID: fmt.Sprintf("opt%d", i), Label: label}
			}
			e.openReview(t, s, model.Review{Kind: enum.ReviewQuestion, Prompt: a.Prompt, Options: options})
		})
		return model.ToolResult{Stop: true}
	}
}

func (e *Engine) rememberTool(in subRun) func(context.Context, string, json.RawMessage) model.ToolResult {
	return func(_ context.Context, _ string, raw json.RawMessage) model.ToolResult {
		var a struct {
			Text string `json:"text"`
		}
		if err := json.Unmarshal(raw, &a); err != nil || strings.TrimSpace(a.Text) == "" {
			return toolError("text is required")
		}
		e.apply(in, func(t *model.Task, s *model.SubTask) {
			e.keepNote(t, s, a.Text)
		})
		return model.ToolResult{Text: "remembered"}
	}
}

// keepNote saves what an employee wrote down and logs it, skipping blanks and repeats.
func (e *Engine) keepNote(t *model.Task, s *model.SubTask, text string) {
	text = strings.TrimSpace(text)
	if text != "" && e.remember(s.ReplicaID, text, "work", t.ID) {
		e.logLine(s, enum.LogSystem, i18n.T("寫入記憶：%s", text), "memory", map[string]any{"text": text})
	}
}

func (e *Engine) forgetTool(in subRun) func(context.Context, string, json.RawMessage) model.ToolResult {
	return func(_ context.Context, _ string, raw json.RawMessage) model.ToolResult {
		var a struct {
			ID string `json:"id"`
		}
		if err := json.Unmarshal(raw, &a); err != nil || a.ID == "" {
			return toolError("id is required")
		}
		found := false
		e.apply(in, func(_ *model.Task, s *model.SubTask) {
			text, ok := e.forget(s.ReplicaID, a.ID)
			if found = ok; ok {
				e.logLine(s, enum.LogSystem, i18n.T("移除記憶：%s", text), "forget", map[string]any{"text": text})
			}
		})
		if !found {
			return toolError("no note with id %s", a.ID)
		}
		return model.ToolResult{Text: "forgotten"}
	}
}

func (e *Engine) sendBackTool(in subRun) func(context.Context, string, json.RawMessage) model.ToolResult {
	return func(ctx context.Context, cwd string, raw json.RawMessage) model.ToolResult {
		var a struct {
			Reason string `json:"reason"`
		}
		if err := json.Unmarshal(raw, &a); err != nil || strings.TrimSpace(a.Reason) == "" {
			return toolError("reason is required")
		}
		commit, err := e.git.Commit(ctx, cwd, in.spec.name, in.label+i18n.T("：退回"))
		if err != nil {
			return toolError("commit failed: %v", err)
		}
		e.apply(in, func(t *model.Task, s *model.SubTask) {
			s.SendBackReason = a.Reason
			s.Handoff = &model.Handoff{Commit: commit,
				Agent: model.AgentHandoff{Goal: t.Title, Done: []string{}, Outputs: []string{}, Decisions: []string{}, Open: []string{a.Reason}},
				Human: model.HumanSummary{Headline: i18n.T("退回：%s", a.Reason), Did: []string{}, Outputs: []string{}},
			}
			e.finish(t, s, commit)
		})
		return model.ToolResult{Stop: true}
	}
}
