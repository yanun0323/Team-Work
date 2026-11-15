package usecase_test

import (
	"context"
	"fmt"
	"math"
	"strings"
	"testing"
	"time"

	"github.com/yanun0323/Team-Work/internal/model"
	"github.com/yanun0323/Team-Work/internal/usecase"
)

func TestModelCallsAreSummedByProvider(t *testing.T) {
	t.Parallel()
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

func TestProfileStatsSumTheUsersMilestones(t *testing.T) {
	t.Parallel()
	r := newRig(t, func(model.ModelRequest) (model.ModelReply, error) {
		reply := say("好")
		reply.Usage = model.ModelUsage{Input: 100, Output: 20}
		return reply, nil
	})
	before, err := r.e.ProfileStats(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if before.Chats != 0 || before.Messages != 0 || len(before.Partners) != 0 || before.Usage.Calls != 0 {
		t.Fatalf("a new island has milestones: %+v", before)
	}
	c, err := r.e.CreateChat(usecase.NewChat{TeamID: r.team.ID, ReplicaID: r.owner.ID, Text: "嗨"})
	if err != nil {
		t.Fatal(err)
	}
	r.wait("reply", chatDone(c.ID))
	stats, err := r.e.ProfileStats(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if stats.Chats != 1 || stats.Messages != 1 || stats.Usage.Calls != 1 || stats.Usage.Tokens != 120 || stats.Since <= 0 {
		t.Fatalf("%+v", stats)
	}
	if p := stats.Partners; len(p) != 1 || p[0].ID != r.owner.ID || p[0].Name != r.owner.Name || p[0].Count != 1 {
		t.Fatalf("partners %+v", stats.Partners)
	}
	// eleven more employees with a chat each: the owner's two lead, then by name, ten in all
	chat := func(id string) {
		t.Helper()
		c, err := r.e.CreateChat(usecase.NewChat{TeamID: r.team.ID, ReplicaID: id, Text: "嗨"})
		if err != nil {
			t.Fatal(err)
		}
		r.wait("reply", chatDone(c.ID))
	}
	chat(r.owner.ID)
	for i := range 11 {
		hired, err := r.e.Hire(usecase.NewReplica{TeamID: r.team.ID, BlueprintID: r.owner.BlueprintID, Name: fmt.Sprintf("E%02d", 10-i), Model: "fake"})
		if err != nil {
			t.Fatal(err)
		}
		chat(hired.ID)
	}
	stats, err = r.e.ProfileStats(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, p := range stats.Partners {
		names = append(names, fmt.Sprintf("%s:%d", p.Name, p.Count))
	}
	if got := strings.Join(names, " "); got != "Ada:2 E00:1 E01:1 E02:1 E03:1 E04:1 E05:1 E06:1 E07:1 E08:1" {
		t.Fatal(got)
	}
}
