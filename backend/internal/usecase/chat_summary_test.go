package usecase

import (
	"fmt"
	"math/rand"
	"strings"
	"testing"

	"github.com/yanun0323/Team-Work/internal/model"
)

func legacyPreview(text string, limit int) string {
	text = strings.Join(strings.Fields(text), " ")
	chars := []rune(text)
	if len(chars) > limit {
		return string(chars[:limit-1]) + "…"
	}
	return text
}

func TestChatPreviewPreservesWhitespaceAndTruncation(t *testing.T) {
	cases := []string{"", " \t\r\n", " hello  world ", "繁體中文\u3000🙂🙂\u00a0test", "a\x00b", strings.Repeat("界", 199), strings.Repeat("界", 200), strings.Repeat("界", 201), strings.Repeat("a", 200) + "   ", strings.Repeat("a", 199) + "  b", "\xffbroken\xc0"}
	rng := rand.New(rand.NewSource(42))
	chars := []rune("abc界🙂 \t\n\r\v\f\u0085\u00a0\u1680\u2003\u2028\u2029\u202f\u205f\u3000")
	for i := 0; i < 200; i++ {
		var b strings.Builder
		for j, n := 0, rng.Intn(800); j < n; j++ {
			b.WriteRune(chars[rng.Intn(len(chars))])
		}
		cases = append(cases, b.String())
	}
	for _, limit := range []int{1, 2, 5, 199, 200} {
		for i, text := range cases {
			if got, want := previewText(text, limit), legacyPreview(text, limit); got != want {
				t.Fatalf("case %d limit %d: got %q want %q", i, limit, got, want)
			}
		}
	}
}

func TestSummaryDoesNotAllocateOnePreviewPerHistoricalReply(t *testing.T) {
	chat := func(n int) *model.Chat {
		c := &model.Chat{Messages: []model.ChatMessage{{From: "user", Text: "first"}}}
		for i := 0; i < n; i++ {
			c.Messages = append(c.Messages, model.ChatMessage{From: "agent", Text: "reply", At: float64(i), By: "employee"})
		}
		return c
	}
	allocations := func(c *model.Chat) float64 {
		previous := summarizeChat(c, nil, ChatHistory{}).History
		return testing.AllocsPerRun(10, func() { _ = summarizeChat(c, c, previous) })
	}
	small, large := allocations(chat(1)), allocations(chat(200))
	if large > small+4 {
		t.Fatalf("summary allocations scale with discarded previews: one=%.0f many=%.0f", small, large)
	}
}

func TestSummaryKeepsLatestReplyAndMentionsDetached(t *testing.T) {
	c := &model.Chat{CreatedAt: 1, ReplyAt: new(float64), Messages: []model.ChatMessage{
		{From: "user", Text: "#file", At: 2, Mentions: []string{"first"}, Images: []model.Attachment{{URL: "image"}}},
		{From: "agent", Text: "old reply", At: 3, By: "old"},
		{From: "user", Text: "next", At: 4, Mentions: []string{"last"}},
		{From: "agent", Text: "  latest\n reply ", At: 5, By: "last"},
		{From: "tool", Text: "tool", At: 6},
	}}
	h := summarizeChat(c, nil, ChatHistory{}).History
	if h.Preview != "#file" || h.SortAt != 4 || !h.HasAttachment || !h.HasFileMention || h.LastAgent.Text != "latest reply" || h.LastAgent.By != "last" || h.LastAgent.At != 5 {
		t.Fatalf("summary changed: %+v", h)
	}
	h.Mentions[0] = "client edit"
	if c.Messages[2].Mentions[0] != "last" {
		t.Fatal("mentions alias history")
	}
	c.ReplyAt = nil
	if got := summarizeChat(c, nil, ChatHistory{}).History.SortAt; got != 6 {
		t.Fatalf("completed sort: %v", got)
	}
	c.Messages = append(c.Messages, model.ChatMessage{From: "user", Text: "no mentions"})
	if got := summarizeChat(c, nil, ChatHistory{}).History.Mentions; len(got) != 0 {
		t.Fatal("retained earlier mentions")
	}
}

func BenchmarkChatSummaryWork(b *testing.B) {
	text := strings.Repeat("history 界 ", 3000)
	b.Run("preview", func(b *testing.B) {
		b.ReportAllocs()
		for b.Loop() {
			_ = previewText(text, 200)
		}
	})
	for _, n := range []int{1, 200} {
		c := &model.Chat{Messages: []model.ChatMessage{{From: "user", Text: "first"}}}
		for i := 0; i < n; i++ {
			c.Messages = append(c.Messages, model.ChatMessage{From: "agent", Text: text})
		}
		previous := summarizeChat(c, nil, ChatHistory{}).History
		old := copyChat(c)
		b.Run(fmt.Sprintf("metadata/%d", n), func(b *testing.B) {
			b.ReportAllocs()
			for b.Loop() {
				_ = summarizeChat(c, old, previous)
			}
		})
	}
}

func FuzzChatPreviewMatchesLegacy(f *testing.F) {
	for _, text := range []string{"", "  words\n界🙂 ", strings.Repeat("a ", 210), "\xff\xc0broken"} {
		f.Add(text, uint8(200))
	}
	f.Fuzz(func(t *testing.T, text string, size uint8) {
		limit := int(size) + 1
		if got, want := previewText(text, limit), legacyPreview(text, limit); got != want {
			t.Fatalf("limit %d: got %q want %q", limit, got, want)
		}
	})
}
