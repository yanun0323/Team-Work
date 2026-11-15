//go:build unix

package tools

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"syscall"
	"testing"
	"time"
)

// guarded runs body in a child test process killed after a hard limit, so a read that blocks fails the test instead
// of hanging it.
func guarded(t *testing.T, body func(t *testing.T)) {
	t.Helper()
	if os.Getenv("TOOLS_GUARDED") == t.Name() {
		body(t)
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, os.Args[0], "-test.run=^"+regexp.QuoteMeta(t.Name())+"$", "-test.v", "-test.count=1")
	cmd.Env = append(os.Environ(), "TOOLS_GUARDED="+t.Name())
	out, err := cmd.CombinedOutput()
	if ctx.Err() != nil {
		t.Fatalf("the child did not finish in time:\n%s", out)
	}
	if err != nil || !strings.Contains(string(out), "--- PASS: "+t.Name()) {
		t.Fatalf("child: %v\n%s", err, out)
	}
}

// A pipe nothing writes to is refused at once, by read_file and by exec alike, also through a link: opening it must
// not wait for a writer.
func TestReadRefusesAPipeWithoutWaiting(t *testing.T) {
	guarded(t, func(t *testing.T) {
		cwd := t.TempDir()
		if err := syscall.Mkfifo(filepath.Join(cwd, "pipe"), 0o644); err != nil {
			t.Fatal(err)
		}
		if err := os.Symlink("pipe", filepath.Join(cwd, "link")); err != nil {
			t.Fatal(err)
		}
		for _, path := range []string{"pipe", "link"} {
			started := time.Now()
			res := Read{}.Run(context.Background(), cwd, args(map[string]any{"path": path}))
			if !res.IsError || res.Text != path+" is not a regular file" {
				t.Fatalf("%s: %+v", path, res)
			}
			_, err := Read{}.Structured(context.Background(), cwd, args(map[string]any{"path": path}))
			if err == nil || err.Error() != path+" is not a regular file" {
				t.Fatalf("%s: %v", path, err)
			}
			if d := time.Since(started); d > 2*time.Second {
				t.Fatalf("%s took %s", path, d)
			}
		}
	})
}

// Reading counts every line of the file, so a stopped read ends there instead of going on to the end of a long file.
func TestReadStopsWhenItsContextEnds(t *testing.T) {
	cwd := t.TempDir()
	if err := os.WriteFile(filepath.Join(cwd, "long.txt"), []byte(strings.Repeat("line\n", 100000)), 0o644); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if v, err := (Read{}).Structured(ctx, cwd, args(map[string]any{"path": "long.txt"})); err == nil {
		t.Fatalf("read on: %+v", v)
	}
	if res := (Read{}).Run(ctx, cwd, args(map[string]any{"path": "long.txt"})); !res.IsError {
		t.Fatalf("read on: %d bytes", len(res.Text))
	}
	if v, err := (Read{}).Structured(context.Background(), cwd, args(map[string]any{"path": "long.txt", "limit": 1})); err != nil || v.(FileText).TotalLines != 100000 {
		t.Fatalf("%+v %v", v, err)
	}
}
