package providers

import (
	"bytes"
	"context"
	"encoding/json"
	"image/png"
	"io"
	"net/http"

	"github.com/yanun0323/Team-Work/internal/adapter"
	"github.com/yanun0323/Team-Work/internal/model"
)

const (
	// a 4096x4096 picture, the most stable-diffusion.cpp's server draws, can be a large PNG
	maxImageBytes  = 96 << 20
	maxImagePixels = 20_000_000
)

// imageHTTP waits for the answer as long as the request's context allows: a server such as sd-server sends nothing
// until the whole picture is drawn, which takes more than keyedHTTP's two minutes for a large one.
var imageHTTP = func() *http.Client {
	c := newHTTP()
	c.Transport.(*http.Transport).ResponseHeaderTimeout = 0
	return c
}()

type compatibleImage struct {
	openAI
	id string
}

func (c compatibleImage) MakeImage(ctx context.Context, prompt string, sources []string, transparent bool, gif *adapter.Gif, size string) ([]byte, error) {
	if len(sources) > 0 || transparent || gif != nil {
		return nil, model.Errorf(model.CodeInvalid, "這個生圖模型只支援用文字生成 PNG")
	}
	body := map[string]string{"model": c.id, "prompt": prompt, "response_format": "b64_json"}
	if size != "" {
		body["size"] = size
	}
	res, err := c.do(ctx, http.MethodPost, "/images/generations", body, c.auth)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	const limit = (maxImageBytes+2)/3*4 + 1<<20
	raw, err := io.ReadAll(io.LimitReader(res.Body, limit+1))
	if err != nil || len(raw) > limit {
		return nil, model.Errorf(model.CodeUnavailable, "圖片回應中斷或過大")
	}
	var out struct {
		Data []struct {
			PNG []byte `json:"b64_json"`
		} `json:"data"`
	}
	if json.Unmarshal(raw, &out) != nil || len(out.Data) != 1 || len(out.Data[0].PNG) > maxImageBytes {
		return nil, model.Errorf(model.CodeUnavailable, "生圖服務沒有回傳有效的 b64_json 圖片")
	}
	data := out.Data[0].PNG
	cfg, err := png.DecodeConfig(bytes.NewReader(data))
	if err != nil || cfg.Width > maxImagePixels/cfg.Height {
		return nil, model.Errorf(model.CodeUnavailable, "生圖服務沒有回傳有效大小的 PNG")
	}
	return data, nil
}
