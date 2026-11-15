package tools

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"testing"
)

func TestReadOnlyCommandsAreKnownForSure(t *testing.T) {
	for _, cmd := range []string{
		"pwd", "ls -la", "git status", "git status --short", "git status -sb", "git log --oneline -5", "git log --format=%H -1", "git log -n 3 -- a.go",
		"git rev-parse HEAD", "git rev-parse --show-toplevel", "git ls-files", "rg -n -A3 foo", "rg --glob '*.go' foo", "rg -t go -i foo .",
		"find . -name a.go -type f", "find . -mtime -5", "tree -L 2 -a", "file -b a.go", "diff -u a b", `rg -n "foo.*bar" internal`, `grep -rn 'a > b' .`, "cat a.go | head -20",
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
		// options that write or run a program, alone or among others, and anything not known to be safe
		"tree -o out.txt", "tree -a -o out.txt", "tree -ao out.txt", "file -C -m magic", "file -z a.gz", "rg -z foo", "rg -nz foo",
		"rg --pre=./run x", "rg --search-zip foo", "find . -fprint out", "find . -newer a -delete", "diff --output=x a b",
		"git grep -O./writer pattern", "git grep -Oless x", "git grep foo", "git diff", "git diff HEAD~1 -- a.go", "git show HEAD:a.go",
		"git show", "git blame a.go", "git log -p", "git log --stat", "git log --ext-diff -p", "git status --porcelain=v2 -o x",
		"git rev-parse --git-path x --output y", "ls; tree -o x", "cat a | file -C -m m", "sort -o out a", "tree --outfile x",
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

// git diff runs a program of the repository's own when its config says so; it is not counted as only reading.
func TestGitDiffWithAProgramOfItsOwnSaysItChanged(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("no git")
	}
	dir := t.TempDir()
	writer := filepath.Join(dir, "writer.sh")
	if err := os.WriteFile(writer, []byte("#!/bin/sh\necho written > \""+filepath.Join(dir, "by-diff.txt")+"\"\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	for _, c := range []string{"git init -q", "git config diff.external " + writer, "git config user.email a@b", "git config user.name a",
		"echo a > a.txt", "git add a.txt", "git commit -qm a", "echo b > a.txt"} {
		cmd := exec.Command("sh", "-c", c)
		cmd.Dir = dir
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("%s: %v %s", c, err, out)
		}
	}
	var heard []string
	cmd := Command{Changed: func(_, source string) { heard = append(heard, source) }}
	raw, _ := json.Marshal(map[string]string{"command": "git diff"})
	cmd.Run(context.Background(), dir, raw)
	if _, err := os.Stat(filepath.Join(dir, "by-diff.txt")); err != nil {
		t.Fatal("the external diff did not run, so this proves nothing")
	}
	if len(heard) != 1 {
		t.Fatalf("a git diff that ran a program of its own was taken as only reading: %v", heard)
	}
	heard = nil
	raw, _ = json.Marshal(map[string]string{"command": "tree -o listing.txt"})
	cmd.Run(context.Background(), dir, raw)
	if len(heard) != 1 {
		t.Fatalf("tree -o: %v", heard)
	}
}
