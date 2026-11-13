//go:build !darwin

package semantic

// statOf is never trusted off macOS: every file is read again on each scan.
func statOf(string) (stamp, bool) { return stamp{}, false }
