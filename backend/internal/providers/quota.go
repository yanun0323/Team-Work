package providers

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"

	"github.com/yanun0323/Team-Work/internal/adapter"
	"github.com/yanun0323/Team-Work/internal/model"
)

// Quota passes on what the subscription's client reports of its limits.
func (s subscription) Quota(ctx context.Context) (model.Quota, error) {
	if r, ok := s.client.(adapter.QuotaReader); ok {
		return r.Quota(ctx)
	}
	return model.Quota{}, nil
}

// Quota reads the balance from the services that publish one for an API key. Others report nothing: OpenAI,
// Anthropic and Google have no balance endpoint for a plain key.
func (o openAI) Quota(ctx context.Context) (model.Quota, error) {
	u, err := url.Parse(o.base)
	if err != nil || u.Host == "" {
		return model.Quota{}, nil
	}
	root := u.Scheme + "://" + u.Host
	switch host := strings.ToLower(u.Hostname()); {
	case host == "openrouter.ai" || strings.HasSuffix(host, ".openrouter.ai"):
		return o.openRouterBalance(ctx, root)
	case host == "api.deepseek.com":
		return o.deepSeekBalance(ctx, root)
	}
	return model.Quota{}, nil
}

func (o openAI) getJSON(ctx context.Context, root, path string, into any) error {
	res, err := client{base: root, key: o.key, http: o.http}.do(ctx, http.MethodGet, path, nil, o.auth)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if json.NewDecoder(io.LimitReader(res.Body, 1<<20)).Decode(into) != nil {
		return model.Errorf(model.CodeUnavailable, "餘額格式不正確")
	}
	return nil
}

// openRouterBalance reads what is left of the key's own credit limit. A key without a limit reports none:
// the account's total credits need a management key.
// https://openrouter.ai/docs/api/api-reference/api-keys/get-current-key
func (o openAI) openRouterBalance(ctx context.Context, root string) (model.Quota, error) {
	var body struct {
		Data struct {
			Remaining *float64 `json:"limit_remaining"`
		} `json:"data"`
	}
	if err := o.getJSON(ctx, root, "/api/v1/key", &body); err != nil {
		return model.Quota{}, err
	}
	if body.Data.Remaining == nil {
		return model.Quota{}, nil
	}
	return model.Quota{Balance: body.Data.Remaining, Currency: "USD"}, nil
}

// deepSeekBalance reads the account's balance, the first currency it lists.
// https://api-docs.deepseek.com/api/get-user-balance
func (o openAI) deepSeekBalance(ctx context.Context, root string) (model.Quota, error) {
	var body struct {
		Infos []struct {
			Currency string `json:"currency"`
			Total    string `json:"total_balance"`
		} `json:"balance_infos"`
	}
	if err := o.getJSON(ctx, root, "/user/balance", &body); err != nil {
		return model.Quota{}, err
	}
	for _, b := range body.Infos {
		if v, err := strconv.ParseFloat(b.Total, 64); err == nil && b.Currency != "" {
			return model.Quota{Balance: &v, Currency: b.Currency}, nil
		}
	}
	return model.Quota{}, nil
}
