package config

import (
	"os"
	"path/filepath"
	"testing"
)

func TestMemoryDiagnosticsConfig(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("TEAM_WORK_HOME", dir)
	for _, key := range []string{"TEAM_WORK_HOST", "TEAM_WORK_PORT", "TEAM_WORK_ALLOWED_ORIGINS", "TEAM_WORK_DEBUG", "TEAM_WORK_MEMORY_DIAGNOSTICS"} {
		t.Setenv(key, "")
	}
	c, err := Load()
	if err != nil || c.MemoryDiagnostics {
		t.Fatalf("diagnostics must default off: %+v %v", c, err)
	}
	path := filepath.Join(dir, "config.yaml")
	raw := []byte("memoryDiagnostics: true\n")
	if err := os.WriteFile(path, raw, 0o600); err != nil {
		t.Fatal(err)
	}
	c, err = Load()
	if err != nil || !c.MemoryDiagnostics {
		t.Fatalf("YAML opt-in: %+v %v", c, err)
	}
	t.Setenv("TEAM_WORK_MEMORY_DIAGNOSTICS", "false")
	c, err = Load()
	if err != nil || c.MemoryDiagnostics {
		t.Fatalf("environment override: %+v %v", c, err)
	}
	t.Setenv("TEAM_WORK_MEMORY_DIAGNOSTICS", "true")
	c, err = Load()
	if err != nil || !c.MemoryDiagnostics {
		t.Fatalf("environment opt-in: %+v %v", c, err)
	}
	got, err := os.ReadFile(path)
	if err != nil || string(got) != string(raw) {
		t.Fatal("environment override rewrote config")
	}
	t.Setenv("TEAM_WORK_MEMORY_DIAGNOSTICS", "not-a-bool")
	if _, err := Load(); err == nil {
		t.Fatal("accepted invalid diagnostics switch")
	}
}
