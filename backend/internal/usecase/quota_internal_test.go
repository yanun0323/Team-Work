package usecase

import (
	"context"
	"errors"
	"testing"

	"github.com/yanun0323/Team-Work/internal/adapter"
	"github.com/yanun0323/Team-Work/internal/model"
)

// quotaFake counts how often its allowance is asked, and fails while fail is set.
type quotaFake struct {
	adapter.Providers
	asked int
	fail  bool
}

func (f *quotaFake) For(model.ModelProvider, string) (adapter.Provider, error) { return f, nil }
func (f *quotaFake) Complete(context.Context, model.ModelRequest, func(string)) (model.ModelReply, error) {
	return model.ModelReply{}, nil
}
func (f *quotaFake) Models(context.Context) ([]model.ModelSpec, error) { return nil, nil }
func (f *quotaFake) Quota(context.Context) (model.Quota, error) {
	f.asked++
	if f.fail {
		return model.Quota{}, errors.New("down")
	}
	v := float64(f.asked)
	return model.Quota{FiveHour: &v}, nil
}

func TestQuotasReuseAnAnswerForAMinute(t *testing.T) {
	t.Parallel()
	fake := &quotaFake{}
	now := 1000.0
	w := model.NewWorld()
	w.Providers["p"] = &model.ModelProvider{ID: "p", Auth: model.ProviderAuth{Kind: "apiKey"}}
	e := &Engine{w: w, secrets: map[string]string{"p": "k1"}, quotas: map[string]quotaEntry{}, providers: fake, clock: func() float64 { return now }}
	ctx := context.Background()

	got := func() float64 {
		t.Helper()
		q, ok := e.Quotas(ctx)["p"]
		if !ok || q.FiveHour == nil {
			t.Fatalf("no quota for p")
		}
		return *q.FiveHour
	}
	if got() != 1 {
		t.Fatal("first read should ask")
	}
	now += 59
	if got() != 1 || fake.asked != 1 {
		t.Fatalf("within a minute the answer should be reused, asked %d", fake.asked)
	}
	now += 1
	if got() != 2 {
		t.Fatal("after a minute it should ask again")
	}
	e.secrets["p"] = "k2"
	if got() != 3 {
		t.Fatal("a new key should ask again")
	}
	e.secrets["p"] = "k1"
	now += 60
	fake.fail = true
	if _, ok := e.Quotas(ctx)["p"]; ok {
		t.Fatal("a failed read should leave the provider out")
	}
	fake.fail = false
	if got() != 5 {
		t.Fatal("a failed read should not be cached")
	}
}
