package usecase

import (
	"cmp"
	"context"
	"slices"
	"time"

	"github.com/yanun0323/Team-Work/internal/adapter"
	"github.com/yanun0323/Team-Work/internal/model"
)

// meter records what each call to the provider consumed.
type meter struct {
	adapter.Provider
	e            *Engine
	providerID   string
	providerName string
	model        string
	price        *model.ModelPrice
}

func (m meter) Complete(ctx context.Context, req model.ModelRequest, onText func(string)) (model.ModelReply, error) {
	reply, err := m.Provider.Complete(ctx, req, onText)
	if u := reply.Usage; u.Input+u.Output > 0 {
		m.e.recordUsage(model.Usage{ProviderID: m.providerID, ProviderName: m.providerName, Model: m.model}, m.price, u)
	}
	return reply, err
}

// recordUsage keeps one call's consumption. It outlives the call, so a stopped run still counts.
func (e *Engine) recordUsage(rec model.Usage, price *model.ModelPrice, u model.ModelUsage) {
	rec.At, rec.Input, rec.Output, rec.CacheRead = e.clock(), u.Input, u.Output, u.CacheRead
	if price != nil {
		rec.CostUSD, rec.Priced = cost(u, *price), true
	}
	if err := e.store.AddUsage(context.WithoutCancel(e.ctx), rec); err != nil {
		e.log.Warn().Err(err).Msg("record model usage")
	}
}

// Usage sums model calls made at or after since, by provider and model and by day.
// offset is the asker's time zone in minutes east of UTC; days run from since (or the first call) to today, empty ones included.
func (e *Engine) Usage(ctx context.Context, since float64, offset int) (model.UsageStats, error) {
	records, err := e.store.LoadUsage(ctx, since)
	if err != nil {
		return model.UsageStats{}, err
	}
	e.mu.Lock()
	names := make(map[string]string, len(e.w.Providers))
	for id, p := range e.w.Providers {
		names[id] = p.Name
	}
	now := e.clock()
	e.mu.Unlock()
	return sumUsage(records, names, since, now, offset), nil
}

func sumUsage(records []model.Usage, names map[string]string, since, now float64, offset int) model.UsageStats {
	zone := time.FixedZone("", offset*60)
	day := func(at float64) time.Time {
		t := time.UnixMilli(int64(at * 1000)).In(zone)
		return time.Date(t.Year(), t.Month(), t.Day(), 0, 0, 0, 0, zone)
	}
	out := model.UsageStats{Since: since, Providers: []model.UsageProvider{}, Days: []model.UsageDay{}}
	providers := map[string]*model.UsageProvider{}
	models := map[string]map[string]*model.UsageModel{}
	days := map[string]*model.UsageDay{}
	type partKey struct{ day, provider, model string }
	parts := map[partKey]int{}
	for _, u := range records {
		out.Total.Add(u)
		p := providers[u.ProviderID]
		if p == nil {
			p = &model.UsageProvider{ID: u.ProviderID, Name: cmp.Or(names[u.ProviderID], u.ProviderName)}
			providers[u.ProviderID], models[u.ProviderID] = p, map[string]*model.UsageModel{}
		}
		p.Add(u)
		m := models[u.ProviderID][u.Model]
		if m == nil {
			m = &model.UsageModel{Model: u.Model}
			models[u.ProviderID][u.Model] = m
		}
		m.Add(u)
		key := day(u.At).Format(time.DateOnly)
		if days[key] == nil {
			days[key] = &model.UsageDay{Date: key}
		}
		d := days[key]
		d.Add(u)
		pk := partKey{key, u.ProviderID, u.Model}
		i, ok := parts[pk]
		if !ok {
			i = len(d.Parts)
			parts[pk] = i
			d.Parts = append(d.Parts, model.UsagePart{ProviderID: u.ProviderID, Model: u.Model})
		}
		d.Parts[i].Tokens += max(u.Input-u.CacheRead, 0) + u.Output
	}
	for id, p := range providers {
		for _, m := range models[id] {
			p.Models = append(p.Models, *m)
		}
		slices.SortFunc(p.Models, func(a, b model.UsageModel) int { return cmp.Or(b.Tokens-a.Tokens, cmp.Compare(a.Model, b.Model)) })
		out.Providers = append(out.Providers, *p)
	}
	slices.SortFunc(out.Providers, func(a, b model.UsageProvider) int { return cmp.Or(b.Tokens-a.Tokens, cmp.Compare(a.Name, b.Name)) })

	first := since
	if len(records) > 0 && (first <= 0 || records[0].At < first) {
		first = records[0].At
	}
	if first <= 0 {
		return out
	}
	for d, last := day(first), day(now); !d.After(last); d = d.AddDate(0, 0, 1) {
		key := d.Format(time.DateOnly)
		entry := model.UsageDay{Date: key, Parts: []model.UsagePart{}}
		if t := days[key]; t != nil {
			entry = *t
		}
		out.Days = append(out.Days, entry)
	}
	return out
}
