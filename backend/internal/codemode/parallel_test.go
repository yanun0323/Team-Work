package codemode_test

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/yanun0323/Team-Work/internal/codemode"
)

// slow waits d, or until its context ends, and counts how many run at once.
func slow(name string, d time.Duration, running, most *atomic.Int32) codemode.Func {
	return codemode.Func{Name: name, Returns: "unknown", Call: func(ctx context.Context, raw json.RawMessage) (any, error) {
		now := running.Add(1)
		defer running.Add(-1)
		for {
			old := most.Load()
			if now <= old || most.CompareAndSwap(old, now) {
				break
			}
		}
		select {
		case <-time.After(d):
		case <-ctx.Done():
			return nil, ctx.Err()
		}
		var a struct{ N int }
		_ = json.Unmarshal(raw, &a)
		if a.N < 0 {
			return nil, errors.New("negative")
		}
		return map[string]any{"n": a.N * 2}, nil
	}}
}

func TestParallelRunsCallsAtOnceInOrder(t *testing.T) {
	var running, most atomic.Int32
	fn := slow("wait", 200*time.Millisecond, &running, &most)
	started := time.Now()
	res := run(t, `
const out = parallel([1, 2, -1, 3, 4].map(n => ({tool: "wait", args: {N: n}})));
return out.map(r => r.ok ? r.value.n : "error: " + r.error);`, fn)
	took := time.Since(started)
	if res.Err != nil {
		t.Fatalf("%+v", res.Err)
	}
	if want := `[2,4,"error: negative",6,8]`; res.Output != want {
		t.Fatalf("output %s, want %s", res.Output, want)
	}
	// five calls of 200ms one after another take a second
	if took > 600*time.Millisecond || most.Load() < 2 {
		t.Fatalf("took %v, at most %d at once", took, most.Load())
	}
	if res.Calls["wait"] != 5 || res.Batches != 1 {
		t.Fatalf("calls %v, batches %d", res.Calls, res.Batches)
	}
}

func TestParallelMixesWithSyncCallsAndChecksItsArguments(t *testing.T) {
	var n atomic.Int32
	x := codemode.Func{Name: "x", Returns: "unknown", Call: func(context.Context, json.RawMessage) (any, error) { n.Add(1); return map[string]any{"a": 1}, nil }}
	res := run(t, `
const one = tools.x({});
const many = parallel([{tool: "x"}, {tool: "x", args: {}}]);
let bad = [];
for (const arg of [5, [{tool: "nope"}], [3], [{tool: "x", args: [1]}]]) {
  try { parallel(arg) } catch (e) { bad.push(e instanceof TypeError) }
}
return [one.a, many.length, many[1].value.a, bad];`, x)
	if res.Err != nil || res.Output != `[1,2,1,[true,true,true,true]]` || n.Load() != 3 {
		t.Fatalf("%+v n=%d", res, n.Load())
	}
}

// The call limit and the host's refusal hold for a batch as a whole: none of it runs and the script cannot catch it.
func TestParallelKeepsTheLimitsUncatchable(t *testing.T) {
	var n atomic.Int32
	x := codemode.Func{Name: "x", Returns: "unknown", Call: func(context.Context, json.RawMessage) (any, error) { n.Add(1); return nil, nil }}
	res := run(t, `
for (let i = 0; i < 60; i++) tools.x();
try { parallel([1,2,3,4,5].map(() => ({tool: "x"}))) } catch (e) { text("caught") }
text("after")`, x)
	if res.Err == nil || res.Err.Reason != codemode.ReasonCallLimit || n.Load() != 60 || strings.Contains(res.Output, "caught") || strings.Contains(res.Output, "after") {
		t.Fatalf("%+v n=%d", res, n.Load())
	}

	var mu sync.Mutex
	asked := 0
	h := codemode.Hooks{BeforeCall: func(string) error {
		mu.Lock()
		defer mu.Unlock()
		if asked++; asked > 32 {
			return &codemode.Failure{Reason: "owner_limit", Message: "over"}
		}
		return nil
	}}
	n.Store(0)
	res = codemode.Run(context.Background(), `
for (let i = 0; i < 30; i++) tools.x();
try { parallel([1,2,3,4].map(() => ({tool: "x"}))) } catch (e) { text("caught") }`, []codemode.Func{x}, codemode.DefaultLimits(), h)
	if res.Err == nil || res.Err.Reason != "owner_limit" || n.Load() != 30 || res.Output != "" {
		t.Fatalf("%+v n=%d", res, n.Load())
	}
}

func TestParallelStopsWithTheRun(t *testing.T) {
	var running, most atomic.Int32
	fn := slow("wait", time.Minute, &running, &most)
	ctx, cancel := context.WithCancel(context.Background())
	time.AfterFunc(100*time.Millisecond, cancel)
	started := time.Now()
	res := codemode.Run(ctx, `try { parallel([{tool: "wait"}, {tool: "wait"}]) } catch (e) { text("caught") }`, []codemode.Func{fn}, codemode.DefaultLimits(), codemode.Hooks{})
	if res.Err == nil || res.Err.Reason != codemode.ReasonCancelled || res.Output != "" || time.Since(started) > 5*time.Second {
		t.Fatalf("%+v", res)
	}

	lim := codemode.DefaultLimits()
	lim.Timeout = 150 * time.Millisecond
	res = codemode.Run(context.Background(), `try { parallel([{tool: "wait"}]) } catch (e) { text("caught") }`, []codemode.Func{fn}, lim, codemode.Hooks{})
	if res.Err == nil || res.Err.Reason != codemode.ReasonTimeout || res.Output != "" {
		t.Fatalf("%+v", res)
	}
	deadline := time.Now().Add(5 * time.Second)
	for running.Load() != 0 && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if running.Load() != 0 {
		t.Fatal("calls still running")
	}
}

// Calls counts the calls that ran, not those the limits held back: a batch the host refuses, or a script that hit its
// call limit, adds none of its own; calls a stopped batch never started add nothing either.
func TestCallsCountWhatRan(t *testing.T) {
	var n atomic.Int32
	x := codemode.Func{Name: "x", Returns: "unknown", Call: func(context.Context, json.RawMessage) (any, error) { n.Add(1); return nil, nil }}
	asked := 0
	h := codemode.Hooks{BeforeCall: func(string) error {
		if asked++; asked > 32 {
			return &codemode.Failure{Reason: "owner_limit", Message: "over"}
		}
		return nil
	}}
	res := codemode.Run(context.Background(), `
for (let i = 0; i < 30; i++) tools.x();
parallel([1,2,3,4].map(() => ({tool: "x"})))`, []codemode.Func{x}, codemode.DefaultLimits(), h)
	if res.Err == nil || n.Load() != 30 || res.Calls["x"] != 30 {
		t.Fatalf("ran %d, counted %v", n.Load(), res.Calls)
	}

	n.Store(0)
	res = run(t, `
for (let i = 0; i < 60; i++) tools.x();
parallel([1,2,3,4,5].map(() => ({tool: "x"})))`, x)
	if res.Err == nil || n.Load() != 60 || res.Calls["x"] != 60 {
		t.Fatalf("ran %d, counted %v", n.Load(), res.Calls)
	}

	// a batch stopped with calls still queued counts only those that started
	var running, most, started atomic.Int32
	wait := slow("wait", time.Minute, &running, &most)
	inner := wait.Call
	wait.Call = func(ctx context.Context, args json.RawMessage) (any, error) { started.Add(1); return inner(ctx, args) }
	ctx, cancel := context.WithCancel(context.Background())
	time.AfterFunc(150*time.Millisecond, cancel)
	res = codemode.Run(ctx, `parallel(Array.from({length: 20}, () => ({tool: "wait"})))`, []codemode.Func{wait}, codemode.DefaultLimits(), codemode.Hooks{})
	if res.Err == nil || res.Err.Reason != codemode.ReasonCancelled || res.Calls["wait"] != int(started.Load()) || started.Load() >= 20 {
		t.Fatalf("started %d, counted %v", started.Load(), res.Calls)
	}
}
