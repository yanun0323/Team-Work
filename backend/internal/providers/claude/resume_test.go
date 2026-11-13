package claude

import (
	"bufio"
	"context"
	"encoding/json"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"
)

type launch struct{ Args, Content string }

// launches reads what the fake Claude Code was started with and sent, one line per user message.
func launches(t *testing.T, path string) []launch {
	t.Helper()
	f, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	var out []launch
	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		var l launch
		if json.Unmarshal(scanner.Bytes(), &l) != nil {
			t.Fatal(scanner.Text())
		}
		out = append(out, l)
	}
	return out
}
func resumedFrom(l launch) string {
	_, after, _ := strings.Cut(l.Args, "--resume=")
	id, _, _ := strings.Cut(after, " ")
	return id
}
func plain(t *testing.T) CompleteParams {
	p := base(t)
	p.Tools = nil
	return p
}

func TestNewProcessResumesClaudesOwnTranscript(t *testing.T) {
	fakeClaude(t)
	sent := filepath.Join(t.TempDir(), "sent.jsonl")
	t.Setenv("MHO_TEST_CLAUDE_LOG", sent)
	logs := &lockedBuffer{}
	p := plain(t)
	b := newBridge()
	runTurn(t, b, &p)
	b.close()
	first := launches(t, sent)
	saved := loadSaved(p.Session)
	if len(first) != 1 || saved == nil || saved.Count != 2 {
		t.Fatalf("%+v %+v", first, saved)
	}
	// the record holds fingerprints, not the conversation or its instructions
	raw, _ := os.ReadFile(savedPath(p.Session))
	if strings.Contains(string(raw), "hello") || strings.Contains(string(raw), "Preserve Mho") {
		t.Fatalf("the record quotes the conversation: %s", raw)
	}

	// a later process takes up Claude's own transcript and is sent only what is new
	b = newBridge()
	b.log = slog.New(slog.NewJSONHandler(logs, nil))
	p.Messages = append(p.Messages, ModelMessage{Role: "user", Content: []Block{text("next")}})
	runTurn(t, b, &p)
	b.close()
	got := launches(t, sent)
	if len(got) != 2 || resumedFrom(got[1]) != saved.Session || !strings.Contains(got[1].Content, "next") || strings.Contains(got[1].Content, "hello") {
		t.Fatalf("%+v", got)
	}
	if !strings.Contains(logs.String(), `"reason":"resumed"`) {
		t.Fatal(logs.String())
	}
	if again := loadSaved(p.Session); again == nil || again.Session != saved.Session || again.Count != 4 {
		t.Fatalf("%+v", again)
	}

	// an edited history cannot be resumed: it is rebuilt, and the old transcript goes
	b = newBridge()
	edited := p
	edited.Messages = append([]ModelMessage{{Role: "user", Content: []Block{text("edited")}}}, p.Messages[1:]...)
	edited.Messages = append(edited.Messages, ModelMessage{Role: "user", Content: []Block{text("more")}})
	runTurn(t, b, &edited)
	b.close()
	got = launches(t, sent)
	if resumedFrom(got[2]) == saved.Session {
		t.Fatalf("resumed an edited history: %+v", got[2])
	}
	if _, err := os.Stat(mirrorPath(claudeDir(), saved.Cwd, saved.Session)); !os.IsNotExist(err) {
		t.Fatal("the stale transcript was kept", err)
	}
	if rebuilt := loadSaved(p.Session); rebuilt == nil || rebuilt.Session == saved.Session || rebuilt.Count != len(edited.Messages) {
		t.Fatalf("%+v", rebuilt)
	}
}

func TestMissingTranscriptOrChangedSettingsRebuild(t *testing.T) {
	fakeClaude(t)
	sent := filepath.Join(t.TempDir(), "sent.jsonl")
	t.Setenv("MHO_TEST_CLAUDE_LOG", sent)
	p := plain(t)
	b := newBridge()
	runTurn(t, b, &p)
	b.close()
	saved := loadSaved(p.Session)

	changed := p
	changed.Model = "sonnet"
	changed.Messages = append(append([]ModelMessage{}, p.Messages...), ModelMessage{Role: "user", Content: []Block{text("next")}})
	cwd, _ := filepath.EvalSymlinks(p.Cwd)
	if resumable(p.Session, changed, cwd, time.Now()) != nil {
		t.Fatal("resumed with another model")
	}
	next := changed
	next.Model = p.Model
	if resumable(p.Session, next, cwd, time.Now()) == nil {
		t.Fatal("could not resume")
	}
	if resumable(p.Session, next, cwd, time.Now().Add(keepSaved+time.Minute)) != nil {
		t.Fatal("resumed after Claude's cache ran out")
	}
	tool := next
	tool.Messages = append(append([]ModelMessage{}, p.Messages...), ModelMessage{Role: "tool", CallID: "c0", Content: []Block{text("r")}})
	if resumable(p.Session, tool, cwd, time.Now()) != nil {
		t.Fatal("resumed with a tool result it was not waiting for")
	}
	_ = os.Remove(mirrorPath(claudeDir(), saved.Cwd, saved.Session))
	if resumable(p.Session, next, cwd, time.Now()) != nil {
		t.Fatal("resumed a transcript Claude no longer has")
	}
	b = newBridge()
	runTurn(t, b, &next)
	b.close()
	if got := launches(t, sent); resumedFrom(got[1]) == saved.Session {
		t.Fatalf("%+v", got[1])
	}
}

func TestFailedTurnForgetsTheTranscript(t *testing.T) {
	fakeClaude(t)
	p := plain(t)
	b := newBridge()
	defer b.close()
	runTurn(t, b, &p)
	saved := loadSaved(p.Session)
	p.Messages = append(p.Messages, ModelMessage{Role: "user", Content: []Block{text("BLOCK_FOREVER")}})
	ctx, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
	defer cancel()
	if _, err := b.complete(ctx, p, func(any) error { return nil }); err == nil {
		t.Fatal("the blocked turn finished")
	}
	if loadSaved(p.Session) != nil {
		t.Fatal("a half-written transcript is still offered for resuming")
	}
	if _, err := os.Stat(mirrorPath(claudeDir(), saved.Cwd, saved.Session)); !os.IsNotExist(err) {
		t.Fatal("the half-written transcript was kept", err)
	}
}

func TestToolCallsInFlightAreNotSavedForResuming(t *testing.T) {
	fakeClaude(t)
	p := base(t)
	b := newBridge()
	defer b.close()
	if result, _ := runTurn(t, b, &p); result.StopReason != "tool_use" {
		t.Fatal(result)
	}
	if loadSaved(p.Session) != nil {
		t.Fatal("a turn waiting for tool results was saved")
	}
}

func TestSweepDropsWhatOutlivedTheCache(t *testing.T) {
	fakeClaude(t)
	p := plain(t)
	b := newBridge()
	runTurn(t, b, &p)
	b.close()
	saved := loadSaved(p.Session)
	transcript := mirrorPath(claudeDir(), saved.Cwd, saved.Session)
	_ = os.WriteFile(filepath.Join(savedDir(), "junk.json"), []byte("{"), 0o600)
	sweepSaved(time.Now())
	if loadSaved(p.Session) == nil {
		t.Fatal("swept a fresh record")
	}
	sweepSaved(time.Now().Add(keepSaved + time.Minute))
	if loadSaved(p.Session) != nil {
		t.Fatal("kept an old record")
	}
	if _, err := os.Stat(transcript); !os.IsNotExist(err) {
		t.Fatal("kept an old transcript", err)
	}
	if _, err := os.Stat(filepath.Join(savedDir(), "junk.json")); !os.IsNotExist(err) {
		t.Fatal("kept an unreadable record", err)
	}
}

func TestExitedProcessIsReplacedNotReused(t *testing.T) {
	fakeClaude(t)
	sent := filepath.Join(t.TempDir(), "sent.jsonl")
	t.Setenv("MHO_TEST_CLAUDE_LOG", sent)
	p := plain(t)
	b := newBridge()
	defer b.close()
	runTurn(t, b, &p)
	saved := loadSaved(p.Session)
	child := b.sessions[p.Session].child
	_ = syscall.Kill(-child.cmd.Process.Pid, syscall.SIGKILL)
	<-child.done
	p.Messages = append(p.Messages, ModelMessage{Role: "user", Content: []Block{text("next")}})
	runTurn(t, b, &p)
	got := launches(t, sent)
	if len(got) != 2 || resumedFrom(got[1]) != saved.Session {
		t.Fatalf("the conversation was not taken up again: %+v", got)
	}
}
