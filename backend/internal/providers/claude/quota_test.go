package claude

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
)

func fakeUsage(t *testing.T, token string, status int, body string) *http.Request {
	t.Helper()
	got := &http.Request{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		*got = *r
		w.WriteHeader(status)
		io.WriteString(w, body)
	}))
	t.Cleanup(srv.Close)
	oldURL, oldToken := usageURL, accessToken
	usageURL = srv.URL
	accessToken = func(context.Context) (string, error) {
		if token == "" {
			return "", errors.New("no credentials")
		}
		return token, nil
	}
	t.Cleanup(func() { usageURL, accessToken = oldURL, oldToken })
	return got
}

func TestQuotaReadsBothWindows(t *testing.T) {
	req := fakeUsage(t, "tok", 200, `{"five_hour":{"utilization":8,"resets_at":"2026-11-02T17:00:00.888578+08:00"},"seven_day":{"utilization":115},"seven_day_opus":null}`)
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
	if req.Header.Get("Authorization") != "Bearer tok" || req.Header.Get("anthropic-beta") != "oauth-2025-04-20" {
		t.Fatal(req.Header)
	}
}

func TestQuotaLeavesOutWhatIsNotReported(t *testing.T) {
	fakeUsage(t, "tok", 200, `{"five_hour":null,"seven_day":null}`)
	q, err := (&Client{}).Quota(context.Background())
	if err != nil || q.FiveHour != nil || q.Weekly != nil {
		t.Fatalf("%+v %v", q, err)
	}
}

func TestQuotaFailsWithoutALoginOrWhenTurnedDown(t *testing.T) {
	fakeUsage(t, "", 200, `{}`)
	if _, err := (&Client{}).Quota(context.Background()); err == nil {
		t.Fatal("read usage without credentials")
	}
	fakeUsage(t, "expired", 401, `{"type":"error"}`)
	if _, err := (&Client{}).Quota(context.Background()); err == nil {
		t.Fatal("a refused token gave usage")
	}
}
