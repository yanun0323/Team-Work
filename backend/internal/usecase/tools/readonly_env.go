package tools

import (
	"bytes"
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

// readOnlyIn says whether a shell command, run from cwd as run_command runs it, surely changes no file: its words
// say so (readOnly), and nothing in its environment, the folders it runs in or the config they read has one of its
// commands run another program. Whatever cannot be told for sure counts as possibly writing.
func readOnlyIn(cwd, command string) bool {
	parts, ok := readOnlyParts(command)
	if !ok || !shellEnvSafe() {
		return false
	}
	dir := cwd
	for _, p := range parts {
		name, args := p.words[0], p.words[1:]
		switch name {
		case "cd":
			// a cd in a pipe changes nothing after it, and one that fails leaves the folder as it was: either way the
			// folder the rest runs in would not be the one checked
			if p.piped || len(args) != 1 || strings.HasPrefix(args[0], "-") || os.Getenv("CDPATH") != "" {
				return false
			}
			next := args[0]
			if !filepath.IsAbs(next) {
				next = filepath.Join(dir, next)
			}
			if fi, err := os.Stat(next); err != nil || !fi.IsDir() {
				return false
			}
			dir = next
			continue
		case "pwd", "echo", "true": // the shell's own
			continue
		}
		path, err := exec.LookPath(name)
		if err != nil || inFolder(path, cwd) || inFolder(path, dir) {
			return false
		}
		switch name {
		case "git":
			if !gitReadsOnly(path, dir, args) {
				return false
			}
		case "rg":
			if !rgConfigReadsOnly(dir) {
				return false
			}
		}
	}
	return true
}

// shellEnvSafe says the shell runs the commands it is given and nothing else: no startup script, no function in place
// of a command, and no folder of PATH that depends on where it runs.
func shellEnvSafe() bool {
	if os.Getenv("BASH_ENV") != "" || os.Getenv("ENV") != "" {
		return false
	}
	for _, kv := range os.Environ() {
		if strings.HasPrefix(kv, "BASH_FUNC_") {
			return false
		}
	}
	for _, d := range filepath.SplitList(os.Getenv("PATH")) {
		if !filepath.IsAbs(d) {
			return false
		}
	}
	return true
}

// inFolder says whether path is in folder root, following symbolic links where it can.
func inFolder(path, root string) bool {
	real := func(p string) string {
		if r, err := filepath.EvalSymlinks(p); err == nil {
			return r
		}
		return filepath.Clean(p)
	}
	rel, err := filepath.Rel(real(root), real(path))
	return err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator))
}

// gitEnvSafe are the GIT_ variables that cannot have a reading git command run a program or write a file.
var gitEnvSafe = map[string]bool{
	"GIT_TERMINAL_PROMPT": true, "GIT_EDITOR": true, "GIT_SEQUENCE_EDITOR": true, "GIT_PAGER": true, // no terminal here
	"GIT_AUTHOR_NAME": true, "GIT_AUTHOR_EMAIL": true, "GIT_AUTHOR_DATE": true,
	"GIT_COMMITTER_NAME": true, "GIT_COMMITTER_EMAIL": true, "GIT_COMMITTER_DATE": true,
}

// gitCheckTime is the longest the checks of a git command's config may take.
const gitCheckTime = 5 * time.Second

// gitReadsOnly says whether a git command readOnlyGit allows, run from dir, surely runs no program and writes no
// file by the config it reads there: git's whole config as it sees it, includes and all.
func gitReadsOnly(git, dir string, args []string) bool {
	for _, kv := range os.Environ() {
		if k, _, _ := strings.Cut(kv, "="); strings.HasPrefix(k, "GIT_") && !gitEnvSafe[k] {
			return false
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), gitCheckTime)
	defer cancel()
	run := func(args ...string) ([]byte, bool) {
		cmd := exec.CommandContext(ctx, git, args...)
		cmd.Dir = dir
		out, err := cmd.Output()
		return out, err == nil
	}
	out, ok := run("config", "--list", "-z")
	if !ok {
		return false
	}
	sub := args[0]
	worktree := sub == "status" || sub == "ls-files" // these read the files themselves, through filters
	for _, entry := range bytes.Split(out, []byte{0}) {
		if len(entry) == 0 {
			continue
		}
		key, value, hasValue := strings.Cut(string(entry), "\n")
		key = strings.ToLower(key)
		switch {
		case key == "core.fsmonitor" && (!hasValue || !gitFalse(value)):
			return false
		case strings.HasPrefix(key, "trace2."): // writes trace files
			return false
		case worktree && (strings.HasPrefix(key, "filter.") || key == "diff.external" ||
			strings.HasPrefix(key, "diff.") && (strings.HasSuffix(key, ".textconv") || strings.HasSuffix(key, ".command"))):
			return false
		case sub == "log" && key == "log.showsignature" && (!hasValue || !gitFalse(value)):
			return false
		case sub == "log" && (key == "format.pretty" || strings.HasPrefix(key, "pretty.")) && strings.Contains(value, "%G"):
			return false
		}
	}
	switch sub {
	case "log":
		// %G placeholders show a signature, which runs gpg.program to check
		for _, a := range args {
			if strings.Contains(a, "%G") {
				return false
			}
		}
	case "status":
		// status looks into submodules with a git of their own, under their own config
		out, ok := run("ls-files", "--stage", "-z")
		if !ok {
			return false
		}
		for _, entry := range bytes.Split(out, []byte{0}) {
			if bytes.HasPrefix(entry, []byte("160000 ")) {
				return false
			}
		}
	}
	return true
}

// gitFalse says a git config value is false.
func gitFalse(v string) bool {
	switch strings.ToLower(strings.TrimSpace(v)) {
	case "false", "no", "off", "0":
		return true
	}
	return false
}

// rgConfigReadsOnly says whether the config file RIPGREP_CONFIG_PATH names, if any, has only options that read, as rg
// run from dir reads it: a relative path is found from dir. Each of its lines is one argument; those starting with #
// are comments.
func rgConfigReadsOnly(dir string) bool {
	p := os.Getenv("RIPGREP_CONFIG_PATH")
	if p == "" {
		return true
	}
	if !filepath.IsAbs(p) {
		p = filepath.Join(dir, p)
	}
	b, err := os.ReadFile(p)
	if err != nil {
		return false
	}
	var args []string
	for _, line := range strings.Split(string(b), "\n") {
		line = strings.TrimSpace(line)
		if line != "" && !strings.HasPrefix(line, "#") {
			args = append(args, line)
		}
	}
	return readOnlyFlags["rg"].allow(args)
}
