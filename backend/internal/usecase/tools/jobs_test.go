package tools

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"
)

func runIn(t *testing.T, c Command, dir string, args map[string]any) (string, bool) {
	t.Helper()
	raw, _ := json.Marshal(args)
	r := c.Run(context.Background(), dir, raw)
	return r.Text, r.IsError
}

func jobOf(t *testing.T, text string) string {
	t.Helper()
	_, rest, ok := strings.Cut(text, "Started background command ")
	id, _, _ := strings.Cut(rest, ".")
	if !ok || !strings.HasPrefix(id, "job-") {
		t.Fatalf("%q", text)
	}
	return id
}

// alive says whether a process is still there.
func alive(pid int) bool { return syscall.Kill(pid, 0) == nil }

func waitGone(t *testing.T, pid int) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for alive(pid) {
		if time.Now().After(deadline) {
			t.Fatalf("process %d still running", pid)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func TestBackgroundCommandStatusWaitAndKill(t *testing.T) {
	dir := t.TempDir()
	var mu sync.Mutex
	var ended []string
	var heard []string
	jobs := &Jobs{Done: func(scope string) { mu.Lock(); ended = append(ended, scope); mu.Unlock() }}
	defer jobs.Close()
	c := Command{OutputDir: t.TempDir(), Jobs: jobs, JobScope: "a", Changed: func(_, source string) { mu.Lock(); heard = append(heard, source); mu.Unlock() }}

	text, isErr := runIn(t, c, dir, map[string]any{"command": "echo start; sleep 0.3; echo end > out.txt; echo done", "background": true})
	if isErr {
		t.Fatal(text)
	}
	id := jobOf(t, text)
	if got := jobs.Running("a"); len(got) != 1 || got[0] != id {
		t.Fatalf("%v", got)
	}
	text, isErr = runIn(t, c, dir, map[string]any{"job_id": id, "action": "status"})
	if isErr || !strings.Contains(text, "is still running") {
		t.Fatal(text)
	}
	// another scope cannot reach it
	other := c
	other.JobScope = "b"
	if text, isErr = runIn(t, other, dir, map[string]any{"job_id": id, "action": "status"}); !isErr {
		t.Fatal(text)
	}
	text, isErr = runIn(t, c, dir, map[string]any{"job_id": id, "action": "wait"})
	if isErr || !strings.Contains(text, "exited with code 0") || !strings.Contains(text, "start\ndone") || !strings.Contains(text, "Full output: ") {
		t.Fatal(text)
	}
	// waited for, so it is not reported again
	if jobs.HasEnded("a") || len(jobs.Ended("a")) != 0 {
		t.Fatal("reported twice")
	}
	mu.Lock()
	if len(ended) != 1 || ended[0] != "a" || len(heard) != 1 {
		t.Fatalf("ended %v, heard %v", ended, heard)
	}
	mu.Unlock()
	if b, _ := os.ReadFile(filepath.Join(dir, "out.txt")); string(b) != "end\n" {
		t.Fatalf("%q", b)
	}

	// wait with a timeout leaves it running; kill stops it with what it started
	text, _ = runIn(t, c, dir, map[string]any{"command": "sleep 30 & echo $! > child.pid; wait", "background": true})
	id = jobOf(t, text)
	var child int
	for deadline := time.Now().Add(5 * time.Second); child == 0 && time.Now().Before(deadline); time.Sleep(20 * time.Millisecond) {
		b, _ := os.ReadFile(filepath.Join(dir, "child.pid"))
		child, _ = strconv.Atoi(strings.TrimSpace(string(b)))
	}
	text, isErr = runIn(t, c, dir, map[string]any{"job_id": id, "action": "wait", "timeout": 1})
	if isErr || !strings.Contains(text, "is still running") || !alive(child) {
		t.Fatal(text)
	}
	text, isErr = runIn(t, c, dir, map[string]any{"job_id": id, "action": "kill"})
	if isErr || !strings.Contains(text, "was stopped") {
		t.Fatal(text)
	}
	waitGone(t, child)
	for _, bad := range []map[string]any{{"job_id": id, "action": "nope"}, {"action": "status"}, {"job_id": "job-999", "action": "status"}, {"command": "x", "timeout": -1}} {
		if text, isErr := runIn(t, c, dir, bad); !isErr {
			t.Fatalf("%v: %s", bad, text)
		}
	}
}

func TestBackgroundCommandsAreLimitedAndTimedOut(t *testing.T) {
	dir := t.TempDir()
	jobs := &Jobs{}
	defer jobs.Close()
	c := Command{Jobs: jobs, JobScope: "a"}
	for range MaxJobs {
		if text, isErr := runIn(t, c, dir, map[string]any{"command": "sleep 30", "background": true}); isErr {
			t.Fatal(text)
		}
	}
	text, isErr := runIn(t, c, dir, map[string]any{"command": "sleep 30", "background": true})
	if !isErr || !strings.Contains(text, "already running") || !strings.Contains(text, "job-1") {
		t.Fatal(text)
	}
	// another scope has its own
	other := c
	other.JobScope = "b"
	text, isErr = runIn(t, other, dir, map[string]any{"command": "sleep 0.5", "background": true, "timeout": 30})
	if isErr {
		t.Fatal(text)
	}
	jobs.End("a")
	if got := jobs.Running("a"); len(got) != 0 {
		t.Fatalf("%v", got)
	}
	text, _ = runIn(t, other, dir, map[string]any{"command": "sleep 30", "background": true, "timeout": 1})
	id := jobOf(t, text)
	text, _ = runIn(t, other, dir, map[string]any{"job_id": id, "action": "wait"})
	if !strings.Contains(text, "ran past its timeout") {
		t.Fatal(text)
	}
	// without a registry, nothing runs in the background
	if text, isErr := runIn(t, Command{}, dir, map[string]any{"command": "true", "background": true}); !isErr || !strings.Contains(text, "not available") {
		t.Fatal(text)
	}
}

// Ending a scope stops its commands and what they started, grandchildren included; their end is reported once.
func TestEndingAScopeStopsItsProcessGroups(t *testing.T) {
	dir := t.TempDir()
	jobs := &Jobs{}
	defer jobs.Close()
	c := Command{Jobs: jobs, JobScope: "a"}
	text, _ := runIn(t, c, dir, map[string]any{"command": "sh -c 'sleep 30 & echo $! > grand.pid; wait' & wait", "background": true})
	jobOf(t, text)
	text, _ = runIn(t, c, dir, map[string]any{"command": "echo quick", "background": true})
	quick := jobOf(t, text)
	var grand int
	for deadline := time.Now().Add(5 * time.Second); grand == 0 && time.Now().Before(deadline); time.Sleep(20 * time.Millisecond) {
		b, _ := os.ReadFile(filepath.Join(dir, "grand.pid"))
		grand, _ = strconv.Atoi(strings.TrimSpace(string(b)))
	}
	if grand == 0 || !alive(grand) {
		t.Fatal("no grandchild")
	}
	for deadline := time.Now().Add(5 * time.Second); !jobs.HasEnded("a"); time.Sleep(10 * time.Millisecond) {
		if time.Now().After(deadline) {
			t.Fatal("the quick one did not end")
		}
	}
	ended := jobs.Ended("a")
	if len(ended) != 1 || ended[0].ID != quick || ended[0].State != JobExited || !strings.Contains(ended[0].Text(), "quick") || len(jobs.Ended("a")) != 0 {
		t.Fatalf("%+v", ended)
	}
	jobs.End("a")
	waitGone(t, grand)
	if text, isErr := runIn(t, c, dir, map[string]any{"job_id": quick, "action": "status"}); !isErr {
		t.Fatalf("still known after its scope ended: %s", text)
	}
}

// What ends while a scope waits wakes it.
func TestSignalWakesOnEnd(t *testing.T) {
	jobs := &Jobs{}
	defer jobs.Close()
	sig := jobs.Signal("a")
	if _, err := jobs.Start(context.Background(), "a", t.TempDir(), "true", 0, "", nil); err != nil {
		t.Fatal(err)
	}
	select {
	case <-sig:
	case <-time.After(5 * time.Second):
		t.Fatal("not woken")
	}
}
