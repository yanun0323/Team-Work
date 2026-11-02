package model

import "github.com/yanun0323/mho-company/internal/i18n"

// Machine codes returned to clients.
const (
	CodeNotFound    = "not_found"
	CodeInvalid     = "invalid_request"
	CodeConflict    = "conflict"
	CodeUnavailable = "unavailable" // a passing failure, worth trying again
	CodeInternal    = "internal"
	// CodeContextOverflow means the conversation is longer than the model can read.
	CodeContextOverflow = "context_overflow"
)

// Error is a failure with a stable code and a message that is safe to show.
type Error struct {
	Code    string
	Message string
}

func (e *Error) Error() string { return e.Message }

func Errorf(code, format string, args ...any) *Error {
	return &Error{Code: code, Message: i18n.T(format, args...)}
}
