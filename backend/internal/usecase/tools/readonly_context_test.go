package tools

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// isolate keeps git and rg from reading this machine's own config: HOME and XDG_CONFIG_HOME go to an empty folder,
// and nothing in the environment points either of them at a config of its own.
func isolate(t *testing.T) {
	t.Helper()
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("XDG_CONFIG_HOME", home)
	t.Setenv("RIPGREP_CONFIG_PATH", "")
	for _, kv := range os.Environ() {
		if k, _, _ := strings.Cut(kv, "="); strings.HasPrefix(k, "GIT_") {
			t.Setenv(k, "")
			os.Unsetenv(k)
		}
	}
}

func sh(t *testing.T, dir string, lines ...string) string {
	t.Helper()
	var last string
	for _, c := range lines {
		cmd := exec.Command("sh", "-c", c)
		cmd.Dir = dir
		out, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("%s: %v %s", c, err, out)
		}
		last = strings.TrimSpace(string(out))
	}
	return last
}

// repo makes a git repository in dir with one commit of a.txt.
func repo(t *testing.T, dir string) {
	t.Helper()
	sh(t, dir, "git init -q", "git config user.email a@b", "git config user.name a", "echo needle > a.txt", "git add a.txt", "git commit -qm a")
}

// marking writes a script that leaves marker behind when it runs, then does what rest says.
func marking(t *testing.T, dir, name, marker, rest string) string {
	t.Helper()
	p := filepath.Join(dir, name)
	if err := os.WriteFile(p, []byte("#!/bin/sh\necho ran > \""+marker+"\"\n"+rest+"\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	return p
}

// changedBy runs command in dir in the foreground and in the background, and says for each whether it was said to
// have changed files.
func changedBy(t *testing.T, dir, command string) (fg, bg bool) {
	t.Helper()
	var mu sync.Mutex
	heard := 0
	jobs := &Jobs{}
	defer jobs.Close()
	c := Command{OutputDir: t.TempDir(), Jobs: jobs, JobScope: "a", Changed: func(string, string) { mu.Lock(); heard++; mu.Unlock() }}
	runIn(t, c, dir, map[string]any{"command": command})
	mu.Lock()
	fg, heard = heard > 0, 0
	mu.Unlock()
	text, isErr := runIn(t, c, dir, map[string]any{"command": command, "background": true})
	if isErr {
		t.Fatal(text)
	}
	if _, err := jobs.Wait(context.Background(), "a", jobOf(t, text), 10*time.Second); err != nil {
		t.Fatal(err)
	}
	mu.Lock()
	defer mu.Unlock()
	return fg, heard > 0
}

// What a reading command runs by its config, its environment or the folder it runs in may write anything: such a
// command is not taken as only reading, in the foreground or the background. The same commands without any of it are.
func TestReadingCommandsThatRunAProgramByTheirConfigSayTheyChanged(t *testing.T) {
	for _, tool := range []string{"git", "rg"} {
		if _, err := exec.LookPath(tool); err != nil {
			t.Skip("no " + tool)
		}
	}
	isolate(t)
	scripts := t.TempDir()
	marker := filepath.Join(scripts, "marker")

	plain := t.TempDir()
	repo(t, plain)
	for _, command := range []string{"git status", "git status --porcelain", "git log --oneline", "rg needle a.txt", "ls; git rev-parse HEAD"} {
		if fg, bg := changedBy(t, plain, command); fg || bg {
			t.Errorf("%q in a plain repository: changed %v in the foreground, %v in the background", command, fg, bg)
		}
	}

	check := func(what, dir, command string) {
		t.Helper()
		_ = os.Remove(marker)
		fg, bg := changedBy(t, dir, command)
		if _, err := os.Stat(marker); err != nil {
			t.Fatalf("%s: the program never ran, so this proves nothing", what)
		}
		if !fg || !bg {
			t.Errorf("%s: %q ran a program yet was taken as only reading (foreground said changed %v, background %v)", what, command, fg, bg)
		}
	}

	// git status runs core.fsmonitor
	fsmonitor := t.TempDir()
	repo(t, fsmonitor)
	sh(t, fsmonitor, "git config core.fsmonitor "+marking(t, scripts, "fsmonitor.sh", marker, `printf '\0'`))
	check("core.fsmonitor", fsmonitor, "git status --porcelain")

	// cd into a folder whose config runs a program, from one whose config does not
	outer := t.TempDir()
	repo(t, outer)
	inner := filepath.Join(outer, "inner")
	if err := os.Mkdir(inner, 0o755); err != nil {
		t.Fatal(err)
	}
	repo(t, inner)
	sh(t, inner, "git config core.fsmonitor "+marking(t, scripts, "fsmonitor-inner.sh", marker, `printf '\0'`))
	if fg, bg := changedBy(t, outer, "git status"); fg || bg {
		t.Errorf("git status in the outer repository: changed %v, %v", fg, bg)
	}
	check("cd into a repository with core.fsmonitor", outer, "cd inner; git status")

	// rg runs the --pre of the config RIPGREP_CONFIG_PATH names
	rc := filepath.Join(scripts, "ripgreprc")
	if err := os.WriteFile(rc, []byte("--pre="+marking(t, scripts, "pre.sh", marker, `cat "$1"`)+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	t.Setenv("RIPGREP_CONFIG_PATH", rc)
	check("RIPGREP_CONFIG_PATH with --pre", plain, "rg needle a.txt")
	// a config with only options that read changes nothing
	if err := os.WriteFile(rc, []byte("# reading only\n--smart-case\n--glob=!*.min.js\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if fg, bg := changedBy(t, plain, "rg needle a.txt"); fg || bg {
		t.Errorf("rg with a config that only reads: changed %v, %v", fg, bg)
	}
	t.Setenv("RIPGREP_CONFIG_PATH", "")

	// git log checks a signature with gpg.program: by log.showSignature, or by a format that shows one
	signed := t.TempDir()
	repo(t, signed)
	tree := sh(t, signed, "git rev-parse HEAD^{tree}")
	body := "tree " + tree + "\nauthor a <a@b> 0 +0000\ncommitter a <a@b> 0 +0000\ngpgsig -----BEGIN PGP SIGNATURE-----\n \n fake\n -----END PGP SIGNATURE-----\n\nsigned\n"
	if err := os.WriteFile(filepath.Join(scripts, "commit"), []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	commit := sh(t, signed, "git hash-object -t commit -w "+filepath.Join(scripts, "commit"))
	sh(t, signed, "git config gpg.program "+marking(t, scripts, "gpg.sh", marker, "exit 1"))
	if fg, bg := changedBy(t, signed, "git log --oneline "+commit); fg || bg {
		t.Errorf("git log without a signature shown: changed %v, %v", fg, bg)
	}
	check("a format that shows a signature", signed, "git log --format=%GG "+commit)
	sh(t, signed, "git config log.showSignature true")
	check("log.showSignature", signed, "git log --oneline "+commit)
}

// The environment and PATH run_command runs with can have a reading command run something else.
func TestReadingCommandsAreJudgedWithTheirEnvironment(t *testing.T) {
	isolate(t)
	dir := t.TempDir()
	if !readOnlyIn(dir, "ls; cat a.txt") {
		t.Fatal("a plain ls is not taken as only reading, so this proves nothing")
	}
	path := os.Getenv("PATH")
	bin := filepath.Join(dir, "bin")
	if err := os.Mkdir(bin, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(bin, "ls"), []byte("#!/bin/sh\ntouch written\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	for _, c := range []struct{ name, key, value, command string }{
		{"an ls of the folder's own first in PATH", "PATH", bin + ":" + path, "ls"},
		{"a relative folder in PATH", "PATH", "bin:" + path, "ls"},
		{"an empty entry in PATH, the current folder", "PATH", ":" + path, "cat a"},
		{"BASH_ENV runs a script first", "BASH_ENV", filepath.Join(dir, "env.sh"), "pwd"},
		{"ENV runs a script first", "ENV", filepath.Join(dir, "env.sh"), "pwd"},
		{"an exported function in place of a command", "BASH_FUNC_ls%%", "() {  touch written\n}", "ls"},
		{"CDPATH changes where cd goes", "CDPATH", "/tmp", "cd bin; ls"},
		{"git config from the environment", "GIT_CONFIG_PARAMETERS", "'core.fsmonitor'='true'", "git status"},
		{"git's own trace files", "GIT_TRACE", filepath.Join(dir, "trace"), "git status"},
	} {
		t.Run(c.name, func(t *testing.T) {
			t.Setenv(c.key, c.value)
			if readOnlyIn(dir, c.command) {
				t.Errorf("%q with %s=%q taken as only reading", c.command, c.key, c.value)
			}
		})
	}
	for _, command := range []string{"cd missing; ls", "cd -; ls", "cd; ls", "cd -P bin; ls", "cd bin | ls", "ls | cd bin; ls"} {
		if readOnlyIn(dir, command) {
			t.Errorf("%q taken as only reading", command)
		}
	}
	if !readOnlyIn(dir, "cd bin; pwd") || !readOnlyIn(dir, "cd "+bin+"; cd ..; ls") {
		t.Error("a cd into a folder that is there is not taken as only reading")
	}
}
