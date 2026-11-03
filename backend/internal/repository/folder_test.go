package repository

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/yanun0323/Team-Work/internal/model"
)

func TestPickFolder(t *testing.T) {
	cases := []struct {
		name, script, want string
		fails              bool
	}{
		{name: "picked", script: `echo "/Users/me/my app/"`, want: "/Users/me/my app"},
		{name: "the disk itself", script: `echo /`, want: "/"},
		{name: "cancelled", script: `echo "execution error: User canceled. (-128)" >&2; exit 1`},
		{name: "broken", script: `echo nope >&2; exit 1`, fails: true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got, err := FolderPicker{Command: []string{"sh", "-c", c.script}}.PickFolder(context.Background())
			if (err != nil) != c.fails || got != c.want {
				t.Fatalf("%q %v", got, err)
			}
			var known *model.Error
			if c.fails && !errors.As(err, &known) {
				t.Fatalf("%v", err)
			}
		})
	}
}

func TestPickFolderStopsWhenTheClientLeaves(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := (FolderPicker{Command: []string{"sleep", "30"}}).PickFolder(ctx); err == nil {
		t.Fatal("no error")
	}
}

func TestOpenFolder(t *testing.T) {
	dir := t.TempDir()
	out := filepath.Join(dir, "said")
	p := FolderPicker{Opener: []string{"sh", "-c", `echo "$0" > ` + out}}
	if err := p.OpenFolder(context.Background(), dir); err != nil {
		t.Fatal(err)
	}
	if got, _ := os.ReadFile(out); strings.TrimSpace(string(got)) != dir {
		t.Fatalf("%q", got)
	}
	if err := p.OpenFolder(context.Background(), filepath.Join(dir, "gone")); err == nil {
		t.Fatal("a missing folder was opened")
	}
}
