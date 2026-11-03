package usecase

import (
	"context"
	"sync"
	"time"

	"github.com/yanun0323/Team-Work/internal/adapter"
	"github.com/yanun0323/Team-Work/internal/model"
)

const quotaTimeout = 15 * time.Second

// Quotas asks every provider at once what is left of its allowance, by provider id. A provider that cannot
// tell, is not signed in or does not answer in time is left out.
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

	ctx, cancel := context.WithTimeout(ctx, quotaTimeout)
	defer cancel()
	out := map[string]model.Quota{}
	var mu sync.Mutex
	var wg sync.WaitGroup
	for _, a := range asks {
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
		}()
	}
	wg.Wait()
	return out
}
