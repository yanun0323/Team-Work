package usecase_test

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/yanun0323/Team-Work/internal/model"
	"github.com/yanun0323/Team-Work/internal/model/enum"
	"github.com/yanun0323/Team-Work/internal/usecase"
)

func outputFiles(t *testing.T, dir string) int {
	t.Helper()
	entries, err := os.ReadDir(dir)
	if os.IsNotExist(err) {
		return 0
	}
	if err != nil {
		t.Fatal(err)
	}
	return len(entries)
}

func TestLongCommandOutputGoesWithItsChat(t *testing.T) {
	r := newRig(t, func(req model.ModelRequest) (model.ModelReply, error) {
		if last := req.Messages[len(req.Messages)-1]; last.Content[0].Type == enum.BlockToolResult {
			return say("跑完了"), nil
		}
		return call("run_command", map[string]any{"command": "seq 1 3000"}), nil
	})
	c, err := r.e.CreateChat(usecase.NewChat{TeamID: r.team.ID, ReplicaID: r.owner.ID, Text: "跑一下"})
	if err != nil {
		t.Fatal(err)
	}
	r.wait("reply", chatDone(c.ID))
	own := filepath.Join(r.data, "cache", "outputs", c.ID)
	if outputFiles(t, own) != 1 {
		t.Fatal("the long output was not kept with the chat")
	}
	fork, err := r.e.HandOffChat(c.ID, len(r.world().Chats[c.ID].Messages)-1, c.ReplicaID)
	if err != nil {
		t.Fatal(err)
	}
	if err := r.e.DeleteChat(c.ID); err != nil {
		t.Fatal(err)
	}
	if outputFiles(t, own) != 0 {
		t.Fatal("the output outlived its chat")
	}
	if outputFiles(t, filepath.Join(r.data, "cache", "outputs", fork.ID)) != 1 {
		t.Fatal("the fork lost the output its conversation points to")
	}
}

func TestCommandOutputGoesWithItsTask(t *testing.T) {
	r := newRig(t, func(model.ModelRequest) (model.ModelReply, error) { return say("好"), nil })
	task := r.task(r.flow.ID)
	dir := filepath.Join(r.data, "cache", "outputs", task.ID)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	os.WriteFile(filepath.Join(dir, "command-1.log"), []byte("x"), 0o600)
	if err := r.e.DeleteTask(task.ID); err != nil {
		t.Fatal(err)
	}
	if outputFiles(t, dir) != 0 {
		t.Fatal("the output outlived its task")
	}
}

func TestChatShowsARunningCommandAndClearsIt(t *testing.T) {
	r := newRig(t, func(req model.ModelRequest) (model.ModelReply, error) {
		if last := req.Messages[len(req.Messages)-1]; last.Content[0].Type == enum.BlockToolResult {
			return say("好了"), nil
		}
		return call("run_command", map[string]any{"command": "echo building; sleep 0.3; echo done"}), nil
	})
	_, events, cancel, err := r.e.Subscribe()
	if err != nil {
		t.Fatal(err)
	}
	defer cancel()
	c, err := r.e.CreateChat(usecase.NewChat{TeamID: r.team.ID, ReplicaID: r.owner.ID, Text: "建置"})
	if err != nil {
		t.Fatal(err)
	}
	r.wait("reply", chatDone(c.ID))
	var shown []string
	for {
		select {
		case ev := <-events:
			if ev.SubID == c.ID && ev.Type == "toolOutput" {
				shown = append(shown, ev.Text)
			}
			continue
		default:
		}
		break
	}
	if len(shown) < 2 || shown[0] != "building" || shown[len(shown)-1] != "" {
		t.Fatalf("shown %q", shown)
	}
	// a page that connects afterwards sees nothing running
	_, later, cancelLater, err := r.e.Subscribe()
	if err != nil {
		t.Fatal(err)
	}
	defer cancelLater()
	select {
	case ev := <-later:
		if ev.Type == "toolOutput" {
			t.Fatalf("a finished command still shows: %+v", ev)
		}
	default:
	}
}
