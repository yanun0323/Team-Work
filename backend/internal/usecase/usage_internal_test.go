package usecase

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/rs/zerolog"
	"github.com/yanun0323/Team-Work/internal/adapter"
	"github.com/yanun0323/Team-Work/internal/model"
	"github.com/yanun0323/Team-Work/internal/model/enum"
	"github.com/yanun0323/Team-Work/internal/providers"
)

func TestSumUsageFillsDaysInTheAskersZone(t *testing.T) {
	zone := time.FixedZone("", 8*3600)
	at := func(s string) float64 {
		v, err := time.ParseInLocation("2006-01-02 15:04", s, zone)
		if err != nil {
			t.Fatal(err)
		}
		return float64(v.Unix())
	}
	records := []model.Usage{
		{At: at("2026-11-01 23:30"), ProviderID: "a", ProviderName: "舊名", Model: "m1", Input: 100, Output: 10, Priced: true, CostUSD: 1},
		{At: at("2026-11-03 00:10"), ProviderID: "b", ProviderName: "已刪除", Model: "m2", Input: 500, Output: 500, CacheRead: 400},
		{At: at("2026-11-03 09:00"), ProviderID: "a", ProviderName: "舊名", Model: "m3", Input: 10, Output: 10, Priced: true, CostUSD: 2},
	}
	got := sumUsage(records, map[string]string{"a": "新名"}, 0, at("2026-11-04 08:00"), 8*60)

	var dates []string
	for _, d := range got.Days {
		dates = append(dates, d.Date)
	}
	if want := []string{"2026-11-01", "2026-11-02", "2026-11-03", "2026-11-04"}; len(dates) != 4 || dates[0] != want[0] || dates[3] != want[3] {
		t.Fatalf("days %v", dates)
	}
	if got.Days[1].Calls != 0 || got.Days[2].Calls != 2 {
		t.Fatalf("day totals %+v", got.Days)
	}
	if p := got.Days[2].Parts; len(p) != 2 ||
		p[0] != (model.UsagePart{ProviderID: "b", Model: "m2", UsageTotals: model.UsageTotals{Calls: 1, Input: 500, Output: 500, CacheRead: 400, Tokens: 600, Unpriced: 1}}) ||
		p[1] != (model.UsagePart{ProviderID: "a", Model: "m3", UsageTotals: model.UsageTotals{Calls: 1, Input: 10, Output: 10, Tokens: 20, CostUSD: 2}}) {
		t.Fatalf("day parts %+v", p)
	}
	if got.Days[1].Parts == nil {
		t.Fatal("an empty day's parts should be [], not null")
	}
	if len(got.Providers) != 2 || got.Providers[0].ID != "b" || got.Providers[0].Name != "已刪除" || got.Providers[1].Name != "新名" {
		t.Fatalf("providers %+v", got.Providers)
	}
	if a := got.Providers[1]; a.Tokens != 130 || a.CostUSD != 3 || a.Unpriced != 0 || len(a.Models) != 2 || a.Models[0].Model != "m1" {
		t.Fatalf("provider a %+v", a)
	}
	if got.Total.Unpriced != 1 || got.Total.Tokens != 730 {
		t.Fatalf("total %+v", got.Total)
	}
}

func TestMeterLogsEachCallsCacheUse(t *testing.T) {
	var buf bytes.Buffer
	m := meter{e: &Engine{log: zerolog.New(&buf)}, kind: "anthropic/subscription", model: "opus"}
	m.logCall("sub-1", model.ModelUsage{Input: 100, Output: 5, CacheRead: 60, CacheWrite: 30, CacheWriteKnown: true}, nil)
	m.logCall("sub-1", model.ModelUsage{Input: 50, CacheRead: 40}, nil)
	m.logCall("sub-1", model.ModelUsage{}, model.Errorf(model.CodeUnavailable, "private prompt text"))
	m.logCall("sub-1", model.ModelUsage{}, fmt.Errorf("wrapped: %w", context.Canceled))
	var lines []map[string]any
	for _, line := range strings.Split(strings.TrimSpace(buf.String()), "\n") {
		var v map[string]any
		if err := json.Unmarshal([]byte(line), &v); err != nil {
			t.Fatal(err)
		}
		lines = append(lines, v)
	}
	if len(lines) != 4 {
		t.Fatalf("%d lines", len(lines))
	}
	first := lines[0]
	if first["message"] != "model call" || first["session"] != "sub-1" || first["provider"] != "anthropic/subscription" || first["model"] != "opus" ||
		first["input"] != 100.0 || first["cacheRead"] != 60.0 || first["cacheWrite"] != 30.0 || first["ok"] != true {
		t.Fatalf("first call %v", first)
	}
	if _, ok := lines[1]["cacheWrite"]; ok {
		t.Fatalf("a provider that does not report cache writes logged one: %v", lines[1])
	}
	if lines[2]["ok"] != false || lines[2]["error"] != model.CodeUnavailable || lines[3]["error"] != "canceled" {
		t.Fatalf("failed calls %v %v", lines[2], lines[3])
	}
	if strings.Contains(buf.String(), "private") {
		t.Fatal("the log quoted an error's text")
	}
}

type usageStore struct {
	adapter.Store
	got []model.Usage
}

func (s *usageStore) AddUsage(_ context.Context, u model.Usage) error {
	s.got = append(s.got, u)
	return nil
}

// A call that fails after its provider reported usage is still metered and logged, with no reply to act on.
func TestFailedCallsKeepTheUsageTheyReported(t *testing.T) {
	cases := []struct {
		kind              enum.ProviderKind
		stream            string
		input, read       int
		write, writeKnown any
	}{
		{enum.ProviderAnthropic, `data: {"type":"message_start","message":{"usage":{"input_tokens":3,"cache_read_input_tokens":4,"cache_creation_input_tokens":2}}}

data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"c1","name":"t"}}

data: {"type":"content_block_stop","index":0}

data: {"type":"error","error":{"type":"overloaded_error","message":"private text"}}

`, 9, 4, 2.0, true},
		{enum.ProviderAnthropic, `data: {"type":"message_start","message":{"usage":{"input_tokens":3,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}

`, 3, 0, 0.0, true},
		{enum.ProviderOpenAI, `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"t","arguments":"{}"}}]}}]}

data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5,"prompt_tokens_details":{"cached_tokens":4}}}

`, 10, 4, nil, false},
	}
	for _, c := range cases {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { io.WriteString(w, c.stream) }))
		p, err := providers.NewFactory(nil, nil).For(model.ModelProvider{Name: "x", Kind: c.kind, BaseURL: srv.URL, Auth: model.ProviderAuth{Kind: "apiKey"}}, "sk")
		if err != nil {
			t.Fatal(err)
		}
		var buf bytes.Buffer
		store := &usageStore{}
		m := meter{Provider: p, e: &Engine{log: zerolog.New(&buf), store: store, ctx: context.Background(), clock: func() float64 { return 1 }},
			kind: string(c.kind), model: "m"}
		reply, err := m.Complete(context.Background(), model.ModelRequest{Session: "sub-1", Model: "m",
			Messages: []model.Message{userText("secret prompt")}}, func(string) {})
		srv.Close()
		if err == nil || len(reply.Content) != 0 {
			t.Fatalf("%s: failure %v gave a reply to act on: %+v", c.kind, err, reply.Content)
		}
		if len(store.got) != 1 || store.got[0].Input != c.input || store.got[0].CacheRead != c.read {
			t.Fatalf("%s: usage recorded %+v", c.kind, store.got)
		}
		var line map[string]any
		if err := json.Unmarshal(buf.Bytes(), &line); err != nil {
			t.Fatal(err)
		}
		write, known := line["cacheWrite"]
		if line["session"] != "sub-1" || line["ok"] != false || line["input"] != float64(c.input) || line["cacheRead"] != float64(c.read) ||
			known != c.writeKnown || write != c.write {
			t.Fatalf("%s: logged %v", c.kind, line)
		}
		if strings.Contains(buf.String(), "private") || strings.Contains(buf.String(), "secret") {
			t.Fatalf("%s: the log quoted the conversation or the error: %s", c.kind, buf.String())
		}
	}
}

// A call canceled after its response finished still counts what it used, and logs as canceled.
func TestCanceledCallsKeepTheUsageTheyReported(t *testing.T) {
	var buf bytes.Buffer
	store := &usageStore{}
	m := meter{Provider: canceledProvider{}, e: &Engine{log: zerolog.New(&buf), store: store, ctx: context.Background(), clock: func() float64 { return 1 }},
		kind: "openai/subscription", model: "m"}
	reply, err := m.Complete(context.Background(), model.ModelRequest{Session: "sub-1", Model: "m"}, func(string) {})
	if err != context.Canceled || len(reply.Content) != 0 {
		t.Fatalf("err=%v content=%+v", err, reply.Content)
	}
	if len(store.got) != 1 || store.got[0].Input != 10 || store.got[0].Output != 5 || store.got[0].CacheRead != 4 {
		t.Fatalf("usage recorded %+v", store.got)
	}
	var line map[string]any
	if err := json.Unmarshal(buf.Bytes(), &line); err != nil {
		t.Fatal(err)
	}
	if line["session"] != "sub-1" || line["ok"] != false || line["error"] != "canceled" || line["input"] != float64(10) || line["cacheRead"] != float64(4) {
		t.Fatalf("logged %v", line)
	}
}

type canceledProvider struct{ adapter.Provider }

func (canceledProvider) Complete(context.Context, model.ModelRequest, func(string)) (model.ModelReply, error) {
	return model.ModelReply{Usage: model.ModelUsage{Input: 10, Output: 5, CacheRead: 4}}, context.Canceled
}
