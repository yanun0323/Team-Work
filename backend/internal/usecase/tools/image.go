package tools

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"image"
	"image/gif"
	"image/png"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/yanun0323/Team-Work/internal/adapter"
	"github.com/yanun0323/Team-Work/internal/model"
)

const (
	// imageTimeout bounds one picture; drawing takes from seconds to a few minutes.
	imageTimeout       = 5 * time.Minute
	maxSourceBytes     = 5 << 20
	maxSources         = 5
	previewSide        = 1024
	generatedImagesDir = "generated-images"
)

// Image draws a picture, or edits pictures, with the ChatGPT subscription chosen in the preferences. Adapted from
// mho's codex image tool: it writes a new PNG, or a GIF when asked for one, and never overwrites a file.
type Image struct {
	Maker adapter.ImageMaker
	// Extra lists folders source images may come from besides the working directory.
	Extra []string
	// Keep, when set, gets each saved picture, so it can be shown where the tool ran.
	Keep func(output string, data []byte)
}

func (Image) Spec() model.ToolSpec {
	return model.ToolSpec{Name: "image_gen",
		Description: "Generate an image, or edit 1–5 local images when images is provided. Uses the ChatGPT subscription's allowance and can take a few minutes. Returns a new PNG path, or a GIF path when gif is set, and a still preview; never overwrites files. Relative paths use the working directory.\n" +
			"GIF guidelines:\n" +
			"- Use gif only for simple looping animations with 2–16 frames. For more complex animations or more frames, use other tools instead.\n" +
			"- Use {} for the defaults (9 frames, 200 ms per frame), or set frame_count and frame_duration_ms.\n" +
			"- To edit a GIF, first inspect its frames, then make a spritesheet with equal-sized cells in a regular grid. Pass that spritesheet in images and set gif. Do not pass the GIF itself as an edit input.",
		Parameters: json.RawMessage(`{"type":"object","properties":{"prompt":{"type":"string","minLength":1},"images":{"type":"array","minItems":1,"maxItems":5,"items":{"type":"string","minLength":1},"description":"Source PNG, JPEG or GIF paths, each up to 5 MiB and 20 million pixels. Omit to generate."},"transparent_background":{"type":"boolean"},"gif":{"type":"object","properties":{"frame_count":{"type":"integer","minimum":2,"maximum":16},"frame_duration_ms":{"type":"integer","minimum":20,"maximum":2000}},"additionalProperties":false,"description":"Set to make a looping animated GIF instead of a PNG."},"output_path":{"type":"string","minLength":1,"description":"New .png path, or .gif with gif, in the working directory. Defaults to a unique file under generated-images/."}},"required":["prompt"],"additionalProperties":false}`)}
}

func (t Image) Run(ctx context.Context, cwd string, raw json.RawMessage) model.ToolResult {
	var args struct {
		Prompt      string       `json:"prompt"`
		Images      []string     `json:"images"`
		Transparent bool         `json:"transparent_background"`
		Gif         *adapter.Gif `json:"gif"`
		Output      string       `json:"output_path"`
	}
	if err := decode(raw, &args); err != nil {
		return fail("invalid arguments: %v", err)
	}
	if strings.TrimSpace(args.Prompt) == "" {
		return fail("prompt is required")
	}
	if len(args.Images) > maxSources {
		return fail("give 1–5 source images, or none to generate")
	}
	if g := args.Gif; g != nil && (g.Frames != 0 && (g.Frames < 2 || g.Frames > 16) || g.FrameMS != 0 && (g.FrameMS < 20 || g.FrameMS > 2000)) {
		return fail("gif takes 2–16 frames of 20–2000 ms each")
	}
	ext := ".png"
	if args.Gif != nil {
		ext = ".gif"
	}
	var sources []string
	for _, name := range args.Images {
		source, err := t.source(cwd, name)
		if err != nil {
			return fail("%s", err)
		}
		sources = append(sources, source)
	}
	output := args.Output
	if output == "" {
		id := make([]byte, 8)
		_, _ = rand.Read(id)
		output = filepath.Join(generatedImagesDir, hex.EncodeToString(id)+ext)
	}
	if !strings.EqualFold(filepath.Ext(output), ext) {
		return fail("choose an output path ending in %s", ext)
	}
	path, err := within(cwd, output)
	if err != nil {
		return fail("%s", problem(err))
	}
	// reserve the file before spending the allowance; O_EXCL also refuses a symlink or a race
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return fail("%s", problem(err))
	}
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o644)
	if err != nil {
		if errors.Is(err, os.ErrExist) {
			return fail("%s already exists; choose a new %s path", output, ext)
		}
		return fail("%s", problem(err))
	}
	saved := false
	defer func() {
		file.Close()
		if !saved {
			os.Remove(path)
		}
	}()
	ctx, cancel := context.WithTimeout(ctx, imageTimeout)
	defer cancel()
	data, err := t.Maker.MakeImage(ctx, args.Prompt, sources, args.Transparent, args.Gif)
	if err != nil {
		if ctx.Err() == context.DeadlineExceeded {
			return fail("the image took longer than 5 minutes; it was not retried")
		}
		var known *model.Error
		if errors.As(err, &known) {
			return fail("%s", known.Message)
		}
		return fail("could not make the image")
	}
	var cfg image.Config
	var still image.Image
	frames := 0
	if args.Gif != nil {
		anim, err := gif.DecodeAll(bytes.NewReader(data))
		if err != nil || len(anim.Image) == 0 {
			return fail("the image service returned no GIF; animated output may not be available to this subscription yet")
		}
		cfg, still, frames = anim.Config, anim.Image[0], len(anim.Image)
	} else if cfg, err = png.DecodeConfig(bytes.NewReader(data)); err != nil {
		return fail("the image service returned no valid PNG")
	}
	preview, err := imagePreview(data, cfg, still)
	if err != nil {
		return fail("could not prepare the preview")
	}
	if _, err := file.Write(data); err != nil {
		return fail("%s", problem(err))
	}
	if err := file.Close(); err != nil {
		return fail("%s", problem(err))
	}
	saved = true
	if t.Keep != nil {
		t.Keep(output, data)
	}
	saidAs := fmt.Sprintf("Saved image: %s (%d x %d). Use this path for later edits. The attachment is a preview.", output, cfg.Width, cfg.Height)
	if frames > 0 {
		saidAs = fmt.Sprintf("Saved animated GIF: %s (%d x %d, %d frames). The attachment is its first frame as a still preview.", output, cfg.Width, cfg.Height, frames)
	}
	return model.ToolResult{Text: saidAs,
		MimeType: "image/png", Data: base64.StdEncoding.EncodeToString(preview)}
}

// source reads a source image into a data URL.
func (t Image) source(cwd, name string) (string, error) {
	if strings.TrimSpace(name) == "" {
		return "", errors.New("source image paths cannot be empty")
	}
	path, err := within(cwd, name, t.Extra...)
	if err != nil {
		return "", errors.New(problem(err))
	}
	f, err := os.Open(path)
	if err != nil {
		return "", errors.New(problem(err))
	}
	defer f.Close()
	if info, err := f.Stat(); err != nil || !info.Mode().IsRegular() {
		return "", fmt.Errorf("%s is not a regular file", name)
	}
	data, err := io.ReadAll(io.LimitReader(f, maxSourceBytes+1))
	if err != nil {
		return "", errors.New(problem(err))
	}
	if len(data) > maxSourceBytes {
		return "", fmt.Errorf("%s is larger than 5 MiB", name)
	}
	cfg, format, err := image.DecodeConfig(bytes.NewReader(data))
	if err != nil || (format != "png" && format != "jpeg" && format != "gif") {
		return "", fmt.Errorf("%s is not a PNG, JPEG or GIF", name)
	}
	if cfg.Width <= 0 || cfg.Height <= 0 || int64(cfg.Width)*int64(cfg.Height) > maxPixels {
		return "", fmt.Errorf("%s has more than 20 million pixels; resize it first", name)
	}
	if _, _, err := image.Decode(bytes.NewReader(data)); err != nil {
		return "", fmt.Errorf("%s is incomplete or damaged", name)
	}
	return "data:image/" + format + ";base64," + base64.StdEncoding.EncodeToString(data), nil
}

// imagePreview keeps what the model sees a small PNG; the file on disk stays whole. still, when set, is the picture
// to show in place of data, such as a GIF's first frame.
func imagePreview(data []byte, cfg image.Config, still image.Image) ([]byte, error) {
	src := still
	if src == nil {
		if len(data) <= maxImageBytes && cfg.Width <= previewSide && cfg.Height <= previewSide {
			return data, nil
		}
		var err error
		if src, err = png.Decode(bytes.NewReader(data)); err != nil {
			return nil, err
		}
	}
	w, h := cfg.Width, cfg.Height
	if side := max(w, h); side > previewSide {
		w, h = max(1, w*previewSide/side), max(1, h*previewSide/side)
	}
	dst := image.NewNRGBA(image.Rect(0, 0, w, h))
	for y := range h {
		for x := range w {
			dst.Set(x, y, src.At(x*cfg.Width/w, y*cfg.Height/h))
		}
	}
	var out bytes.Buffer
	if err := png.Encode(&out, dst); err != nil {
		return nil, err
	}
	return out.Bytes(), nil
}
