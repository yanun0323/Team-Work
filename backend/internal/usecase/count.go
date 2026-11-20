package usecase

import (
	"context"
	"time"

	"github.com/yanun0323/Team-Work/internal/adapter"
	"github.com/yanun0323/Team-Work/internal/model"
)

// countRetryAfter is how long a provider whose counting call failed is left unasked, so a server with no
// counting endpoint is asked once in a while, not on every round.
const countRetryAfter = 10 * time.Minute

// countAskTimeout is the longest a turn waits on a provider counting its request; past it the rough count
// stands, as it does for a server that answers nothing else. A test shortens it instead of waiting.
var countAskTimeout = 5 * time.Second

// measureFrom is the share of the point a conversation is summed up at from which the rough count is close
// enough to it to be worth an exact one: far below it there is nothing to decide, and one HTTP call is
// spared each round of the many chats that stay well short of full.
const measureFrom = 70

// nearlyFull says whether what a request is roughly counted at has come near enough the point it is summed up
// at that the two may disagree on whether it is reached.
func nearlyFull(estimate, at int) bool {
	return at > 0 && estimate*100 >= at*measureFrom
}

// countTokens asks the request's provider to say what it would really send, and whether the number covers the
// request whole. Only services with a counting endpoint of their own answer; a call that failed leaves the
// provider unasked until countRetryAfter has passed, and the caller counts the rough way meanwhile. A request
// the user called off while it was counted holds nothing: another one may ask again right away.
func (e *Engine) countTokens(ctx context.Context, provider adapter.Provider, modelID string, req model.ModelRequest) (int, bool, bool) {
	counter, ok := provider.(adapter.TokenCounter)
	if m, wrapped := provider.(meter); wrapped {
		counter, ok = m.Provider.(adapter.TokenCounter)
	}
	if !ok {
		return 0, false, false
	}
	asked := modelID
	e.mu.Lock()
	if p := e.providerFor(modelID); p != nil {
		asked = p.ID
	}
	e.mu.Unlock()
	e.countMu.Lock()
	held := e.countOff[asked] > 0 && e.clock() < e.countOff[asked]
	e.countMu.Unlock()
	if held {
		return 0, false, false
	}
	// the counting goes to the provider beside the meter, so what is counted is what the call will send
	messages, err := e.resolveImages(ctx, req.Messages)
	if err != nil {
		return 0, false, false
	}
	req.Messages = messages
	ask, cancel := context.WithTimeout(ctx, countAskTimeout)
	defer cancel()
	n, whole, err := counter.CountTokens(ask, req)
	if err != nil || n <= 0 {
		if ctx.Err() == nil { // what was called off holds nothing
			e.countMu.Lock()
			if e.countOff == nil {
				e.countOff = map[string]float64{}
			}
			e.countOff[asked] = e.clock() + countRetryAfter.Seconds()
			e.countMu.Unlock()
		}
		if err != nil && ctx.Err() == nil {
			e.log.Debug().Err(err).Str("model", modelID).Msg("count request tokens")
		}
		return 0, false, false
	}
	e.countMu.Lock()
	delete(e.countOff, asked)
	e.countMu.Unlock()
	return n, whole, true
}

// howMany says what the turn's next call would send. The rough count stands while it is far below the point the
// conversation is summed up at; once it comes near, the provider is asked for the real number, since the two may
// disagree on whether the point is reached. A count of the request whole decides over the rough one. A count of
// less than that - a self-hosted server's tokenize, which never sees the chat template the server wraps the
// words in - is a floor the rough count may be raised to but never brought under, as it would else take back
// what the provider itself reported. A provider that cannot say leaves the rough count standing, as it always
// did; what the counting decided goes to the run that keeps the conversation's measure, so the screen and the
// next round measure by the number the turn went by.
func (t *turn) howMany(ctx context.Context, rough int) int {
	if t.exact == nil || !nearlyFull(rough, t.compactAt) {
		return rough
	}
	n, whole, ok := t.exact(ctx, t.req)
	if !ok {
		return rough
	}
	if !whole && n < rough {
		return rough // it says the request is no shorter than the rough count already does
	}
	if t.measured != nil {
		t.measured(n)
	}
	return n
}

// needsCompacting says whether what the turn's next call would send has reached the point its conversation is
// summed up at.
func (t *turn) needsCompacting(ctx context.Context, rough int) bool {
	return t.howMany(ctx, rough) >= t.compactAt
}

// exactFor is a turn's way of asking its own provider how many tokens a request would send.
func (e *Engine) exactFor(provider adapter.Provider, modelID string) func(context.Context, model.ModelRequest) (int, bool, bool) {
	return func(ctx context.Context, req model.ModelRequest) (int, bool, bool) {
		return e.countTokens(ctx, provider, modelID, req)
	}
}
