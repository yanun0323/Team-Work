package usecase_test

import (
	"bytes"
	"context"
	"encoding/json"
	"image"
	"image/color"
	"image/png"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/rs/zerolog"

	"github.com/yanun0323/Team-Work/internal/adapter"
	"github.com/yanun0323/Team-Work/internal/model"
	"github.com/yanun0323/Team-Work/internal/model/enum"
	"github.com/yanun0323/Team-Work/internal/repository"
	"github.com/yanun0323/Team-Work/internal/usecase"
)

// script is a fake model: each call takes the next reply, given what the model was just told.
type script struct {
	mu        sync.Mutex
	reply     func(req model.ModelRequest) (model.ModelReply, error)
	seen      []model.ModelRequest
	login     *adapter.LoginFlow
	loggedOut bool
	models    []model.ModelSpec
	// midway runs after a reply's text went out, before the reply is done.
	midway func()
}

func (s *script) Complete(_ context.Context, req model.ModelRequest, onText func(string)) (model.ModelReply, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.seen = append(s.seen, req)
	r, err := s.reply(req)
	for _, b := range r.Content {
		if b.Type == enum.BlockText {
			onText(b.Text)
		}
	}
	if s.midway != nil {
		s.midway()
	}
	return r, err
}

func (s *script) Models(context.Context) ([]model.ModelSpec, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.models != nil {
		return s.models, nil
	}
	return []model.ModelSpec{{ID: "fake", Thinking: []string{"low", "high"}}}, nil
}
func (s *script) For(model.ModelProvider, string) (adapter.Provider, error) {
	return s, nil
}
func (s *script) Images(p model.ModelProvider) (adapter.ImageMaker, error) {
	if !model.MakesImages(p) || !p.Auth.SignedIn {
		return nil, model.Errorf(model.CodeInvalid, "no images")
	}
	return s, nil
}

// MakeImage draws one white pixel.
func (s *script) MakeImage(context.Context, string, []string, bool) ([]byte, error) {
	var out bytes.Buffer
	pic := image.NewNRGBA(image.Rect(0, 0, 1, 1))
	pic.Set(0, 0, color.White)
	err := png.Encode(&out, pic)
	return out.Bytes(), err
}
func (s *script) Login(context.Context, model.ModelProvider, string) (*adapter.LoginFlow, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.login, nil
}
func (s *script) Logout(context.Context, model.ModelProvider) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.loggedOut = true
	return nil
}

func call(name string, args any) model.ModelReply {
	raw, _ := json.Marshal(args)
	return model.ModelReply{Content: []model.Block{{Type: enum.BlockToolCall, ID: name + "-1", Name: name, Args: raw}}, Usage: model.ModelUsage{Input: 1000, Output: 1000}}
}

func say(text string) model.ModelReply {
	return model.ModelReply{Content: []model.Block{{Type: enum.BlockText, Text: text}}}
}

var handoff = map[string]any{"goal": "g", "done": []string{"d"}, "headline": "h", "did": []string{"x"}}

// stepOf reads which step a request is for, from the system prompt.
func stepOf(req model.ModelRequest) string {
	_, rest, _ := strings.Cut(req.System, "# This step: ")
	name, _, _ := strings.Cut(rest, "\n")
	return name
}

func lastIsResult(req model.ModelRequest) bool {
	last := req.Messages[len(req.Messages)-1]
	return len(last.Content) > 0 && last.Content[0].Type == enum.BlockToolResult
}

func gitOut(t *testing.T, dir string, args ...string) string {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %v: %v\n%s", args, err, out)
	}
	return strings.TrimSpace(string(out))
}

type rig struct {
	t      *testing.T
	e      *usecase.Engine
	fake   *script
	store  *repository.Store
	data   string
	folder string
	team   *model.Team
	owner  *model.Replica
	flow   *model.Workflow
}

func newEngine(t *testing.T, r *rig) {
	t.Helper()
	store, err := repository.NewStore(r.data)
	if err != nil {
		t.Fatal(err)
	}
	e, err := usecase.NewEngine(context.Background(), usecase.Options{
		Store: store, Git: repository.NewGit(r.data), Providers: r.fake, DataDir: r.data, Log: zerolog.Nop(),
	})
	if err != nil {
		t.Fatal(err)
	}
	r.e, r.store = e, store
	t.Cleanup(func() { e.Close(); store.Close() })
}

func newRig(t *testing.T, reply func(model.ModelRequest) (model.ModelReply, error)) *rig {
	t.Helper()
	r := &rig{t: t, fake: &script{reply: reply}, data: t.TempDir(), folder: t.TempDir()}
	newEngine(t, r)
	ctx := context.Background()
	team, err := r.e.CreateTeam(ctx, usecase.NewTeam{Name: "公司", Folder: r.folder})
	if err != nil {
		t.Fatal(err)
	}
	r.team = team
	if _, err := r.e.AddProvider(ctx, usecase.NewProvider{Name: "p", Kind: enum.ProviderCompatible, Login: usecase.ProviderLogin{Kind: "apiKey", APIKey: "sk-secret-1234"},
		Prices: map[string]model.ModelPrice{"fake": {Input: 1, Output: 1}}}); err != nil {
		t.Fatal(err)
	}
	bp, err := r.e.CreateBlueprint(model.Blueprint{Name: "Dev", Prompt: "你是開發者", Tools: []enum.Tool{enum.ToolReadFile, enum.ToolWriteFile, enum.ToolRunCommand}})
	if err != nil {
		t.Fatal(err)
	}
	owner, err := r.e.Hire(usecase.NewReplica{TeamID: team.ID, BlueprintID: bp.ID, Name: "Ada", Model: "fake"})
	if err != nil {
		t.Fatal(err)
	}
	r.owner = owner
	// 整理需求 then 驗收 on the app's templates, both worked by the owner, so a test's task needs no staff
	plain, err := r.e.CreateWorkflow("只有頭尾")
	if err != nil {
		t.Fatal(err)
	}
	step := func(id, name, prompt string) model.WorkflowNode {
		return model.WorkflowNode{ID: id, Kind: enum.NodeWork, Name: name, Prompt: prompt, ReplicaIDs: []string{owner.ID},
			Handoff: enum.HandoffAll, Join: enum.JoinAll}
	}
	plain.Nodes = []model.WorkflowNode{step("start", "整理需求", usecase.StartPrompt), step("end", "驗收", usecase.EndPrompt)}
	plain.Nodes[1].SendBack = ptrTo(true)
	plain.Edges = []model.WorkflowEdge{{ID: "e", From: "start", To: "end"}}
	if err := r.e.SaveWorkflow(plain.ID, *plain); err != nil {
		t.Fatal(err)
	}
	r.flow = r.world().Workflows[plain.ID]
	return r
}

func (r *rig) world() *model.World {
	r.t.Helper()
	raw, err := r.e.Snapshot()
	if err != nil {
		r.t.Fatal(err)
	}
	w := model.NewWorld()
	if err := json.Unmarshal(raw, w); err != nil {
		r.t.Fatal(err)
	}
	return w
}

func (r *rig) wait(what string, ok func(*model.World) bool) *model.World {
	r.t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		if w := r.world(); ok(w) {
			return w
		}
		time.Sleep(5 * time.Millisecond)
	}
	raw, _ := r.e.Snapshot()
	r.t.Fatalf("timed out waiting for %s\n%s", what, raw)
	return nil
}

// task makes a task and starts it, as the user does with the start button.
func (r *rig) task(wfID string) *model.Task {
	r.t.Helper()
	return r.start(r.e.CreateTask(usecase.NewTask{TeamID: r.team.ID, Title: "加功能", Description: "說明", WorkflowID: wfID, OwnerID: &r.owner.ID}))
}

// start starts a task just made, which waits in 待辦 until then.
func (r *rig) start(task *model.Task, err error) *model.Task {
	r.t.Helper()
	if err != nil {
		r.t.Fatal(err)
	}
	if err := r.e.ResumeTask(task.ID); err != nil {
		r.t.Fatal(err)
	}
	return r.world().Tasks[task.ID]
}

func stage(id string, want enum.TaskStage) func(*model.World) bool {
	return func(w *model.World) bool { return w.Tasks[id] != nil && w.Tasks[id].Stage == want }
}

func subAt(w *model.World, taskID, nodeName string) *model.SubTask {
	var found *model.SubTask
	task := w.Tasks[taskID]
	for _, s := range w.SubTasks {
		if s.TaskID != taskID || (found != nil && s.CreatedAt < found.CreatedAt) {
			continue
		}
		for _, n := range task.Workflow.Nodes {
			if n.ID == s.NodeID && n.Name == nodeName {
				found = s
			}
		}
	}
	return found
}

func TestTaskRunsToMergeOnRealGit(t *testing.T) {
	r := newRig(t, func(req model.ModelRequest) (model.ModelReply, error) {
		if lastIsResult(req) {
			return call("submit_handoff", handoff), nil
		}
		if stepOf(req) == "Clarify requirements" {
			return call("write_file", map[string]string{"path": "feature.txt", "content": "new\n"}), nil
		}
		return call("submit_handoff", handoff), nil
	})
	task := r.task(r.flow.ID)
	w := r.wait("await merge", stage(task.ID, enum.StageAwaitMerge))

	first := subAt(w, task.ID, "整理需求")
	if first.Handoff == nil || first.Handoff.Commit == "" {
		t.Fatalf("no commit in handoff: %+v", first.Handoff)
	}
	if first.CostUSD <= 0 {
		t.Fatal("cost was not counted")
	}
	if first.Tokens <= 0 {
		t.Fatal("tokens were not counted")
	}
	// the review step was told what came from upstream
	last := r.fake.seen[len(r.fake.seen)-1]
	if !strings.Contains(last.Messages[0].Content[0].Text, `Handoff from "Clarify requirements"`) {
		t.Fatalf("no upstream handoff in: %s", last.Messages[0].Content[0].Text)
	}
	if _, err := os.Stat(filepath.Join(r.folder, "feature.txt")); err == nil {
		t.Fatal("the target branch changed before the user merged")
	}

	if err := r.e.MergeTask(task.ID); err != nil {
		t.Fatal(err)
	}
	r.wait("done", stage(task.ID, enum.StageDone))
	if _, err := os.Stat(filepath.Join(r.folder, "feature.txt")); err != nil {
		t.Fatal("the work did not land in the target branch")
	}
	if got := gitOut(t, r.folder, "branch", "--list", "task/1"); got != "" {
		t.Fatalf("branch left behind: %s", got)
	}
}

func TestQuestionResumesWithTheAnswer(t *testing.T) {
	asked := false
	r := newRig(t, func(req model.ModelRequest) (model.ModelReply, error) {
		if !asked {
			asked = true
			return call("ask_user", map[string]any{"prompt": "用哪個？", "options": []string{"A", "B"}}), nil
		}
		return call("submit_handoff", handoff), nil
	})
	task := r.task(r.flow.ID)
	w := r.wait("question", func(w *model.World) bool {
		s := subAt(w, task.ID, "整理需求")
		return s != nil && s.Review != nil
	})
	sub := subAt(w, task.ID, "整理需求")
	if sub.Review.Kind != enum.ReviewQuestion || len(sub.Review.Options) != 2 {
		t.Fatalf("review = %+v", sub.Review)
	}
	if err := r.e.ResolveReview(sub.ID, "nope", ""); err == nil {
		t.Fatal("an option that does not exist was accepted")
	}
	if err := r.e.ResolveReview(sub.ID, "opt1", "比較快"); err != nil {
		t.Fatal(err)
	}
	w = r.wait("await merge", stage(task.ID, enum.StageAwaitMerge))
	found := false
	for _, req := range r.fake.seen {
		for _, m := range req.Messages {
			for _, b := range m.Content {
				found = found || (b.Type == enum.BlockToolResult && b.Name == "ask_user" && strings.Contains(b.Text, "B") && strings.Contains(b.Text, "比較快"))
			}
		}
	}
	if !found {
		t.Fatal("the model was never told the answer")
	}
	if got := w.Replicas[r.owner.ID].Memory; len(got) != 0 {
		t.Fatalf("a one-off answer went into memory: %v", got)
	}
}

func TestPickOneAskingAndFailureReview(t *testing.T) {
	var fail bool
	r := newRig(t, func(req model.ModelRequest) (model.ModelReply, error) {
		if fail && stepOf(req) == "乙" {
			return model.ModelReply{}, model.Errorf(model.CodeInvalid, "模型壞了")
		}
		return call("submit_handoff", handoff), nil
	})
	fail = true
	wf := *r.flow
	start, end := wf.Nodes[0].ID, wf.Nodes[1].ID
	wf.Nodes[0].Handoff = enum.HandoffPickOne
	node := func(id, name string) model.WorkflowNode {
		return model.WorkflowNode{ID: id, Kind: enum.NodeWork, Name: name, Prompt: "做", ReplicaIDs: []string{r.owner.ID}, Handoff: enum.HandoffAll, Join: enum.JoinAny}
	}
	wf.Nodes = append(wf.Nodes[:1], node("a", "甲"), node("b", "乙"), wf.Nodes[1])
	wf.Edges = []model.WorkflowEdge{{ID: "1", From: start, To: "a", Condition: "簡單"}, {ID: "2", From: start, To: "b", Condition: "困難"}, {ID: "3", From: "a", To: end}, {ID: "4", From: "b", To: end}}
	if err := r.e.SaveWorkflow(wf.ID, wf); err != nil {
		t.Fatal(err)
	}
	task := r.task(wf.ID)
	w := r.wait("route question", func(w *model.World) bool {
		s := subAt(w, task.ID, "整理需求")
		return s != nil && s.Review != nil
	})
	sub := subAt(w, task.ID, "整理需求")
	if sub.Review.Kind != enum.ReviewPickRoute {
		t.Fatalf("review = %+v", sub.Review)
	}
	if err := r.e.ResolveReview(sub.ID, "b", ""); err != nil {
		t.Fatal(err)
	}
	// retries once by the company's setting, then asks
	w = r.wait("failure review", func(w *model.World) bool {
		s := subAt(w, task.ID, "乙")
		return s != nil && s.Review != nil
	})
	failed := subAt(w, task.ID, "乙")
	if failed.Review.Kind != enum.ReviewFailed || failed.Attempts != 2 {
		t.Fatalf("attempts %d review %+v", failed.Attempts, failed.Review)
	}
	if subAt(w, task.ID, "甲") != nil {
		t.Fatal("the step not picked ran")
	}
	if err := r.e.ResolveReview(failed.ID, "skip", ""); err != nil {
		t.Fatal(err)
	}
	r.wait("await merge", stage(task.ID, enum.StageAwaitMerge))
}

// Steps with nothing before them all start the task, each from its description; it ends once every last step is done.
func TestSeveralStartsAndEnds(t *testing.T) {
	r := newRig(t, func(model.ModelRequest) (model.ModelReply, error) { return call("submit_handoff", handoff), nil })
	node := func(id, name string) model.WorkflowNode {
		return model.WorkflowNode{ID: id, Kind: enum.NodeWork, Name: name, Prompt: "做", ReplicaIDs: []string{r.owner.ID}, Handoff: enum.HandoffAll, Join: enum.JoinAll}
	}
	wf := *r.flow
	wf.Nodes = []model.WorkflowNode{node("a", "甲"), node("b", "乙"), node("j", "合"), node("c", "丙")}
	wf.Edges = []model.WorkflowEdge{{ID: "1", From: "a", To: "j"}, {ID: "2", From: "b", To: "j"}, {ID: "3", From: "a", To: "c"}}
	if err := r.e.SaveWorkflow(wf.ID, wf); err != nil {
		t.Fatal(err)
	}
	task := r.task(wf.ID)
	w := r.wait("await merge", stage(task.ID, enum.StageAwaitMerge))
	for _, name := range []string{"甲", "乙"} {
		if s := subAt(w, task.ID, name); s == nil || len(s.UpstreamIDs) != 0 {
			t.Fatalf("%s: %+v", name, s)
		}
	}
	if j := subAt(w, task.ID, "合"); j == nil || len(j.UpstreamIDs) != 2 || j.Status != enum.StatusComplete {
		t.Fatalf("%+v", j)
	}
	if c := subAt(w, task.ID, "丙"); c == nil || c.Status != enum.StatusComplete {
		t.Fatalf("%+v", c)
	}
	runs := 0
	for _, s := range w.SubTasks {
		if s.TaskID == task.ID {
			runs++
		}
	}
	if runs != 4 {
		t.Fatalf("%d runs", runs)
	}
}

// A last step switched off from sending back gets no send_back; with the switch unset it has it, as before.
func TestSendBackSwitch(t *testing.T) {
	var mu sync.Mutex
	tools := map[string][]string{}
	r := newRig(t, func(req model.ModelRequest) (model.ModelReply, error) {
		mu.Lock()
		tools[stepOf(req)] = toolsOf(req)
		mu.Unlock()
		return call("submit_handoff", handoff), nil
	})
	for _, on := range []*bool{ptrTo(false), nil} {
		wf := *r.flow
		wf.Nodes = slices.Clone(wf.Nodes)
		wf.Nodes[1].SendBack = on
		if err := r.e.SaveWorkflow(wf.ID, wf); err != nil {
			t.Fatal(err)
		}
		task := r.task(wf.ID)
		r.wait("await merge", stage(task.ID, enum.StageAwaitMerge))
		mu.Lock()
		got := slices.Contains(tools["Acceptance review"], "send_back")
		mu.Unlock()
		if got != (on == nil) {
			t.Fatalf("switch %v: send_back %v", on, got)
		}
	}
}

func TestHandedFileReadsTheCommit(t *testing.T) {
	r := newRig(t, func(req model.ModelRequest) (model.ModelReply, error) {
		if lastIsResult(req) {
			return call("submit_handoff", handoff), nil
		}
		if stepOf(req) == "Clarify requirements" {
			return call("write_file", map[string]string{"path": "docs/spec.md", "content": "# 真的內容\n"}), nil
		}
		return call("submit_handoff", handoff), nil
	})
	task := r.task(r.flow.ID)
	w := r.wait("await merge", stage(task.ID, enum.StageAwaitMerge))
	sub := subAt(w, task.ID, "整理需求")
	ctx := context.Background()
	text, err := r.e.HandedFile(ctx, sub.ID, "docs/spec.md")
	if err != nil || text != "# 真的內容" {
		t.Fatalf("text %q err %v", text, err)
	}
	for _, path := range []string{"missing.md", "docs", "../secret", "/etc/hosts", "--help", ""} {
		if _, err := r.e.HandedFile(ctx, sub.ID, path); err == nil {
			t.Errorf("%q read", path)
		}
	}
}

func TestEveryStepSeesItsNeighbours(t *testing.T) {
	var mu sync.Mutex
	systems := map[string]string{}
	r := newRig(t, func(req model.ModelRequest) (model.ModelReply, error) {
		mu.Lock()
		systems[stepOf(req)] = req.System
		mu.Unlock()
		if stepOf(req) == "討論" {
			return say("想問你一件事"), nil
		}
		return call("submit_handoff", handoff), nil
	})
	wf := *r.flow
	start, end := wf.Nodes[0].ID, wf.Nodes[1].ID
	node := func(id, kind, name, prompt string) model.WorkflowNode {
		return model.WorkflowNode{ID: id, Kind: enum.NodeKind(kind), Name: name, Prompt: prompt, ReplicaIDs: []string{r.owner.ID}, Handoff: enum.HandoffAll, Join: enum.JoinAll}
	}
	wf.Nodes = append(wf.Nodes, node("work", string(enum.NodeWork), "寫碼", "寫碼的指示"), node("talk", string(enum.NodeTalk), "討論", usecase.TalkPrompt))
	wf.Edges = []model.WorkflowEdge{{ID: "1", From: start, To: "work"}, {ID: "2", From: "work", To: "talk"}, {ID: "3", From: "talk", To: end}}
	if err := r.e.SaveWorkflow(wf.ID, wf); err != nil {
		t.Fatal(err)
	}
	task := r.task(wf.ID)
	r.wait("discussion", func(w *model.World) bool {
		s := subAt(w, task.ID, "討論")
		return s != nil && s.Review != nil
	})
	mu.Lock()
	defer mu.Unlock()
	for step, wants := range map[string][]string{
		"寫碼": {"- Clarify requirements: " + usecase.StartPrompt, "- 討論 (id: talk): " + usecase.TalkPrompt},
		"討論": {"- 寫碼: 寫碼的指示", "- Acceptance review: " + usecase.EndPrompt},
	} {
		for _, want := range wants {
			if !strings.Contains(systems[step], want) {
				t.Errorf("%s does not see %q", step, want)
			}
		}
	}
	if strings.Contains(systems["整理需求"], "# 上一步") {
		t.Error("the first step has nothing before it")
	}
}

func TestBudgetStopsTheRun(t *testing.T) {
	r := newRig(t, func(model.ModelRequest) (model.ModelReply, error) { return call("submit_handoff", handoff), nil })
	limit := model.TeamSettings{TimeoutMin: 1, CostLimitUSD: 0.001, Retries: 0}
	if err := r.e.UpdateTeam(r.team.ID, usecase.TeamPatch{Settings: &limit}); err != nil {
		t.Fatal(err)
	}
	task := r.task(r.flow.ID)
	w := r.wait("budget", func(w *model.World) bool {
		s := subAt(w, task.ID, "整理需求")
		return s != nil && s.Review != nil
	})
	s := subAt(w, task.ID, "整理需求")
	if s.Review.Kind != enum.ReviewBudget || s.Handoff != nil {
		t.Fatalf("review %+v handoff %+v", s.Review, s.Handoff)
	}
	if err := r.e.ResolveReview(s.ID, "addBudget", ""); err != nil {
		t.Fatal(err)
	}
	r.wait("budget raised", func(w *model.World) bool { return w.Tasks[task.ID].BudgetBonus > 0 })
}

func TestDiscussion(t *testing.T) {
	r := newRig(t, func(req model.ModelRequest) (model.ModelReply, error) {
		if stepOf(req) == "討論" {
			if len(req.Messages) > 1 {
				return say("了解"), nil
			}
			return say("想問你一件事"), nil
		}
		return call("submit_handoff", handoff), nil
	})
	wf := *r.flow
	start, end := wf.Nodes[0].ID, wf.Nodes[1].ID
	wf.Nodes = append(wf.Nodes[:1], model.WorkflowNode{ID: "talk", Kind: enum.NodeTalk, Name: "討論", Prompt: usecase.TalkPrompt, ReplicaIDs: []string{r.owner.ID}, Handoff: enum.HandoffAll, Join: enum.JoinAll}, wf.Nodes[1])
	wf.Edges = []model.WorkflowEdge{{ID: "1", From: start, To: "talk"}, {ID: "2", From: "talk", To: end}}
	if err := r.e.SaveWorkflow(wf.ID, wf); err != nil {
		t.Fatal(err)
	}
	task := r.task(wf.ID)
	w := r.wait("discussion", func(w *model.World) bool {
		s := subAt(w, task.ID, "討論")
		return s != nil && s.Review != nil
	})
	s := subAt(w, task.ID, "討論")
	if s.Talk.Messages[0].Text != "想問你一件事" {
		t.Fatalf("talk = %+v", s.Talk)
	}
	if err := r.e.SayInTalk(s.ID, "用 A", nil); err != nil {
		t.Fatal(err)
	}
	r.wait("reply", func(w *model.World) bool {
		x := w.SubTasks[s.ID]
		return len(x.Talk.Messages) == 3 && x.Talk.ReplyAt == nil
	})
	if err := r.e.EndTalk(s.ID, model.TalkEnd{Kind: "back"}); err == nil {
		t.Fatal("sending back without a reason was accepted")
	}
	if err := r.e.EndTalk(s.ID, model.TalkEnd{Kind: "continue"}); err != nil {
		t.Fatal(err)
	}
	w = r.wait("await merge", stage(task.ID, enum.StageAwaitMerge))
	if d := w.SubTasks[s.ID].Handoff.Agent.Decisions; len(d) != 1 || d[0] != "User: 用 A" {
		t.Fatalf("decisions = %v", d)
	}
}

func TestSendBackThenPass(t *testing.T) {
	sent := false
	r := newRig(t, func(req model.ModelRequest) (model.ModelReply, error) {
		if stepOf(req) == "Acceptance review" && !sent {
			sent = true
			return call("send_back", map[string]string{"reason": "少了測試"}), nil
		}
		return call("submit_handoff", handoff), nil
	})
	task := r.task(r.flow.ID)
	w := r.wait("await merge", stage(task.ID, enum.StageAwaitMerge))
	count := 0
	reworked := false
	for _, s := range w.SubTasks {
		if s.TaskID == task.ID {
			count++
			reworked = reworked || (s.Rework != nil && s.Rework.Reason == "少了測試")
		}
	}
	if count != 4 || !reworked {
		t.Fatalf("runs = %d, reworked = %v", count, reworked)
	}
}

func TestMergeConflictIsResolvedByTheOwner(t *testing.T) {
	r := newRig(t, nil)
	var folder = r.folder
	r.fake.mu.Lock()
	r.fake.reply = func(req model.ModelRequest) (model.ModelReply, error) {
		if strings.Contains(req.System, "merging a task branch") && stepOf(req) == "" {
			if lastIsResult(req) {
				return say("留下雙方"), nil
			}
			return call("write_file", map[string]string{"path": "f.txt", "content": "both\n"}), nil
		}
		if stepOf(req) == "Clarify requirements" && !lastIsResult(req) {
			return call("write_file", map[string]string{"path": "f.txt", "content": "task\n"}), nil
		}
		return call("submit_handoff", handoff), nil
	}
	r.fake.mu.Unlock()
	task := r.task(r.flow.ID)
	r.wait("await merge", stage(task.ID, enum.StageAwaitMerge))
	if err := os.WriteFile(filepath.Join(folder, "f.txt"), []byte("target\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	gitOut(t, folder, "add", "-A")
	gitOut(t, folder, "-c", "user.name=me", "-c", "user.email=me@x", "commit", "-m", "moved on")
	if err := r.e.MergeTask(task.ID); err != nil {
		t.Fatal(err)
	}
	w := r.wait("done", stage(task.ID, enum.StageDone))
	if !w.Tasks[task.ID].Merge.Conflict {
		t.Fatal("no conflict was seen")
	}
	if w.Tasks[task.ID].TokensCarry <= 0 {
		t.Fatal("resolving the conflict counted no tokens")
	}
	raw, _ := os.ReadFile(filepath.Join(folder, "f.txt"))
	if string(raw) != "both\n" {
		t.Fatalf("f.txt = %q", raw)
	}
}

func TestMergeLeftUnresolvedCanBeTriedAgain(t *testing.T) {
	resolve := false
	r := newRig(t, nil)
	r.fake.mu.Lock()
	r.fake.reply = func(req model.ModelRequest) (model.ModelReply, error) {
		if stepOf(req) == "" {
			if resolve && !lastIsResult(req) {
				return call("write_file", map[string]string{"path": "f.txt", "content": "both\n"}), nil
			}
			return say("好了"), nil
		}
		if stepOf(req) == "Clarify requirements" && !lastIsResult(req) {
			return call("write_file", map[string]string{"path": "f.txt", "content": "task\n"}), nil
		}
		return call("submit_handoff", handoff), nil
	}
	r.fake.mu.Unlock()
	task := r.task(r.flow.ID)
	r.wait("await merge", stage(task.ID, enum.StageAwaitMerge))
	os.WriteFile(filepath.Join(r.folder, "f.txt"), []byte("target\n"), 0o644)
	gitOut(t, r.folder, "add", "-A")
	gitOut(t, r.folder, "-c", "user.name=me", "-c", "user.email=me@x", "commit", "-m", "moved on")

	if err := r.e.MergeTask(task.ID); err != nil {
		t.Fatal(err)
	}
	// the employee says it is done, but left the markers in: the task comes back and master is untouched
	r.wait("failed merge", func(w *model.World) bool {
		m := w.Tasks[task.ID].Merge
		return w.Tasks[task.ID].Stage == enum.StageAwaitMerge && m != nil && strings.Contains(m.Log[len(m.Log)-1].Text, "沒解完")
	})
	if raw, _ := os.ReadFile(filepath.Join(r.folder, "f.txt")); string(raw) != "target\n" {
		t.Fatalf("master changed: %q", raw)
	}
	r.fake.mu.Lock()
	resolve = true
	r.fake.mu.Unlock()
	if err := r.e.MergeTask(task.ID); err != nil {
		t.Fatal(err)
	}
	w := r.wait("done", stage(task.ID, enum.StageDone))
	if raw, _ := os.ReadFile(filepath.Join(r.folder, "f.txt")); string(raw) != "both\n" {
		t.Fatalf("f.txt = %q", raw)
	}
	if len(w.Tasks[task.ID].Merge.Log) < 5 {
		t.Fatalf("earlier attempt's log lost: %+v", w.Tasks[task.ID].Merge.Log)
	}
}

func TestNewTaskWaitsInTodoUntilStarted(t *testing.T) {
	r := newRig(t, func(model.ModelRequest) (model.ModelReply, error) { return call("submit_handoff", handoff), nil })
	made, err := r.e.CreateTask(usecase.NewTask{TeamID: r.team.ID, Title: "等著", WorkflowID: r.flow.ID, OwnerID: &r.owner.ID})
	if err != nil {
		t.Fatal(err)
	}
	time.Sleep(300 * time.Millisecond)
	w := r.world()
	task := w.Tasks[made.ID]
	if !task.Paused || task.PausedAt != nil || task.PausedStatus != enum.StatusTodo || len(r.fake.requests()) != 0 {
		t.Fatalf("%+v, %d model calls", task, len(r.fake.requests()))
	}
	if err := r.e.ResumeTask(made.ID); err != nil {
		t.Fatal(err)
	}
	w = r.wait("await merge", stage(made.ID, enum.StageAwaitMerge))
	if slices.Contains(w.Tutorial.Actions, "pause") {
		t.Fatal("starting a new task counted as pausing one")
	}
}

func TestPauseStopsTheRunAndResumeContinues(t *testing.T) {
	release := make(chan struct{})
	first := true
	var fake *rig
	r := newRig(t, func(model.ModelRequest) (model.ModelReply, error) { return model.ModelReply{}, nil })
	fake = r
	r.fake.mu.Lock()
	r.fake.reply = func(model.ModelRequest) (model.ModelReply, error) {
		if first {
			first = false
			close(release)
			return call("run_command", map[string]any{"command": "sleep 30"}), nil
		}
		return call("submit_handoff", handoff), nil
	}
	r.fake.mu.Unlock()
	task := r.task(r.flow.ID)
	<-release
	fake.wait("running", func(w *model.World) bool {
		s := subAt(w, task.ID, "整理需求")
		return s != nil && s.Status == enum.StatusProgressing
	})
	started := time.Now()
	if err := r.e.PauseTask(task.ID); err != nil {
		t.Fatal(err)
	}
	w := r.world()
	if s := subAt(w, task.ID, "整理需求"); s.Status != enum.StatusTodo || !w.Tasks[task.ID].Paused {
		t.Fatalf("status %s paused %v", s.Status, w.Tasks[task.ID].Paused)
	}
	if err := r.e.CancelTask("missing"); err == nil {
		t.Fatal("a missing task was cancelled")
	}
	if err := r.e.ResumeTask(task.ID); err != nil {
		t.Fatal(err)
	}
	r.wait("await merge", stage(task.ID, enum.StageAwaitMerge))
	if time.Since(started) > 8*time.Second {
		t.Fatal("the command was not stopped")
	}
}

func TestChangingTheWorkflowKeepsTheTokensSpent(t *testing.T) {
	first := true
	r := newRig(t, func(model.ModelRequest) (model.ModelReply, error) {
		if first {
			first = false
			return call("run_command", map[string]any{"command": "sleep 30"}), nil
		}
		return call("submit_handoff", handoff), nil
	})
	task := r.task(r.flow.ID)
	r.wait("counted", func(w *model.World) bool {
		s := subAt(w, task.ID, "整理需求")
		return s != nil && s.Tokens > 0
	})
	if err := r.e.PauseTask(task.ID); err != nil {
		t.Fatal(err)
	}
	if err := r.e.ChangeWorkflow(task.ID, r.flow.ID); err != nil {
		t.Fatal(err)
	}
	if got := r.world().Tasks[task.ID].TokensCarry; got != 2000 {
		t.Fatalf("carried %d tokens", got)
	}
}

func TestRestartPicksUpWhereItWas(t *testing.T) {
	stuck := make(chan struct{})
	var once sync.Once
	block := true
	r := newRig(t, func(req model.ModelRequest) (model.ModelReply, error) {
		if block {
			once.Do(func() { close(stuck) })
			return call("run_command", map[string]any{"command": "sleep 30"}), nil
		}
		return call("submit_handoff", handoff), nil
	})
	task := r.task(r.flow.ID)
	<-stuck
	r.wait("conversation saved", func(w *model.World) bool {
		s := subAt(w, task.ID, "整理需求")
		return s != nil && len(s.Log) > 2
	})
	r.e.Close()
	r.store.Close()
	r.fake.mu.Lock()
	block = false
	r.fake.mu.Unlock()
	r.fake.seen = nil

	newEngine(t, r)
	r.wait("await merge", stage(task.ID, enum.StageAwaitMerge))
	// the provider key came back too, and the conversation went on rather than starting over
	if len(r.fake.seen) == 0 || len(r.fake.seen[0].Messages) < 3 {
		t.Fatalf("conversation restarted: %+v", r.fake.seen)
	}
	if !lastIsResult(r.fake.seen[0]) {
		t.Fatal("the interrupted call has no result")
	}
}

func TestSubscriptionLogin(t *testing.T) {
	r := newRig(t, func(model.ModelRequest) (model.ModelReply, error) { return call("submit_handoff", handoff), nil })
	ctx := context.Background()
	p, err := r.e.AddProvider(ctx, usecase.NewProvider{Name: "訂閱", Kind: enum.ProviderOpenAI, Login: usecase.ProviderLogin{Kind: "subscription"}})
	if err != nil {
		t.Fatal(err)
	}
	if p.Auth.SignedIn || len(p.Models) != 0 {
		t.Fatalf("%+v", p)
	}
	if _, err := r.e.AddProvider(ctx, usecase.NewProvider{Name: "x", Kind: enum.ProviderGoogle, Login: usecase.ProviderLogin{Kind: "subscription"}}); err == nil {
		t.Fatal("Google subscription accepted")
	}

	// fails, with the reason shown on the provider
	r.fake.mu.Lock()
	r.fake.login = &adapter.LoginFlow{Prompt: model.LoginPrompt{Method: "browser", URL: "https://login"},
		Wait:  func(context.Context) error { return model.Errorf(model.CodeInvalid, "不接受") },
		Paste: func(string) error { return nil }}
	r.fake.mu.Unlock()
	if _, err := r.e.StartLogin(ctx, p.ID, "browser"); err != nil {
		t.Fatal(err)
	}
	w := r.wait("failure", func(w *model.World) bool {
		l := w.Providers[p.ID].Auth.Login
		return l != nil && l.Error == "不接受"
	})
	if w.Providers[p.ID].Auth.SignedIn {
		t.Fatal("signed in after failing")
	}

	// waits, can be pasted into, and ends signed in with the models
	pasted := make(chan string, 1)
	r.fake.mu.Lock()
	r.fake.login = &adapter.LoginFlow{Prompt: model.LoginPrompt{Method: "browser", URL: "https://login"},
		Wait: func(ctx context.Context) error {
			select {
			case <-pasted:
				return nil
			case <-ctx.Done():
				return ctx.Err()
			}
		},
		Paste: func(v string) error { pasted <- v; return nil }}
	r.fake.mu.Unlock()
	prompt, err := r.e.StartLogin(ctx, p.ID, "")
	if err != nil || prompt.URL != "https://login" {
		t.Fatalf("%+v %v", prompt, err)
	}
	if err := r.e.PasteLogin(p.ID, "code"); err != nil {
		t.Fatal(err)
	}
	w = r.wait("signed in", func(w *model.World) bool { return w.Providers[p.ID].Auth.SignedIn })
	if a := w.Providers[p.ID]; a.Auth.Login != nil || len(a.Models) == 0 {
		t.Fatalf("%+v", a)
	}

	// renaming stays signed in
	name := "新名字"
	if err := r.e.UpdateProvider(ctx, p.ID, usecase.ProviderPatch{Name: &name}); err != nil {
		t.Fatal(err)
	}
	if w := r.world(); !w.Providers[p.ID].Auth.SignedIn || w.Providers[p.ID].Name != name {
		t.Fatalf("%+v", w.Providers[p.ID])
	}
	if err := r.e.Logout(ctx, p.ID); err != nil {
		t.Fatal(err)
	}
	if w := r.world(); w.Providers[p.ID].Auth.SignedIn || !r.fake.loggedOut {
		t.Fatal("still signed in")
	}
	// cancelling a sign-in under way ends its wait
	if _, err := r.e.StartLogin(ctx, p.ID, ""); err != nil {
		t.Fatal(err)
	}
	if err := r.e.CancelLogin(p.ID); err != nil {
		t.Fatal(err)
	}
	if err := r.e.PasteLogin(p.ID, "x"); err == nil {
		t.Fatal("a cancelled login took a paste")
	}
	// a key provider has no sign-in
	for id, q := range r.world().Providers {
		if q.Auth.Kind == "apiKey" {
			if _, err := r.e.StartLogin(ctx, id, ""); err == nil {
				t.Fatal("signed in to an API key")
			}
		}
	}
}

// A subscription signed out elsewhere fails its runs; the provider then shows it is signed out, so it can be signed in again.
func TestSubscriptionSignedOutElsewhere(t *testing.T) {
	r := newRig(t, func(model.ModelRequest) (model.ModelReply, error) {
		return model.ModelReply{}, model.Errorf(model.CodeSignedOut, "ChatGPT 的登入已失效，請重新登入")
	})
	ctx := context.Background()
	r.fake.mu.Lock()
	r.fake.models = []model.ModelSpec{{ID: "plan-model"}}
	r.fake.login = &adapter.LoginFlow{Wait: func(context.Context) error { return nil }, Paste: func(string) error { return nil }}
	r.fake.mu.Unlock()
	p, err := r.e.AddProvider(ctx, usecase.NewProvider{Name: "訂閱", Kind: enum.ProviderOpenAI, Login: usecase.ProviderLogin{Kind: "subscription"}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := r.e.StartLogin(ctx, p.ID, ""); err != nil {
		t.Fatal(err)
	}
	r.wait("signed in", func(w *model.World) bool { return w.Providers[p.ID].Auth.SignedIn })
	worker, err := r.e.Hire(usecase.NewReplica{TeamID: r.team.ID, BlueprintID: r.owner.BlueprintID, Name: "Bo", Model: "plan-model"})
	if err != nil {
		t.Fatal(err)
	}
	r.start(r.e.CreateTask(usecase.NewTask{TeamID: r.team.ID, Title: "t", WorkflowID: r.flow.ID, OwnerID: &worker.ID,
		Staff: map[string][]string{"start": {worker.ID}, "end": {worker.ID}}}))
	r.wait("signed out", func(w *model.World) bool { return !w.Providers[p.ID].Auth.SignedIn })
	if _, err := r.e.StartLogin(ctx, p.ID, ""); err != nil {
		t.Fatal(err)
	}
	r.wait("signed in again", func(w *model.World) bool { return w.Providers[p.ID].Auth.SignedIn })
}

func TestSubscriptionRunsSayNothingAboutPrices(t *testing.T) {
	r := newRig(t, func(model.ModelRequest) (model.ModelReply, error) { return call("submit_handoff", handoff), nil })
	ctx := context.Background()
	r.fake.mu.Lock()
	r.fake.models = []model.ModelSpec{{ID: "plan-model"}}
	r.fake.login = &adapter.LoginFlow{Wait: func(context.Context) error { return nil }, Paste: func(string) error { return nil }}
	r.fake.mu.Unlock()
	p, err := r.e.AddProvider(ctx, usecase.NewProvider{Name: "訂閱", Kind: enum.ProviderOpenAI, Login: usecase.ProviderLogin{Kind: "subscription"}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := r.e.StartLogin(ctx, p.ID, ""); err != nil {
		t.Fatal(err)
	}
	r.wait("signed in", func(w *model.World) bool { return w.Providers[p.ID].Auth.SignedIn })
	worker, err := r.e.Hire(usecase.NewReplica{TeamID: r.team.ID, BlueprintID: r.owner.BlueprintID, Name: "Bo", Model: "plan-model"})
	if err != nil {
		t.Fatal(err)
	}
	task := r.start(r.e.CreateTask(usecase.NewTask{TeamID: r.team.ID, Title: "t", WorkflowID: r.flow.ID, OwnerID: &worker.ID,
		Staff: map[string][]string{"start": {worker.ID}, "end": {worker.ID}}}))
	w := r.wait("await merge", stage(task.ID, enum.StageAwaitMerge))
	s := subAt(w, task.ID, "整理需求")
	if s.Unpriced || s.CostUSD != 0 || s.Tokens <= 0 {
		t.Fatalf("%+v", s)
	}
}

func TestEditingATask(t *testing.T) {
	block := make(chan struct{})
	r := newRig(t, func(model.ModelRequest) (model.ModelReply, error) {
		<-block
		return call("submit_handoff", handoff), nil
	})
	defer close(block)
	bo, err := r.e.Hire(usecase.NewReplica{TeamID: r.team.ID, BlueprintID: r.owner.BlueprintID, Name: "Bo", Model: "fake"})
	if err != nil {
		t.Fatal(err)
	}
	task := r.task(r.flow.ID)
	title, blank := "新標題", " "
	if err := r.e.UpdateTask(task.ID, usecase.TaskPatch{Title: &blank}); err == nil {
		t.Fatal("a blank title was accepted")
	}
	stranger := "nobody"
	if err := r.e.UpdateTask(task.ID, usecase.TaskPatch{OwnerID: &stranger}); err == nil {
		t.Fatal("a stranger became the owner")
	}
	if err := r.e.UpdateTask(task.ID, usecase.TaskPatch{Title: &title, OwnerID: &bo.ID}); err != nil {
		t.Fatal(err)
	}
	got := r.world().Tasks[task.ID]
	// the owner answers for the task and works no step by it: who works each step stays
	if got.Title != title || *got.OwnerID != bo.ID || got.Workflow.Nodes[1].ReplicaIDs[0] != r.owner.ID {
		t.Fatalf("%+v", got)
	}
}

func TestKeyNeverReachesClients(t *testing.T) {
	r := newRig(t, func(model.ModelRequest) (model.ModelReply, error) { return say(""), nil })
	raw, err := r.e.Snapshot()
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(raw), "sk-secret-1234") {
		t.Fatal("the API key is in the world")
	}
	if !strings.Contains(string(raw), `"keyHint":"1234"`) {
		t.Fatal("no key hint")
	}
}

func TestCannotDeleteWhatIsInUse(t *testing.T) {
	r := newRig(t, func(model.ModelRequest) (model.ModelReply, error) { return say(""), nil })
	w := r.world()
	for id := range w.Providers {
		if err := r.e.DeleteProvider(context.Background(), id); err == nil {
			t.Fatal("a provider in use was deleted")
		}
	}
	if err := r.e.DeleteBlueprint(r.owner.BlueprintID); err == nil {
		t.Fatal("a blueprint in use was deleted")
	}
	bad := *r.flow
	bad.Edges = append(bad.Edges, model.WorkflowEdge{ID: "x", From: bad.Nodes[1].ID, To: bad.Nodes[0].ID})
	if err := r.e.SaveWorkflow(bad.ID, bad); err == nil {
		t.Fatal("a cycle was accepted")
	}
}

func TestKeysStayOutOfTheDocuments(t *testing.T) {
	r := newRig(t, func(model.ModelRequest) (model.ModelReply, error) { return say(""), nil })
	docs, err := r.store.LoadDocs(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(docs) == 0 {
		t.Fatal("nothing saved")
	}
	for _, d := range docs {
		if strings.Contains(string(d.Data), "sk-secret-1234") {
			t.Fatalf("key stored in document %s", d.Kind)
		}
	}
}

func TestCompanyFolderSkillsComeFirstForEveryBlueprint(t *testing.T) {
	writeSkill := func(dir, name, description string) {
		t.Helper()
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dir, "SKILL.md"), []byte("---\nname: "+name+"\ndescription: "+description+"\n---\n做法\n"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	r := newRig(t, func(model.ModelRequest) (model.ModelReply, error) { return call("submit_handoff", handoff), nil })
	// not committed, so only the company's folder has them, not the task's work tree
	writeSkill(filepath.Join(r.folder, ".claude", "skills", "shared"), "shared", "專案的")
	writeSkill(filepath.Join(r.folder, ".agents", "skills", "lint"), "lint", "專案檢查")
	writeSkill(filepath.Join(r.folder, ".team-work", "deploy"), "deploy", "專案部署")
	writeSkill(filepath.Join(r.folder, ".codex", "skills", "review"), "review", "專案審查")
	mine := t.TempDir()
	writeSkill(filepath.Join(mine, "skills", "shared"), "shared", "藍圖的")
	bp := *r.world().Blueprints[r.owner.BlueprintID]
	bp.Skills = []model.SkillPack{{Source: &model.BlueprintSource{Kind: "local", Path: mine}, Exclude: []string{}}}
	if err := r.e.SaveBlueprint(bp.ID, bp); err != nil {
		t.Fatal(err)
	}

	task := r.task(r.flow.ID)
	r.wait("await merge", stage(task.ID, enum.StageAwaitMerge))
	system := r.fake.seen[0].System
	for _, want := range []string{"專案的", "專案檢查", "專案部署", "專案審查"} {
		if !strings.Contains(system, want) {
			t.Fatalf("%s missing from the task's skills:\n%s", want, system)
		}
	}
	if strings.Contains(system, "藍圖的") {
		t.Fatalf("the company's skill should win over the blueprint's by the same name:\n%s", system)
	}

	skills, err := r.e.ReplicaSkills(context.Background(), r.owner.ID)
	if err != nil {
		t.Fatal(err)
	}
	if at := slices.IndexFunc(skills, func(s usecase.SkillInfo) bool { return s.Name == "shared" }); at < 0 || skills[at].Description != "專案的" {
		t.Fatalf("$ should offer the company's skill: %+v", skills)
	}
	for _, name := range []string{"lint", "deploy", "review"} {
		if !slices.ContainsFunc(skills, func(s usecase.SkillInfo) bool { return s.Name == name }) {
			t.Fatalf("$ should offer %s: %+v", name, skills)
		}
	}
}

func TestSkillsFromSeveralFolders(t *testing.T) {
	// one folder links its skill to somewhere else, and both folders have it
	writeSkill := func(dir, description string) {
		t.Helper()
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dir, "SKILL.md"), []byte("---\nname: shared\ndescription: "+description+"\n---\n做法\n"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	first, second, elsewhere := t.TempDir(), t.TempDir(), t.TempDir()
	writeSkill(filepath.Join(elsewhere, "shared"), "第一份")
	if err := os.MkdirAll(filepath.Join(first, "skills"), 0o755); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(first, "skills", "shared")
	if err := os.Symlink(filepath.Join(elsewhere, "shared"), link); err != nil {
		t.Fatal(err)
	}
	writeSkill(filepath.Join(second, "skills", "shared"), "第二份")

	path := filepath.Join(link, "SKILL.md")
	read := false
	r := newRig(t, func(model.ModelRequest) (model.ModelReply, error) {
		if !read {
			read = true
			return call("read_file", map[string]any{"path": path}), nil
		}
		return call("submit_handoff", handoff), nil
	})
	bp := *r.world().Blueprints[r.owner.BlueprintID]
	bp.Skills = []model.SkillPack{
		{Source: &model.BlueprintSource{Kind: "local", Path: first}, Exclude: []string{}},
		{Source: &model.BlueprintSource{Kind: "local", Path: second}, Exclude: []string{}},
	}
	if err := r.e.SaveBlueprint(bp.ID, bp); err != nil {
		t.Fatal(err)
	}
	task := r.task(r.flow.ID)
	r.wait("await merge", stage(task.ID, enum.StageAwaitMerge))

	system := r.fake.seen[0].System
	if !strings.Contains(system, "第一份") || strings.Contains(system, "第二份") {
		t.Fatalf("the skill should be listed once, from the first folder:\n%s", system)
	}
	for _, req := range r.fake.seen {
		for _, m := range req.Messages {
			for _, b := range m.Content {
				if b.Type == enum.BlockToolResult && b.Name == "read_file" {
					if !strings.Contains(b.Text, "做法") {
						t.Fatalf("the linked skill could not be read: %s", b.Text)
					}
					return
				}
			}
		}
	}
	t.Fatal("the model was never given the file")
}

// requests is what the model was asked so far, safe while a run is under way.
func (s *script) requests() []model.ModelRequest {
	s.mu.Lock()
	defer s.mu.Unlock()
	return slices.Clone(s.seen)
}

func TestHandoffKeepsWhatWasLearned(t *testing.T) {
	r := newRig(t, func(model.ModelRequest) (model.ModelReply, error) {
		return call("submit_handoff", map[string]any{"goal": "g", "done": []string{"d"}, "headline": "h", "did": []string{"x"}, "learned": []string{" 測試要加 -race ", "  "}}), nil
	})
	task := r.task(r.flow.ID)
	w := r.wait("await merge", stage(task.ID, enum.StageAwaitMerge))
	got := w.Replicas[r.owner.ID].Memory
	if len(got) != 1 || got[0].Text != "測試要加 -race" || got[0].Source != "work" || got[0].TaskID != task.ID {
		t.Fatalf("memory = %+v", got)
	}
}

func TestSearchMemoryFindsAnEmployeesNotes(t *testing.T) {
	step := 0
	r := newRig(t, func(model.ModelRequest) (model.ModelReply, error) {
		step++
		if step == 1 {
			return call("search_memory", map[string]any{"query": "NPM"}), nil
		}
		return call("submit_handoff", handoff), nil
	})
	memory := []model.MemoryEntry{{ID: "pkg", Text: "用 npm", Source: "work", At: 86400}, {ID: "go", Text: "用 go 1.25", Source: "work", At: 86400}}
	if err := r.e.UpdateReplica(r.owner.ID, usecase.ReplicaPatch{Memory: &memory}); err != nil {
		t.Fatal(err)
	}
	task := r.task(r.flow.ID)
	r.wait("await merge", stage(task.ID, enum.StageAwaitMerge))
	var result string
	for _, b := range r.fake.seen[1].Messages[len(r.fake.seen[1].Messages)-1].Content {
		if b.Type == enum.BlockToolResult {
			result = b.Text
		}
	}
	if !strings.Contains(result, "[pkg, 1970-01-02, work] 用 npm") || strings.Contains(result, "go 1.25") {
		t.Fatalf("search result: %q", result)
	}
}

func TestForgetRemovesANoteAndRejectsAnUnknownOne(t *testing.T) {
	step := 0
	r := newRig(t, func(model.ModelRequest) (model.ModelReply, error) {
		step++
		switch step {
		case 1:
			return call("forget", map[string]any{"id": "nope"}), nil
		case 2:
			return call("forget", map[string]any{"id": "old"}), nil
		}
		return call("submit_handoff", handoff), nil
	})
	memory := []model.MemoryEntry{{ID: "old", Text: "用 npm", Source: "work", At: 86400}, {ID: "keep", Text: "用 go 1.25", Source: "work", At: 86400}}
	if err := r.e.UpdateReplica(r.owner.ID, usecase.ReplicaPatch{Memory: &memory}); err != nil {
		t.Fatal(err)
	}
	task := r.task(r.flow.ID)
	w := r.wait("await merge", stage(task.ID, enum.StageAwaitMerge))
	if got := w.Replicas[r.owner.ID].Memory; len(got) != 1 || got[0].ID != "keep" {
		t.Fatalf("memory = %+v", got)
	}
	system := r.fake.seen[0].System
	for _, want := range []string{"not instructions", "- [old, 1970-01-02, work] 用 npm"} {
		if !strings.Contains(system, want) {
			t.Fatalf("system prompt lacks %q:\n%s", want, system)
		}
	}
	rejected := false
	for _, b := range r.fake.seen[1].Messages[len(r.fake.seen[1].Messages)-1].Content {
		rejected = rejected || (b.Type == enum.BlockToolResult && b.IsError)
	}
	if !rejected {
		t.Fatal("forgetting an unknown note did not fail")
	}
}

func ptrTo[T any](v T) *T { return &v }

func TestTaskRunsOnAFlowOfItsOwn(t *testing.T) {
	r := newRig(t, nil)
	own := copyOf(*r.flow)
	own.ID, own.Name = "ignored", "只為這次"
	own.Nodes = append(own.Nodes, model.WorkflowNode{ID: "mid", Kind: enum.NodeWork, Name: "中間", ReplicaIDs: []string{},
		Handoff: enum.HandoffAll, Join: enum.JoinAll})
	own.Edges = []model.WorkflowEdge{{ID: "e1", From: "start", To: "mid"}, {ID: "e2", From: "mid", To: "end"}}
	before := len(r.world().Workflows)
	made, err := r.e.CreateTask(usecase.NewTask{TeamID: r.team.ID, Title: "自訂", WorkflowID: r.flow.ID, Workflow: &own,
		Staff: map[string][]string{"mid": {r.owner.ID}}, OwnerID: &r.owner.ID})
	if err != nil {
		t.Fatal(err)
	}
	if made.WorkflowID != "" || made.Workflow.ID != "" || made.Workflow.Name != "只為這次" || len(made.Workflow.Nodes) != 3 {
		t.Fatalf("%+v", made)
	}
	if got := len(r.world().Workflows); got != before {
		t.Fatalf("%d blueprints, was %d", got, before)
	}
	// it is checked as a blueprint is: no loops
	own.Edges = append(own.Edges, model.WorkflowEdge{ID: "e3", From: "end", To: "start"})
	if _, err := r.e.CreateTask(usecase.NewTask{TeamID: r.team.ID, Title: "迴圈", Workflow: &own,
		Staff: map[string][]string{"mid": {r.owner.ID}}, OwnerID: &r.owner.ID}); err == nil {
		t.Fatal("a flow with a loop was taken")
	}
}

func copyOf[T any](v T) T {
	raw, _ := json.Marshal(v)
	var out T
	_ = json.Unmarshal(raw, &out)
	return out
}
