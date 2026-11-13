package usecase_test

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"

	"github.com/yanun0323/Team-Work/internal/model"
	"github.com/yanun0323/Team-Work/internal/model/enum"
	"github.com/yanun0323/Team-Work/internal/usecase"
)

func countNamed(w *model.World, name string) int {
	n := 0
	for _, r := range w.Replicas {
		if r.Name == name {
			n++
		}
	}
	return n
}

func secondTeam(t *testing.T, r *rig) *model.Team {
	t.Helper()
	team, err := r.e.CreateTeam(context.Background(), usecase.NewTeam{Name: "別間", Folder: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := r.e.Hire(usecase.NewReplica{TeamID: team.ID, BlueprintID: r.owner.BlueprintID, Name: "Cy", Model: "fake"}); err != nil {
		t.Fatal(err)
	}
	return team
}

// The staffing agency hires with no company of its own, keeps its employees across a restart, and any company can
// pick them: the work runs in the company that asked, in its folder.
func TestStaffingEmployeesWorkInTheCompanyThatAsks(t *testing.T) {
	t.Parallel()
	r := newRig(t, func(req model.ModelRequest) (model.ModelReply, error) { return call("submit_handoff", handoff), nil })
	other := secondTeam(t, r)
	shared, err := r.e.Hire(usecase.NewReplica{TeamID: model.StaffingID, BlueprintID: r.owner.BlueprintID, Name: "Hal", Model: "fake"})
	if err != nil {
		t.Fatal(err)
	}
	newEngine(t, r) // the agency has no company folder in the settings: its employees still load
	if got := r.world().Replicas[shared.ID]; got == nil || got.TeamID != model.StaffingID {
		t.Fatalf("after restart: %+v", got)
	}
	task := r.start(r.e.CreateTask(usecase.NewTask{Legacy: true, TeamID: other.ID, Title: "共用", WorkflowID: r.flow.ID, OwnerID: &shared.ID,
		Staff: map[string][]string{"start": {shared.ID}, "end": {shared.ID}}}))
	r.wait("done", func(w *model.World) bool {
		return w.Tasks[task.ID].Stage == enum.StageAwaitMerge || w.Tasks[task.ID].Stage == enum.StageDone
	})
	r.fake.mu.Lock()
	seen := slices.Clone(r.fake.seen)
	r.fake.mu.Unlock()
	if len(seen) == 0 {
		t.Fatal("no model call")
	}
	for _, req := range seen {
		if !strings.Contains(req.Cwd, filepath.Join("worktrees", other.ID)) {
			t.Fatalf("worked in %s, want the work tree of %s", req.Cwd, other.ID)
		}
	}
	if _, err := r.e.CreateChat(usecase.NewChat{TeamID: r.team.ID, ReplicaID: shared.ID, Text: "hi"}); err != nil {
		t.Fatalf("a chat in another company: %v", err)
	}
	// someone of another company is still no one's to pick
	cy := ""
	for _, x := range r.world().Replicas {
		if x.TeamID == other.ID {
			cy = x.ID
		}
	}
	if _, err := r.e.CreateTask(usecase.NewTask{TeamID: r.team.ID, Title: "x", WorkflowID: r.flow.ID, OwnerID: &cy}); err == nil {
		t.Fatal("another company's employee owned a task here")
	}
}

// Moving into the agency lets the employee go as firing does and hires someone new there: same name, look, settings,
// model and level, no memory. Sending it again makes no second one.
func TestMoveToStaffingIsAFreshHire(t *testing.T) {
	t.Parallel()
	r := newRig(t, nil)
	bo, err := r.e.Hire(usecase.NewReplica{TeamID: r.team.ID, Name: "Bo", Model: "fake", Effort: "high",
		Custom: &model.Blueprint{Prompt: "我的設定", Tools: []enum.Tool{enum.ToolReadFile}}})
	if err != nil {
		t.Fatal(err)
	}
	mem := []model.MemoryEntry{{ID: "m1", Text: "秘密的事", Source: "user"}}
	if err := r.e.UpdateReplica(bo.ID, usecase.ReplicaPatch{Memory: &mem}); err != nil {
		t.Fatal(err)
	}
	before := r.world().Replicas[bo.ID]
	moved, err := r.e.MoveReplica(bo.ID, model.StaffingID, r.owner.ID)
	if err != nil {
		t.Fatal(err)
	}
	w := r.world()
	got := w.Replicas[moved.ID]
	if w.Replicas[bo.ID] != nil || got == nil || got.ID == bo.ID || got.TeamID != model.StaffingID {
		t.Fatalf("moved = %+v, old still there: %v", got, w.Replicas[bo.ID] != nil)
	}
	if got.Name != "Bo" || got.Look != before.Look || got.Model != "fake" || got.Effort != "high" || len(got.Memory) != 0 {
		t.Fatalf("moved = %+v", got)
	}
	bp := w.Blueprints[got.BlueprintID]
	if bp == nil || bp.Owner != got.ID || bp.Prompt != "我的設定" || w.Blueprints[before.BlueprintID] != nil {
		t.Fatalf("own settings = %+v, old kept: %v", bp, w.Blueprints[before.BlueprintID] != nil)
	}
	if _, err := r.e.MoveReplica(bo.ID, model.StaffingID, r.owner.ID); err == nil {
		t.Fatal("moved twice")
	}
	if n := countNamed(r.world(), "Bo"); n != 1 {
		t.Fatalf("%d Bo", n)
	}
	// and back: a company employee again, still the same person to look at, and new once more
	back, err := r.e.MoveReplica(moved.ID, r.team.ID, "")
	if err != nil {
		t.Fatal(err)
	}
	if w := r.world(); w.Replicas[moved.ID] != nil || w.Replicas[back.ID].TeamID != r.team.ID || countNamed(w, "Bo") != 1 {
		t.Fatalf("back = %+v", w.Replicas[back.ID])
	}
}

// A company keeps one employee of its own whatever else is around, and a failed move changes nothing.
func TestTheLastEmployeeStays(t *testing.T) {
	t.Parallel()
	r := newRig(t, nil)
	hal, err := r.e.Hire(usecase.NewReplica{TeamID: model.StaffingID, BlueprintID: r.owner.BlueprintID, Name: "Hal", Model: "fake"})
	if err != nil {
		t.Fatal(err)
	}
	if err := r.e.Fire(r.owner.ID, hal.ID); err == nil {
		t.Fatal("fired the company's last employee")
	}
	if _, err := r.e.MoveReplica(r.owner.ID, model.StaffingID, hal.ID); err == nil {
		t.Fatal("moved the company's last employee out")
	}
	if _, err := r.e.MoveReplica(hal.ID, "team-nope", ""); err == nil {
		t.Fatal("moved into no company")
	}
	if _, err := r.e.MoveReplica(hal.ID, model.StaffingID, ""); err == nil {
		t.Fatal("moved within the agency")
	}
	w := r.world()
	if w.Replicas[r.owner.ID] == nil || w.Replicas[hal.ID] == nil || len(w.Replicas) != 2 {
		t.Fatalf("changed: %+v", w.Replicas)
	}
	// the agency may end up with nobody
	if err := r.e.Fire(hal.ID, ""); err != nil {
		t.Fatal(err)
	}
}

// An agency employee with work somewhere hands it to someone who can work there before going.
func TestStaffingHandsOverToSomeoneWhoCanWorkThere(t *testing.T) {
	t.Parallel()
	r := newRig(t, nil)
	other := secondTeam(t, r)
	hal, err := r.e.Hire(usecase.NewReplica{TeamID: model.StaffingID, BlueprintID: r.owner.BlueprintID, Name: "Hal", Model: "fake"})
	if err != nil {
		t.Fatal(err)
	}
	task, err := r.e.CreateTask(usecase.NewTask{TeamID: r.team.ID, Title: "x", WorkflowID: r.flow.ID, OwnerID: &hal.ID})
	if err != nil {
		t.Fatal(err)
	}
	if err := r.e.Fire(hal.ID, ""); err == nil {
		t.Fatal("left with work to hand over")
	}
	var cy string
	for _, x := range r.world().Replicas {
		if x.TeamID == other.ID {
			cy = x.ID
		}
	}
	if _, err := r.e.MoveReplica(hal.ID, other.ID, cy); err == nil {
		t.Fatal("handed to someone who cannot work at that company")
	}
	moved, err := r.e.MoveReplica(hal.ID, other.ID, r.owner.ID)
	if err != nil {
		t.Fatal(err)
	}
	w := r.world()
	if got := w.Tasks[task.ID].OwnerID; got == nil || *got != r.owner.ID {
		t.Fatalf("owner = %v", got)
	}
	if w.Replicas[moved.ID].TeamID != other.ID {
		t.Fatalf("moved = %+v", w.Replicas[moved.ID])
	}
	// a company employee may hand over to the agency, the company keeping someone of its own
	if err := r.e.Fire(moved.ID, r.owner.ID); err == nil {
		t.Fatal("a company employee left without an heir")
	}
}

type island struct {
	*rig
	bo *model.Replica
}

// sourceIsland has Bo, whose own settings take skills from a Git repo and from a folder on that computer.
func sourceIsland(t *testing.T) (*island, *skillsRepo, string) {
	t.Helper()
	r := newRig(t, nil)
	repo := newSkillsRepo(t, "tdd")
	src, err := r.e.AddSource(context.Background(), usecase.NewSource{Kind: "git", Repo: repo.dir, Ref: "main"})
	if err != nil {
		t.Fatal(err)
	}
	folder := t.TempDir()
	write := func(rel, text string) {
		path := filepath.Join(folder, rel)
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(text), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write("skills/lint/SKILL.md", "---\nname: lint\n---\nrun the linter")
	write("skills/lint/scripts/run.sh", "echo lint")
	write("skills/lint/.secret", "hidden")
	outside := filepath.Join(t.TempDir(), "outside.txt")
	if err := os.WriteFile(outside, []byte("not part of the skill"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(folder, "skills", "lint", "link.txt")); err != nil {
		t.Fatal(err)
	}
	local, err := r.e.AddSource(context.Background(), usecase.NewSource{Kind: "local", Path: folder})
	if err != nil {
		t.Fatal(err)
	}
	bo, err := r.e.Hire(usecase.NewReplica{TeamID: r.team.ID, Name: "Bo", Model: "fake", Effort: "high", Custom: &model.Blueprint{
		Prompt: "複製我", Tools: []enum.Tool{enum.ToolReadFile, enum.ToolRunCommand},
		Skills: []model.SkillPack{{SourceID: src.ID, Exclude: []string{}}, {SourceID: local.ID, Exclude: []string{}}}}})
	if err != nil {
		t.Fatal(err)
	}
	mem := []model.MemoryEntry{{ID: "m1", Text: "秘密的事", Source: "user"}}
	if err := r.e.UpdateReplica(bo.ID, usecase.ReplicaPatch{Memory: &mem}); err != nil {
		t.Fatal(err)
	}
	return &island{r, bo}, repo, folder
}

// Copying only where the skills come from: the Git repo is kept here as a source, the folder on the other computer is
// to be picked again, and nothing else of theirs comes.
func TestCopyKeepsGitSourcesAndAsksForFolders(t *testing.T) {
	t.Parallel()
	there, repo, folder := sourceIsland(t)
	before := there.world()
	x, err := there.e.ExportReplica(context.Background(), there.bo.ID, false)
	if err != nil {
		t.Fatal(err)
	}
	if len(x.Files) != 0 || len(x.Packs) != 2 || !slices.Equal(x.Packs[0].Skills, []string{"tdd"}) || !slices.Equal(x.Packs[1].Skills, []string{"lint"}) {
		t.Fatalf("export = %+v", x)
	}
	here := newRig(t, nil)
	res, err := here.e.CopyReplica(x, usecase.CopyOptions{Skills: usecase.SkillsSource})
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(res.Missing, []string{folder}) {
		t.Fatalf("missing = %v", res.Missing)
	}
	w := here.world()
	got := w.Replicas[res.Replica.ID]
	if got == nil || got.TeamID != model.StaffingID || got.Name != "Bo" || got.Look != there.bo.Look || got.Effort != "high" || len(got.Memory) != 0 {
		t.Fatalf("copy = %+v", got)
	}
	bp := w.Blueprints[got.BlueprintID]
	if bp.Prompt != "複製我" || !slices.Equal(bp.Tools, []enum.Tool{enum.ToolReadFile, enum.ToolRunCommand}) || len(bp.Skills) != 1 {
		t.Fatalf("settings = %+v", bp)
	}
	if s := w.Sources[bp.Skills[0].SourceID]; s == nil || s.Kind != "git" || s.Repo != repo.dir {
		t.Fatalf("source = %+v", s)
	}
	skills, err := here.e.BlueprintSkills(context.Background(), bp.ID)
	if err != nil || len(skills) != 1 || !slices.Equal(skills[0], []string{"tdd"}) {
		t.Fatalf("skills here = %v %v", skills, err)
	}
	// the other island is as it was
	after := there.world()
	if len(after.Replicas) != len(before.Replicas) || len(after.Replicas[there.bo.ID].Memory) != 1 || len(after.Sources) != len(before.Sources) {
		t.Fatal("the island copied from changed")
	}
}

// Copying the files brings the picked skills' own files only: no link out, nothing hidden, kept in this computer's
// data folder, and the skill is there to use.
func TestCopyBringsTheSkillFilesOnly(t *testing.T) {
	t.Parallel()
	there, _, _ := sourceIsland(t)
	x, err := there.e.ExportReplica(context.Background(), there.bo.ID, true)
	if err != nil {
		t.Fatal(err)
	}
	files := map[string]string{}
	for _, s := range x.Files {
		for _, f := range s.Files {
			files[s.Name+"/"+f.Path] = string(f.Data)
		}
	}
	if len(files) != 3 || files["lint/scripts/run.sh"] != "echo lint" || files["tdd/SKILL.md"] == "" || files["lint/link.txt"] != "" {
		t.Fatalf("files = %v", files)
	}
	here := newRig(t, nil)
	res, err := here.e.CopyReplica(x, usecase.CopyOptions{Skills: usecase.SkillsFiles})
	if err != nil || len(res.Missing) != 0 {
		t.Fatalf("%+v %v", res, err)
	}
	w := here.world()
	bp := w.Blueprints[w.Replicas[res.Replica.ID].BlueprintID]
	src := w.Sources[bp.Skills[0].SourceID]
	if len(bp.Skills) != 1 || src.Kind != "local" || !strings.HasPrefix(src.Path, here.data) {
		t.Fatalf("skills = %+v, source = %+v", bp.Skills, src)
	}
	skills, err := here.e.BlueprintSkills(context.Background(), bp.ID)
	if err != nil || len(skills) != 1 || !slices.Equal(skills[0], []string{"tdd", "lint"}) && !slices.Equal(skills[0], []string{"lint", "tdd"}) {
		t.Fatalf("skills here = %v %v", skills, err)
	}
	if raw, err := os.ReadFile(filepath.Join(src.Path, "skills", "lint", "scripts", "run.sh")); err != nil || string(raw) != "echo lint" {
		t.Fatalf("run.sh = %q %v", raw, err)
	}
}

// Files that would lead out of the folder, a model this island lacks and a level it does not take are refused, and
// leave nothing behind; the same request sent again hires nobody new.
func TestCopyRefusalsChangeNothing(t *testing.T) {
	t.Parallel()
	there, _, _ := sourceIsland(t)
	x, err := there.e.ExportReplica(context.Background(), there.bo.ID, true)
	if err != nil {
		t.Fatal(err)
	}
	here := newRig(t, nil)
	count := len(here.world().Replicas)
	for _, bad := range []string{"../escape.txt", "/etc/x", "a/../../b"} {
		y := x
		y.Files = []usecase.ExportSkill{{Name: "evil", Files: []usecase.ExportFile{{Path: "SKILL.md", Data: []byte("x")}, {Path: bad, Data: []byte("x")}}}}
		if _, err := here.e.CopyReplica(y, usecase.CopyOptions{Skills: usecase.SkillsFiles}); err == nil {
			t.Fatalf("%s was written", bad)
		}
	}
	y := x
	y.Files = []usecase.ExportSkill{{Name: "../up", Files: []usecase.ExportFile{{Path: "SKILL.md", Data: []byte("x")}}}}
	if _, err := here.e.CopyReplica(y, usecase.CopyOptions{Skills: usecase.SkillsFiles}); err == nil {
		t.Fatal("a skill named to lead out was written")
	}
	if _, err := os.Stat(filepath.Join(here.data, "escape.txt")); err == nil {
		t.Fatal("wrote outside")
	}
	if entries, _ := os.ReadDir(filepath.Join(here.data, "copied-skills")); len(entries) != 0 {
		t.Fatalf("left behind %d folders", len(entries))
	}
	x.Model = "gone"
	if _, err := here.e.CopyReplica(x, usecase.CopyOptions{}); err == nil {
		t.Fatal("copied on a model this island lacks")
	}
	if p := here.e.PreviewCopy(x); p.ModelOK || !slices.Contains(p.Models, "fake") {
		t.Fatalf("preview = %+v", p)
	}
	if _, err := here.e.CopyReplica(x, usecase.CopyOptions{Model: "fake", Effort: "max"}); err == nil {
		t.Fatal("copied on a level the model does not take")
	}
	if n := len(here.world().Replicas); n != count {
		t.Fatalf("%d employees, want %d", n, count)
	}
	one, err := here.e.CopyReplica(x, usecase.CopyOptions{Model: "fake", Effort: "low", Key: "k1"})
	if err != nil {
		t.Fatal(err)
	}
	two, err := here.e.CopyReplica(x, usecase.CopyOptions{Model: "fake", Effort: "low", Key: "k1"})
	if err != nil || two.Replica.ID != one.Replica.ID || len(here.world().Replicas) != count+1 {
		t.Fatalf("again: %+v %v", two, err)
	}
	if got := here.world().Replicas[one.Replica.ID]; got.Model != "fake" || got.Effort != "low" {
		t.Fatalf("copy = %+v", got)
	}
}

func plainExport() usecase.ReplicaExport {
	return usecase.ReplicaExport{Name: "Bo", Model: "fake", Effort: model.ThinkingDefault,
		Blueprint: usecase.ExportBlueprint{Name: "Dev", Prompt: "複製我", Tools: []string{}}, Packs: []usecase.ExportPack{}}
}

// A copy that went through but whose answer was lost is the same copy when sent again after a restart.
func TestCopyRetriedAfterARestartHiresNobodyNew(t *testing.T) {
	t.Parallel()
	r, _, reopen := diskRig(t)
	count := len(r.world().Replicas)
	one, err := r.e.CopyReplica(plainExport(), usecase.CopyOptions{Key: "peer\x00rep-1\x00k1"})
	if err != nil {
		t.Fatal(err)
	}
	reopen()
	two, err := r.e.CopyReplica(plainExport(), usecase.CopyOptions{Key: "peer\x00rep-1\x00k1"})
	if err != nil || two.Replica == nil || two.Replica.ID != one.Replica.ID {
		t.Fatalf("again: %+v %v", two, err)
	}
	if n := countNamed(r.world(), "Bo"); n != 1 || len(r.world().Replicas) != count+1 {
		t.Fatalf("%d named Bo", n)
	}
	// moved into a company in the meantime, they are still who that copy hired
	moved, err := r.e.MoveReplica(one.Replica.ID, r.team.ID, "")
	if err != nil {
		t.Fatal(err)
	}
	if again, err := r.e.CopyReplica(plainExport(), usecase.CopyOptions{Key: "peer\x00rep-1\x00k1"}); err != nil || again.Replica.ID != moved.ID || countNamed(r.world(), "Bo") != 1 {
		t.Fatalf("after the move: %+v %v", again, err)
	}
	// another copy is someone else
	three, err := r.e.CopyReplica(plainExport(), usecase.CopyOptions{Key: "peer\x00rep-1\x00k2"})
	if err != nil || three.Replica.ID == one.Replica.ID || countNamed(r.world(), "Bo") != 2 {
		t.Fatalf("another: %+v %v", three, err)
	}
}

// A copy whose employee was let go since is not made again by the same request, after a restart too: the request is
// remembered apart from whoever it hired.
func TestCopyOfSomeoneLetGoIsNotMadeAgain(t *testing.T) {
	t.Parallel()
	r, _, reopen := diskRig(t)
	one, err := r.e.CopyReplica(plainExport(), usecase.CopyOptions{Key: "k1"})
	if err != nil {
		t.Fatal(err)
	}
	if err := r.e.Fire(one.Replica.ID, ""); err != nil {
		t.Fatal(err)
	}
	reopen()
	count := len(r.world().Replicas)
	if _, err := r.e.CopyReplica(plainExport(), usecase.CopyOptions{Key: "k1"}); codeOf(err) != model.CodeConflict {
		t.Fatalf("sent again: %v", err)
	}
	if w := r.world(); countNamed(w, "Bo") != 0 || len(w.Replicas) != count {
		t.Fatal("the same request hired someone again")
	}
}

// Moved first and then let go, the copy is not made again either.
func TestCopyMovedAndLetGoIsNotMadeAgain(t *testing.T) {
	t.Parallel()
	r, _, reopen := diskRig(t)
	one, err := r.e.CopyReplica(plainExport(), usecase.CopyOptions{Key: "k1"})
	if err != nil {
		t.Fatal(err)
	}
	moved, err := r.e.MoveReplica(one.Replica.ID, r.team.ID, "")
	if err != nil {
		t.Fatal(err)
	}
	reopen()
	if err := r.e.Fire(moved.ID, r.owner.ID); err != nil {
		t.Fatal(err)
	}
	reopen()
	if _, err := r.e.CopyReplica(plainExport(), usecase.CopyOptions{Key: "k1"}); codeOf(err) != model.CodeConflict {
		t.Fatalf("sent again: %v", err)
	}
	if countNamed(r.world(), "Bo") != 0 {
		t.Fatal("the same request hired someone again")
	}
}

// The same copy sent at once from several places while a save fails: the one that failed leaves nothing to find, the
// others hire one employee between them, and every answer names someone who is there.
func TestCopySentTogetherWhileASaveFailsHiresOnce(t *testing.T) {
	t.Parallel()
	for round := 0; round < 20; round++ {
		t.Run(fmt.Sprint(round), func(t *testing.T) {
			t.Parallel()
			r, disk, _ := diskRig(t)
			disk.fails.Store(1)
			var wg sync.WaitGroup
			results := make([]usecase.CopyResult, 8)
			errs := make([]error, len(results))
			for i := range results {
				wg.Add(1)
				go func() {
					defer wg.Done()
					results[i], errs[i] = r.e.CopyReplica(plainExport(), usecase.CopyOptions{Key: "k"})
				}()
			}
			wg.Wait()
			w := r.world()
			if n := countNamed(w, "Bo"); n != 1 {
				t.Fatalf("%d named Bo", n)
			}
			failed := 0
			for i, res := range results {
				if errs[i] != nil {
					failed++
					continue
				}
				if w.Replicas[res.Replica.ID] == nil {
					t.Fatalf("answered with %s, who was never saved", res.Replica.ID)
				}
			}
			if failed != 1 {
				t.Fatalf("%d failed", failed)
			}
		})
	}
}

// A copy whose save failed is not remembered: sent again it hires, once, and stays after a restart.
func TestCopyThatFailedToSaveIsMadeOnRetry(t *testing.T) {
	t.Parallel()
	r, disk, reopen := diskRig(t)
	disk.broken.Store(true)
	if _, err := r.e.CopyReplica(plainExport(), usecase.CopyOptions{Key: "k"}); err == nil {
		t.Fatal("a copy that was not saved was made")
	}
	disk.broken.Store(false)
	res, err := r.e.CopyReplica(plainExport(), usecase.CopyOptions{Key: "k"})
	if err != nil || r.world().Replicas[res.Replica.ID] == nil {
		t.Fatalf("%+v %v", res, err)
	}
	reopen()
	if w := r.world(); w.Replicas[res.Replica.ID] == nil || countNamed(w, "Bo") != 1 {
		t.Fatal("the copy was not kept")
	}
}

// A model picked in place of theirs comes with a level picked for it too: theirs is kept only where it is taken, and
// none is put in its place.
func TestCopyNeverPicksALevel(t *testing.T) {
	t.Parallel()
	r := newRig(t, nil)
	x := plainExport()
	x.Model, x.Effort = "gone", "max"
	if _, err := r.e.CopyReplica(x, usecase.CopyOptions{Model: "fake"}); err == nil {
		t.Fatal("copied on a level put in place of theirs")
	}
	if countNamed(r.world(), "Bo") != 0 {
		t.Fatal("hired")
	}
}

// folderIsland has Bo, whose skills come from the folder source made by lay; lay gets the source folder and one
// outside it.
func folderIsland(t *testing.T, lay func(source, outside string) string) (*rig, *model.Replica) {
	t.Helper()
	r := newRig(t, nil)
	source := lay(t.TempDir(), t.TempDir())
	local, err := r.e.AddSource(context.Background(), usecase.NewSource{Kind: "local", Path: source})
	if err != nil {
		t.Fatal(err)
	}
	bo, err := r.e.Hire(usecase.NewReplica{TeamID: r.team.ID, Name: "Bo", Model: "fake", Custom: &model.Blueprint{
		Prompt: "複製我", Skills: []model.SkillPack{{SourceID: local.ID, Exclude: []string{}}}}})
	if err != nil {
		t.Fatal(err)
	}
	return r, bo
}

func put(t *testing.T, path, text string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(text), 0o644); err != nil {
		t.Fatal(err)
	}
}

func link(t *testing.T, to, at string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(at), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(to, at); err != nil {
		t.Fatal(err)
	}
}

func exportedText(x usecase.ReplicaExport) string {
	var b strings.Builder
	for _, s := range x.Files {
		for _, f := range s.Files {
			b.WriteString(s.Name + "/" + f.Path + "=" + string(f.Data) + "\n")
		}
	}
	return b.String()
}

// A skill reached through a link that leads out of the folder picked, at the skill or above it, does not bring what
// is out there: the copy with files is refused. A folder picked that is itself a link is that folder.
func TestExportStaysInsideTheSkillSource(t *testing.T) {
	t.Parallel()
	for name, lay := range map[string]func(source, outside string) string{
		"the skills folder links out": func(source, outside string) string {
			put(t, filepath.Join(outside, "lint", "SKILL.md"), "---\nname: lint\n---\nx")
			put(t, filepath.Join(outside, "lint", "secret.txt"), "outside")
			link(t, outside, filepath.Join(source, "skills"))
			return source
		},
		"the skill links out": func(source, outside string) string {
			put(t, filepath.Join(outside, "SKILL.md"), "---\nname: lint\n---\nx")
			put(t, filepath.Join(outside, "secret.txt"), "outside")
			link(t, outside, filepath.Join(source, "skills", "lint"))
			return source
		},
	} {
		t.Run(name, func(t *testing.T) {
			r, bo := folderIsland(t, lay)
			x, err := r.e.ExportReplica(context.Background(), bo.ID, true)
			if err == nil || strings.Contains(exportedText(x), "outside") {
				t.Fatalf("exported %q, %v", exportedText(x), err)
			}
			// where they come from can still be copied
			if _, err := r.e.ExportReplica(context.Background(), bo.ID, false); err != nil {
				t.Fatal(err)
			}
		})
	}
	t.Run("the folder picked is a link", func(t *testing.T) {
		r, bo := folderIsland(t, func(source, outside string) string {
			put(t, filepath.Join(outside, "skills", "lint", "SKILL.md"), "---\nname: lint\n---\nx")
			put(t, filepath.Join(outside, "skills", "lint", "run.sh"), "echo")
			at := filepath.Join(source, "picked")
			link(t, outside, at)
			return at
		})
		x, err := r.e.ExportReplica(context.Background(), bo.ID, true)
		if err != nil || !strings.Contains(exportedText(x), "lint/run.sh=echo") {
			t.Fatalf("exported %q, %v", exportedText(x), err)
		}
	})
}

// A folder source that is a Git checkout, with a token in its remote and credential files beside the skill, brings the
// skill's own files and none of those; the folder's remote is never asked for.
func TestExportOfAFolderLeavesItsCredentials(t *testing.T) {
	t.Parallel()
	r, bo := folderIsland(t, func(source, _ string) string {
		put(t, filepath.Join(source, ".git", "config"), "[remote \"origin\"]\n\turl = https://x-access-token:ghp_TOKEN@github.com/me/private.git\n")
		put(t, filepath.Join(source, ".git-credentials"), "https://me:ghp_TOKEN@github.com")
		put(t, filepath.Join(source, "skills", "lint", "SKILL.md"), "---\nname: lint\n---\nx")
		put(t, filepath.Join(source, "skills", "lint", ".env"), "TOKEN=ghp_TOKEN")
		put(t, filepath.Join(source, "skills", "lint", ".git", "config"), "url = https://ghp_TOKEN@github.com/me/private.git")
		put(t, filepath.Join(source, "skills", "other.txt"), "ghp_TOKEN beside the skill")
		return source
	})
	for _, files := range []bool{false, true} {
		x, err := r.e.ExportReplica(context.Background(), bo.ID, files)
		if err != nil {
			t.Fatal(err)
		}
		raw, _ := json.Marshal(x)
		if strings.Contains(string(raw), "ghp_TOKEN") || strings.Contains(string(raw), "private.git") {
			t.Fatalf("export carries a credential: %s", raw)
		}
		if files && exportedText(x) != "lint/SKILL.md=---\nname: lint\n---\nx\n" {
			t.Fatalf("files = %q", exportedText(x))
		}
	}
}

// A token written into a repo's address as its user, or in its query, goes without it too.
func TestExportLeavesTokensInAddressesOut(t *testing.T) {
	t.Parallel()
	r := newRig(t, nil)
	bo, err := r.e.Hire(usecase.NewReplica{TeamID: r.team.ID, Name: "Bo", Model: "fake", Custom: &model.Blueprint{
		Source: model.BlueprintSource{Kind: "git", Repo: "https://ghp_TOKEN@git.example.com/x.git", Commit: "abc"},
		Skills: []model.SkillPack{{Source: &model.BlueprintSource{Kind: "git", Repo: "https://git.example.com/y.git?private_token=ghp_TOKEN", Ref: "main", Commit: "abc"}, Exclude: []string{}}}}})
	if err != nil {
		t.Fatal(err)
	}
	x, err := r.e.ExportReplica(context.Background(), bo.ID, false)
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := json.Marshal(x)
	if strings.Contains(string(raw), "ghp_TOKEN") || x.Packs[0].Repo != "https://git.example.com/y.git" || x.Blueprint.Source.Repo != "https://git.example.com/x.git" {
		t.Fatalf("export = %s", raw)
	}
}

// An address with a user and password in it goes without them.
func TestExportLeavesCredentialsOut(t *testing.T) {
	t.Parallel()
	r := newRig(t, nil)
	bo, err := r.e.Hire(usecase.NewReplica{TeamID: r.team.ID, Name: "Bo", Model: "fake", Custom: &model.Blueprint{
		Source: model.BlueprintSource{Kind: "git", Repo: "https://me:hunter2@git.example.com/x.git", Commit: "abc"},
		Skills: []model.SkillPack{{Source: &model.BlueprintSource{Kind: "git", Repo: "https://me:hunter2@git.example.com/y.git", Ref: "main", Commit: "abc"}, Exclude: []string{}}}}})
	if err != nil {
		t.Fatal(err)
	}
	x, err := r.e.ExportReplica(context.Background(), bo.ID, false)
	if err != nil {
		t.Fatal(err)
	}
	raw := x.Blueprint.Source.Repo + x.Packs[0].Repo
	if strings.Contains(raw, "hunter2") || strings.Contains(raw, "me@") || x.Packs[0].Repo != "https://git.example.com/y.git" {
		t.Fatalf("export = %+v", x)
	}
}
