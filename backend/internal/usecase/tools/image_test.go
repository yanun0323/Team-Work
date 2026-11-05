package tools

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"image"
	"image/color"
	"image/gif"
	"image/png"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/yanun0323/Team-Work/internal/adapter"
)

type drawer struct {
	prompt  string
	sources []string
	side    int
	gif     *adapter.Gif
	// still answers a GIF request with a PNG, as a service without animations would
	still bool
}

func (d *drawer) MakeImage(_ context.Context, prompt string, sources []string, _ bool, g *adapter.Gif) ([]byte, error) {
	d.prompt, d.sources, d.gif = prompt, sources, g
	var out bytes.Buffer
	if g == nil || d.still {
		_ = png.Encode(&out, image.NewNRGBA(image.Rect(0, 0, d.side, d.side)))
		return out.Bytes(), nil
	}
	pal := color.Palette{color.Black, color.White}
	anim := &gif.GIF{}
	for range 3 {
		anim.Image = append(anim.Image, image.NewPaletted(image.Rect(0, 0, d.side, d.side), pal))
		anim.Delay = append(anim.Delay, 20)
	}
	_ = gif.EncodeAll(&out, anim)
	return out.Bytes(), nil
}

func TestImageSavesAnAnimatedGIF(t *testing.T) {
	dir := t.TempDir()
	d := &drawer{side: 1500}
	tool := Image{Maker: d}
	res := tool.Run(context.Background(), dir, json.RawMessage(`{"prompt":"a dancing cat","gif":{"frame_count":3,"frame_duration_ms":200}}`))
	if res.IsError {
		t.Fatal(res.Text)
	}
	if d.gif == nil || d.gif.Frames != 3 || d.gif.FrameMS != 200 {
		t.Fatalf("asked for %+v", d.gif)
	}
	files, _ := filepath.Glob(filepath.Join(dir, generatedImagesDir, "*.gif"))
	if len(files) != 1 {
		t.Fatalf("generated %v", files)
	}
	// the file keeps every frame; the model sees the first as a small PNG
	saved, _ := os.ReadFile(files[0])
	if anim, err := gif.DecodeAll(bytes.NewReader(saved)); err != nil || len(anim.Image) != 3 {
		t.Fatalf("saved %v", err)
	}
	preview, _ := base64.StdEncoding.DecodeString(res.Data)
	if cfg, err := png.DecodeConfig(bytes.NewReader(preview)); err != nil || cfg.Width != previewSide || res.MimeType != "image/png" {
		t.Fatalf("preview %+v %v", cfg, err)
	}
	if !strings.Contains(res.Text, "3 frames") {
		t.Fatal(res.Text)
	}

	// defaults are left to the service; the path must suit the format
	if res := tool.Run(context.Background(), dir, json.RawMessage(`{"prompt":"x","gif":{}}`)); res.IsError || d.gif == nil || *d.gif != (adapter.Gif{}) {
		t.Fatalf("%s %+v", res.Text, d.gif)
	}
	for _, bad := range []string{
		`{"prompt":"x","gif":{},"output_path":"a.png"}`,
		`{"prompt":"x","output_path":"a.gif"}`,
		`{"prompt":"x","gif":{"frame_count":17}}`,
		`{"prompt":"x","gif":{"frame_duration_ms":10}}`,
	} {
		if res := tool.Run(context.Background(), dir, json.RawMessage(bad)); !res.IsError {
			t.Fatalf("took %s", bad)
		}
	}

	// a still picture where a GIF was asked for is not saved as one
	d.still = true
	if res := tool.Run(context.Background(), dir, json.RawMessage(`{"prompt":"x","gif":{},"output_path":"still.gif"}`)); !res.IsError {
		t.Fatal("saved a PNG as a GIF")
	}
	if _, err := os.Stat(filepath.Join(dir, "still.gif")); !os.IsNotExist(err) {
		t.Fatal("left the reserved file behind")
	}
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
