package model

// Usage is one model call's consumption, kept so the airport can sum it by provider and day.
// ProviderName keeps what the provider was called, for when it is gone.
type Usage struct {
	At           float64 `json:"at"`
	ProviderID   string  `json:"providerId"`
	ProviderName string  `json:"providerName"`
	Model        string  `json:"model"`
	Input        int     `json:"input"` // includes CacheRead
	Output       int     `json:"output"`
	CacheRead    int     `json:"cacheRead"`
	// CostUSD is priced when the call was made; Priced says whether the model had a price then.
	CostUSD float64 `json:"costUsd"`
	Priced  bool    `json:"priced"`
}

// UsageTotals sums calls. Tokens is what was newly consumed: everything but what was read back from the cache.
type UsageTotals struct {
	Calls     int     `json:"calls"`
	Input     int     `json:"input"`
	Output    int     `json:"output"`
	CacheRead int     `json:"cacheRead"`
	Tokens    int     `json:"tokens"`
	CostUSD   float64 `json:"costUsd"`
	// Unpriced counts calls whose model had no price, so their cost is missing from CostUSD.
	Unpriced int `json:"unpriced"`
}

// Add counts u in.
func (t *UsageTotals) Add(u Usage) {
	t.Calls++
	t.Input += u.Input
	t.Output += u.Output
	t.CacheRead += u.CacheRead
	t.Tokens += max(u.Input-u.CacheRead, 0) + u.Output
	t.CostUSD += u.CostUSD
	if !u.Priced {
		t.Unpriced++
	}
}

// UsageModel is one model's share of a provider's usage.
type UsageModel struct {
	Model string `json:"model"`
	UsageTotals
}

// UsageProvider is one provider's usage, most used model first.
type UsageProvider struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	UsageTotals
	Models []UsageModel `json:"models"`
}

// UsageDay is one day's usage. Date is YYYY-MM-DD in the asker's time zone.
type UsageDay struct {
	Date string `json:"date"`
	UsageTotals
	// Parts are the day's tokens by provider and model, in no order.
	Parts []UsagePart `json:"parts"`
}

// UsagePart is one model's tokens on a day.
type UsagePart struct {
	ProviderID string `json:"providerId"`
	Model      string `json:"model"`
	Tokens     int    `json:"tokens"`
}

// UsageStats is usage since a moment, by provider and by day.
type UsageStats struct {
	Since     float64         `json:"since"`
	Total     UsageTotals     `json:"total"`
	Providers []UsageProvider `json:"providers"`
	Days      []UsageDay      `json:"days"`
}
