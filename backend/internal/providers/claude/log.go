package claude

import (
	"errors"
	"fmt"
	"log/slog"
	"strings"
)

func record(log *slog.Logger, event string, fields ...any) {
	if log != nil {
		log.Info(event, fields...)
	}
}

// Only fixed categories and known protocol codes leave this boundary. Regex
// redaction alone cannot reliably remove credentials or quoted prompt content.
func diagnosticCategory(text string) string {
	s := strings.ToLower(text)
	switch {
	case strings.Contains(s, "prompt is too long"), strings.Contains(s, "context window"), strings.Contains(s, "context length"):
		return "context_overflow"
	case strings.Contains(s, "auth"), strings.Contains(s, "login"), strings.Contains(s, "credential"):
		return "authentication"
	case strings.Contains(s, "rate_limit"), strings.Contains(s, "rate limit"), strings.Contains(s, "429"):
		return "rate_limit"
	case strings.Contains(s, "overloaded"), strings.Contains(s, "503"):
		return "overloaded"
	case strings.Contains(s, "network"), strings.Contains(s, "fetch failed"):
		return "network"
	case strings.Contains(s, "timeout"), strings.Contains(s, "timed out"):
		return "timeout"
	case strings.Contains(s, "invalid_request"), strings.Contains(s, "invalid request"):
		return "invalid_request"
	default:
		return "unknown"
	}
}

func diagnosticCode(s string) string {
	switch s {
	case "", "authentication_failed", "billing_error", "rate_limit", "rate_limit_error", "invalid_request", "invalid_request_error", "server_error", "api_error", "overloaded_error", "unknown", "success", "error", "error_during_execution", "error_max_turns", "error_max_budget_usd", "error_max_structured_output_retries":
		return s
	default:
		return "[omitted]"
	}
}

func errorCode(err error) string {
	if err == nil {
		return ""
	}
	var p *Error
	if errors.As(safeError(err), &p) {
		return p.Code
	}
	return "unknown"
}

// errorType says which kind of error ended a request. Its text is left out, as it can quote what it failed on.
func errorType(err error) string {
	if err == nil {
		return ""
	}
	return fmt.Sprintf("%T", err)
}

func (c *child) recordFrame(f frame) {
	switch {
	case f.Type == "assistant" && f.Error != "":
		detail := f.Error
		for _, b := range f.Message.Content {
			detail += " " + b.Text
		}
		record(c.log, "claude_failure", "stage", "assistant", "error_code", diagnosticCode(f.Error), "category", diagnosticCategory(detail))
	case f.Type == "result" && f.IsError:
		record(c.log, "claude_failure", "stage", "result", "subtype", diagnosticCode(f.Subtype), "category", diagnosticCategory(strings.Join(f.Errors, " ")+" "+f.Result), "error_count", len(f.Errors))
	}
}

// exec.Cmd drains stderr into this bounded prefix. It is inspected only after
// Wait has joined the copy goroutine, then discarded; raw stderr is never logged.
type diagnosticStderr struct {
	prefix []byte
	bytes  int64
}

func (w *diagnosticStderr) Write(p []byte) (int, error) {
	n := len(p)
	w.bytes += int64(n)
	remaining := 8192 - len(w.prefix)
	if len(p) > remaining {
		p = p[:remaining]
	}
	w.prefix = append(w.prefix, p...)
	return n, nil
}
