package config

import (
	"os"
	"path/filepath"
	"testing"
)

func TestGlobalConfig(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("TEAM_WORK_HOME", dir)
	for _, key := range []string{"TEAM_WORK_HOST", "TEAM_WORK_PORT", "TEAM_WORK_ALLOWED_ORIGINS", "TEAM_WORK_DEBUG"} {
		t.Setenv(key, "")
	}
	c, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if c.DataDir != dir || c.Port != 8787 || len(c.AllowedOrigins) != 2 {
		t.Fatalf("%+v", c)
	}
	path := filepath.Join(dir, "config.yaml")
	raw := []byte("host: localhost\nport: 9988\nallowedOrigins: [http://localhost:9988]\ndebug: true\n")
	if err := os.WriteFile(path, raw, 0o600); err != nil {
		t.Fatal(err)
	}
	c, err = Load()
	if err != nil || c.Port != 9988 || !c.Debug {
		t.Fatalf("%+v %v", c, err)
	}
	t.Setenv("TEAM_WORK_PORT", "18787")
	c, err = Load()
	if err != nil || c.Port != 18787 {
		t.Fatalf("%+v %v", c, err)
	}
	got, _ := os.ReadFile(path)
	if string(got) != string(raw) {
		t.Fatal("startup overwrote YAML")
	}
	if err := os.WriteFile(path, []byte("host: 0.0.0.0\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := Load(); err == nil {
		t.Fatal("accepted public listener")
	}
	if err := os.WriteFile(path, []byte("unknown: true\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := Load(); err == nil {
		t.Fatal("accepted unknown setting")
	}
}
