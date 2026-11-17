package codemode

import (
	"fmt"
	"os"
	"strings"
	"time"
)

// charsPerToken is the estimate output is measured with.
const charsPerToken = 4

// result is how the run went, its output as the model reads it.
func (s *sandbox) result(started time.Time, opts scriptOptions, spillDir string) Result {
	d := time.Since(started)
	res := Result{Err: s.failed, Calls: s.calls, Duration: d}
	if s.failed == nil && s.changed {
		res.Store = s.store
	}
	body := s.body()
	res.Output = len(body)
	head := fmt.Sprintf("Script completed in %.2fs", d.Seconds())
	if s.failed != nil {
		head = fmt.Sprintf("Script failed in %.2fs", d.Seconds())
	}
	if body == "" {
		res.Text = head
		return res
	}
	res.Text = head + "\n" + cut(body, opts.outputTokens*charsPerToken, spillDir)
	return res
}

// body is the output in order: the text items, each under a header when there are several, then the console's
// lines, then the error.
func (s *sandbox) body() string {
	var parts []string
	for i, item := range s.items {
		if len(s.items) > 1 {
			item = fmt.Sprintf("==> text %d/%d <==\n%s", i+1, len(s.items), item)
		}
		parts = append(parts, item)
	}
	if len(s.console) > 0 {
		parts = append(parts, "<console_output>\n"+strings.Join(s.console, "\n")+"\n</console_output>")
	}
	if f := s.failed; f != nil {
		line := "Script error: " + f.Message
		if f.Reason != ReasonScript {
			line = "Script error (" + f.Reason + "): " + f.Message
		}
		if f.Line > 0 {
			line += fmt.Sprintf(" (line %d, column %d)", f.Line, f.Column)
		}
		parts = append(parts, line)
	}
	return strings.Join(parts, "\n")
}

// cut keeps text within limit characters: its start and its end, with the whole of it saved to a file that the
// cut names.
func cut(text string, limit int, dir string) string {
	runes := []rune(text)
	if len(runes) <= limit {
		return text
	}
	where := "the whole output could not be saved"
	if path, err := spill(text, dir); err == nil {
		where = "the whole output is in " + path
	} else {
		where += ": " + err.Error()
	}
	half := limit / 2
	return fmt.Sprintf("%s\n[... %d characters cut; %s ...]\n%s", string(runes[:half]), len(runes)-2*half, where, string(runes[len(runes)-half:]))
}

func spill(text, dir string) (string, error) {
	if dir != "" {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			return "", err
		}
	}
	f, err := os.CreateTemp(dir, "exec-*.txt")
	if err != nil {
		return "", err
	}
	if _, err := f.WriteString(text); err != nil {
		f.Close()
		return "", err
	}
	return f.Name(), f.Close()
}
