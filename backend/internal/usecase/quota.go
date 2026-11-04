package usecase

import (
	"context"
	"strconv"
	"sync"
	"time"

	"github.com/yanun0323/Team-Work/internal/adapter"
	"github.com/yanun0323/Team-Work/internal/model"
)

const (
	quotaTimeout = 15 * time.Second
	// quotaTTL is how long a provider's reported allowance is reused before it is asked again.
	quotaTTL = time.Minute
)

// quotaEntry is an allowance a provider reported, with when and for which settings it was asked.
type quotaEntry struct {
	sig string
	at  float64
	q   model.Quota
}

// quotaSig is what a provider's allowance depends on: a change to any of it asks again before the cache expires.
func quotaSig(p model.ModelProvider, key string) string {
	return string(p.Kind) + "\x00" + p.BaseURL + "\x00" + p.Auth.Kind + "\x00" + strconv.FormatBool(p.Auth.SignedIn) + "\x00" + key
}

// Quotas asks every provider at once what is left of its allowance, by provider id. An answer younger than quotaTTL
// for the same settings is reused. A provider that cannot tell, is not signed in or does not answer in time is left
// out, and asked again next time.
func (e *Engine) Quotas(ctx context.Context) map[string]model.Quota {
	type ask struct {
		p   model.ModelProvider
		key string
	}
	e.mu.Lock()
	asks := make([]ask, 0, len(e.w.Providers))
	for id, p := range e.w.Providers {
		asks = append(asks, ask{*clone(p), e.secrets[id]})
	}
	e.mu.Unlock()

	now := e.clock()
	out := map[string]model.Quota{}
	var fresh []ask
	e.quotaMu.Lock()
	live := make(map[string]bool, len(asks))
	for _, a := range asks {
		live[a.p.ID] = true
		if c, ok := e.quotas[a.p.ID]; ok && c.sig == quotaSig(a.p, a.key) && now-c.at < quotaTTL.Seconds() {
			out[a.p.ID] = c.q
			continue
		}
		fresh = append(fresh, a)
	}
	for id := range e.quotas {
		if !live[id] {
			delete(e.quotas, id)
		}
	}
	e.quotaMu.Unlock()

	ctx, cancel := context.WithTimeout(ctx, quotaTimeout)
	defer cancel()
	var mu sync.Mutex
	var wg sync.WaitGroup
	for _, a := range fresh {
		provider, err := e.providers.For(a.p, a.key)
		if err != nil {
			continue
		}
		reader, ok := provider.(adapter.QuotaReader)
		if !ok {
			continue
		}
		wg.Add(1)
		go func() {
			defer wg.Done()
			q, err := reader.Quota(ctx)
			if err != nil {
				e.noteSignedOut(a.p.ID, err)
				return
			}
			mu.Lock()
			out[a.p.ID] = q
			mu.Unlock()
			e.quotaMu.Lock()
			e.quotas[a.p.ID] = quotaEntry{sig: quotaSig(a.p, a.key), at: now, q: q}
			e.quotaMu.Unlock()
		}()
	}
	wg.Wait()
	return out
}
