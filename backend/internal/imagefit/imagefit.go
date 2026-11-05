// Package imagefit scales images down to a size every model provider accepts.
package imagefit

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"image"
	_ "image/gif"
	"image/jpeg"
	"image/png"
	"sync"

	"golang.org/x/image/draw"
	_ "golang.org/x/image/webp"
)

// MaxSide is the longest side an image may have. Anthropic rejects a request
// holding more than 20 images when any of them is larger than 2000 x 2000.
const MaxSide = 2000

// Fit returns the image scaled so neither side exceeds MaxSide, keeping its
// aspect ratio. JPEG stays JPEG and other types become PNG. An image that
// already fits, or cannot be read, comes back unchanged with changed false.
func Fit(data []byte, mime string) (out []byte, outMime string, width, height int, changed bool) {
	cfg, _, err := image.DecodeConfig(bytes.NewReader(data))
	if err != nil || cfg.Width <= 0 || cfg.Height <= 0 {
		return data, mime, 0, 0, false
	}
	if cfg.Width <= MaxSide && cfg.Height <= MaxSide {
		return data, mime, cfg.Width, cfg.Height, false
	}
	src, format, err := image.Decode(bytes.NewReader(data))
	if err != nil {
		return data, mime, cfg.Width, cfg.Height, false
	}
	w, h := cfg.Width, cfg.Height
	if w >= h {
		w, h = MaxSide, max(1, h*MaxSide/w)
	} else {
		w, h = max(1, w*MaxSide/h), MaxSide
	}
	dst := image.NewRGBA(image.Rect(0, 0, w, h))
	draw.ApproxBiLinear.Scale(dst, dst.Bounds(), src, src.Bounds(), draw.Src, nil)
	var buf bytes.Buffer
	outMime = "image/png"
	if format == "jpeg" {
		outMime = "image/jpeg"
		err = jpeg.Encode(&buf, dst, &jpeg.Options{Quality: 90})
	} else {
		err = (&png.Encoder{CompressionLevel: png.BestSpeed}).Encode(&buf, dst)
	}
	if err != nil {
		return data, mime, cfg.Width, cfg.Height, false
	}
	return buf.Bytes(), outMime, w, h, true
}

// fitted maps the sha256 of base64 data to its scaled [mime, data], or to an
// empty pair when it already fits.
var fitted sync.Map

// FitBase64 is Fit for base64 data. Conversations resend every image on each
// request, so results are kept and an image is scaled only once.
func FitBase64(data, mime string) (string, string) {
	key := sha256.Sum256([]byte(data))
	if v, ok := fitted.Load(key); ok {
		if r := v.([2]string); r[1] != "" {
			return r[1], r[0]
		}
		return data, mime
	}
	raw, err := base64.StdEncoding.DecodeString(data)
	if err != nil {
		return data, mime
	}
	out, outMime, _, _, changed := Fit(raw, mime)
	if !changed {
		fitted.Store(key, [2]string{})
		return data, mime
	}
	enc := base64.StdEncoding.EncodeToString(out)
	fitted.Store(key, [2]string{outMime, enc})
	return enc, outMime
}
