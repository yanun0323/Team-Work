package claude

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/yanun0323/mho-company/internal/model"
)

// Quota asks Claude Code how much of the 5-hour and weekly limits is used, as its /usage does. Claude Code
// keeps the login, refreshes it and talks to Anthropic itself.
func (c *Client) Quota(ctx context.Context) (model.Quota, error) {
	home, err := osHome()
	if err != nil {
		return model.Quota{}, err
	}
	child, err := startChild(CompleteParams{Cwd: home}, "", nil)
	if err != nil {
		return model.Quota{}, err
	}
	defer child.close()
	s := &session{child: child}
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	if _, err := s.initialize(ctx, ""); err != nil {
		var auth *authError
		if errors.As(err, &auth) {
			return model.Quota{}, errLoggedOut()
		}
		return model.Quota{}, safeError(err)
	}
	raw, err := child.control(ctx, object{"subtype": "get_usage", "skip_behaviors": true}, s.control)
	if err != nil {
		return model.Quota{}, safeError(err)
	}
	type window struct {
		Used    *float64 `json:"utilization"`
		ResetAt string   `json:"resets_at"`
	}
	var body struct {
		Available bool `json:"rate_limits_available"`
		Limits    struct {
			FiveHour *window `json:"five_hour"`
			SevenDay *window `json:"seven_day"`
		} `json:"rate_limits"`
	}
	if json.Unmarshal(raw, &body) != nil {
		return model.Quota{}, unavailable("Claude Code 回了無法讀取的用量")
	}
	if !body.Available {
		return model.Quota{}, nil
	}
	used := func(w *window) *float64 {
		if w == nil || w.Used == nil {
			return nil
		}
		v := min(max(*w.Used, 0), 100)
		return &v
	}
	resetAt := func(w *window) int64 {
		if w == nil {
			return 0
		}
		t, err := time.Parse(time.RFC3339Nano, w.ResetAt)
		if err != nil {
			return 0
		}
		return t.Unix()
	}
	l := body.Limits
	return model.Quota{FiveHour: used(l.FiveHour), Weekly: used(l.SevenDay),
		FiveHourResetAt: resetAt(l.FiveHour), WeeklyResetAt: resetAt(l.SevenDay)}, nil
}
