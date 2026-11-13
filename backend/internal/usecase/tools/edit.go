package tools

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"sort"
	"strings"

	"github.com/yanun0323/Team-Work/internal/model"
)

const bom = "\uFEFF"

// Edit replaces exact text in a file in the working directory. It comes with write_file.
// Edit replaces text in a file. Changed, when set, hears each file it changed.
type Edit struct{ Changed func(path, source string) }

func (Edit) Spec() model.ToolSpec {
	return model.ToolSpec{Name: "edit_file", Description: "Replace exact text in a file. Each edit's old text must appear exactly once in the file as it is before any edit, and edits must not overlap. Include enough surrounding text to make old unique.",
		Parameters: json.RawMessage(`{"type":"object","properties":{` +
			`"path":{"type":"string","description":"Absolute, or relative to the working directory"},` +
			`"edits":{"type":"array","description":"Replacements, each matched against the original file","items":{"type":"object","properties":{` +
			`"old":{"type":"string","description":"Exact text to replace"},` +
			`"new":{"type":"string","description":"Text to put in its place"}` +
			`},"required":["old","new"]}}` +
			`},"required":["path","edits"]}`)}
}

func (t Edit) Run(_ context.Context, cwd string, raw json.RawMessage) model.ToolResult {
	var args struct {
		Path  string `json:"path"`
		Edits []struct {
			Old string `json:"old"`
			New string `json:"new"`
		} `json:"edits"`
	}
	if err := decode(raw, &args); err != nil {
		return fail("invalid arguments: %v", err)
	}
	if args.Path == "" || len(args.Edits) == 0 {
		return fail("path and at least one edit are required")
	}
	path, err := within(cwd, args.Path)
	if err != nil {
		return fail("%s", problem(err))
	}
	info, err := os.Stat(path)
	if err != nil {
		return fail("%s", problem(err))
	}
	if !info.Mode().IsRegular() {
		return fail("%s is not a regular file", args.Path)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return fail("%s", problem(err))
	}

	// Match on plain text: a BOM and CRLF line ends are taken off here and put back on writing.
	text := string(data)
	hadBOM := strings.HasPrefix(text, bom)
	text = strings.TrimPrefix(text, bom)
	crlf := strings.Contains(text, "\r\n")
	if crlf {
		text = strings.ReplaceAll(text, "\r\n", "\n")
	}

	type span struct {
		start, end int
		new        string
		n          int
	}
	spans := make([]span, 0, len(args.Edits))
	for i, e := range args.Edits {
		n := i + 1
		old, repl := strings.ReplaceAll(e.Old, "\r\n", "\n"), strings.ReplaceAll(e.New, "\r\n", "\n")
		switch count := strings.Count(text, old); {
		case old == "":
			return fail("edit %d: old is empty", n)
		case old == repl:
			return fail("edit %d: old and new are the same", n)
		case count == 0:
			return fail("edit %d: old text was not found in %s. It must match exactly, including whitespace.", n, args.Path)
		case count > 1:
			return fail("edit %d: old text appears %d times in %s. Add surrounding text to make it unique.", n, count, args.Path)
		}
		at := strings.Index(text, old)
		spans = append(spans, span{at, at + len(old), repl, n})
	}
	sort.Slice(spans, func(i, j int) bool { return spans[i].start < spans[j].start })
	for i := 1; i < len(spans); i++ {
		if spans[i].start < spans[i-1].end {
			return fail("edits %d and %d overlap; merge them into one", spans[i-1].n, spans[i].n)
		}
	}

	var b strings.Builder
	last := 0
	for _, s := range spans {
		b.WriteString(text[last:s.start])
		b.WriteString(s.new)
		last = s.end
	}
	b.WriteString(text[last:])
	out := b.String()
	if crlf {
		out = strings.ReplaceAll(out, "\n", "\r\n")
	}
	if hadBOM {
		out = bom + out
	}
	if err := os.WriteFile(path, []byte(out), info.Mode().Perm()); err != nil {
		return fail("%s", problem(err))
	}
	if t.Changed != nil {
		t.Changed(path, "edit_file")
	}
	if len(spans) == 1 {
		return model.ToolResult{Text: "edited " + args.Path + " (1 replacement)"}
	}
	return model.ToolResult{Text: fmt.Sprintf("edited %s (%d replacements)", args.Path, len(spans))}
}
