package usecase_test

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/yanun0323/Team-Work/internal/model"
	"github.com/yanun0323/Team-Work/internal/model/enum"
	"github.com/yanun0323/Team-Work/internal/usecase"
)

func TestCodeModeSettingIsOffUntilTurnedOn(t *testing.T) {
	t.Parallel()
	r := newRig(t, func(model.ModelRequest) (model.ModelReply, error) { return say("ok"), nil })
	if r.world().Preferences.CodeMode {
		t.Fatal("on by default")
	}
	for _, bad := range []string{`null`, `"yes"`, `1`} {
		err := r.e.UpdatePreferences(map[string]json.RawMessage{"codeMode": json.RawMessage(bad)})
		var known *model.Error
		if !errors.As(err, &known) || known.Code != model.CodeInvalid {
			t.Fatalf("%s: %v", bad, err)
		}
	}
	if err := r.e.UpdatePreferences(map[string]json.RawMessage{"codeMode": json.RawMessage(`true`)}); err != nil {
		t.Fatal(err)
	}
	if !r.world().Preferences.CodeMode {
		t.Fatal("not turned on")
	}
	raw, err := os.ReadFile(filepath.Join(r.data, "preferences.yaml"))
	if err != nil || !strings.Contains(string(raw), "codeMode: true") {
		t.Fatalf("%s %v", raw, err)
	}
	r.e.Close()
	newEngine(t, r)
	if !r.world().Preferences.CodeMode {
		t.Fatal("lost on restart")
	}
	if err := r.e.UpdatePreferences(map[string]json.RawMessage{"codeMode": json.RawMessage(`false`)}); err != nil || r.world().Preferences.CodeMode {
		t.Fatal(err)
	}
}

var declaredTools = regexp.MustCompile(`(?m)^  ([a-z_]+)\(args`)

// execTools are the tools an exec request declares, sorted; nil without exec.
func execTools(req model.ModelRequest) []string {
	for _, s := range req.Tools {
		if s.Name == "exec" {
			out := []string{}
			for _, m := range declaredTools.FindAllStringSubmatch(s.Description, -1) {
				out = append(out, m[1])
			}
			slices.Sort(out)
			return out
		}
	}
	return nil
}

func hasExec(req model.ModelRequest) bool {
	return slices.ContainsFunc(req.Tools, func(s model.ToolSpec) bool { return s.Name == "exec" })
}

func execResultOf(req model.ModelRequest) model.Block {
	m := req.Messages[len(req.Messages)-1]
	for _, b := range m.Content {
		if b.Type == enum.BlockToolResult {
			return b
		}
	}
	return model.Block{}
}

// readingTools are what an employee with read_file reads tasks, blueprints and the like with.
var readingTools = []string{"list_blueprints", "list_companies", "list_employees", "list_providers", "list_tasks", "list_workflows",
	"read_blueprint", "read_chat", "read_company", "read_employee", "read_file", "read_provider", "read_task", "read_workflow"}

// exec comes with the setting: to a read-only employee in a step, a discussion and a chat, over just what they may
// read, in their own company; never to one with nothing to read. A script chains reads and only its summary is kept.
func TestExecReachesReadOnlyEmployeesWithinTheirCompany(t *testing.T) {
	t.Parallel()
	var mu sync.Mutex
	var otherTask string
	results := map[string]model.Block{} // where exec ran: its result
	const stepScript = `
const all = tools.list_tasks();
const todo = all.filter(t => t.title.startsWith("待辦"));
let matched = 0;
for (const t of todo) if (tools.read_task({task_id: t.id}).text.includes("UNIQUE" + "_A")) matched++;
let other; try { tools.read_task({task_id: OTHER}) } catch (e) { other = e.message }
let wrote; try { tools.write_file({path: "pwned.txt", content: "x"}) } catch (e) { wrote = e.name }
text(JSON.stringify({todo: todo.length, matched, other, wrote, teamIds: all.filter(t => t.teamId).length}));`
	const chatScript = `const key = "sk-SECRET_MARKER"; try { tools.nope() } catch (e) {} text(tools.read_file({path: "x.txt"}).content.trim())`
	r := newRig(t, func(req model.ModelRequest) (model.ModelReply, error) {
		step := stepOf(req)
		if lastIsResult(req) {
			if res := execResultOf(req); res.Name == "exec" {
				mu.Lock()
				results[step] = res
				mu.Unlock()
			}
			if step == "" {
				return say("好"), nil
			}
			return call("submit_handoff", handoff), nil
		}
		switch {
		case step == "談":
			return say("談完"), nil
		case step == "讀" && hasExec(req):
			mu.Lock()
			code := strings.ReplaceAll(stepScript, "OTHER", `"`+otherTask+`"`)
			mu.Unlock()
			return call("exec", map[string]string{"code": code}), nil
		case step == "" && hasExec(req):
			return call("exec", map[string]string{"code": chatScript}), nil
		case step == "":
			return say("好"), nil
		}
		return call("submit_handoff", handoff), nil
	})
	ctx := context.Background()
	if err := os.WriteFile(filepath.Join(r.folder, "x.txt"), []byte("hello\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	readOnly, err := r.e.CreateBlueprint(model.Blueprint{Name: "Researcher", Prompt: "你是研究員", Tools: []enum.Tool{enum.ToolReadFile}})
	if err != nil {
		t.Fatal(err)
	}
	nothing, err := r.e.CreateBlueprint(model.Blueprint{Name: "Mute", Prompt: "你只說話", Tools: []enum.Tool{}})
	if err != nil {
		t.Fatal(err)
	}
	reader, err := r.e.Hire(usecase.NewReplica{TeamID: r.team.ID, BlueprintID: readOnly.ID, Name: "Reader", Model: "fake"})
	if err != nil {
		t.Fatal(err)
	}
	mute, err := r.e.Hire(usecase.NewReplica{TeamID: r.team.ID, BlueprintID: nothing.ID, Name: "Mute", Model: "fake"})
	if err != nil {
		t.Fatal(err)
	}
	flow := func(name string, kind enum.NodeKind, who string) string {
		wf, err := r.e.CreateWorkflow(name)
		if err != nil {
			t.Fatal(err)
		}
		wf.Nodes = []model.WorkflowNode{{ID: "n", Kind: kind, Name: name, Prompt: "做", ReplicaIDs: []string{who}, Handoff: enum.HandoffAll, Join: enum.JoinAll}}
		if err := r.e.SaveWorkflow(wf.ID, *wf); err != nil {
			t.Fatal(err)
		}
		return wf.ID
	}
	readFlow, talkFlow, muteFlow := flow("讀", enum.NodeWork, reader.ID), flow("談", enum.NodeTalk, reader.ID), flow("空", enum.NodeWork, mute.ID)
	for _, title := range []string{"待辦一", "待辦二"} {
		if _, err := r.e.CreateTask(usecase.NewTask{Legacy: true, TeamID: r.team.ID, Title: title, Description: "UNIQUE_A " + title, WorkflowID: r.flow.ID}); err != nil {
			t.Fatal(err)
		}
	}
	other, err := r.e.CreateTeam(ctx, usecase.NewTeam{Name: "別家", Folder: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	stranger, err := r.e.Hire(usecase.NewReplica{TeamID: other.ID, BlueprintID: readOnly.ID, Name: "Stranger", Model: "fake"})
	if err != nil {
		t.Fatal(err)
	}
	theirs, err := r.e.CreateTask(usecase.NewTask{Legacy: true, TeamID: other.ID, Title: "待辦 別家", Description: "UNIQUE_B", WorkflowID: flow("別家", enum.NodeWork, stranger.ID)})
	if err != nil {
		t.Fatal(err)
	}
	mu.Lock()
	otherTask = theirs.ID
	mu.Unlock()

	// everything once with the setting off, and once with it on
	runAll := func() (read, talk, muted *model.Task, chat string) {
		start := func(wf string) *model.Task {
			return r.start(r.e.CreateTask(usecase.NewTask{Legacy: true, TeamID: r.team.ID, Title: "做事", Description: "說明", WorkflowID: wf}))
		}
		read, talk, muted = start(readFlow), start(talkFlow), start(muteFlow)
		c, err := r.e.CreateChat(usecase.NewChat{TeamID: r.team.ID, ReplicaID: reader.ID, Text: "看看"})
		if err != nil {
			t.Fatal(err)
		}
		r.wait("all of it", func(w *model.World) bool {
			talked := false
			for _, s := range w.SubTasks {
				talked = talked || s.TaskID == talk.ID && s.Talk != nil
			}
			return talked && chatDone(c.ID)(w) && w.Tasks[read.ID].Stage == enum.StageAwaitMerge && w.Tasks[muted.ID].Stage == enum.StageAwaitMerge
		})
		return read, talk, muted, c.ID
	}
	runAll()
	for _, req := range r.fake.requests() {
		if hasExec(req) {
			t.Fatalf("exec offered while off, in %q", stepOf(req))
		}
	}
	before := len(r.fake.requests())
	if err := r.e.UpdatePreferences(map[string]json.RawMessage{"codeMode": json.RawMessage(`true`)}); err != nil {
		t.Fatal(err)
	}
	read, _, _, chatID := runAll()

	seen := map[string]bool{}
	for _, req := range r.fake.requests()[before:] {
		step := stepOf(req)
		got := execTools(req)
		switch step {
		case "空":
			if got != nil {
				t.Fatalf("exec with nothing to read: %v", got)
			}
		case "讀", "談", "":
			if !slices.Equal(got, readingTools) {
				t.Fatalf("%q declares %v", step, got)
			}
			seen[step] = true
		}
	}
	if len(seen) != 3 {
		t.Fatalf("exec offered in %v", seen)
	}

	mu.Lock()
	stepRes, chatRes := results["讀"], results[""]
	mu.Unlock()
	var summary struct {
		Todo, Matched, TeamIDs int
		Other, Wrote           string
	}
	if err := json.Unmarshal([]byte(stepRes.Text), &summary); err != nil || stepRes.IsError {
		t.Fatalf("%+v %v", stepRes, err)
	}
	if summary.Todo != 2 || summary.Matched != 2 || summary.TeamIDs != 0 || summary.Other != "no task "+theirs.ID || summary.Wrote != "TypeError" {
		t.Fatalf("%+v", summary)
	}
	if chatRes.IsError || chatRes.Text != "hello" {
		t.Fatalf("%+v", chatRes)
	}

	// what the tools returned stayed in the script: the step kept the summary alone
	w := r.world()
	sub := subAt(w, read.ID, "讀")
	conv, _ := json.Marshal(r.e.Conversation(sub.ID))
	if strings.Contains(string(conv), "UNIQUE_A") || strings.Contains(string(conv), "UNIQUE_B") || !strings.Contains(string(conv), `\"matched\":2`) {
		t.Fatalf("%s", conv)
	}
	// and the logs name what it read, never its code
	line := ""
	for _, l := range sub.Log {
		if l.Kind == enum.LogTool && strings.HasPrefix(l.Text, "exec") {
			line = l.Text
		}
	}
	if !regexp.MustCompile(`^exec list_tasks, read_task \(\d+ chars\)$`).MatchString(line) {
		t.Fatalf("step log line %q", line)
	}
	line = ""
	for _, m := range w.Chats[chatID].Messages {
		if m.From == "tool" && strings.HasPrefix(m.Text, "exec") {
			line = m.Text
		}
	}
	if line != "exec read_file ("+strconv.Itoa(len([]rune(chatScript)))+" chars)" {
		t.Fatalf("chat line %q", line)
	}
	if _, err := os.Stat(filepath.Join(r.folder, "pwned.txt")); err == nil {
		t.Fatal("exec wrote a file")
	}
}

func toolCalls(blocks ...model.Block) model.ModelReply {
	return model.ModelReply{Content: blocks, Usage: model.ModelUsage{Input: 10, Output: 10}}
}

var ownerSeq atomic.Int64

func ownerBlock(name string, args any) model.Block {
	raw, _ := json.Marshal(args)
	return model.Block{Type: enum.BlockToolCall, ID: name + "-" + strconv.Itoa(int(ownerSeq.Add(1))), Name: name, Args: raw}
}

// Each tool an exec script calls counts towards the owner's limit: the one past it does not run, nor does anything
// after exec in the same reply, and the owner stops for the user then, without another model call.
func TestExecCountsTowardsTheOwnersToolLimit(t *testing.T) {
	t.Parallel()
	var phase, extra atomic.Int32
	var rr *rig // set before the task starts
	const script = `text("start");
for (let i = 0; i < 3; i++) { try { text("read " + tools.read_task({}).number) } catch (e) { text("caught") } }
text("after")`
	r := newRig(t, func(req model.ModelRequest) (model.ModelReply, error) {
		if !isOwner(req) {
			return call("submit_handoff", handoff), nil
		}
		switch phase.Add(1) {
		case 1:
			if hasExec(req) {
				return say("exec while off"), nil
			}
			// 30 tools, within the limit
			var blocks []model.Block
			for range 30 {
				blocks = append(blocks, ownerBlock("read_task_history", map[string]any{}))
			}
			// turned on during the turn: the next model call offers it
			if err := rr.e.UpdatePreferences(map[string]json.RawMessage{"codeMode": json.RawMessage(`true`)}); err != nil {
				return model.ModelReply{}, err
			}
			return toolCalls(blocks...), nil
		case 2:
			if !slices.Equal(execTools(req), []string{"read_file", "read_step", "read_task", "read_task_entry", "read_task_history"}) {
				return say("wrong tools: " + strings.Join(execTools(req), ",")), nil
			}
			return toolCalls(ownerBlock("exec", map[string]string{"code": script}), ownerBlock("read_task", map[string]any{})), nil
		}
		extra.Add(1)
		return say("idle"), nil
	})
	log := &lockedLog{}
	r.log = log
	r.e.Close()
	newEngine(t, r)
	rr = r
	task := r.ownerTask(r.flow.ID)
	r.wait("the owner to stop", func(w *model.World) bool {
		c := w.Tasks[task.ID].Coordination
		return c.OwnerState == model.OwnerBlocked && c.BlockedReason == "loop"
	})
	time.Sleep(200 * time.Millisecond)
	if phase.Load() != 2 || extra.Load() != 0 {
		t.Fatalf("the owner's model was called %d times", phase.Load())
	}
	conv := r.e.OwnerConversation(task.ID)
	last := conv[len(conv)-1]
	if len(last.Content) != 2 {
		t.Fatalf("%+v", last)
	}
	ran, after := last.Content[0], last.Content[1]
	if !ran.IsError || !strings.HasPrefix(ran.Text, "exec failed (owner_limit): ") || !strings.HasSuffix(ran.Text, "Output before the failure:\nstart\nread 1") {
		t.Fatalf("exec: %q", ran.Text)
	}
	if !after.IsError || after.Name != "read_task" || after.Text != "owner tool limit reached; not run" {
		t.Fatalf("after: %+v", after)
	}
	logged := log.String()
	if !strings.Contains(logged, `"message":"codemode_failed"`) || !strings.Contains(logged, `"reason":"owner_limit"`) || !strings.Contains(logged, `"tools":"read_task:1"`) ||
		!strings.Contains(logged, `"source":"owner"`) || !strings.Contains(logged, `"task":"`+task.ID+`"`) || strings.Contains(logged, "read 1") || strings.Contains(logged, "text(") {
		t.Fatalf("%s", logged)
	}
	if !slices.ContainsFunc(r.world().Tasks[task.ID].Coordination.Questions, func(q model.TaskQuestion) bool { return q.Audience == "user" && q.Kind == "approval" }) {
		t.Fatal("the user was not asked")
	}
}

// A script that uses up the owner's limit exactly leaves nothing for the next tool of the same reply: that tool is
// refused with its result kept, and the owner stops for the user as when the script itself went past the limit.
func TestExecThatUsesUpTheOwnersLimitStopsTheNextTool(t *testing.T) {
	t.Parallel()
	var phase atomic.Int32
	const script = `for (let i = 0; i < 31; i++) tools.read_task({}); text("done")`
	r := newRig(t, func(req model.ModelRequest) (model.ModelReply, error) {
		if !isOwner(req) {
			return call("submit_handoff", handoff), nil
		}
		if phase.Add(1) == 1 {
			return toolCalls(ownerBlock("exec", map[string]string{"code": script}), ownerBlock("read_task", map[string]any{})), nil
		}
		return say("idle"), nil
	})
	if err := r.e.UpdatePreferences(map[string]json.RawMessage{"codeMode": json.RawMessage(`true`)}); err != nil {
		t.Fatal(err)
	}
	task := r.ownerTask(r.flow.ID)
	r.wait("the owner to stop", func(w *model.World) bool {
		c := w.Tasks[task.ID].Coordination
		return phase.Load() > 1 || c.OwnerState == model.OwnerBlocked && c.BlockedReason == "loop"
	})
	time.Sleep(200 * time.Millisecond)
	if phase.Load() != 1 {
		t.Fatalf("the owner's model was called %d times", phase.Load())
	}
	c := r.world().Tasks[task.ID].Coordination
	if c.OwnerState != model.OwnerBlocked || c.BlockedReason != "loop" ||
		!slices.ContainsFunc(c.Questions, func(q model.TaskQuestion) bool { return q.Audience == "user" && q.Kind == "approval" }) {
		t.Fatalf("%+v", c)
	}
	conv := r.e.OwnerConversation(task.ID)
	calls, last := conv[len(conv)-2], conv[len(conv)-1]
	if len(calls.Content) != 2 || len(last.Content) != 2 {
		t.Fatalf("%+v\n%+v", calls, last)
	}
	ran, after := last.Content[0], last.Content[1]
	if ran.IsError || ran.ID != calls.Content[0].ID || !strings.HasSuffix(ran.Text, "done") {
		t.Fatalf("exec: %+v", ran)
	}
	if !after.IsError || after.ID != calls.Content[1].ID || after.Text != "owner tool limit reached; not run" {
		t.Fatalf("after: %+v", after)
	}
}
