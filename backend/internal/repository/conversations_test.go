package repository

import (
	"context"
	"strings"
	"testing"

	"github.com/yanun0323/Team-Work/internal/model"
)

func TestConversationIndexKeepsBodiesOnDisk(t *testing.T) {
	ctx := context.Background()
	store, err := NewStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	raw := []byte(`[{"role":"user","content":[{"type":"text","text":"` + strings.Repeat("history", 1000) + `"}]}]`)
	docs := []model.Doc{{Kind: "conv", ID: "c", Data: raw}, {Kind: "chat", ID: "c", Data: []byte(`{"id":"c"}`)},
		{Kind: "conv", ID: "old", Data: []byte(`[{"content":[{"type":"image","data":"aGVsbG8="}]}]`)}}
	if err = store.Apply(ctx, docs, nil, nil); err != nil {
		t.Fatal(err)
	}
	index, err := store.LoadDocs(ctx, true)
	if err != nil {
		t.Fatal(err)
	}
	if len(index) != 3 {
		t.Fatal("missing index rows")
	}
	for _, d := range index {
		if d.Kind == "conv" && d.Data != nil {
			t.Fatal("index loaded history body")
		}
		if d.Kind == "chat" && len(d.Data) == 0 {
			t.Fatal("public data lost")
		}
	}
	full, err := store.LoadDocs(ctx)
	if err != nil {
		t.Fatal(err)
	}
	for _, d := range full {
		if len(d.Data) == 0 {
			t.Fatal("legacy full load changed")
		}
	}
	got, err := store.LoadConversation(ctx, "c")
	if err != nil || string(got) != string(raw) {
		t.Fatal("single history changed", err)
	}
	if _, err = store.LoadConversation(ctx, "missing"); err == nil {
		t.Fatal("missing record accepted")
	}
	ids, err := store.InlineConversations(ctx)
	if err != nil || len(ids) != 1 || ids[0] != "old" {
		t.Fatal("inline migration candidates", ids, err)
	}
	cancelled, cancel := context.WithCancel(ctx)
	cancel()
	if _, err = store.LoadConversation(cancelled, "c"); err == nil {
		t.Fatal("cancelled read succeeded")
	}
}

func BenchmarkLoadConversationIndex(b *testing.B) {
	ctx := context.Background()
	store, err := NewStore(b.TempDir())
	if err != nil {
		b.Fatal(err)
	}
	defer store.Close()
	raw := []byte(`[{"role":"user","content":[{"type":"text","text":"` + strings.Repeat("history ", 125000) + `"}]}]`)
	var docs []model.Doc
	for i := 0; i < 100; i++ {
		docs = append(docs, model.Doc{Kind: "conv", ID: strings.Repeat("c", i+1), Data: raw})
	}
	if err = store.Apply(ctx, docs, nil, nil); err != nil {
		b.Fatal(err)
	}
	for _, lazy := range []bool{false, true} {
		name := "full"
		if lazy {
			name = "index"
		}
		b.Run(name, func(b *testing.B) {
			b.ReportAllocs()
			for b.Loop() {
				loaded, err := store.LoadDocs(ctx, lazy)
				if err != nil {
					b.Fatal(err)
				}
				bytes := 0
				for _, d := range loaded {
					bytes += len(d.Data)
				}
				b.ReportMetric(float64(bytes), "history-B")
			}
		})
	}
	b.Run("inline-scan", func(b *testing.B) {
		b.ReportAllocs()
		for b.Loop() {
			ids, err := store.InlineConversations(ctx)
			if err != nil || len(ids) != 0 {
				b.Fatal(ids, err)
			}
		}
	})

}
