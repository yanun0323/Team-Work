package usecase_test

import (
	"context"
	"math"
	"testing"
	"time"

	"github.com/yanun0323/Team-Work/internal/model"
	"github.com/yanun0323/Team-Work/internal/usecase"
)

func TestModelCallsAreSummedByProvider(t *testing.T) {
	r := newRig(t, func(model.ModelRequest) (model.ModelReply, error) {
		reply := say("好")
		reply.Usage = model.ModelUsage{Input: 1000, Output: 50, CacheRead: 600}
		return reply, nil
	})
	c, err := r.e.CreateChat(usecase.NewChat{TeamID: r.team.ID, ReplicaID: r.owner.ID, Text: "嗨"})
	if err != nil {
		t.Fatal(err)
	}
	r.wait("reply", chatDone(c.ID))

	stats, err := r.e.Usage(context.Background(), 0, 8*60)
	if err != nil {
		t.Fatal(err)
	}
	want := model.UsageTotals{Calls: 1, Input: 1000, Output: 50, CacheRead: 600, Tokens: 450, CostUSD: 450 / 1e6}
	got := stats.Total
	if math.Abs(got.CostUSD-want.CostUSD) > 1e-12 {
		t.Fatalf("cost %v", got.CostUSD)
	}
	got.CostUSD = want.CostUSD
	if got != want {
		t.Fatalf("total %+v", got)
	}
	if len(stats.Providers) != 1 || stats.Providers[0].Name != "p" || len(stats.Providers[0].Models) != 1 || stats.Providers[0].Models[0].Model != "fake" {
		t.Fatalf("providers %+v", stats.Providers)
	}
	today := time.Now().In(time.FixedZone("", 8*3600)).Format(time.DateOnly)
	if n := len(stats.Days); n != 1 || stats.Days[0].Date != today || stats.Days[0].Tokens != 450 {
		t.Fatalf("days %+v", stats.Days)
	}

	later, err := r.e.Usage(context.Background(), float64(time.Now().Add(time.Hour).Unix()), 0)
	if err != nil {
		t.Fatal(err)
	}
	if later.Total.Calls != 0 || len(later.Providers) != 0 {
		t.Fatalf("calls before since were counted: %+v", later)
	}
}
