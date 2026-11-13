//go:build !darwin

package semantic

import "runtime"

// Detect looks at this computer; semantic search runs only on macOS.
func Detect(helper string) Platform {
	return Platform{OS: runtime.GOOS, Helper: helper, Missing: true}
}
