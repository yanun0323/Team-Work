package providers

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/yanun0323/Team-Work/internal/adapter"
	"github.com/yanun0323/Team-Work/internal/model"
	"github.com/yanun0323/Team-Work/internal/model/enum"
)

func balanceServer(t *testing.T, path, body string) (openAI, string) {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != path || r.Header.Get("Authorization") != "Bearer sk-key" {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		io.WriteString(w, body)
	}))
	t.Cleanup(srv.Close)
	return openAI{client: client{key: "sk-key", http: newHTTP()}}, srv.URL
}

func TestOpenRouterBalanceIsTheKeysLimitLeft(t *testing.T) {
	o, root := balanceServer(t, "/api/v1/key", `{"data":{"limit":20,"usage":7.5,"limit_remaining":12.5}}`)
	q, err := o.openRouterBalance(context.Background(), root)
	if err != nil || q.Balance == nil || *q.Balance != 12.5 || q.Currency != "USD" {
		t.Fatalf("%+v %v", q, err)
	}
	o, root = balanceServer(t, "/api/v1/key", `{"data":{"limit":null,"limit_remaining":null}}`)
	if q, err := o.openRouterBalance(context.Background(), root); err != nil || q.Balance != nil {
		t.Fatalf("a key without a limit reported %+v %v", q, err)
	}
}

func TestDeepSeekBalance(t *testing.T) {
	o, root := balanceServer(t, "/user/balance", `{"is_available":true,"balance_infos":[{"currency":"CNY","total_balance":"110.00"}]}`)
	q, err := o.deepSeekBalance(context.Background(), root)
	if err != nil || q.Balance == nil || *q.Balance != 110 || q.Currency != "CNY" {
		t.Fatalf("%+v %v", q, err)
	}
}

func TestOtherKeysReportNoBalance(t *testing.T) {
	for _, kind := range []enum.ProviderKind{enum.ProviderOpenAI, enum.ProviderAnthropic, enum.ProviderGoogle} {
		p, err := NewFactory(nil, nil).For(model.ModelProvider{Name: "x", Kind: kind, Auth: model.ProviderAuth{Kind: "apiKey"}}, "sk-key")
		if err != nil {
			t.Fatal(err)
		}
		r, ok := p.(adapter.QuotaReader)
		if !ok {
			continue
		}
		if q, err := r.Quota(context.Background()); err != nil || q != (model.Quota{}) {
			t.Fatalf("%s: %+v %v", kind, q, err)
		}
	}
}
