package delivery

import (
	"bytes"
	"image"
	"image/png"
	"io"
	"net/http"
	"strings"
	"testing"
)

func TestAttachmentImagesRenderInlineButActiveContentDoesNot(t *testing.T) {
	api := setup(t).URL + "/api/v1"
	var pngBytes bytes.Buffer
	if err := png.Encode(&pngBytes, image.NewRGBA(image.Rect(0, 0, 1, 1))); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct{ name, body, mime, disposition string }{
		{"png", pngBytes.String(), "image/png", "inline"},
		{"html", "<!DOCTYPE html><script>alert(1)</script>", "application/octet-stream", "attachment"},
		{"svg", "<svg xmlns=\"http://www.w3.org/2000/svg\"><script>alert(1)</script></svg>", "application/octet-stream", "attachment"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			code, body := send(t, "POST", api+"/attachments", tc.body)
			if code != http.StatusCreated {
				t.Fatalf("upload %d", code)
			}
			res, err := http.Get(strings.TrimSuffix(api, "/api/v1") + body["url"].(string))
			if err != nil {
				t.Fatal(err)
			}
			defer res.Body.Close()
			raw, err := io.ReadAll(res.Body)
			if err != nil || res.StatusCode != 200 || string(raw) != tc.body || res.Header.Get("Content-Type") != tc.mime || res.Header.Get("Content-Disposition") != tc.disposition || res.Header.Get("X-Content-Type-Options") != "nosniff" {
				t.Fatalf("download: %d %v", res.StatusCode, res.Header)
			}
		})
	}
}
