package imagefit

import (
	"bytes"
	"encoding/base64"
	"image"
	"image/jpeg"
	"image/png"
	"testing"
)

func encoded(t *testing.T, w, h int, asJPEG bool) []byte {
	t.Helper()
	var buf bytes.Buffer
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	var err error
	if asJPEG {
		err = jpeg.Encode(&buf, img, nil)
	} else {
		err = png.Encode(&buf, img)
	}
	if err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func size(t *testing.T, data []byte) (int, int) {
	t.Helper()
	cfg, _, err := image.DecodeConfig(bytes.NewReader(data))
	if err != nil {
		t.Fatal(err)
	}
	return cfg.Width, cfg.Height
}

func TestFitScalesTheLongerSide(t *testing.T) {
	for _, c := range []struct {
		w, h, wantW, wantH int
		jpeg               bool
		mime               string
	}{
		{3200, 2000, 2000, 1250, false, "image/png"},
		{1000, 4800, 416, 2000, true, "image/jpeg"},
	} {
		in := encoded(t, c.w, c.h, c.jpeg)
		out, mime, w, h, changed := Fit(in, "x")
		gotW, gotH := size(t, out)
		if !changed || mime != c.mime || w != c.wantW || h != c.wantH || gotW != c.wantW || gotH != c.wantH {
			t.Fatalf("%dx%d: %s %dx%d decoded %dx%d changed=%v", c.w, c.h, mime, w, h, gotW, gotH, changed)
		}
	}
}

func TestFitLeavesWhatFits(t *testing.T) {
	in := encoded(t, 2000, 2000, false)
	if out, mime, w, h, changed := Fit(in, "image/png"); changed || !bytes.Equal(out, in) || mime != "image/png" || w != 2000 || h != 2000 {
		t.Fatalf("%s %dx%d %v", mime, w, h, changed)
	}
	if out, mime, _, _, changed := Fit([]byte("not an image"), "image/png"); changed || string(out) != "not an image" || mime != "image/png" {
		t.Fatal("unreadable data changed")
	}
}

func TestFitBase64(t *testing.T) {
	big := base64.StdEncoding.EncodeToString(encoded(t, 2400, 1200, false))
	for range 2 { // the second call comes from the kept result
		data, mime := FitBase64(big, "image/png")
		raw, err := base64.StdEncoding.DecodeString(data)
		if err != nil || mime != "image/png" {
			t.Fatal(err, mime)
		}
		if w, h := size(t, raw); w != 2000 || h != 1000 {
			t.Fatalf("%dx%d", w, h)
		}
	}
	small := base64.StdEncoding.EncodeToString(encoded(t, 3, 2, false))
	for range 2 {
		if data, mime := FitBase64(small, "image/webp"); data != small || mime != "image/webp" {
			t.Fatal("small image changed")
		}
	}
	if data, _ := FitBase64("%%%", "image/png"); data != "%%%" {
		t.Fatal("bad base64 changed")
	}
}
