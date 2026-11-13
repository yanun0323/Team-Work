package usecase

import (
	"regexp"
	"strconv"
	"strings"
	"testing"

	"github.com/yanun0323/Team-Work/internal/model"
)

// readTaskText is read_task as an employee of every company reads it.
func readTaskText(t *testing.T, e *Engine, a readArgs) string {
	t.Helper()
	res := e.readTask(manager{}, a)
	if res.IsError {
		t.Fatal(res.Text)
	}
	if len(res.Text) > readChatBytes {
		t.Fatalf("read %d bytes, more than %d", len(res.Text), readChatBytes)
	}
	return res.Text
}

var earlier = regexp.MustCompile(`before=(\d+)`)

func TestReadTaskPagesTheConversationWithin50KB(t *testing.T) {
	t.Parallel()
	e, _, task := logEngine(t)
	task.Number, task.Title, task.Description = 7, "加功能", "說明"
	for i := 1; i <= 40; i++ {
		e.addActivity(task, model.TaskActivity{Kind: "message", From: "user", Text: "m" + strconv.Itoa(i) + " " + strings.Repeat("字", 1000)})
	}

	latest := readTaskText(t, e, readArgs{TaskID: task.ID})
	if !strings.HasPrefix(latest, "{") || !strings.Contains(latest, `"description":"說明"`) || !strings.Contains(latest, "[40] ") || !strings.Contains(latest, "m40 ") {
		t.Fatalf("not the task and its latest entry: %.300s", latest)
	}
	found := earlier.FindStringSubmatch(latest)
	if found == nil {
		t.Fatalf("no way to read on: %s", latest[len(latest)-200:])
	}
	before, _ := strconv.Atoi(found[1])
	if before <= 1 || before > 40 || strings.Contains(latest, "["+strconv.Itoa(before-1)+"] ") {
		t.Fatalf("before=%d", before)
	}

	older := readTaskText(t, e, readArgs{TaskID: task.ID, Before: before})
	if strings.HasPrefix(older, "{") || strings.Contains(older, "[40] ") || !strings.Contains(older, "["+strconv.Itoa(before-1)+"] ") {
		t.Fatalf("not the entries before %d: %.300s", before, older)
	}

	few := readTaskText(t, e, readArgs{TaskID: task.ID, Limit: 5})
	if !strings.Contains(few, "Entries 36-40 of 40") || strings.Contains(few, "[35] ") || !strings.Contains(few, "before=36") {
		t.Fatalf("limit 5: %s", few[strings.Index(few, "# Conversation"):])
	}

	if none := readTaskText(t, e, readArgs{TaskID: task.ID, Before: 1}); !strings.Contains(none, "none is before 1") {
		t.Fatal(none)
	}
}

func TestReadTaskCutsOnlyAnEntryLargerThanARead(t *testing.T) {
	t.Parallel()
	e, _, task := logEngine(t)
	task.Description = strings.Repeat("長", 40<<10) // more than the description read_task gives
	e.addActivity(task, model.TaskActivity{Kind: "message", From: "user", Text: "short one"})
	e.addActivity(task, model.TaskActivity{Kind: "message", From: "user", Text: strings.Repeat("大", 30<<10)})

	text := readTaskText(t, e, readArgs{TaskID: task.ID})
	if !strings.Contains(text, "[description cut") || !strings.Contains(text, "[entry cut]") || strings.Contains(text, "short one") || !strings.Contains(text, "before=2") {
		t.Fatalf("%.200s … %s", text, text[len(text)-200:])
	}
	if whole := readTaskText(t, e, readArgs{TaskID: task.ID, Before: 2}); !strings.Contains(whole, "[1] ") || strings.Contains(whole, "entry cut") {
		t.Fatal(whole)
	}
}

func TestReadTaskSaysATaskNotLedByAnOwnerHasNoConversation(t *testing.T) {
	t.Parallel()
	e, _, _ := logEngine(t)
	replica := "rep-1"
	e.w.Replicas[replica] = &model.Replica{ID: replica, Name: "Ada"}
	legacy := &model.Task{ID: "t2", Number: 2, Title: "舊的", Workflow: model.Workflow{Nodes: []model.WorkflowNode{{ID: "start", Name: "整理需求"}, {ID: "end", Name: "驗收"}}}}
	e.w.Tasks[legacy.ID] = legacy
	e.w.SubTasks["sub-1"] = &model.SubTask{ID: "sub-1", TaskID: legacy.ID, NodeID: "start", ReplicaID: &replica, Status: "complete",
		Handoff: &model.Handoff{Human: model.HumanSummary{Headline: "需求整理好了"}}}

	text := readTaskText(t, e, readArgs{TaskID: legacy.ID})
	for _, want := range []string{"not led by an owner", `- start "整理需求":`, "sub-1 by Ada (rep-1): complete; handoff: 需求整理好了", `- end "驗收": not run yet`} {
		if !strings.Contains(text, want) {
			t.Fatalf("no %q in %s", want, text)
		}
	}
}
