package model

import "fmt"

// Machine codes returned to clients.
const (
	CodeNotFound    = "not_found"
	CodeInvalid     = "invalid_request"
	CodeConflict    = "conflict"
	CodeUnavailable = "unavailable" // a passing failure, worth trying again
	CodeInternal    = "internal"
)

// Error is a failure with a stable code and a message that is safe to show.
type Error struct {
	Code    string
	Message string
}

func (e *Error) Error() string { return e.Message }

func Errorf(code, format string, args ...any) *Error {
	return &Error{Code: code, Message: fmt.Sprintf(format, args...)}
}
