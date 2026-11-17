package codemode

import (
	"regexp"
	"slices"
	"strconv"
	"strings"

	"github.com/rs/zerolog"
)

// errorKind is the class a thrown error's message starts with, such as TypeError.
var errorKind = regexp.MustCompile(`^([A-Z][A-Za-z]*Error)\b`)

// Log starts the event for a finished run: codemode_done, or codemode_failed with its reason, the kind of error and
// its place, so `grep codemode_ backend.log` shows every run. It carries counts, sizes and kinds only: never the
// script, arguments, results or error messages, any of which may hold what was read. The caller adds who ran it and
// sends it.
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
	e = e.Str(zerolog.MessageFieldName, name).Int("calls", total).Str("tools", strings.Join(names, ",")).
		Int64("ms", res.Duration.Milliseconds()).Int("out_bytes", res.Output)
	if res.Err != nil {
		e = e.Str("reason", res.Err.Reason).Int("line", res.Err.Line).Int("column", res.Err.Column)
		if m := errorKind.FindStringSubmatch(res.Err.Message); m != nil {
			e = e.Str("error", m[1])
		}
	}
	return e
}
