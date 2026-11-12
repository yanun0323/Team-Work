package usecase

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/yanun0323/Team-Work/internal/i18n"
	"github.com/yanun0323/Team-Work/internal/model"
)

// A failure git gave a reason for keeps the first few files and counts the rest; git's words keep no path of this
// computer, and a long message is cut.
func TestMergeFailureKeepsWhatHelpsAndNoPaths(t *testing.T) {
	home, err := os.UserHomeDir()
	if err != nil {
		t.Skip(err)
	}
	in := mergeRun{folder: filepath.Join(home, "proj"), dir: filepath.Join(home, ".team-work", "trees", "t1"), target: "main"}
	files := []string{"a", "b", "c", "d", "e", "f", "g"}
	raw := fmt.Errorf("git merge: exit status 1: %s/AGENTS.md in %s, and %s/x", in.folder, in.dir, filepath.Join(home, "other"))
	f := mergeFailure(in, &model.MergeBlocked{Kind: model.MergeUncommitted, Files: files, Err: raw})
	if f.Kind != model.MergeUncommitted || f.Target != "main" || !slices.Equal(f.Files, files[:5]) || f.More != 2 {
		t.Fatalf("%+v", f)
	}
	if want := "git merge: exit status 1: AGENTS.md in ., and ~/other/x"; f.Detail != want {
		t.Fatalf("detail %q, want %q", f.Detail, want)
	}

	long := mergeFailure(in, errors.New(strings.Repeat("字", mergeDetailMost+50)))
	if long.Kind != model.MergeUnknown || len([]rune(long.Detail)) != mergeDetailMost+1 || !strings.HasSuffix(long.Detail, "…") {
		t.Fatalf("%s, %d characters", long.Kind, len([]rune(long.Detail)))
	}
}

// A model call that failed resolving a clash says what it said, in short; any other error is unknown with its words.
func TestMergeFailureOfTheModelAndOfTheUnknown(t *testing.T) {
	in := mergeRun{folder: "/x/proj", dir: "/x/tree", target: "main"}
	said := mergeFailure(in, resolveFailed{model.Errorf(model.CodeInvalid, "模型呼叫失敗")})
	if said.Kind != model.MergeResolveFailed || said.Reason != "模型呼叫失敗" {
		t.Fatalf("%+v", said)
	}
	raw := mergeFailure(in, resolveFailed{errors.New("dial /x/tree/sock: refused")})
	if raw.Kind != model.MergeResolveFailed || raw.Reason != "dial sock: refused" {
		t.Fatalf("%+v", raw)
	}
	other := mergeFailure(in, errors.New("fatal: refusing to fetch into branch checked out at /x/proj"))
	if other.Kind != model.MergeUnknown || other.Detail != "fatal: refusing to fetch into branch checked out at ." {
		t.Fatalf("%+v", other)
	}
	if text := mergeFailureText(other); text == "" || mergeFailureState(&other) == "" || !strings.Contains(mergeFailureState(&other), other.Detail) {
		t.Fatal("an unknown failure tells the owner nothing")
	}
}

// The owner, woken or reading the task, reads why the last merge failed; a completion after it clears it.
func TestTheOwnerReadsTheLastMergeFailure(t *testing.T) {
	e, _, task := logEngine(t)
	task.TeamID = "c1"
	e.w.Teams["c1"] = &model.Team{ID: "c1"}
	if strings.Contains(e.taskState(task), "Last merge failed") || strings.Contains(e.taskDetails(task), "lastMergeFailure") {
		t.Fatal("a failure told before any merge")
	}
	task.Merge = &model.Merge{Failure: &model.MergeFailure{Kind: model.MergeUncommitted, Target: "main", Files: []string{"AGENTS.md"}, Detail: "would be overwritten"}}
	state := e.taskState(task)
	for _, want := range []string{"Last merge failed", "Kind: uncommitted", "Files in the way: AGENTS.md", "would be overwritten", "Only the user can merge"} {
		if !strings.Contains(state, want) {
			t.Errorf("the owner is not told %q:\n%s", want, state)
		}
	}
	if details := e.taskDetails(task); !strings.Contains(details, `"lastMergeFailure":{"kind":"uncommitted","target":"main","files":["AGENTS.md"]`) {
		t.Errorf("read_task does not say it: %s", details)
	}
}

// Every kind has its own words, naming the files and the branch, and the next step.
func TestMergeFailureTextNamesWhatIsInTheWay(t *testing.T) {
	t.Cleanup(func() { i18n.Set("") })
	i18n.Set("zh")
	for kind, want := range map[string]string{
		model.MergeUncommitted:   "專案資料夾裡的 a、b 等 5 個 有未提交的修改",
		model.MergeMoved:         "main 在合併期間有新的提交",
		model.MergeUnresolved:    "自動解決衝突沒有成功（a、b 等 5 個）",
		model.MergeNoTarget:      "找不到目標分支 main",
		model.MergeWorktreeDirty: "任務的工作資料夾還有未提交的檔案（a、b 等 5 個）",
		model.MergeResolveFailed: "模型呼叫失敗：逾時",
		model.MergeUnknown:       "合併失敗，原因無法判斷",
	} {
		got := mergeFailureText(model.MergeFailure{Kind: kind, Target: "main", Files: []string{"a", "b"}, More: 3, Reason: "逾時"})
		if !strings.Contains(got, want) {
			t.Errorf("%s: %q does not say %q", kind, got, want)
		}
	}
}
