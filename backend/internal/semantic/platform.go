package semantic

import (
	"runtime"
	"strconv"
	"strings"
)

// Platform is what this computer is, as far as semantic search cares.
type Platform struct {
	OS      string // product version, such as 27.0.1
	Build   string // OS build, such as 26A434; Core AI compiles the model again after it changes
	Chip    string
	Arm64   bool // the backend runs natively on Apple silicon, not under Rosetta
	Helper  string
	Missing bool // the helper is not in the app
}

// Supported says whether Core AI can run here, and why not when it cannot.
func (p Platform) Supported() (bool, string) {
	switch {
	case runtime.GOOS != "darwin":
		return false, "not macOS"
	case !p.Arm64:
		return false, "not Apple silicon"
	case major(p.OS) < 27:
		return false, "macOS " + p.OS + " is older than 27"
	case p.Helper == "" || p.Missing:
		return false, "semantic-helper is not in the app"
	}
	return true, ""
}

func major(version string) int {
	n, err := strconv.Atoi(strings.SplitN(version, ".", 2)[0])
	if err != nil {
		return 0
	}
	return n
}
