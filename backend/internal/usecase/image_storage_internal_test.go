package usecase

import (
	"context"
	"encoding/base64"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/yanun0323/Team-Work/internal/model"
	"github.com/yanun0323/Team-Work/internal/model/enum"
)

func TestStoredToolImagesResolveWithoutMutatingSharedHistory(t *testing.T) {
	e := &Engine{dataDir: t.TempDir()}
	data := base64.StdEncoding.EncodeToString([]byte("original image"))
	conv := []model.Message{{Role: enum.RoleUser, Content: []model.Block{
		{Type: enum.BlockToolResult, ID: "tool-1", Text: "image result", MimeType: "image/png", Data: data},
		{Type: enum.BlockImage, MimeType: "image/png", Data: data},
	}}}
	stored, changed, err := e.storeMessageImages(conv)
	if err != nil || !changed {
		t.Fatalf("store: %v %v", changed, err)
	}
	if conv[0].Content[0].Data != data || conv[0].Content[0].ImageRef != "" {
		t.Fatal("mutated running turn")
	}
	for _, b := range stored[0].Content {
		if b.Data != "" || b.ImageRef == "" {
			t.Fatal("inline history")
		}
	}
	files, err := os.ReadDir(e.attachmentRoot("uploads"))
	if err != nil || len(files) != 1 {
		t.Fatalf("dedup: %d %v", len(files), err)
	}
	got, err := e.resolveImages(context.Background(), stored)
	if err != nil {
		t.Fatal(err)
	}
	for i, b := range got[0].Content {
		want := conv[0].Content[i]
		if b.Data != want.Data || b.Text != want.Text || b.Type != want.Type || b.ID != want.ID || b.MimeType != want.MimeType || b.ImageRef != "" {
			t.Fatalf("resolved block changed: %+v", b)
		}
	}
	if stored[0].Content[0].Data != "" {
		t.Fatal("resolution mutated stored history")
	}
	if tokensOf(stored) != tokensOf(conv) {
		t.Fatal("image token accounting changed")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := e.resolveImages(ctx, stored); err == nil {
		t.Fatal("ignored cancellation")
	}
	hash := stored[0].Content[0].ImageRef
	if err := os.WriteFile(e.uploadPath(hash), []byte("corrupt"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := e.resolveImages(context.Background(), stored); err == nil {
		t.Fatal("accepted corrupted image")
	}
	if _, _, err := e.storeMessageImages(conv); err == nil {
		t.Fatal("replaced inline evidence with a corrupted existing object")
	}
	if conv[0].Content[0].Data != data {
		t.Fatal("lost inline evidence after collision")
	}

	if err := os.Remove(e.uploadPath(hash)); err != nil {
		t.Fatal(err)
	}
	if _, err := e.resolveImages(context.Background(), stored); err == nil {
		t.Fatal("silently dropped missing image")
	}
	stored[0].Content[0].ImageRef = "../secret"
	if _, err := e.resolveImages(context.Background(), stored); err == nil {
		t.Fatal("accepted path traversal")
	}
}

func TestFailedImageStorageKeepsOriginalEvidence(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "cache"), []byte("not a directory"), 0600); err != nil {
		t.Fatal(err)
	}
	e := &Engine{dataDir: root}
	data := base64.StdEncoding.EncodeToString([]byte("original"))
	conv := []model.Message{{Content: []model.Block{{Type: enum.BlockImage, MimeType: "image/png", Data: data}}}}
	if _, _, err := e.storeMessageImages(conv); err == nil {
		t.Fatal("expected disk failure")
	}
	if conv[0].Content[0].Data != data {
		t.Fatal("lost evidence")
	}
}

// Same text and image count in both cases; no provider, user data or network.
func BenchmarkHistorySnapshotImages(b *testing.B) {
	for _, refs := range []bool{false, true} {
		name := "inline"
		if refs {
			name = "references"
		}
		b.Run(name, func(b *testing.B) {
			e := &Engine{w: model.NewWorld(), dataDir: b.TempDir(), dirty: map[string]bool{}}
			image := "data:image/png;base64," + base64.StdEncoding.EncodeToString([]byte(strings.Repeat("x", 880_000)))
			for i := range 277 {
				c := &model.Chat{ID: strings.Repeat("c", i+1)}
				for range 60 {
					c.Messages = append(c.Messages, model.ChatMessage{Text: strings.Repeat("text ", 50)})
				}
				if i < 78 {
					c.Messages[0].Images = []model.Attachment{{URL: image}}
				}
				e.w.Chats[c.ID] = c
			}
			if refs {
				if err := e.storeHistoryImages(true); err != nil {
					b.Fatal(err)
				}
			}
			e.clock = func() float64 { return 1 }
			raw, err := e.Snapshot()
			if err != nil {
				b.Fatal(err)
			}
			size := len(raw)
			b.ReportAllocs()
			b.ResetTimer()
			for b.Loop() {
				if _, err := e.Snapshot(); err != nil {
					b.Fatal(err)
				}
			}
			b.ReportMetric(float64(size), "payload-B")
		})
	}
}
