package tools

import (
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

// A relative RIPGREP_CONFIG_PATH is read by rg from the command's folder, not the server's. A safe config at the
// same relative path in the server must not hide a preprocessor in the command's actual folder, including after cd.
func TestRelativeRipgrepConfigUsesTheCommandsFolder(t *testing.T) {
	if _, err := exec.LookPath("rg"); err != nil {
		t.Skip("no rg")
	}
	isolate(t)
	serverConfig, err := os.MkdirTemp(".", "rg-relative-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(serverConfig) })
	relative := filepath.Join(serverConfig, "rg.conf")
	if err := os.WriteFile(relative, []byte("--smart-case\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	t.Setenv("RIPGREP_CONFIG_PATH", relative)
	for _, cd := range []bool{false, true} {
		name := "direct"
		if cd {
			name = "after_cd"
		}
		t.Run(name, func(t *testing.T) {
			cwd := t.TempDir()
			dir, command := cwd, "rg needle a.txt"
			if cd {
				dir, command = filepath.Join(cwd, "inner"), "cd inner; rg needle a.txt"
			}
			actual := filepath.Join(dir, relative)
			if err := os.MkdirAll(filepath.Dir(actual), 0o755); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(filepath.Join(dir, "a.txt"), []byte("needle\n"), 0o644); err != nil {
				t.Fatal(err)
			}
			// Control: both configs only read, so neither foreground nor background should notify a change.
			if err := os.WriteFile(actual, []byte("--smart-case\n"), 0o644); err != nil {
				t.Fatal(err)
			}
			if fg, bg := changedBy(t, cwd, command); fg || bg {
				t.Fatalf("reading control: changed %v, %v", fg, bg)
			}
			marker := filepath.Join(dir, "ran-pre")
			pre := marking(t, dir, "pre.sh", marker, `cat "$1"`)
			if err := os.WriteFile(actual, []byte("--pre="+pre+"\n"), 0o644); err != nil {
				t.Fatal(err)
			}
			fg, bg := changedBy(t, cwd, command)
			if _, err := os.Stat(marker); err != nil {
				t.Fatal("preprocessor did not run; this does not reproduce the bug")
			}
			if !fg || !bg {
				t.Fatalf("actual cwd config wrote a file but Changed was missed: foreground=%v background=%v", fg, bg)
			}
		})
	}
}
