// Package tools holds the tools a blueprint can allow: read files, write and edit files, search and read the web, run commands.
package tools

import (
	"bufio"
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"image"
	"image/gif"
	"image/jpeg"
	"image/png"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"unicode/utf8"

	"golang.org/x/image/webp"

	"github.com/yanun0323/mho-company/internal/adapter"
	"github.com/yanun0323/mho-company/internal/model"
	"github.com/yanun0323/mho-company/internal/model/enum"
)

const (
	// maxLines and maxBytes bound what one tool call hands to the model.
	maxLines = 2000
	maxBytes = 50 << 10
	// Anthropic takes at most 5MB of base64 per image, the tightest limit among the providers.
	maxImageBytes = 5 << 20 / 4 * 3
	// maxPixels keeps a small file from decoding into a huge image.
	maxPixels = 20_000_000
)

// images are the types every provider can look at.
var images = map[string]bool{"image/png": true, "image/jpeg": true, "image/gif": true, "image/webp": true}

// CanLookAt says whether every provider can take an image of this type and size.
func CanLookAt(mime string, size int) bool { return images[mime] && size <= maxImageBytes }

// Env is what a set of tools reaches beyond its working directory.
type Env struct {
	// Read lists folders readable besides the working directory (skills, attachments).
	Read []string
	// Output is where run_command keeps output too long to show; it is readable too. The system's
	// temporary folder when empty.
	Output string
	// Search is the search the engine shares, so its queue and cooldown hold across everyone; a
	// default one when nil.
	Search *Search
}

// For returns the named tools.
func For(allowed []enum.Tool, env Env) []adapter.Tool {
	read := env.Read
	if env.Output != "" {
		read = append(slices.Clone(read), env.Output)
	}
	search := env.Search
	if search == nil {
		search = exa
	}
	var out []adapter.Tool
	for _, t := range allowed {
		switch t {
		case enum.ToolReadFile:
			out = append(out, Read{Extra: read})
		case enum.ToolWriteFile:
			out = append(out, Write{}, Edit{})
		case enum.ToolRunCommand:
			out = append(out, Command{OutputDir: env.Output})
		case enum.ToolWebSearch:
			out = append(out, search, Fetch{})
		}
	}
	return out
}

func fail(format string, args ...any) model.ToolResult {
	return model.ToolResult{Text: fmt.Sprintf(format, args...), IsError: true}
}

// problem is how a failed file operation reads to the model, without the noise of the Go error chain.
func problem(err error) string {
	return strings.TrimPrefix(err.Error(), "open ")
}

func decode(raw json.RawMessage, into any) error {
	if len(raw) == 0 {
		raw = json.RawMessage("{}")
	}
	return json.Unmarshal(raw, into)
}

// cutUTF8 shortens s to at most n bytes without splitting a character.
func cutUTF8(s string, n int) string {
	if len(s) <= n {
		return s
	}
	s = s[:n]
	for !utf8.ValidString(s) {
		s = s[:len(s)-1]
	}
	return s
}

// real follows every symlink in path, including through parents that do not exist yet.
func real(path string) (string, error) {
	path = filepath.Clean(path)
	var missing []string
	for {
		resolved, err := filepath.EvalSymlinks(path)
		if err == nil {
			return filepath.Join(append([]string{resolved}, missing...)...), nil
		}
		if !errors.Is(err, os.ErrNotExist) {
			return "", err
		}
		parent := filepath.Dir(path)
		if parent == path {
			return "", err
		}
		missing = append([]string{filepath.Base(path)}, missing...)
		path = parent
	}
}

// within resolves a path the model gave, and refuses one outside the given roots.
func within(cwd, path string, roots ...string) (string, error) {
	if !filepath.IsAbs(path) {
		path = filepath.Join(cwd, path)
	}
	resolved, err := real(path)
	if err != nil {
		return "", err
	}
	for _, root := range append([]string{cwd}, roots...) {
		r, err := real(root)
		if err != nil {
			continue
		}
		if rel, err := filepath.Rel(r, resolved); err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
			return resolved, nil
		}
	}
	return "", fmt.Errorf("%s is outside the working directory", path)
}

// Read returns a text file or an image from the working directory or a skill folder.
type Read struct{ Extra []string }

func (Read) Spec() model.ToolSpec {
	return model.ToolSpec{Name: "read_file", Description: "Read a text file or look at an image (PNG, JPEG, GIF, WebP). Text returns at most 2000 lines or 50KB; use offset and limit to continue. An image comes whole, up to 3.75MB and 20 million pixels.",
		Parameters: json.RawMessage(`{"type":"object","properties":{"path":{"type":"string","description":"Absolute, or relative to the working directory"},"offset":{"type":"integer","minimum":1,"description":"Line to start from, 1-indexed"},"limit":{"type":"integer","minimum":1,"description":"Maximum number of lines"}},"required":["path"]}`)}
}

func (t Read) Run(_ context.Context, cwd string, raw json.RawMessage) model.ToolResult {
	var args struct {
		Path   string `json:"path"`
		Offset int    `json:"offset"`
		Limit  int    `json:"limit"`
	}
	if err := decode(raw, &args); err != nil {
		return fail("invalid arguments: %v", err)
	}
	if args.Path == "" {
		return fail("path is required")
	}
	path, err := within(cwd, args.Path, t.Extra...)
	if err != nil {
		return fail("%s", problem(err))
	}
	f, err := os.Open(path)
	if err != nil {
		return fail("%s", problem(err))
	}
	defer f.Close()
	if info, err := f.Stat(); err != nil || !info.Mode().IsRegular() {
		return fail("%s is not a regular file", args.Path)
	}
	r := bufio.NewReaderSize(f, 64<<10)
	head, err := r.Peek(8 << 10)
	if err != nil && !errors.Is(err, io.EOF) && !errors.Is(err, bufio.ErrBufferFull) {
		return fail("%s", problem(err))
	}
	if mime := http.DetectContentType(head); images[mime] {
		return readImage(r, args.Path, mime)
	}
	if bytes.IndexByte(head, 0) >= 0 {
		return fail("%s is a binary file", args.Path)
	}
	return readLines(r, args.Offset, args.Limit)
}

// readLines shows a window of lines as they are in the file, and says how to read on.
func readLines(r *bufio.Reader, offset, limit int) model.ToolResult {
	start := max(offset, 1)
	if limit <= 0 || limit > maxLines {
		limit = maxLines
	}
	var b strings.Builder
	total, end, full, cutLine := 0, start-1, false, false
	for {
		line, err := r.ReadString('\n')
		if err != nil && !errors.Is(err, io.EOF) {
			return fail("%s", problem(err))
		}
		if line == "" {
			break
		}
		total++
		if total >= start && !full {
			switch {
			case total-start < limit && b.Len()+len(line) <= maxBytes:
				b.WriteString(line)
				end = total
			case total == start: // one line longer than everything that may be shown
				b.WriteString(cutUTF8(line, maxBytes))
				b.WriteString("\n")
				end, full, cutLine = total, true, true
			default:
				full = true
			}
		}
		if err != nil {
			break
		}
	}
	if start > total {
		if total == 0 {
			return model.ToolResult{}
		}
		return fail("offset %d is past the end of the file, which has %d lines", start, total)
	}
	if cutLine {
		fmt.Fprintf(&b, "\n[Line %d is cut at 50KB.]", end)
	}
	if end < total {
		fmt.Fprintf(&b, "\n[Showing lines %d-%d of %d. Use offset=%d to continue.]", start, end, total, end+1)
	}
	return model.ToolResult{Text: b.String()}
}

func readImage(r io.Reader, path, mime string) model.ToolResult {
	data, err := io.ReadAll(io.LimitReader(r, maxImageBytes+1))
	if err != nil {
		return fail("%s", problem(err))
	}
	if len(data) > maxImageBytes {
		return fail("%s is too large to look at; images can be up to 3.75MB", path)
	}
	var config func(io.Reader) (image.Config, error)
	var decodeImage func(io.Reader) (image.Image, error)
	switch mime {
	case "image/png":
		config, decodeImage = png.DecodeConfig, png.Decode
	case "image/jpeg":
		config, decodeImage = jpeg.DecodeConfig, jpeg.Decode
	case "image/gif":
		config, decodeImage = gif.DecodeConfig, gif.Decode
	case "image/webp":
		config, decodeImage = webp.DecodeConfig, webp.Decode
	default:
		return fail("%s is an image type no model can look at", path)
	}
	cfg, err := config(bytes.NewReader(data))
	if err != nil {
		return fail("%s is not a valid image: %v", path, err)
	}
	if cfg.Width <= 0 || cfg.Height <= 0 || int64(cfg.Width)*int64(cfg.Height) > maxPixels {
		return fail("%s has more than 20 million pixels; resize it before looking at it", path)
	}
	if _, err := decodeImage(bytes.NewReader(data)); err != nil {
		return fail("%s is not a valid image: %v", path, err)
	}
	return model.ToolResult{Text: fmt.Sprintf("Image %s (%s, %d x %d, %d bytes)", path, mime, cfg.Width, cfg.Height, len(data)), MimeType: mime, Data: base64.StdEncoding.EncodeToString(data)}
}

// Write creates or replaces a file in the working directory.
type Write struct{}

func (Write) Spec() model.ToolSpec {
	return model.ToolSpec{Name: "write_file", Description: "Create a file or replace everything in it. Missing folders are created. To change part of a file, use edit_file.",
		Parameters: json.RawMessage(`{"type":"object","properties":{"path":{"type":"string","description":"Absolute, or relative to the working directory"},"content":{"type":"string","description":"The whole new content of the file"}},"required":["path","content"]}`)}
}

func (Write) Run(_ context.Context, cwd string, raw json.RawMessage) model.ToolResult {
	var args struct {
		Path    string  `json:"path"`
		Content *string `json:"content"`
	}
	if err := decode(raw, &args); err != nil {
		return fail("invalid arguments: %v", err)
	}
	if args.Path == "" || args.Content == nil {
		return fail("path and content are required")
	}
	path, err := within(cwd, args.Path)
	if err != nil {
		return fail("%s", problem(err))
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return fail("%s", problem(err))
	}
	if err := os.WriteFile(path, []byte(*args.Content), 0o644); err != nil {
		return fail("%s", problem(err))
	}
	return model.ToolResult{Text: fmt.Sprintf("wrote %d bytes to %s", len(*args.Content), args.Path)}
}
