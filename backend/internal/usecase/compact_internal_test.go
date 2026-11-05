package usecase

import (
	"context"
	"fmt"
	"strings"
	"testing"

	"github.com/yanun0323/Team-Work/internal/model"
	"github.com/yanun0323/Team-Work/internal/model/enum"
)

func TestCompactAtTakesTheLowerOfTheShareAndTheRoomKept(t *testing.T) {
	prefs := model.DefaultPreferences()
	for _, c := range []struct{ window, want int }{
		{1_000_000, 400_000}, // 40% of 1M
		{272_000, 244_800},   // 90% of 272K
		{256_000, 230_400},   // the 256K group starts at 256K
		{255_999, 235_999},   // 95% would leave less than 20K
		{200_000, 180_000},   // 95% would leave 10K, so 20K stays free
		{128_000, 108_000},
		{127_999, 107_999},
		{32_000, 24_000}, // a quarter stays free, not 20K
	} {
		if got := compactAt(c.window, prefs); got != c.want {
			t.Errorf("compactAt(%d) = %d, want %d", c.window, got, c.want)
		}
	}
	prefs.Compact1M = 100
	if got := compactAt(1_000_000, prefs); got != 980_000 {
		t.Errorf("100%% still keeps 20K free: %d", got)
	}
}

func TestCompactCutKeepsLessOnASmallModel(t *testing.T) {
	var conv []model.Message
	for range 40 {
		conv = append(conv, userText(strings.Repeat("a", 4_000)), model.Message{Role: enum.RoleAssistant, Content: []model.Block{{Type: enum.BlockText, Text: strings.Repeat("b", 4_000)}}})
	}
	kept := func(room int) int { return tokensOf(conv[compactCut(conv, 0, room):]) }
	// whole turns stay, up to about 20K, or a tenth of 32K
	if big, small := kept(1_000_000), kept(32_000); big < 15_000 || big > 21_000 || small > 3_200 {
		t.Fatalf("kept %d on 1M, %d on 32K", big, small)
	}
}

func TestCompactPartsFitBesideTheSummary(t *testing.T) {
	entries := []string{strings.Repeat("x", 600), strings.Repeat("y", 600), strings.Repeat("z", 600)}
	part, rest := compactParts(entries, 1_000, 300)
	if len(part) != 1 || len(rest) != 2 {
		t.Fatalf("part %d, rest %d", len(part), len(rest))
	}
	// one line too long to fit is still read, alone
	part, rest = compactParts(entries[2:], 100, 300)
	if len(part) != 1 || len(rest) != 0 {
		t.Fatalf("part %d, rest %d", len(part), len(rest))
	}
}

type summer struct{ asked []string }

func (s *summer) Complete(_ context.Context, req model.ModelRequest, _ func(string)) (model.ModelReply, error) {
	s.asked = append(s.asked, req.Messages[0].Content[0].Text)
	return model.ModelReply{Content: []model.Block{{Type: enum.BlockText, Text: fmt.Sprintf("summary %d", len(s.asked))}}}, nil
}

func (s *summer) Models(context.Context) ([]model.ModelSpec, error) { return nil, nil }

// A transcript too long for one call is read in parts, each with the whole summary so far, so the oldest summary is
// never cut off for room.
func TestSummarizeCarriesTheSummaryThroughEveryPart(t *testing.T) {
	s := &summer{}
	e := &Engine{clock: func() float64 { return 0 }}
	in := chatRun{id: "c", room: 16_000, chairRoom: 16_000, chair: agentSpec{provider: s, model: "m"}}
	var entries []string
	for i := range 6 {
		entries = append(entries, fmt.Sprintf("user: %d %s\n\n", i, strings.Repeat("x", 3_000)))
	}
	got, _, err := e.summarize(context.Background(), in, "rules", "the oldest summary", entries)
	if err != nil {
		t.Fatal(err)
	}
	if len(s.asked) < 2 || got != fmt.Sprintf("summary %d", len(s.asked)) {
		t.Fatalf("%d calls, got %q", len(s.asked), got)
	}
	if !strings.Contains(s.asked[0], "the oldest summary") {
		t.Fatal("the summary before was not read")
	}
	for i, text := range s.asked[1:] {
		if !strings.Contains(text, fmt.Sprintf("summary %d", i+1)) {
			t.Fatalf("part %d did not carry the summary so far", i+2)
		}
	}
	read := strings.Join(s.asked, "")
	for i := range 6 {
		if !strings.Contains(read, fmt.Sprintf("user: %d ", i)) {
			t.Fatalf("line %d was never read", i)
		}
	}
}
