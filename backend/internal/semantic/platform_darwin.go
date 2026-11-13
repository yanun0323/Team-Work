package semantic

import (
	"os"
	"path/filepath"
	"runtime"

	"golang.org/x/sys/unix"
)

// Detect looks at this Mac. helper is the semantic-helper path to use; empty means next to this executable, as in
// the app's Contents/Helpers.
func Detect(helper string) Platform {
	p := Platform{Helper: helper}
	p.OS, _ = unix.Sysctl("kern.osproductversion")
	p.Build, _ = unix.Sysctl("kern.osversion")
	p.Chip, _ = unix.Sysctl("machdep.cpu.brand_string")
	// sysctl.proc_translated is 1 under Rosetta, where Core AI and the arm64 helper do not belong.
	translated, _ := unix.SysctlUint32("sysctl.proc_translated")
	p.Arm64 = runtime.GOARCH == "arm64" && translated == 0
	if p.Helper == "" {
		if exe, err := os.Executable(); err == nil {
			p.Helper = filepath.Join(filepath.Dir(exe), "semantic-helper")
		}
	}
	if info, err := os.Stat(p.Helper); err != nil || !info.Mode().IsRegular() {
		p.Missing = true
	}
	return p
}
