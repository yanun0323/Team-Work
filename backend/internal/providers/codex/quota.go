package codex

import (
	"context"
	"encoding/json"
	"io"
	"net/http"

	"github.com/yanun0323/mho-company/internal/model"
)

// Window lengths the usage endpoint reports, in seconds. Which window is primary depends on the plan.
const (
	fiveHourWindow = 5 * 60 * 60
	weeklyWindow   = 7 * 24 * 60 * 60
)

// Quota reads how much of the 5-hour and weekly limits is used, from the endpoint behind Codex's /status
// (not a published API).
func (c *Client) Quota(ctx context.Context) (model.Quota, error) {
	for attempt := 0; attempt < 2; attempt++ {
		creds, err := c.session(ctx, attempt > 0)
		if err != nil {
			return model.Quota{}, err
		}
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.APIURL+"/wham/usage", nil)
		if err != nil {
			return model.Quota{}, err
		}
		c.headers(req, creds)
		res, err := c.HTTP.Do(req)
		if err != nil {
			if ctx.Err() != nil {
				return model.Quota{}, ctx.Err()
			}
			return model.Quota{}, unavailable("連不上 ChatGPT")
		}
		if res.StatusCode == http.StatusUnauthorized && attempt == 0 {
			res.Body.Close()
			continue
		}
		if res.StatusCode != http.StatusOK {
			res.Body.Close()
			return model.Quota{}, unavailable("ChatGPT 無法提供用量（%d）", res.StatusCode)
		}
		type window struct {
			Used    *float64 `json:"used_percent"`
			Seconds int64    `json:"limit_window_seconds"`
			ResetAt int64    `json:"reset_at"`
		}
		var body struct {
			RateLimit struct {
				Primary   *window `json:"primary_window"`
				Secondary *window `json:"secondary_window"`
			} `json:"rate_limit"`
		}
		err = json.NewDecoder(io.LimitReader(res.Body, 1<<20)).Decode(&body)
		res.Body.Close()
		if err != nil {
			return model.Quota{}, unavailable("ChatGPT 回了無法讀取的用量")
		}
		var q model.Quota
		for _, w := range []*window{body.RateLimit.Primary, body.RateLimit.Secondary} {
			if w == nil || w.Used == nil {
				continue
			}
			used := min(max(*w.Used, 0), 100)
			switch w.Seconds {
			case fiveHourWindow:
				q.FiveHour, q.FiveHourResetAt = &used, w.ResetAt
			case weeklyWindow:
				q.Weekly, q.WeeklyResetAt = &used, w.ResetAt
			}
		}
		return q, nil
	}
	return model.Quota{}, rejected("ChatGPT 的登入已失效，請重新登入")
}
