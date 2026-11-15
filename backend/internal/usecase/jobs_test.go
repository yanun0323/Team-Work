package usecase_test

import (
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/yanun0323/Team-Work/internal/model"
	"github.com/yanun0323/Team-Work/internal/model/enum"
	"github.com/yanun0323/Team-Work/internal/usecase"
)

const jobsEnded = "[Background commands ended]"

func background(command string) model.ModelReply {
	return call("run_command", map[string]any{"command": command, "background": true})
}

// pidIn waits for a process id written to path and returns it.
func pidIn(t *testing.T, path string) int {
	t.Helper()
	deadline := time.Now().Add(patience)
	for time.Now().Before(deadline) {
		b, _ := os.ReadFile(path)
		if pid, err := strconv.Atoi(strings.TrimSpace(string(b))); err == nil && pid > 0 {
			return pid
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("no pid in %s", path)
	return 0
}

func waitDead(t *testing.T, pid int) {
	t.Helper()
	deadline := time.Now().Add(patience)
	for syscall.Kill(pid, 0) == nil {
		if time.Now().After(deadline) {
			t.Fatalf("process %d is still running", pid)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// A step that stops talking while its background command runs is not told it stopped without handing off: it waits,
// and how the command ended comes to it, once, after which it hands off.
func TestStepWaitsForItsBackgroundCommand(t *testing.T) {
	t.Parallel()
	r := newRig(t, func(req model.ModelRequest) (model.ModelReply, error) {
		switch {
		case laterStep(req) || strings.Contains(sentText(req), jobsEnded):
			return call("submit_handoff", handoff), nil
		case lastIsResult(req):
			return say("等背景指令"), nil
		}
		return background("sleep 0.3; echo bg-out"), nil
	})
	task := r.task(r.flow.ID)
	r.wait("done", stage(task.ID, enum.StageAwaitMerge))
	told := 0
	for _, req := range r.fake.requests() {
		text := sentText(req)
		if strings.Contains(text, "You have not handed off") {
			t.Fatal("nudged while the command ran")
		}
		if !laterStep(req) && strings.Contains(text, jobsEnded) {
			told++
			if !strings.Contains(text, "bg-out") || !strings.Contains(text, "exited with code 0") || !strings.Contains(text, "Full output: ") {
				t.Fatalf("%s", text)
			}
		}
	}
	if told != 1 {
		t.Fatalf("told %d times", told)
	}
}

// A step cannot hand off while a background command still runs, and stopping it stops the command with what that
// started.
func TestStepWithARunningCommandCannotHandOffAndStopsIt(t *testing.T) {
	t.Parallel()
	pids := t.TempDir()
	var mu sync.Mutex
	refused := ""
	r := newRig(t, func(req model.ModelRequest) (model.ModelReply, error) {
		results := lastResultsOf(req)
		switch {
		case laterStep(req):
			return call("submit_handoff", handoff), nil
		case len(results) > 0 && results[0].Name == "submit_handoff":
			mu.Lock()
			refused = results[0].Text
			mu.Unlock()
			return say("等"), nil
		case len(results) > 0:
			return call("submit_handoff", handoff), nil
		}
		return background("sh -c 'sleep 60 & echo $! > " + filepath.Join(pids, "grand.pid") + "; wait'"), nil
	})
	task := r.task(r.flow.ID)
	grand := pidIn(t, filepath.Join(pids, "grand.pid"))
	r.wait("refused", func(*model.World) bool { mu.Lock(); defer mu.Unlock(); return refused != "" })
	mu.Lock()
	if !strings.Contains(refused, "still running: job-") {
		t.Fatalf("%q", refused)
	}
	mu.Unlock()
	if w := r.world(); w.Tasks[task.ID].Stage != enum.StageRunning || subAt(w, task.ID, "整理需求").Status != enum.StatusProgressing {
		t.Fatalf("%+v", subAt(w, task.ID, "整理需求"))
	}
	if syscall.Kill(grand, 0) != nil {
		t.Fatal("the command ended early")
	}
	if err := r.e.PauseTask(task.ID); err != nil {
		t.Fatal(err)
	}
	waitDead(t, grand)
}

// laterStep says a request is for a step after the first, which reads the first one's handoff.
func laterStep(req model.ModelRequest) bool { return strings.Contains(sentText(req), "# Handoff from") }

func lastResultsOf(req model.ModelRequest) []model.Block {
	if len(req.Messages) == 0 || !lastIsResult(req) {
		return nil
	}
	return req.Messages[len(req.Messages)-1].Content
}

func chatHasLine(c *model.Chat, from, prefix string) int {
	for i, m := range c.Messages {
		if m.From == from && strings.HasPrefix(m.Text, prefix) {
			return i
		}
	}
	return -1
}

// A chat's background command goes on after the reply; when it ends, the chat shows it as a tool line and the
// employee is woken to tell the user.
func TestChatIsWokenWhenItsBackgroundCommandEnds(t *testing.T) {
	t.Parallel()
	r := newRig(t, func(req model.ModelRequest) (model.ModelReply, error) {
		switch {
		case strings.Contains(sentText(req), jobsEnded):
			return say("背景指令完成了"), nil
		case lastIsResult(req):
			return say("已在背景執行"), nil
		}
		return background("sleep 0.3; echo chat-bg"), nil
	})
	c, err := r.e.CreateChat(usecase.NewChat{TeamID: r.team.ID, ReplicaID: r.owner.ID, Text: "跑一下"})
	if err != nil {
		t.Fatal(err)
	}
	w := r.wait("woken", func(w *model.World) bool {
		return chatDone(c.ID)(w) && chatHasLine(w.Chats[c.ID], "agent", "背景指令完成了") >= 0
	})
	got := w.Chats[c.ID]
	line, said := chatHasLine(got, "tool", `run_command {"job_id":"job-`), chatHasLine(got, "agent", "背景指令完成了")
	if line < 0 || line > said || !strings.Contains(got.Messages[line].Text, `"exit_code":0`) || !got.Unread {
		t.Fatalf("%+v", got.Messages)
	}
	users := 0
	for _, m := range got.Messages {
		if m.From != "agent" && m.From != "tool" {
			users++
		}
	}
	if users != 1 {
		t.Fatalf("%d messages show as the user's: %+v", users, got.Messages)
	}
	for _, req := range r.fake.requests() {
		if text := sentText(req); strings.Contains(text, jobsEnded) && !strings.Contains(text, "chat-bg") {
			t.Fatalf("%s", text)
		}
	}
}

// While a chat waits on the user's answer, a command that ends shows at once but wakes nobody; the employee reads
// how it ended with the answer.
func TestChatWaitingOnTheUserReadsTheEndWithTheAnswer(t *testing.T) {
	t.Parallel()
	r := newRig(t, func(req model.ModelRequest) (model.ModelReply, error) {
		results := lastResultsOf(req)
		switch {
		case strings.Contains(sentText(req), jobsEnded):
			return say("收到結果"), nil
		case len(results) > 0 && results[0].Name == "run_command":
			return call("ask_user", map[string]any{"reply": "要繼續嗎？", "options": []string{"繼續", "停"}}), nil
		}
		return background("sleep 0.2; echo answered-bg"), nil
	})
	c, err := r.e.CreateChat(usecase.NewChat{TeamID: r.team.ID, ReplicaID: r.owner.ID, Text: "跑一下"})
	if err != nil {
		t.Fatal(err)
	}
	r.wait("tool line", func(w *model.World) bool {
		return w.Chats[c.ID].Question != nil && chatHasLine(w.Chats[c.ID], "tool", `run_command {"job_id"`) >= 0
	})
	before := len(r.fake.requests())
	time.Sleep(200 * time.Millisecond)
	if w := r.world(); len(r.fake.requests()) != before || w.Chats[c.ID].ReplyAt != nil || w.Chats[c.ID].Question == nil {
		t.Fatal("woken while waiting on the user")
	}
	if err := r.e.SayInChat(c.ID, "繼續", nil); err != nil {
		t.Fatal(err)
	}
	w := r.wait("answer", func(w *model.World) bool {
		return chatDone(c.ID)(w) && chatHasLine(w.Chats[c.ID], "agent", "收到結果") >= 0
	})
	lines := 0
	for _, m := range w.Chats[c.ID].Messages {
		if m.From == "tool" && strings.HasPrefix(m.Text, `run_command {"job_id"`) {
			lines++
		}
	}
	if lines != 1 {
		t.Fatalf("%d lines for one end", lines)
	}
}

// Deleting a chat stops its background commands, with what they started.
func TestDeletingAChatStopsItsBackgroundCommands(t *testing.T) {
	t.Parallel()
	pids := t.TempDir()
	r := newRig(t, func(req model.ModelRequest) (model.ModelReply, error) {
		if lastIsResult(req) {
			return say("在跑"), nil
		}
		return background("sh -c 'sleep 60 & echo $! > " + filepath.Join(pids, "grand.pid") + "; wait'"), nil
	})
	c, err := r.e.CreateChat(usecase.NewChat{TeamID: r.team.ID, ReplicaID: r.owner.ID, Text: "跑一下"})
	if err != nil {
		t.Fatal(err)
	}
	grand := pidIn(t, filepath.Join(pids, "grand.pid"))
	r.wait("reply", chatDone(c.ID))
	if err := r.e.DeleteChat(c.ID); err != nil {
		t.Fatal(err)
	}
	waitDead(t, grand)
}

// Closing the engine stops the chats' background commands too.
func TestClosingStopsChatsBackgroundCommands(t *testing.T) {
	t.Parallel()
	pids := t.TempDir()
	r := newRig(t, func(req model.ModelRequest) (model.ModelReply, error) {
		if lastIsResult(req) {
			return say("在跑"), nil
		}
		return background("sleep 60 & echo $! > " + filepath.Join(pids, "child.pid") + "; wait"), nil
	})
	c, err := r.e.CreateChat(usecase.NewChat{TeamID: r.team.ID, ReplicaID: r.owner.ID, Text: "跑一下"})
	if err != nil {
		t.Fatal(err)
	}
	child := pidIn(t, filepath.Join(pids, "child.pid"))
	r.wait("reply", chatDone(c.ID))
	r.e.Close()
	waitDead(t, child)
}
