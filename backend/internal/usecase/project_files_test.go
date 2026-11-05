package usecase_test

import (
	"crypto/sha256"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/yanun0323/Team-Work/internal/model"
)

func projectCode(t *testing.T, err error, code string) {
	t.Helper()
	var known *model.Error
	if !errors.As(err, &known) || known.Code != code {
		t.Fatalf("got %v, want %s", err, code)
	}
}

func TestProjectTreeListsOnlyOneLevelAndIncludesHiddenEntries(t *testing.T) {
	r := newRig(t, func(model.ModelRequest) (model.ModelReply, error) { return say("好"), nil })
	parent := filepath.Join(r.folder, "browse")
	for _, name := range []string{".git", "node_modules", "dist", ".cache", ".tmp", "Zdir"} {
		if err := os.MkdirAll(filepath.Join(parent, name, "nested"), 0755); err != nil {
			t.Fatal(err)
		}
	}
	for _, name := range []string{".hidden", "a.txt", "B.txt", "ignored"} {
		if err := os.WriteFile(filepath.Join(parent, name), []byte("hello"), 0644); err != nil {
			t.Fatal(err)
		}
	}
	for name, target := range map[string]string{"linked": filepath.Join(parent, "Zdir"), "outside": t.TempDir(), "broken": filepath.Join(parent, "absent")} {
		if err := os.Symlink(target, filepath.Join(parent, name)); err != nil {
			t.Fatal(err)
		}
	}
	tree, err := r.e.ProjectTree(r.team.ID, "browse")
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, entry := range tree.Entries {
		names = append(names, entry.Kind+":"+entry.Name)
		if entry.Path != "browse/"+entry.Name {
			t.Fatalf("bad path: %+v", entry)
		}
	}
	want := "dir:.cache dir:.git dir:.tmp dir:dist dir:linked dir:node_modules dir:Zdir file:.hidden file:a.txt file:B.txt file:broken file:ignored file:outside"
	if strings.Join(names, " ") != want || tree.Truncated {
		t.Fatalf("%+v", tree)
	}
	empty, err := r.e.ProjectTree(r.team.ID, "browse/Zdir/nested")
	if err != nil || empty.Entries == nil || len(empty.Entries) != 0 {
		t.Fatalf("%+v %v", empty, err)
	}
	for _, rel := range []string{"../", "browse/../browse", parent, "browse/outside"} {
		_, err := r.e.ProjectTree(r.team.ID, rel)
		projectCode(t, err, model.CodeInvalid)
	}
	_, err = r.e.ProjectTree(r.team.ID, "browse/a.txt")
	projectCode(t, err, model.CodeInvalid)
	_, err = r.e.ProjectTree(r.team.ID, "missing")
	projectCode(t, err, model.CodeNotFound)
	_, err = r.e.ProjectTree("missing", "")
	projectCode(t, err, model.CodeNotFound)
	_, err = r.e.ProjectTree("", "")
	projectCode(t, err, model.CodeNotFound)
}

func TestProjectTreeTruncatesAfterSorting(t *testing.T) {
	r := newRig(t, func(model.ModelRequest) (model.ModelReply, error) { return say("好"), nil })
	parent := filepath.Join(r.folder, "many")
	if err := os.Mkdir(parent, 0755); err != nil {
		t.Fatal(err)
	}
	for i := 5000; i >= 0; i-- {
		if err := os.WriteFile(filepath.Join(parent, fmt.Sprintf("%04d", i)), nil, 0644); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.Mkdir(filepath.Join(parent, "z-directory"), 0755); err != nil {
		t.Fatal(err)
	}
	got, err := r.e.ProjectTree(r.team.ID, "many")
	if err != nil || !got.Truncated || len(got.Entries) != 5000 || got.Entries[0].Name != "z-directory" || got.Entries[4999].Name != "4998" {
		t.Fatalf("len=%d truncated=%v err=%v", len(got.Entries), got.Truncated, err)
	}
}

func TestProjectSaveUsesRawHashPreservesModeAndRefusesStaleWrites(t *testing.T) {
	r := newRig(t, func(model.ModelRequest) (model.ModelReply, error) { return say("好"), nil })
	at := filepath.Join(r.folder, "run.sh")
	original := "echo hello\r\n"
	if err := os.WriteFile(at, []byte(original), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(at, filepath.Join(r.folder, "alias")); err != nil {
		t.Fatal(err)
	}
	read, err := r.e.ProjectFile(r.team.ID, "run.sh")
	if err != nil || read.Text != original || read.Hash != fmt.Sprintf("%x", sha256.Sum256([]byte(original))) {
		t.Fatalf("%+v %v", read, err)
	}
	next := "echo 世界\r\n"
	hash, err := r.e.SaveProjectFile(r.team.ID, "alias", next, read.Hash)
	if err != nil || hash != fmt.Sprintf("%x", sha256.Sum256([]byte(next))) {
		t.Fatalf("%s %v", hash, err)
	}
	data, _ := os.ReadFile(at)
	info, _ := os.Stat(at)
	link, _ := os.Lstat(filepath.Join(r.folder, "alias"))
	if string(data) != next || info.Mode().Perm() != 0755 || link.Mode()&os.ModeSymlink == 0 {
		t.Fatal("save changed bytes, permissions or symlink")
	}
	_, err = r.e.SaveProjectFile(r.team.ID, "run.sh", "stale", read.Hash)
	projectCode(t, err, model.CodeConflict)
	data, _ = os.ReadFile(at)
	if string(data) != next {
		t.Fatal("stale write overwrote file")
	}
	if err := os.Remove(at); err != nil {
		t.Fatal(err)
	}
	_, err = r.e.SaveProjectFile(r.team.ID, "run.sh", "gone", hash)
	projectCode(t, err, model.CodeConflict)
}

func TestProjectCreateAndSaveValidation(t *testing.T) {
	r := newRig(t, func(model.ModelRequest) (model.ModelReply, error) { return say("好"), nil })
	for _, kind := range []string{"dir", "file"} {
		got, err := r.e.CreateProjectEntry(r.team.ID, "", kind, kind)
		if err != nil || got.Path != kind || got.Name != kind || got.Kind != kind {
			t.Fatalf("%+v %v", got, err)
		}
		_, err = r.e.CreateProjectEntry(r.team.ID, "", kind, kind)
		projectCode(t, err, model.CodeConflict)
	}
	for _, name := range []string{"", " ", ".", "..", "a/b", "a\\b", "a\x00b", "a\nb", strings.Repeat("世", 86)} {
		_, err := r.e.CreateProjectEntry(r.team.ID, "", name, "file")
		projectCode(t, err, model.CodeInvalid)
	}
	_, err := r.e.CreateProjectEntry(r.team.ID, "", "good", "other")
	projectCode(t, err, model.CodeInvalid)
	_, err = r.e.CreateProjectEntry(r.team.ID, "missing", "good", "file")
	projectCode(t, err, model.CodeNotFound)
	_, err = r.e.CreateProjectEntry(r.team.ID, "file", "good", "file")
	projectCode(t, err, model.CodeInvalid)
	_, err = r.e.CreateProjectEntry("", "", "good", "file")
	projectCode(t, err, model.CodeNotFound)
	for _, tc := range []struct{ path, text, hash, code string }{
		{"file", "ok", "", model.CodeInvalid},
		{"file", "ok", "not-a-hash", model.CodeInvalid},
		{"file", strings.Repeat("x", 1<<20+1), fmt.Sprintf("%x", sha256.Sum256(nil)), model.CodeInvalid},
		{"file", "a\x00b", fmt.Sprintf("%x", sha256.Sum256(nil)), model.CodeInvalid},
		{"dir", "x", fmt.Sprintf("%x", sha256.Sum256(nil)), model.CodeInvalid},
		{"", "x", fmt.Sprintf("%x", sha256.Sum256(nil)), model.CodeInvalid},
	} {
		_, err := r.e.SaveProjectFile(r.team.ID, tc.path, tc.text, tc.hash)
		projectCode(t, err, tc.code)
	}
	for name, raw := range map[string][]byte{"binary": {0, 1}, "nonutf8": {0xff}, "large": []byte(strings.Repeat("x", 1<<20+1))} {
		if err := os.WriteFile(filepath.Join(r.folder, name), raw, 0644); err != nil {
			t.Fatal(err)
		}
		_, err := r.e.ProjectFile(r.team.ID, name)
		projectCode(t, err, model.CodeUnsupported)
		_, err = r.e.SaveProjectFile(r.team.ID, name, "x", fmt.Sprintf("%x", sha256.Sum256(raw)))
		projectCode(t, err, model.CodeUnsupported)
	}
	// Names with surrounding spaces must round-trip without selecting a different file.
	got, err := r.e.CreateProjectEntry(r.team.ID, "dir", " spaced ", "file")
	if err != nil {
		t.Fatal(err)
	}
	read, err := r.e.ProjectFile(r.team.ID, got.Path)
	if err != nil || read.Text != "" {
		t.Fatalf("%+v %v", read, err)
	}
}

func TestProjectMutationsRejectTraversalAndEscapingSymlinks(t *testing.T) {
	r := newRig(t, func(model.ModelRequest) (model.ModelReply, error) { return say("好"), nil })
	outside := t.TempDir()
	at := filepath.Join(outside, "secret")
	if err := os.WriteFile(at, []byte("secret"), 0644); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(r.folder, "away")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(at, filepath.Join(r.folder, "link")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(outside, "absent"), filepath.Join(r.folder, "broken")); err != nil {
		t.Fatal(err)
	}
	hash := fmt.Sprintf("%x", sha256.Sum256([]byte("secret")))
	for _, rel := range []string{at, "../secret", "away/secret", "link", "away/../secret"} {
		_, err := r.e.SaveProjectFile(r.team.ID, rel, "changed", hash)
		projectCode(t, err, model.CodeInvalid)
	}
	for _, parent := range []string{outside, "../", "away", "away/../"} {
		for _, kind := range []string{"dir", "file"} {
			_, err := r.e.CreateProjectEntry(r.team.ID, parent, "new", kind)
			projectCode(t, err, model.CodeInvalid)
		}
	}
	for _, name := range []string{"link", "broken"} {
		_, err := r.e.CreateProjectEntry(r.team.ID, "", name, "file")
		projectCode(t, err, model.CodeConflict)
	}
	raw, _ := os.ReadFile(at)
	if string(raw) != "secret" {
		t.Fatal("outside file changed")
	}
	if _, err := os.Stat(filepath.Join(outside, "new")); !os.IsNotExist(err) {
		t.Fatal("created outside")
	}
}

func TestProjectConcurrentSavesAndCreatesHaveOneWinner(t *testing.T) {
	r := newRig(t, func(model.ModelRequest) (model.ModelReply, error) { return say("好"), nil })
	for _, op := range []string{"create", "save"} {
		var wg sync.WaitGroup
		results := make(chan error, 2)
		for i := 0; i < 2; i++ {
			wg.Add(1)
			go func(i int) {
				defer wg.Done()
				var err error
				if op == "create" {
					_, err = r.e.CreateProjectEntry(r.team.ID, "", "race", "file")
				} else {
					_, err = r.e.SaveProjectFile(r.team.ID, "race", fmt.Sprint(i), fmt.Sprintf("%x", sha256.Sum256(nil)))
				}
				results <- err
			}(i)
		}
		wg.Wait()
		close(results)
		wins := 0
		for err := range results {
			if err == nil {
				wins++
			} else {
				projectCode(t, err, model.CodeConflict)
			}
		}
		if wins != 1 {
			t.Fatalf("%s winners: %d", op, wins)
		}
	}
}

func TestProjectBrowserBoundaryAndInRootDirectorySymlink(t *testing.T) {
	r := newRig(t, func(model.ModelRequest) (model.ModelReply, error) { return say("好"), nil })
	if err := os.Mkdir(filepath.Join(r.folder, "actual"), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(r.folder, "actual"), filepath.Join(r.folder, "alias")); err != nil {
		t.Fatal(err)
	}
	got, err := r.e.CreateProjectEntry(r.team.ID, "alias", "file", "file")
	if err != nil || got.Path != "alias/file" {
		t.Fatalf("%+v %v", got, err)
	}
	tree, err := r.e.ProjectTree(r.team.ID, "alias")
	if err != nil || len(tree.Entries) != 1 || tree.Entries[0].Path != "alias/file" {
		t.Fatalf("%+v %v", tree, err)
	}
	text := strings.Repeat("x", 1<<20)
	hash, err := r.e.SaveProjectFile(r.team.ID, "alias/file", text, fmt.Sprintf("%x", sha256.Sum256(nil)))
	if err != nil {
		t.Fatal(err)
	}
	read, err := r.e.ProjectFile(r.team.ID, "actual/file")
	if err != nil || read.Text != text || read.Hash != hash {
		t.Fatalf("len=%d hash=%s err=%v", len(read.Text), read.Hash, err)
	}
	_, err = r.e.SaveProjectFile(r.team.ID, "actual/file", "", hash)
	if err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(filepath.Join(r.folder, "actual", "file"))
	if err != nil || len(raw) != 0 {
		t.Fatalf("empty save: len=%d err=%v", len(raw), err)
	}
}

func TestProjectTreeDoesNotReadUnexpandedDirectory(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("root bypasses directory permissions")
	}
	r := newRig(t, func(model.ModelRequest) (model.ModelReply, error) { return say("好"), nil })
	parent := filepath.Join(r.folder, "unexpanded")
	if err := os.Mkdir(parent, 0000); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := os.Chmod(parent, 0755); err != nil {
			t.Error(err)
		}
	})
	tree, err := r.e.ProjectTree(r.team.ID, "")
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range tree.Entries {
		if entry.Name == "unexpanded" && entry.Kind == "dir" {
			return
		}
	}
	t.Fatal("unexpanded directory missing")
}
