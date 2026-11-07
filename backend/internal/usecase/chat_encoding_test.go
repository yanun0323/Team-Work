package usecase

import (
	"context"
	"testing"

	"github.com/yanun0323/Team-Work/internal/model"
	"github.com/yanun0323/Team-Work/internal/repository"
	"github.com/yanun0323/Team-Work/pkg/jsonx"
)

func TestChatEncodingReleasedAfterSaveAndLoad(t *testing.T) {
	e, _ := storageEngine(t)
	e.dataDir = t.TempDir()
	disk, err := repository.NewStore(e.dataDir)
	if err != nil {
		t.Fatal(err)
	}
	defer disk.Close()
	e.store = disk
	c := &model.Chat{ID: "c", Messages: []model.ChatMessage{{From: "user", Text: "history"}}}
	e.w.Chats[c.ID] = c
	if err = e.sync(); err != nil {
		t.Fatal(err)
	}
	check := func(e *Engine) {
		t.Helper()
		key := docKey("chat", "c")
		if raw, ok := e.prev[key]; !ok || raw != nil {
			t.Fatal("chat retains JSON instead of presence marker")
		}
		if raw, ok := e.documents()[key]; !ok || raw != nil {
			t.Fatal("unchanged chat encoded or lost")
		}
		if e.savedChats["c"].Messages[0].Text != "history" {
			t.Fatal("detached saved history lost")
		}
		raw, err := e.Snapshot()
		if err != nil {
			t.Fatal(err)
		}
		var w model.World
		if err = jsonx.Unmarshal(raw, &w); err != nil {
			t.Fatal(err)
		}
		if w.Chats["c"].Messages[0].Text != "history" {
			t.Fatal("legacy API lost history")
		}
	}
	check(e)
	reloaded, _ := storageEngine(t)
	reloaded.store = disk
	reloaded.dataDir = e.dataDir
	if err = reloaded.load(context.Background()); err != nil {
		t.Fatal(err)
	}
	check(reloaded)
}

func TestQueuedChatEventsOwnEncodingAfterCacheRelease(t *testing.T) {
	e, disk := storageEngine(t)
	c := &model.Chat{ID: "c", Messages: []model.ChatMessage{{From: "user", Text: "original"}}}
	e.w.Chats[c.ID] = c
	if err := e.sync(); err != nil {
		t.Fatal(err)
	}
	_, full, cancel, err := e.Subscribe()
	if err != nil {
		t.Fatal(err)
	}
	defer cancel()
	_, paged, cancelPaged, err := e.SubscribeChats(true)
	if err != nil {
		t.Fatal(err)
	}
	defer cancelPaged()
	for _, text := range []string{"first", "second"} {
		c.Messages[0].Text = text
		if err := e.sync(); err != nil {
			t.Fatal(err)
		}
	}
	c.Messages[0].Text = "failed"
	disk.fail = true
	if err := e.sync(); err == nil {
		t.Fatal("failed save accepted")
	}
	if len(full) != 2 || len(paged) != 2 {
		t.Fatal("failed save published or event lost")
	}
	for _, text := range []string{"first", "second"} {
		var legacy model.Chat
		ev := <-full
		if len(ev.Upserts) != 1 {
			t.Fatal("unexpected legacy event")
		}
		if err := jsonx.Unmarshal(ev.Upserts[0].Data, &legacy); err != nil {
			t.Fatal(err)
		}
		if legacy.Messages[0].Text != text {
			t.Fatal("queued full event mutated")
		}
		var summary ChatSummary
		ev = <-paged
		if len(ev.Upserts) != 1 {
			t.Fatal("unexpected paged event")
		}
		if err := jsonx.Unmarshal(ev.Upserts[0].Data, &summary); err != nil {
			t.Fatal(err)
		}
		if len(summary.Messages) != 0 || summary.History.Preview != text {
			t.Fatal("queued summary mutated")
		}
	}
	if e.prev[docKey("chat", "c")] != nil {
		t.Fatal("event publication retained encoding")
	}
	if e.savedChats["c"].Messages[0].Text != "second" {
		t.Fatal("failed save changed committed snapshot")
	}
	disk.fail = false
	if err := e.sync(); err != nil {
		t.Fatal(err)
	}
	if len(full) != 1 || len(paged) != 1 {
		t.Fatal("retry not published")
	}
}

func BenchmarkChatEncodingRetained(b *testing.B) {
	e := historyEngine(b)
	b.ReportAllocs()
	b.ResetTimer()
	for b.Loop() {
		_ = e.documents()
	}
	bytes := 0
	for id := range e.w.Chats {
		bytes += len(e.prev[docKey("chat", id)])
	}
	b.ReportMetric(float64(bytes), "cached-JSON-B")
}
