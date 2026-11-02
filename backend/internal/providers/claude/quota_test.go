package claude

import (
	"context"
	"testing"
)

func TestQuotaReadsBothWindows(t *testing.T) {
	fakeClaude(t)
	t.Setenv("MHO_TEST_CLAUDE_USAGE", `{"rate_limits_available":true,"rate_limits":{"five_hour":{"utilization":8,"resets_at":"2026-11-02T17:00:00.888578+08:00"},"seven_day":{"utilization":115},"seven_day_opus":null}}`)
	q, err := (&Client{}).Quota(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if q.FiveHour == nil || *q.FiveHour != 8 || q.Weekly == nil || *q.Weekly != 100 {
		t.Fatalf("%+v", q)
	}
	// a fractional, offset time as Claude sends it; a window without one has none
	if q.FiveHourResetAt != 1793610000 || q.WeeklyResetAt != 0 {
		t.Fatalf("reset times %d %d", q.FiveHourResetAt, q.WeeklyResetAt)
	}
}

func TestQuotaLeavesOutWhatIsNotReported(t *testing.T) {
	fakeClaude(t)
	for _, usage := range []string{
		`{"rate_limits_available":true,"rate_limits":{"five_hour":null,"seven_day":null}}`,
		`{"rate_limits_available":false,"rate_limits":{"five_hour":{"utilization":8}}}`,
	} {
		t.Setenv("MHO_TEST_CLAUDE_USAGE", usage)
		q, err := (&Client{}).Quota(context.Background())
		if err != nil || q.FiveHour != nil || q.Weekly != nil {
			t.Fatalf("%s: %+v %v", usage, q, err)
		}
	}
}

func TestQuotaFailsWithoutALogin(t *testing.T) {
	fakeClaude(t)
	t.Setenv("MHO_TEST_CLAUDE_AUTH_ERROR", "1")
	if _, err := (&Client{}).Quota(context.Background()); err == nil || err.Error() != errLoggedOut().Error() {
		t.Fatal(err)
	}
}
