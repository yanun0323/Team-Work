package tools

import (
	"slices"
	"strings"
)

// readOnlyCommands are commands that only read, whatever plain arguments they get; those whose flags can write or run
// something else are checked by readOnlyArgs.
var readOnlyCommands = map[string]bool{
	"pwd": true, "ls": true, "cat": true, "head": true, "tail": true, "wc": true, "rg": true, "grep": true, "egrep": true, "fgrep": true,
	"git": true, "find": true, "stat": true, "file": true, "du": true, "df": true, "tree": true, "which": true, "echo": true,
	"basename": true, "dirname": true, "realpath": true, "diff": true, "cmp": true, "date": true, "true": true, "cd": true,
}

// readOnlyGit are the git commands that read the work tree and history without writing them.
var readOnlyGit = map[string]bool{"status": true, "diff": true, "log": true, "show": true, "rev-parse": true, "ls-files": true, "blame": true, "grep": true}

// readOnly says whether a shell command surely changes no file: every part of it, between pipes and ;, is a known
// reading command with arguments that cannot write. Redirection, substitution, variables, globs, subshells,
// background jobs, && and ||, variables set before a command and anything unknown count as possibly writing; inside
// single quotes anything goes, inside double quotes nothing the shell would expand.
func readOnly(command string) bool {
	var parts [][]string
	var words []string
	var cur strings.Builder
	in, quote := false, rune(0)
	word := func() {
		if in {
			words = append(words, cur.String())
			cur.Reset()
			in = false
		}
	}
	part := func() bool {
		word()
		if len(words) == 0 {
			return false
		}
		parts, words = append(parts, words), nil
		return true
	}
	for _, r := range command {
		switch {
		case quote == '\'':
			if r == '\'' {
				quote = 0
			} else {
				cur.WriteRune(r)
			}
		case quote == '"':
			if r == '"' {
				quote = 0
			} else if strings.ContainsRune("$`\\!", r) {
				return false
			} else {
				cur.WriteRune(r)
			}
		case r == '\'' || r == '"':
			quote, in = r, true
		case r == ' ' || r == '\t':
			word()
		case r == '|' || r == ';':
			if !part() {
				return false
			}
		case strings.ContainsRune("><`$()&{}\\!*?[]#\n\r", r), r == '~' && !in: // a ~ starting a word is a home folder
			return false
		default:
			cur.WriteRune(r)
			in = true
		}
	}
	if quote != 0 || !part() {
		return false
	}
	for _, words := range parts {
		if !readOnlyCommands[words[0]] || !readOnlyArgs(words[0], words[1:]) {
			return false
		}
	}
	return true
}

// readOnlyArgs refuses the flags of a reading command that write a file or run another program.
func readOnlyArgs(name string, args []string) bool {
	has := func(flags ...string) bool {
		return slices.ContainsFunc(args, func(a string) bool {
			for _, f := range flags {
				if a == f || strings.HasPrefix(a, f+"=") {
					return true
				}
			}
			return false
		})
	}
	switch name {
	case "git":
		// git -C dir, -c key=value and the like come before the command; they are not read-only for sure
		if len(args) == 0 || !readOnlyGit[args[0]] {
			return false
		}
		return !has("--output", "--ext-diff", "-O", "--open-files-in-pager", "--textconv")
	case "rg":
		return !has("--pre", "--pre-glob", "-z", "--search-zip")
	case "find":
		return !has("-delete", "-exec", "-execdir", "-ok", "-okdir", "-fprint", "-fprint0", "-fprintf", "-fls")
	case "diff":
		return !has("-o", "--output")
	case "tail", "cat", "head", "wc", "ls", "grep", "egrep", "fgrep", "stat", "file", "du", "df", "tree", "which", "echo", "basename", "dirname", "realpath", "cmp", "pwd", "true", "cd":
		return true
	case "date":
		// date with an argument may try to set the clock; only a format to print with counts
		return !slices.ContainsFunc(args, func(a string) bool { return !strings.HasPrefix(a, "+") })
	}
	return false
}
