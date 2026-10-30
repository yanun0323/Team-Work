package repository

import (
	"context"
	"errors"
	"testing"

	"github.com/yanun0323/mho-company/internal/model"
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
