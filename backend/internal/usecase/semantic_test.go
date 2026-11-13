package usecase_test

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/rs/zerolog"

	"github.com/yanun0323/Team-Work/internal/model"
	"github.com/yanun0323/Team-Work/internal/model/enum"
	"github.com/yanun0323/Team-Work/internal/semantic"
	"github.com/yanun0323/Team-Work/internal/usecase"
)

type lockedLog struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (l *lockedLog) Write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.buf.Write(p)
}

func (l *lockedLog) String() string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.buf.String()
}

func hasTool(req model.ModelRequest, name string) bool {
	return slices.ContainsFunc(req.Tools, func(s model.ToolSpec) bool { return s.Name == name })
}

func lastResultText(req model.ModelRequest) string {
	last := req.Messages[len(req.Messages)-1]
	for _, b := range last.Content {
		if b.Type == enum.BlockToolResult {
			return b.Text
		}
	}
	return ""
}

// Semantic search, turned on and then started as after a restart, reaches a chat and a task's step, each searching
// its own folder; the work tree's chunks go when the task ends, and turning it off takes the tool away at once. The
// model cannot be downloaded here, so searches are keyword only, as they are while the index is not ready.
func TestSemanticSearchInChatsAndSteps(t *testing.T) {
	if runtime.GOOS != "darwin" {
		t.Skip("macOS only")
	}
	log := &lockedLog{}
	sem := semantic.New(semantic.Options{DataDir: t.TempDir(), Log: zerolog.New(log), BaseURL: "http://127.0.0.1:1/", Retry: time.Millisecond,
		Platform: semantic.Platform{OS: "27.0", Build: "T", Arm64: true, Helper: "/nonexistent"}})
	t.Cleanup(sem.Close)
	var mu sync.Mutex
	found := map[string]string{} // working directory: what semantic_search gave
	r := newRigWith(t, func(req model.ModelRequest) (model.ModelReply, error) {
		step := stepOf(req)
		if lastIsResult(req) {
			mu.Lock()
			found[req.Cwd] = lastResultText(req)
			mu.Unlock()
		} else if hasTool(req, "semantic_search") {
			return call("semantic_search", map[string]string{"query": "toucan feeding"}), nil
		}
		if step == "" {
			return say("好"), nil
		}
		return call("submit_handoff", handoff), nil
	}, sem)
	if st := r.e.SemanticStatus(); st.State != semantic.StateDisabled || st.Enabled {
		t.Fatalf("%+v", st)
	}
	if err := os.WriteFile(filepath.Join(r.folder, "toucan.go"), []byte("package main\n// toucan feeding schedule\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	gitOut(t, r.folder, "add", "-A")
	gitOut(t, r.folder, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "toucan")
	if err := r.e.UpdatePreferences(map[string]json.RawMessage{"semanticSearch": json.RawMessage(`true`)}); err != nil {
		t.Fatal(err)
	}
	if st := r.e.SemanticStatus(); st.State != semantic.StateRestartRequired || !st.RequiresRestart || st.Active {
		t.Fatalf("%+v", st)
	}
	r.e.StartSemantic() // the restart
	if st := r.e.SemanticStatus(); !st.Active || !st.Enabled {
		t.Fatalf("%+v", st)
	}

	c, err := r.e.CreateChat(usecase.NewChat{TeamID: r.team.ID, ReplicaID: r.owner.ID, Text: "找 toucan"})
	if err != nil {
		t.Fatal(err)
	}
	r.wait("the chat", chatDone(c.ID))
	task := r.task(r.flow.ID)
	r.wait("await merge", stage(task.ID, enum.StageAwaitMerge))

	mu.Lock()
	var tree string
	for cwd, text := range found {
		var res semantic.Result
		if err := json.Unmarshal([]byte(text), &res); err != nil {
			t.Fatalf("%s: %s", cwd, text)
		}
		if res.Mode != "keyword" || res.Reason == "" || len(res.Results) != 1 || res.Results[0].Path != "toucan.go" {
			t.Fatalf("%s: %+v", cwd, res)
		}
		if cwd != r.folder {
			tree = cwd
		}
	}
	mu.Unlock()
	if len(found) != 2 || found[r.folder] == "" || !strings.Contains(tree, "worktrees") {
		t.Fatalf("searched in %v", found)
	}
	if !strings.Contains(log.String(), `"task":"`+task.ID+`"`) {
		t.Fatal("the step's search is not logged with its task")
	}

	if err := r.e.DeleteTask(task.ID); err != nil {
		t.Fatal(err)
	}
	removed := false
	for _, line := range strings.Split(log.String(), "\n") {
		if strings.Contains(line, `"message":"semantic_worktree_removed"`) && strings.Contains(line, filepath.Base(tree)+`"`) {
			removed = true
		}
	}
	if !removed {
		t.Fatalf("the work tree's chunks were not dropped\n%s", log.String())
	}

	if err := r.e.UpdatePreferences(map[string]json.RawMessage{"semanticSearch": json.RawMessage(`false`)}); err != nil {
		t.Fatal(err)
	}
	if st := r.e.SemanticStatus(); st.State != semantic.StateDisabled || st.Active {
		t.Fatalf("%+v", st)
	}
	var tools []string
	r.fake.mu.Lock()
	r.fake.reply = func(req model.ModelRequest) (model.ModelReply, error) {
		for _, s := range req.Tools {
			tools = append(tools, s.Name)
		}
		return say("好"), nil
	}
	r.fake.mu.Unlock()
	c, err = r.e.CreateChat(usecase.NewChat{TeamID: r.team.ID, ReplicaID: r.owner.ID, Text: "再找"})
	if err != nil {
		t.Fatal(err)
	}
	r.wait("the chat", chatDone(c.ID))
	if !slices.Contains(tools, "read_file") || slices.Contains(tools, "semantic_search") {
		t.Fatalf("%v", tools)
	}
}

// Every place that gives an employee tools passes semantic search on, with the run's task and employee: chats,
// task steps, owners, meetings and merge conflicts.
func TestEveryToolListGetsSemanticSearch(t *testing.T) {
	calls := 0
	re := regexp.MustCompile(`tools\.For\([^\n]*\)`)
	for _, name := range []string{"chat.go", "run.go", "owner_run.go", "owner_meeting.go", "merge.go"} {
		raw, err := os.ReadFile(name)
		if err != nil {
			t.Fatal(err)
		}
		for _, call := range re.FindAllString(string(raw), -1) {
			calls++
			if !strings.Contains(call, "Semantic: e.semantic") || !strings.Contains(call, "Task: ") || !strings.Contains(call, "Replica: ") {
				t.Errorf("%s: %s", name, call)
			}
		}
	}
	entries, _ := os.ReadDir(".")
	total := 0
	for _, e := range entries {
		if strings.HasSuffix(e.Name(), ".go") && !strings.HasSuffix(e.Name(), "_test.go") {
			raw, _ := os.ReadFile(e.Name())
			total += len(re.FindAllString(string(raw), -1))
		}
	}
	if calls != 5 || total != calls {
		t.Fatalf("%d calls checked of %d", calls, total)
	}
}

// A task's owner and a meeting's participants search the task's work tree as it is when they search, logged with
// the task and who searched. Each writes a file just before searching: only a search of the work tree as it is
// then finds it.
func TestSemanticSearchForOwnersAndMeetings(t *testing.T) {
	if runtime.GOOS != "darwin" {
		t.Skip("macOS only")
	}
	log := &lockedLog{}
	sem := semantic.New(semantic.Options{DataDir: t.TempDir(), Log: zerolog.New(log), BaseURL: "http://127.0.0.1:1/", Retry: time.Millisecond,
		Platform: semantic.Platform{OS: "27.0", Build: "T", Arm64: true, Helper: "/nonexistent"}})
	t.Cleanup(sem.Close)
	type search struct{ cwd, text string }
	var mu sync.Mutex
	asked := map[string]bool{}
	found := map[string]search{} // owner or member: where they searched and what they got
	r, task, people := meetingRigWith(t, []string{"Bob"}, func(req model.ModelRequest, people []*model.Replica, owner string) (model.ModelReply, bool, error) {
		mu.Lock()
		defer mu.Unlock()
		who := ""
		switch {
		case isChair(req):
		case isMember(req):
			who = "member"
		case isOwner(req):
			who = "owner"
		}
		switch {
		case who != "" && !asked[who] && hasTool(req, "semantic_search") && (who == "member" || strings.Contains(sentText(req), "[task_started]")):
			asked[who] = true
			if err := os.WriteFile(filepath.Join(req.Cwd, who+"_notes.go"), []byte("package main\n// toucan "+who+" notes\n"), 0o644); err != nil {
				return model.ModelReply{}, true, err
			}
			return ownerCall("semantic_search", map[string]string{"query": "toucan feeding"}), true, nil
		case who != "" && asked[who] && lastIsResult(req) && found[who].cwd == "":
			found[who] = search{req.Cwd, lastResultText(req)}
			if who == "owner" {
				return ownerCall("hold_meeting", map[string]any{"topic": "選方案", "background": "要在 A 和 B 之間選一個", "replica_ids": []string{people[0].ID}}), true, nil
			}
			return say("用 A"), true, nil
		case isChair(req) && !strings.Contains(sentText(req), "Bob: "):
			return ownerCall("meeting_ask", map[string]any{"replica_ids": []string{people[0].ID}, "text": "Bob 你怎麼看"}), true, nil
		case isChair(req):
			return ownerCall("end_meeting", map[string]any{"summary": "結論：用 A"}), true, nil
		case isOwner(req) && strings.Contains(sentText(req), "[meeting_ended]"):
			return say("收到結論"), true, nil
		}
		return model.ModelReply{}, false, nil
	}, sem, func(r *rig) {
		if err := os.WriteFile(filepath.Join(r.folder, "toucan.go"), []byte("package main\n// toucan feeding schedule\n"), 0o644); err != nil {
			t.Fatal(err)
		}
		gitOut(t, r.folder, "add", "-A")
		gitOut(t, r.folder, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "toucan")
		if err := r.e.UpdatePreferences(map[string]json.RawMessage{"semanticSearch": json.RawMessage(`true`)}); err != nil {
			t.Fatal(err)
		}
		r.e.StartSemantic() // the restart
	})
	r.wait("the owner's word on the conclusion", func(*model.World) bool {
		return hasActivity(r.activity(task.ID), func(a model.TaskActivity) bool { return a.Text == "收到結論" })
	})

	mu.Lock()
	defer mu.Unlock()
	owner, member := found["owner"], found["member"]
	if owner.cwd == "" || member.cwd == "" || owner.cwd != member.cwd || owner.cwd == r.folder || !strings.Contains(owner.cwd, "worktrees") {
		t.Fatalf("searched in %q and %q, the project being %q", owner.cwd, member.cwd, r.folder)
	}
	for who, s := range found {
		var res semantic.Result
		if err := json.Unmarshal([]byte(s.text), &res); err != nil {
			t.Fatalf("%s: %s", who, s.text)
		}
		got := map[string]bool{}
		for _, h := range res.Results {
			got[h.Path] = true
		}
		if res.Mode != "keyword" || res.Reason == "" || !got["toucan.go"] || !got[who+"_notes.go"] {
			t.Fatalf("%s: %+v", who, res)
		}
	}
	// the log names the folder with its links resolved, as /tmp is /private/tmp on macOS
	cwd, err := filepath.EvalSymlinks(owner.cwd)
	if err != nil {
		t.Fatal(err)
	}
	searched := map[string]bool{}
	for _, line := range strings.Split(log.String(), "\n") {
		if strings.Contains(line, `"message":"semantic_search"`) && strings.Contains(line, `"task":"`+task.ID+`"`) &&
			strings.Contains(line, `"cwd":"`+cwd+`"`) {
			for _, id := range []string{r.owner.ID, people[0].ID} {
				if strings.Contains(line, `"replica":"`+id+`"`) {
					searched[id] = true
				}
			}
		}
	}
	if len(searched) != 2 {
		t.Fatalf("searches logged for %v\n%s", searched, log.String())
	}
}
