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

type compatibleImage struct {
	openAI
	id string
}

func (c compatibleImage) MakeImage(ctx context.Context, prompt string, sources []string, transparent bool, gif *adapter.Gif) ([]byte, error) {
	if len(sources) > 0 || transparent || gif != nil {
		return nil, model.Errorf(model.CodeInvalid, "這個生圖模型只支援用文字生成 PNG")
	}
	res, err := c.do(ctx, http.MethodPost, "/images/generations", map[string]string{"model": c.id, "prompt": prompt, "response_format": "b64_json"}, c.auth)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	const maxBytes = 32 << 20
	const limit = (maxBytes+2)/3*4 + 1<<20
	raw, err := io.ReadAll(io.LimitReader(res.Body, limit+1))
	if err != nil || len(raw) > limit {
		return nil, model.Errorf(model.CodeUnavailable, "圖片回應中斷或過大")
	}
	var body struct {
		Data []struct {
			PNG []byte `json:"b64_json"`
		} `json:"data"`
	}
	if json.Unmarshal(raw, &body) != nil || len(body.Data) != 1 || len(body.Data[0].PNG) > maxBytes {
		return nil, model.Errorf(model.CodeUnavailable, "生圖服務沒有回傳有效的 b64_json 圖片")
	}
	data := body.Data[0].PNG
	cfg, err := png.DecodeConfig(bytes.NewReader(data))
	if err != nil || cfg.Width > 20_000_000/cfg.Height {
		return nil, model.Errorf(model.CodeUnavailable, "生圖服務沒有回傳有效大小的 PNG")
	}
	return data, nil
}
