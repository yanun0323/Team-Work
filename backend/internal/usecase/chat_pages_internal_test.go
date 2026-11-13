package usecase

import (
	"fmt"
	"strings"
	"testing"

	"github.com/yanun0323/Team-Work/internal/model"
	"github.com/yanun0323/Team-Work/pkg/jsonx"
)

func TestChatPagesKeepLegacyAndRejectMixedVersions(t *testing.T) {
	t.Parallel()
	e, _ := storageEngine(t)
	c := &model.Chat{ID: "c", CreatedAt: 1, Messages: []model.ChatMessage{}}
	for i := 0; i < 250; i++ {
		c.Messages = append(c.Messages, model.ChatMessage{From: "user", Text: fmt.Sprint(i), At: float64(i)})
	}
	e.w.Chats[c.ID] = c
	if err := e.sync(); err != nil {
		t.Fatal(err)
	}
	raw, err := e.PagedSnapshot()
	if err != nil {
		t.Fatal(err)
	}
	var w struct {
		Chats map[string]ChatSummary `json:"chats"`
	}
	if err = jsonx.Unmarshal(raw, &w); err != nil {
		t.Fatal(err)
	}
	s := w.Chats["c"]
	if len(s.Messages) != 0 || s.History.Count != 250 || s.History.Preview != "0" {
		t.Fatalf("bad summary: %+v", s.History)
	}
	page, err := e.ChatMessages("c", s.History.Version, 250, 100)
	if err != nil {
		t.Fatal(err)
	}
	if page.Start != 150 || len(page.Messages) != 100 || page.Messages[0].Text != "150" {
		t.Fatal("wrong page")
	}
	page.Messages[0].Text = "client edit"
	if c.Messages[150].Text != "150" {
		t.Fatal("aliased page")
	}
	old, err := e.Snapshot()
	if err != nil {
		t.Fatal(err)
	}
	var legacy model.World
	if err = jsonx.Unmarshal(old, &legacy); err != nil {
		t.Fatal(err)
	}
	if len(legacy.Chats["c"].Messages) != 250 {
		t.Fatal("legacy lost history")
	}
	c.Messages = c.Messages[:2]
	if err = e.sync(); err != nil {
		t.Fatal(err)
	}
	if _, err = e.ChatMessages("c", s.History.Version, 150, 100); err == nil {
		t.Fatal("accepted stale page")
	}
	for _, args := range [][2]int{{-1, 100}, {2, 0}, {2, 101}, {999, 100}} {
		if _, err = e.ChatMessages("c", "", args[0], args[1]); err == nil {
			t.Fatal("accepted invalid range")
		}
	}
	if _, err = e.ChatMessages("missing", "", 0, 100); err == nil {
		t.Fatal("missing chat accepted")
	}
}

func TestPagedEventsFollowSuccessfulSavesOnly(t *testing.T) {
	t.Parallel()
	e, disk := storageEngine(t)
	c := &model.Chat{ID: "c", Messages: []model.ChatMessage{{From: "user", Text: "#file", At: 2}}}
	e.w.Chats[c.ID] = c
	if err := e.sync(); err != nil {
		t.Fatal(err)
	}
	_, small, cancel, err := e.SubscribeChats(true)
	if err != nil {
		t.Fatal(err)
	}
	defer cancel()
	_, full, cancelFull, err := e.Subscribe()
	if err != nil {
		t.Fatal(err)
	}
	defer cancelFull()
	old := e.chatSummary(c).History.Version
	c.Messages = append(c.Messages, model.ChatMessage{From: "agent", Text: "reply", At: 3})
	disk.fail = true
	if err = e.sync(); err == nil {
		t.Fatal("missing failure")
	}
	select {
	case <-small:
		t.Fatal("published failed write")
	default:
	}
	if e.chatSummary(c).History.Version != old {
		t.Fatal("failed write changed version")
	}
	disk.fail = false
	if err = e.sync(); err != nil {
		t.Fatal(err)
	}
	var s ChatSummary
	if err = jsonx.Unmarshal((<-small).Upserts[0].Data, &s); err != nil {
		t.Fatal(err)
	}
	if len(s.Messages) != 0 || s.History.Previous != old || s.History.ChangedFrom != 1 || s.History.Count != 2 || !s.History.HasFileMention || s.History.LastAgent.Text != "reply" {
		t.Fatalf("bad summary %+v", s.History)
	}
	var legacy model.Chat
	if err = jsonx.Unmarshal((<-full).Upserts[0].Data, &legacy); err != nil {
		t.Fatal(err)
	}
	if len(legacy.Messages) != 2 {
		t.Fatal("legacy event changed")
	}
	if err = e.RewindChat("c", 0, old); err == nil {
		t.Fatal("stale rewind accepted")
	}
	if _, err = e.HandOffChat("c", 0, "", old); err == nil {
		t.Fatal("stale fork accepted")
	}
	version := s.History.Version
	c.Title = "renamed"
	if err = e.sync(); err != nil {
		t.Fatal(err)
	}
	if err = jsonx.Unmarshal((<-small).Upserts[0].Data, &s); err != nil {
		t.Fatal(err)
	}
	if s.History.Version != version || s.Title != "renamed" {
		t.Fatal("title invalidated history")
	}
	delete(e.w.Chats, "c")
	if err = e.sync(); err != nil {
		t.Fatal(err)
	}
	if len((<-small).Deletes) != 1 || len(e.chatSummaries) != 0 {
		t.Fatal("deleted history retained")
	}
}

func BenchmarkChatSummarySnapshot(b *testing.B) {
	e, _ := storageEngine(b)
	for i := 0; i < 277; i++ {
		c := &model.Chat{ID: fmt.Sprint(i), Messages: []model.ChatMessage{}}
		for j := 0; j < 60; j++ {
			c.Messages = append(c.Messages, model.ChatMessage{From: "user", Text: strings.Repeat("history ", 40)})
		}
		e.w.Chats[c.ID] = c
	}
	if err := e.sync(); err != nil {
		b.Fatal(err)
	}
	for _, paged := range []bool{false, true} {
		b.Run(fmt.Sprintf("paged=%t", paged), func(b *testing.B) {
			b.ReportAllocs()
			for b.Loop() {
				var raw []byte
				var err error
				if paged {
					raw, err = e.PagedSnapshot()
				} else {
					raw, err = e.Snapshot()
				}
				if err != nil {
					b.Fatal(err)
				}
				b.ReportMetric(float64(len(raw)), "payload-B")
			}
		})
	}
}
