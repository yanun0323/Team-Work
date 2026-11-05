package codex

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"image"
	"image/color"
	"image/gif"
	"image/png"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/yanun0323/Team-Work/internal/adapter"
)

// TestImageRequestsAsTheCodexCLISendsThem checks the body of a still picture and of a GIF, matching the Codex CLI's
// image_generation_animation requests.
func TestImageRequestsAsTheCodexCLISendsThem(t *testing.T) {
	var still, anim bytes.Buffer
	_ = png.Encode(&still, image.NewNRGBA(image.Rect(0, 0, 1, 1)))
	pal := color.Palette{color.Black, color.White}
	_ = gif.EncodeAll(&anim, &gif.GIF{Image: []*image.Paletted{image.NewPaletted(image.Rect(0, 0, 1, 1), pal), image.NewPaletted(image.Rect(0, 0, 1, 1), pal)}, Delay: []int{20, 20}})

	var path string
	var body map[string]any
	reply := still.Bytes()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		path, body = r.URL.Path, nil
		_ = json.Unmarshal(raw, &body)
		fmt.Fprintf(w, `{"data":[{"b64_json":%q}]}`, base64.StdEncoding.EncodeToString(reply))
	}))
	t.Cleanup(srv.Close)
	secrets := &memSecrets{m: map[string]string{}}
	c := New("mp-1", secrets)
	c.APIURL = srv.URL
	signIn(t, c, secrets, time.Now().Add(time.Hour).UnixMilli())
	ctx := context.Background()

	if _, err := c.MakeImage(ctx, "a cat", nil, false, nil); err != nil {
		t.Fatal(err)
	}
	if path != "/codex/images/generations" || body["output_format"] != nil || body["frame_count"] != nil || body["model"] != imageModel {
		t.Fatalf("%s %v", path, body)
	}

	reply = anim.Bytes()
	data, err := c.MakeImage(ctx, "a dancing cat", []string{"data:image/png;base64,AA=="}, false, &adapter.Gif{Frames: 2, FrameMS: 200})
	if err != nil || !bytes.Equal(data, anim.Bytes()) {
		t.Fatalf("%v", err)
	}
	if path != "/codex/images/edits" || body["output_format"] != "gif" || body["frame_count"] != float64(2) || body["frame_duration_ms"] != float64(200) {
		t.Fatalf("%s %v", path, body)
	}

	// empty options leave frame count and duration to the service
	if _, err := c.MakeImage(ctx, "x", nil, false, &adapter.Gif{}); err != nil {
		t.Fatal(err)
	}
	if _, has := body["frame_count"]; has || body["output_format"] != "gif" {
		t.Fatalf("%v", body)
	}
}

// The service turns GIFs down for accounts it has not opened them to; the error says so instead of a bare 400.
func TestGIFsNotOpenToTheSubscriptionSaySo(t *testing.T) {
	reply := `{"detail":"GIF output is not enabled for this request."}`
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
		fmt.Fprint(w, reply)
	}))
	t.Cleanup(srv.Close)
	secrets := &memSecrets{m: map[string]string{}}
	c := New("mp-1", secrets)
	c.APIURL = srv.URL
	signIn(t, c, secrets, time.Now().Add(time.Hour).UnixMilli())

	_, err := c.MakeImage(context.Background(), "x", nil, false, &adapter.Gif{})
	if err == nil || !strings.Contains(err.Error(), "GIF") || strings.Contains(err.Error(), "400") {
		t.Fatalf("%v", err)
	}
	// other refusals stay as they were
	reply = `{"detail":"bad prompt"}`
	if _, err := c.MakeImage(context.Background(), "x", nil, false, &adapter.Gif{}); err == nil || !strings.Contains(err.Error(), "400") {
		t.Fatalf("%v", err)
	}
}
