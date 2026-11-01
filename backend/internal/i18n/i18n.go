// Package i18n puts what the backend tells the user into the app's language. A text's key is its Traditional Chinese,
// the same way as the frontend. Everything an employee is told is English already and does not come through here.
package i18n

import (
	"fmt"
	"sync/atomic"
)

// English is the language with a catalog; anything else reads as Chinese.
const English = "en"

var language atomic.Value

// Set picks the language for what is written from now on. Text already written stays as it was.
func Set(next string) { language.Store(next) }

// T is a text in the current language, filled in like fmt.Sprintf. A text missing from the catalog shows as written;
// a test keeps the catalog complete. Call it when the text is needed, not in a package variable.
func T(format string, args ...any) string {
	if language.Load() == English {
		if text, ok := en[format]; ok {
			format = text
		}
	}
	if len(args) == 0 {
		return format
	}
	return fmt.Sprintf(format, args...)
}

// Errorf is an error whose text is in the current language.
func Errorf(format string, args ...any) error { return plain(T(format, args...)) }

type plain string

func (e plain) Error() string { return string(e) }
