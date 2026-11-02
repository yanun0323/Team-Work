package codex

import (
	"context"
	"testing"
	"time"
)

func TestQuotaPlacesWindowsByLength(t *testing.T) {
	for _, tc := range []struct {
		name, usage      string
		fiveHour, weekly float64 // -1: not reported
		fiveHourReset    int64
		weeklyReset      int64
	}{
		{"plus", `{"rate_limit":{"primary_window":{"used_percent":12.5,"limit_window_seconds":18000,"reset_at":1793610000},"secondary_window":{"used_percent":140,"limit_window_seconds":604800,"reset_at":1794000000}}}`, 12.5, 100, 1793610000, 1794000000},
		{"weekly only", `{"rate_limit":{"primary_window":{"used_percent":30,"limit_window_seconds":604800,"reset_at":1794000000},"secondary_window":null}}`, -1, 30, 0, 1794000000},
		{"none", `{"rate_limit":null}`, -1, -1, 0, 0},
	} {
		t.Run(tc.name, func(t *testing.T) {
			c, secrets := setup(t, &fake{usage: tc.usage})
			signIn(t, c, secrets, time.Now().Add(time.Hour).UnixMilli())
			q, err := c.Quota(context.Background())
			if err != nil {
				t.Fatal(err)
			}
			check := func(label string, got *float64, want float64) {
				if want < 0 && got != nil || want >= 0 && (got == nil || *got != want) {
					t.Errorf("%s: got %v, want %v", label, got, want)
				}
			}
			check("5h", q.FiveHour, tc.fiveHour)
			check("weekly", q.Weekly, tc.weekly)
			if q.FiveHourResetAt != tc.fiveHourReset || q.WeeklyResetAt != tc.weeklyReset {
				t.Errorf("reset times %d %d", q.FiveHourResetAt, q.WeeklyResetAt)
			}
		})
	}
}

func TestQuotaNeedsALogin(t *testing.T) {
	c, _ := setup(t, &fake{})
	if _, err := c.Quota(context.Background()); err == nil {
		t.Fatal("read usage without a login")
	}
}
