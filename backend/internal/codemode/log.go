package codemode

import (
	"slices"
	"strconv"
	"strings"

	"github.com/rs/zerolog"
)

// Log starts the event for a finished run: codemode_done, or codemode_failed with its reason and place, so
// `grep codemode_ backend.log` shows every run. It carries counts and sizes only: never the script, arguments, results
// or error messages, any of which may hold what was read. The caller adds who ran it and sends it.
func Log(z zerolog.Logger, res Result) *zerolog.Event {
	e := z.Info()
	name := "codemode_done"
	if res.Err != nil {
		e, name = z.Warn(), "codemode_failed"
	}
	total := 0
	names := make([]string, 0, len(res.Calls))
	for n, c := range res.Calls {
		total += c
		names = append(names, n)
	}
	slices.Sort(names)
	for i, n := range names {
		names[i] = n + ":" + strconv.Itoa(res.Calls[n])
	}
	lines := 0
	if res.Output != "" {
		lines = strings.Count(res.Output, "\n") + 1
	}
	e = e.Str(zerolog.MessageFieldName, name).Int("calls", total).Int("parallel", res.Batches).Str("tools", strings.Join(names, ",")).
		Int64("ms", res.Duration.Milliseconds()).Int("out_bytes", len(res.Output)).Int("out_lines", lines)
	if res.Err != nil {
		e = e.Str("reason", res.Err.Reason).Int("line", res.Err.Line).Int("column", res.Err.Column)
	}
	return e
}
