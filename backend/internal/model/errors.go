package model

import "github.com/yanun0323/Team-Work/internal/i18n"

// Machine codes returned to clients.
const (
	CodeNotFound    = "not_found"
	CodeInvalid     = "invalid_request"
	CodeConflict    = "conflict"
	CodeUnsupported = "unsupported"
	CodeUnavailable = "unavailable" // a passing failure, worth trying again
	CodeInternal    = "internal"
	// CodeContextOverflow means the conversation is longer than the model can read.
	CodeContextOverflow = "context_overflow"
	// CodeSignedOut means a subscription's sign-in is gone; it works again once signed in again.
	CodeSignedOut = "signed_out"
	// CodeNoGitIdentity means git has no name or email of the user's to commit with; only the user can set one.
	CodeNoGitIdentity = "no_git_identity"
)

// Error is a failure with a stable code and a message that is safe to show.
type Error struct {
	Code    string
	Message string
	// Status is the HTTP status a model provider answered with, when that is what failed; 0 otherwise.
	Status int
}

func (e *Error) Error() string { return e.Message }

func Errorf(code, format string, args ...any) *Error {
	return &Error{Code: code, Message: i18n.T(format, args...)}
}
