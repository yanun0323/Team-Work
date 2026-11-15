package tools

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
	"testing"
)

func TestReadOnlyCommandsAreKnownForSure(t *testing.T) {
	for _, cmd := range []string{
		"pwd", "ls -la", "git status", "git status --short", "git diff HEAD~1 -- a.go", "git log --oneline -5", "git log --format=%H -1",
		"git show HEAD:a.go", "git rev-parse HEAD", `rg -n "foo.*bar" internal`, `grep -rn 'a > b' .`, "cat a.go | head -20",
		"wc -l a.go b.go; ls", "find . -name a.go", "tail -n 5 log.txt", "cd backend; ls", "date +%s",
	} {
		if !readOnly(cmd) {
			t.Errorf("%q counted as writing", cmd)
		}
	}
	for _, cmd := range []string{
		"", "  ", "echo x > a.go", "cat a >> b", "ls 2>&1", "ls && rm a", "ls || touch a", "ls & rm a", "rm a", "touch a", "sed -i s/a/b/ a.go",
		"git checkout .", "git stash", "git -C x status", "git diff --output=x.patch", "git log --output x", "rg --pre ./run x", "rg --pre=./run x",
		"find . -delete", "find . -exec rm {} ;", "echo $(rm a)", "echo `rm a`", `echo "$(rm a)"`, "ls *.go", "FOO=1 ls", "cat a | tee b",
		"cat a | sh", "ls; make", "(ls)", "{ ls; }", "ls \\\n rm", "diff -o x a b", "date 0101", "ls ~", "go test ./...", "npm run build", "ls 'unclosed",
		"python3 -c 'print(1)'", "xargs rm", "ls # comment", "echo a\nrm a",
	} {
		if readOnly(cmd) {
			t.Errorf("%q counted as reading only", cmd)
		}
	}
}

// A command that surely only reads does not set off a scan; one that may write still does.
func TestCommandTellsWhatMayHaveChanged(t *testing.T) {
	dir := t.TempDir()
	var mu sync.Mutex
	var heard []string
	cmd := Command{Changed: func(path, source string) { mu.Lock(); heard = append(heard, source); mu.Unlock() }}
	run := func(c string) {
		raw, _ := json.Marshal(map[string]string{"command": c})
		if r := cmd.Run(context.Background(), dir, raw); r.IsError {
			t.Fatalf("%s: %s", c, r.Text)
		}
	}
	run("ls")
	run("pwd; ls -la")
	if len(heard) != 0 {
		t.Fatalf("%v", heard)
	}
	run(`sh -c "echo x > a.go"`)
	if len(heard) != 1 || heard[0] != "run_command" {
		t.Fatalf("%v", heard)
	}
	if b, _ := os.ReadFile(filepath.Join(dir, "a.go")); string(b) != "x\n" {
		t.Fatalf("%q", b)
	}
}
