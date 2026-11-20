package usecase

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/rs/zerolog"

	"github.com/yanun0323/Team-Work/internal/model"
	"github.com/yanun0323/Team-Work/internal/model/enum"
)

// counting is a provider that can say what a request would send.
type counting struct {
	stepsFake
	mu    sync.Mutex
	n     int
	whole bool  // whether its number covers the request whole, as a service's own endpoint's does
	err   error // what the counting answers with, while gone is set
	gone  bool
	asked int
	stop  func() // called off the asking's own context, once
}

func (c *counting) CountTokens(ctx context.Context, _ model.ModelRequest) (int, bool, error) {
	c.mu.Lock()
	c.asked++
	stop := c.stop
	c.stop = nil // it calls off the asking once, not every asking after it
	c.mu.Unlock()
	if stop != nil {
		stop()
		<-ctx.Done()
		return 0, false, ctx.Err()
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.gone {
		return 0, c.whole, c.err
	}
	return c.n, c.whole, nil
}

// stopOn makes the next counting call the user's run called off, the way a stopped chat leaves its count
// waiting on nothing but the cancellation.
func (c *counting) stopOn(cancel func()) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.stop = cancel
}

func (c *counting) say(n int) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.n, c.gone, c.whole = n, false, true
}

// sayWords is a self-hosted server's answer: a count of the request's words alone, which may hold a
// conversation up but not let one down.
func (c *counting) sayWords(n int) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.n, c.gone, c.whole = n, false, false
}

func (c *counting) fail() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.gone, c.err = true, errors.New("no such endpoint")
}

func (c *counting) times() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.asked
}

// countRig is an engine whose clock a test turns by hand, so a wait can be passed without sleeping.
func countRig() (*Engine, *float64, *counting) {
	now := new(float64)
	c := &counting{}
	e := &Engine{w: model.NewWorld(), log: zerolog.Nop(), clock: func() float64 { return *now }, countOff: map[string]float64{}}
	return e, now, c
}

var sayHi = model.ModelRequest{Model: "m", Messages: []model.Message{{Role: enum.RoleUser, Content: []model.Block{{Type: enum.BlockText, Text: "hi"}}}}}

// Only providers with a counting endpoint of their own answer; the rest are left to the rough count, unasked.
func TestOnlyCountingProvidersAreAsked(t *testing.T) {
	t.Parallel()
	e, _, _ := countRig()
	if _, _, ok := e.countTokens(context.Background(), &stepsFake{}, "m", sayHi); ok {
		t.Fatal("a provider without an endpoint counted")
	}
	c := &counting{n: 900}
	if got, whole, ok := e.countTokens(context.Background(), c, "m", sayHi); !ok || got != 900 || whole || c.times() != 1 {
		t.Fatalf("%d whole=%v %v asked %d", got, whole, ok, c.times())
	}
	// the meter wrapped around it answers the same way
	if _, _, ok := e.countTokens(context.Background(), meter{Provider: c}, "m", sayHi); !ok {
		t.Fatal("a metered counter does not count")
	}
}

// A provider that cannot say is asked once, then left alone until countRetryAfter has passed: a server with no
// counting endpoint would otherwise pay for the same 404 every round. An answer clears the hold.
func TestAFailingCounterIsLeftUnasked(t *testing.T) {
	t.Parallel()
	e, now, c := countRig()
	c.fail()
	if _, _, ok := e.countTokens(context.Background(), c, "m", sayHi); ok {
		t.Fatal("a failure counted")
	}
	if _, _, ok := e.countTokens(context.Background(), c, "m", sayHi); ok {
		t.Fatal("asked again right away")
	}
	if c.times() != 1 {
		t.Fatalf("asked %d times", c.times())
	}
	*now += countRetryAfter.Seconds() - 1
	e.countTokens(context.Background(), c, "m", sayHi)
	if c.times() != 1 {
		t.Fatal("still asked one second short of the wait")
	}
	*now += 2
	c.say(700)
	if got, _, ok := e.countTokens(context.Background(), c, "m", sayHi); !ok || got != 700 {
		t.Fatalf("%d %v", got, ok)
	}
	// and once it answers, it keeps being asked
	if _, _, ok := e.countTokens(context.Background(), c, "m", sayHi); !ok || c.times() != 3 {
		t.Fatalf("asked %d times", c.times())
	}
}

// An answer of nothing is no answer: the rough count stands, and the hold goes on like for a failure.
func TestACounterOfZeroDoesNotCount(t *testing.T) {
	t.Parallel()
	e, _, c := countRig()
	c.say(0)
	if _, _, ok := e.countTokens(context.Background(), c, "m", sayHi); ok {
		t.Fatal("zero counted")
	}
	c.say(500)
	if _, _, ok := e.countTokens(context.Background(), c, "m", sayHi); ok {
		t.Fatal("still asked right after a zero")
	}
}

// A count called off because the user stopped that run holds nothing: the next chat, on another conversation of
// the same provider, is asked right away. And the attachments are read only for a provider that is not held:
// cancelling a run past the hold does not pay for loading its pictures.
func TestACancelledCountHoldsNothing(t *testing.T) {
	t.Parallel()
	e, now, c := countRig()
	ctx, cancel := context.WithCancel(context.Background())
	c.stopOn(cancel)
	if _, _, ok := e.countTokens(ctx, c, "m", sayHi); ok {
		t.Fatal("a called-off count counted")
	}
	cancel()
	if c.times() != 1 {
		t.Fatalf("asked %d times", c.times())
	}
	c.say(400)
	if got, _, ok := e.countTokens(context.Background(), c, "m", sayHi); !ok || got != 400 {
		t.Fatalf("the next run could not count: %d %v", got, ok)
	}
	// a real failure still holds, and reads no attachments while held
	c.fail()
	e.countTokens(context.Background(), c, "m", sayHi)
	asked := c.times()
	e.countTokens(context.Background(), c, "m", sayHi)
	if c.times() != asked {
		t.Fatal("asked again while held")
	}
	*now += countRetryAfter.Seconds() + 1
	if _, _, ok := e.countTokens(context.Background(), c, "m", sayHi); ok || c.times() != asked+1 {
		t.Fatalf("asked %d times after the wait", c.times())
	}
}

// A counting call that would take too long does not hold the turn: it is asked to stop, and the rough count
// goes on with the round. Not parallel: it shares countAskTimeout with the process.
func TestCountingIsWaitedOut(t *testing.T) {
	old := countAskTimeout
	countAskTimeout = 50 * time.Millisecond
	t.Cleanup(func() { countAskTimeout = old })
	e, _, _ := countRig()
	slow := &waitCounter{hold: make(chan struct{})}
	over := make(chan [2]any, 1)
	go func() {
		n, _, ok := e.countTokens(context.Background(), slow, "m", sayHi)
		over <- [2]any{n, ok}
	}()
	select {
	case got := <-over:
		if got[1].(bool) {
			t.Fatal("a call that never answered counted")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("the turn waited on the count")
	}
	slow.mu.Lock()
	waited := slow.stopped
	slow.mu.Unlock()
	if !waited {
		t.Fatal("the counting was not asked to stop")
	}
	close(slow.hold)
}

type waitCounter struct {
	stepsFake
	mu      sync.Mutex
	hold    chan struct{}
	stopped bool
}

func (w *waitCounter) CountTokens(ctx context.Context, _ model.ModelRequest) (int, bool, error) {
	select {
	case <-ctx.Done():
		w.mu.Lock()
		w.stopped = true
		w.mu.Unlock()
		return 0, false, ctx.Err()
	case <-w.hold:
		return 1, true, nil
	}
}

// Far below the point a conversation is summed up at there is nothing to decide, so the provider is not asked
// at all; once the rough count comes near it, the provider's whole-request number decides, higher or lower
// than the rough.
func TestTheExactCountComesInNearTheThreshold(t *testing.T) {
	t.Parallel()
	e, _, c := countRig()
	exact := e.exactFor(c, "m")
	for _, test := range []struct {
		name  string
		rough int
		exact int
		want  bool
	}{
		{"far short", 10_000, 0, false},
		{"near, the provider says short", 80_000, 90_000, false},
		{"near, the provider says full", 80_000, 120_000, true},
		{"the rough count alone is past it", 120_000, 95_000, false},
		{"no threshold set: never asked", 120_000, 0, true},
	} {
		c.say(test.exact)
		var kept int
		tr := &turn{compactAt: 100_000, req: sayHi, exact: exact, measured: func(n int) { kept = n }}
		if test.name == "no threshold set: never asked" {
			tr.compactAt = 0
		}
		asked := c.times()
		if got := tr.needsCompacting(context.Background(), test.rough); got != test.want {
			t.Errorf("%s: %v", test.name, got)
		}
		near := test.rough*100 >= tr.compactAt*measureFrom && tr.compactAt > 0
		if c.times() > asked != near {
			t.Errorf("%s: asked %v, the rough count being near is %v", test.name, c.times() > asked, near)
		}
		if test.exact > 0 && kept != test.exact {
			t.Errorf("%s: kept %d, want %d", test.name, kept, test.exact)
		}
	}
}

// A self-hosted server's tokenize counts the request's words without the chat template the server wraps them
// in, so it can come under what the provider itself reported the last round. Such a number may raise the
// measure of what the next call sends - the words it now holds really are there - but never lower it: a
// conversation the rough count already holds at the point it is summed up at goes on being summed up, and
// what the screen holds never walks back on a partial count. A whole-request count still decides both ways.
func TestAPartialCountHoldsTheMeasureUpOnly(t *testing.T) {
	t.Parallel()
	e, _, c := countRig()
	tr := &turn{compactAt: 100_000, req: sayHi, exact: e.exactFor(c, "m")}
	// the provider reported 10,000 sent already; the words alone tokenize to 9,000
	c.sayWords(9_000)
	if got := tr.howMany(context.Background(), 10_000); got != 10_000 {
		t.Errorf("a partial count brought the measure down: %d", got)
	}
	// the same server says the words alone fill the room: that holds against the rough count
	c.sayWords(120_000)
	if got := tr.howMany(context.Background(), 80_000); got != 120_000 {
		t.Errorf("a partial count did not raise the measure: %d", got)
	}
	// and at the deciding point, the conversation the partial count shortened still gets summed up
	c.sayWords(90_000)
	if !tr.needsCompacting(context.Background(), 100_000) {
		t.Error("a chat at its point was let off by a partial count")
	}
	// a whole count still decides down
	c.say(90_000)
	if tr.needsCompacting(context.Background(), 100_000) {
		t.Error("a whole count could not let the chat off")
	}
	// what a partial count raises the measure to is what the run keeps
	var kept int
	tr.measured = func(n int) { kept = n }
	c.sayWords(120_000)
	tr.howMany(context.Background(), 80_000)
	if kept != 120_000 {
		t.Fatalf("kept %d", kept)
	}
	kept = 0
	c.sayWords(9_000)
	tr.howMany(context.Background(), 10_000)
	if kept != 0 {
		t.Fatalf("a partial count that was not taken went to the run anyway: %d", kept)
	}
}

// A provider that cannot say leaves the rough count standing, exactly as it did before counting was asked for.
func TestTheRoughCountStandsAlone(t *testing.T) {
	t.Parallel()
	e, _, c := countRig()
	c.fail()
	tr := &turn{compactAt: 100_000, req: sayHi, exact: e.exactFor(c, "m")}
	if !tr.needsCompacting(context.Background(), 120_000) {
		t.Error("the rough count was not taken")
	}
	if tr.needsCompacting(context.Background(), 99_000) {
		t.Error("the rough count was taken as full")
	}
	bare := &turn{compactAt: 100_000, req: sayHi}
	if !bare.needsCompacting(context.Background(), 120_000) || bare.needsCompacting(context.Background(), 50_000) {
		t.Error("a turn without a counter does not go by the rough count")
	}
}
