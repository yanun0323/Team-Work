package tools

import (
	"slices"
	"strings"
)

// readOnlyCommands are commands that only read whatever arguments they get: none of their options writes a file or
// runs another program. Commands that have such options are in readOnlyFlags instead, with the options they may take.
var readOnlyCommands = map[string]bool{
	"pwd": true, "ls": true, "cat": true, "head": true, "tail": true, "wc": true, "grep": true, "egrep": true, "fgrep": true,
	"stat": true, "du": true, "df": true, "which": true, "echo": true, "basename": true, "dirname": true, "realpath": true,
	"cmp": true, "true": true, "cd": true,
}

// flags are the options a command may take and still surely only read: letters alone or together (-la), letters that
// take a value (-n 5, -n5), long options (--hidden) and long options that take one (--glob x, --glob=x). Nothing else
// starting with - passes, so an option that writes or runs a program has to be left out, not caught.
type flags struct {
	letters, valued  string
	long, longValued []string
	numbers          bool // -5, +5 and the like, as find, head and tail take
}

// readOnlyFlags are the commands with options that write or run something, each with the options that do neither.
var readOnlyFlags = map[string]flags{
	"rg": {letters: "nisSwlcvFxuHNoLqU", valued: "ABCmtTgeM", long: []string{"--hidden", "--no-ignore", "--files", "--line-number",
		"--count", "--files-with-matches", "--fixed-strings", "--ignore-case", "--smart-case", "--word-regexp", "--json", "--no-heading",
		"--heading", "--column", "--only-matching", "--follow", "--invert-match", "--multiline", "--sort-files"},
		longValued: []string{"--glob", "--type", "--type-not", "--max-count", "--context", "--before-context", "--after-context", "--regexp",
			"--sort", "--max-depth", "--color", "--max-columns"}},
	"find": {long: []string{"-print", "-print0", "-empty", "-prune", "-follow", "-o", "-a", "-or", "-and", "-not", "-L", "-H", "-P"},
		longValued: []string{"-name", "-iname", "-path", "-ipath", "-type", "-maxdepth", "-mindepth", "-newer", "-size", "-mtime",
			"-mmin", "-regex", "-iregex", "-perm", "-user", "-group"}, numbers: true},
	"diff": {letters: "uqrNabwBiyctsd", valued: "U", long: []string{"--brief", "--recursive", "--new-file", "--ignore-all-space",
		"--unified", "--side-by-side"}, longValued: []string{"--color", "--unified"}},
	// file -C compiles a magic file, -z and -Z may run decompressors
	"file": {letters: "biLhkNs", long: []string{"--mime", "--mime-type", "--brief"}},
	// tree -o writes its listing to a file
	"tree": {letters: "adfisChnFDpugrtJ", valued: "LIP", long: []string{"--gitignore", "--dirsfirst", "--noreport"}},
}

// readOnlyGit are the git commands that surely read alone, each with the options that keep it so. diff, show, blame
// and grep are not among them: by the repository's config or attributes they may run a program of its own (an external
// diff, a textconv filter, -O's), which only options the command itself does not carry could rule out.
var readOnlyGit = map[string]flags{
	"status": {letters: "sbvz", long: []string{"--short", "--branch", "--long", "--show-stash", "--ahead-behind", "--no-ahead-behind",
		"--porcelain", "--ignored", "--untracked-files"}, longValued: []string{"--porcelain", "--untracked-files", "--ignored"}},
	"rev-parse": {long: []string{"--show-toplevel", "--abbrev-ref", "--short", "--git-dir", "--is-inside-work-tree", "--verify",
		"--show-prefix", "--symbolic-full-name", "--quiet", "--git-common-dir"}, longValued: []string{"--short"}},
	// without anything that shows changes, log runs no diff
	"log": {valued: "n", long: []string{"--oneline", "--graph", "--decorate", "--all", "--reverse", "--first-parent", "--no-merges",
		"--merges", "--abbrev-commit", "--no-decorate"}, longValued: []string{"--format", "--pretty", "--since", "--until", "--author",
		"--grep", "--date", "--max-count", "--skip", "--decorate"}, numbers: true},
	"ls-files": {letters: "cdmoiksuz", long: []string{"--cached", "--deleted", "--modified", "--others", "--ignored", "--stage",
		"--exclude-standard", "--full-name"}},
}

// readOnly says whether a shell command surely changes no file: every part of it, between pipes and ;, is a known
// reading command with arguments that cannot write. Redirection, substitution, variables, globs, subshells,
// background jobs, && and ||, variables set before a command and anything unknown count as possibly writing; inside
// single quotes anything goes, inside double quotes nothing the shell would expand.
func readOnly(command string) bool {
	_, ok := readOnlyParts(command)
	return ok
}

// part is a command among those a shell command runs; piped says it is one side of a pipe, run in a shell of its own.
type part struct {
	words []string
	piped bool
}

// readOnlyParts splits a shell command into the commands it runs, when its words alone show it surely reads only.
func readOnlyParts(command string) ([]part, bool) {
	var parts []part
	var words []string
	pipe := false // the part being read follows a |
	var cur strings.Builder
	in, quote := false, rune(0)
	word := func() {
		if in {
			words = append(words, cur.String())
			cur.Reset()
			in = false
		}
	}
	part := func(piped bool) bool {
		word()
		if len(words) == 0 {
			return false
		}
		parts, words = append(parts, part{words: words, piped: pipe || piped}), nil
		pipe = piped
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
				return nil, false
			} else {
				cur.WriteRune(r)
			}
		case r == '\'' || r == '"':
			quote, in = r, true
		case r == ' ' || r == '\t':
			word()
		case r == '|' || r == ';':
			if !part(r == '|') {
				return nil, false
			}
		case strings.ContainsRune("><`$()&{}\\!*?[]#\n\r", r), r == '~' && !in: // a ~ starting a word is a home folder
			return nil, false
		default:
			cur.WriteRune(r)
			in = true
		}
	}
	if quote != 0 || !part(false) {
		return nil, false
	}
	for _, p := range parts {
		if !readOnlyWords(p.words[0], p.words[1:]) {
			return nil, false
		}
	}
	return parts, true
}

// readOnlyWords says whether a command with these arguments surely only reads.
func readOnlyWords(name string, args []string) bool {
	switch {
	case readOnlyCommands[name]:
		return true
	case name == "date":
		// date with an argument may try to set the clock; only a format to print with counts
		return !slices.ContainsFunc(args, func(a string) bool { return !strings.HasPrefix(a, "+") })
	case name == "git":
		// git -C dir, -c key=value and the like come before the command; they are not read-only for sure
		if len(args) == 0 {
			return false
		}
		f, ok := readOnlyGit[args[0]]
		return ok && f.allow(args[1:])
	}
	f, ok := readOnlyFlags[name]
	return ok && f.allow(args)
}

// allow says whether every option in args is one of f's; what follows -- is no option.
func (f flags) allow(args []string) bool {
	for i := 0; i < len(args); i++ {
		a := args[i]
		switch {
		case a == "--":
			return true
		case len(a) < 2 || a[0] != '-' && a[0] != '+':
			continue // a path, a pattern or an option's value
		case f.numbers && strings.Trim(a[1:], "0123456789") == "":
			continue
		case a[0] == '+':
			return false
		case strings.HasPrefix(a, "--") || len(f.letters)+len(f.valued) == 0:
			name, _, hasValue := strings.Cut(a, "=")
			switch {
			case slices.Contains(f.longValued, name) && (hasValue || !slices.Contains(f.long, name)):
				if !hasValue {
					i++ // its value
				}
			case slices.Contains(f.long, name) && !hasValue:
			default:
				return false
			}
		default:
			for j := 1; j < len(a); j++ {
				c := rune(a[j])
				if strings.ContainsRune(f.valued, c) {
					if j == len(a)-1 {
						i++ // the value is the next argument
					}
					break // the rest of the word is the value
				}
				if !strings.ContainsRune(f.letters, c) {
					return false
				}
			}
		}
	}
	return true
}
