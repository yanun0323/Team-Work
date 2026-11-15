package tools

import (
	"bytes"
	"context"
	"encoding/json"
	"image"
	"image/png"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

// exec reads files through Structured: the same folders and the same windows as read_file itself, as data.
func TestStructuredReadMatchesReadFile(t *testing.T) {
	cwd, extra, outside := t.TempDir(), t.TempDir(), t.TempDir()
	write := func(dir, name, text string) {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(text), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	var long strings.Builder
	for i := range 2500 {
		long.WriteString(strings.Repeat("x", i%7) + "\n")
	}
	write(cwd, "long.txt", long.String())
	write(cwd, "short.txt", "a\nb\nc")
	write(cwd, "empty.txt", "")
	write(cwd, "wide.txt", strings.Repeat("y", 60<<10)+"\nnext\n")
	write(extra, "note.txt", "attached\n")
	write(outside, "secret.txt", "secret\n")
	if err := os.Symlink(filepath.Join(outside, "secret.txt"), filepath.Join(cwd, "link.txt")); err != nil {
		t.Fatal(err)
	}
	var pic bytes.Buffer
	_ = png.Encode(&pic, image.NewNRGBA(image.Rect(0, 0, 1, 1)))
	write(cwd, "pic.png", pic.String())

	r := Read{Extra: []string{extra}}
	ctx := context.Background()
	data := func(a any) (FileText, error) {
		v, err := r.Structured(ctx, cwd, args(a))
		if err != nil {
			return FileText{}, err
		}
		return v.(FileText), nil
	}

	// refused alike, with the same words
	for _, path := range []string{filepath.Join(outside, "secret.txt"), "link.txt", "../x", "missing.txt", "pic.png"} {
		direct := r.Run(ctx, cwd, args(map[string]any{"path": path}))
		_, err := data(map[string]any{"path": path})
		if err == nil {
			t.Fatalf("%s: exec read it", path)
		}
		if path == "pic.png" {
			if direct.IsError || !strings.Contains(err.Error(), "text files only") {
				t.Fatalf("image: %v / %+v", err, direct.IsError)
			}
			continue
		}
		if !direct.IsError || direct.Text != err.Error() {
			t.Fatalf("%s: direct %q, exec %q", path, direct.Text, err)
		}
	}
	if _, err := data(map[string]any{}); err == nil || err.Error() != "path is required" {
		t.Fatal(err)
	}

	// a folder read_file may read besides the working directory
	got, err := data(map[string]any{"path": filepath.Join(extra, "note.txt")})
	if err != nil || got.Content != "attached\n" || r.Run(ctx, cwd, args(map[string]any{"path": filepath.Join(extra, "note.txt")})).Text != "attached\n" {
		t.Fatalf("%+v %v", got, err)
	}

	// the same window of lines, and the same place to go on from
	got, err = data(map[string]any{"path": "long.txt", "offset": 10})
	if err != nil {
		t.Fatal(err)
	}
	direct := r.Run(ctx, cwd, args(map[string]any{"path": "long.txt", "offset": 10})).Text
	if !got.Truncated || got.StartLine != 10 || got.EndLine != 2009 || got.TotalLines != 2500 || !strings.HasPrefix(direct, got.Content) ||
		!strings.Contains(direct, "Use offset=2010 to continue") {
		t.Fatalf("%+v\n%s", got, direct[len(direct)-80:])
	}
	got, _ = data(map[string]any{"path": "short.txt", "offset": 2, "limit": 1})
	if want := (FileText{Path: "short.txt", StartLine: 2, EndLine: 2, TotalLines: 3, Truncated: true, Content: "b\n"}); got != want {
		t.Fatalf("%+v", got)
	}
	got, _ = data(map[string]any{"path": "short.txt"})
	if want := (FileText{Path: "short.txt", StartLine: 1, EndLine: 3, TotalLines: 3, Content: "a\nb\nc"}); got != want || r.Run(ctx, cwd, args(map[string]any{"path": "short.txt"})).Text != "a\nb\nc" {
		t.Fatalf("%+v", got)
	}
	got, _ = data(map[string]any{"path": "empty.txt"})
	if got.TotalLines != 0 || got.Content != "" || got.Truncated {
		t.Fatalf("%+v", got)
	}
	got, _ = data(map[string]any{"path": "wide.txt"})
	direct = r.Run(ctx, cwd, args(map[string]any{"path": "wide.txt"})).Text
	if !got.Truncated || got.EndLine != 1 || len(got.Content) != 50<<10 || !strings.HasPrefix(direct, got.Content) || !strings.Contains(direct, "[Line 1 is cut at 50KB.]") {
		t.Fatalf("%d %+v", len(got.Content), got.EndLine)
	}
	_, err = data(map[string]any{"path": "short.txt", "offset": 9})
	if err == nil || err.Error() != r.Run(ctx, cwd, args(map[string]any{"path": "short.txt", "offset": 9})).Text {
		t.Fatal(err)
	}
}

// What a structured tool says it returns has the keys it returns.
func TestStructuredReadDeclaresItsKeys(t *testing.T) {
	cwd := t.TempDir()
	_ = os.WriteFile(filepath.Join(cwd, "a.txt"), []byte("a\n"), 0o644)
	v, err := Read{}.Structured(context.Background(), cwd, args(map[string]any{"path": "a.txt"}))
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := json.Marshal(v)
	var got map[string]any
	_ = json.Unmarshal(raw, &got)
	var keys []string
	for k := range got {
		keys = append(keys, k)
		if !strings.Contains(Read{}.Returns(), "  "+k+": ") {
			t.Fatalf("%s not declared in %s", k, Read{}.Returns())
		}
	}
	if len(keys) != strings.Count(Read{}.Returns(), ";") {
		t.Fatalf("%v against %s", keys, Read{}.Returns())
	}
	var _ Structured = Read{}
	var _ Structured = SemanticSearch{}
	if !reflect.DeepEqual(Read{}.Returns(), Read{}.Returns()) {
		t.Fatal("not the same twice")
	}
}
