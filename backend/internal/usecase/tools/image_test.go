package tools

import (
	"bytes"
	"context"
	"encoding/json"
	"image"
	"image/png"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

type drawer struct {
	prompt  string
	sources []string
	side    int
}

func (d *drawer) MakeImage(_ context.Context, prompt string, sources []string, _ bool) ([]byte, error) {
	d.prompt, d.sources = prompt, sources
	var out bytes.Buffer
	_ = png.Encode(&out, image.NewNRGBA(image.Rect(0, 0, d.side, d.side)))
	return out.Bytes(), nil
}

func TestImageSavesANewPNG(t *testing.T) {
	dir := t.TempDir()
	d := &drawer{side: 2000}
	tool := Image{Maker: d}
	res := tool.Run(context.Background(), dir, json.RawMessage(`{"prompt":"a cat","output_path":"art/cat.png"}`))
	if res.IsError {
		t.Fatal(res.Text)
	}
	if d.prompt != "a cat" || len(d.sources) != 0 {
		t.Fatalf("%+v", d)
	}
	saved, err := os.ReadFile(filepath.Join(dir, "art", "cat.png"))
	if err != nil {
		t.Fatal(err)
	}
	if cfg, _ := png.DecodeConfig(bytes.NewReader(saved)); cfg.Width != 2000 {
		t.Fatalf("saved %d wide", cfg.Width)
	}
	// the model sees a smaller preview
	if res.MimeType != "image/png" || res.Data == "" || !strings.Contains(res.Text, "art/cat.png") {
		t.Fatalf("%+v", res.Text)
	}

	// never over a file, and never outside the working directory
	if res := tool.Run(context.Background(), dir, json.RawMessage(`{"prompt":"x","output_path":"art/cat.png"}`)); !res.IsError {
		t.Fatal("overwrote a file")
	}
	if res := tool.Run(context.Background(), dir, json.RawMessage(`{"prompt":"x","output_path":"../out.png"}`)); !res.IsError {
		t.Fatal("wrote outside the working directory")
	}

	// edits send the source along
	d.side = 4
	res = tool.Run(context.Background(), dir, json.RawMessage(`{"prompt":"make it red","images":["art/cat.png"]}`))
	if res.IsError {
		t.Fatal(res.Text)
	}
	if len(d.sources) != 1 || !strings.HasPrefix(d.sources[0], "data:image/png;base64,") {
		t.Fatalf("sources %d", len(d.sources))
	}
	if files, _ := filepath.Glob(filepath.Join(dir, generatedImagesDir, "*.png")); len(files) != 1 {
		t.Fatalf("generated %v", files)
	}
}
