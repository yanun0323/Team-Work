package codemode

import (
	"bytes"
	"encoding/json"
	"fmt"
	"strings"
	"time"
)

// optionsMark starts the line a script may set its options with, its first line only.
const optionsMark = "// @options:"

// MaxOutputTokens bounds what max_output_tokens may ask for.
const MaxOutputTokens = 100_000

// DefaultOutputTokens is how much output comes back when the script does not say.
const DefaultOutputTokens = 10_000

// scriptOptions are what a script's options line sets: how much of its output comes back, and its deadline.
type scriptOptions struct {
	outputTokens int
	// timeout is the whole run's deadline, waiting for a worker included; zero for none.
	timeout time.Duration
}

// parseOptions reads the options line a script may start with. It must be the first line: one anywhere else would
// silently not apply, so it fails the script before it runs. The line stays in the code, a comment, so the script's
// lines keep their numbers.
func parseOptions(code string) (scriptOptions, *Failure) {
	opts := scriptOptions{outputTokens: DefaultOutputTokens}
	for i, line := range strings.Split(code, "\n") {
		rest, ok := strings.CutPrefix(strings.TrimSpace(line), optionsMark)
		if !ok {
			continue
		}
		if i > 0 {
			return opts, &Failure{Reason: ReasonInvalid, Message: "an options line must be the script's first line", Line: i + 1, Column: 1}
		}
		var raw struct {
			MaxOutputTokens *int   `json:"max_output_tokens"`
			TimeoutMS       *int64 `json:"timeout_ms"`
		}
		d := json.NewDecoder(bytes.NewReader([]byte(strings.TrimSpace(rest))))
		d.DisallowUnknownFields()
		if err := d.Decode(&raw); err != nil || d.More() {
			return opts, &Failure{Reason: ReasonInvalid, Message: `the options line takes a JSON object with max_output_tokens and timeout_ms, such as // @options: {"max_output_tokens": 2000, "timeout_ms": 60000}`, Line: 1, Column: 1}
		}
		if n := raw.MaxOutputTokens; n != nil {
			if *n < 1 || *n > MaxOutputTokens {
				return opts, &Failure{Reason: ReasonInvalid, Message: fmt.Sprintf("max_output_tokens must be from 1 to %d", MaxOutputTokens), Line: 1, Column: 1}
			}
			opts.outputTokens = *n
		}
		if ms := raw.TimeoutMS; ms != nil {
			if *ms < 1 {
				return opts, &Failure{Reason: ReasonInvalid, Message: "timeout_ms must be at least 1", Line: 1, Column: 1}
			}
			opts.timeout = time.Duration(*ms) * time.Millisecond
		}
	}
	return opts, nil
}
