package codex

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"image/png"
	"io"
	"net/http"
)

// Adapted from mho's codex image tool, which matches the Codex CLI's native Images requests.
const (
	imageModel             = "gpt-image-2"
	maxGeneratedImageBytes = 32 << 20
)

type imageReference struct {
	URL string `json:"image_url"`
}

type imageRequest struct {
	Prompt     string           `json:"prompt"`
	Model      string           `json:"model"`
	Background string           `json:"background"`
	Quality    string           `json:"quality"`
	Size       string           `json:"size"`
	Images     []imageReference `json:"images,omitempty"`
}

// MakeImage draws a PNG from prompt, or edits the sources (data URLs) when there are any. It is never retried once
// the service has it, as each try spends the allowance.
func (c *Client) MakeImage(ctx context.Context, prompt string, sources []string, transparent bool) ([]byte, error) {
	body := imageRequest{Prompt: prompt, Model: imageModel, Background: "opaque", Quality: "auto", Size: "auto"}
	if transparent {
		body.Background = "transparent"
	}
	route := "generations"
	if len(sources) > 0 {
		route = "edits"
		for _, s := range sources {
			body.Images = append(body.Images, imageReference{URL: s})
		}
	}
	raw, err := json.Marshal(body)
	if err != nil {
		return nil, rejected("圖片請求無法編碼")
	}
	turn := randomHex(16)
	var res *http.Response
	// tokens the backend turns down are replaced once: they can be withdrawn before they run out
	for attempt := 0; ; attempt++ {
		creds, err := c.session(ctx, attempt > 0)
		if err != nil {
			return nil, err
		}
		req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.APIURL+"/codex/images/"+route, bytes.NewReader(raw))
		if err != nil {
			return nil, rejected("ChatGPT 位址不正確")
		}
		c.headers(req, creds)
		req.Header.Set("User-Agent", "mho")
		req.Header.Set("x-codex-image-turn-id", turn)
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Accept", "application/json")
		res, err = c.HTTP.Do(req)
		if err != nil {
			if ctx.Err() != nil {
				return nil, ctx.Err()
			}
			return nil, unavailable("連不上 ChatGPT")
		}
		if res.StatusCode != http.StatusUnauthorized || attempt > 0 {
			break
		}
		res.Body.Close()
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return nil, statusError(res)
	}
	const limit = (maxGeneratedImageBytes+2)/3*4 + (1 << 20)
	raw, err = io.ReadAll(io.LimitReader(res.Body, limit+1))
	if err != nil || len(raw) > limit {
		return nil, unavailable("ChatGPT 的圖片中斷了或太大")
	}
	var out struct {
		Data []struct {
			Base64 string `json:"b64_json"`
		} `json:"data"`
	}
	if json.Unmarshal(raw, &out) != nil || len(out.Data) != 1 {
		return nil, unavailable("ChatGPT 沒有回傳圖片")
	}
	data, err := base64.StdEncoding.DecodeString(out.Data[0].Base64)
	if err != nil || len(data) > maxGeneratedImageBytes {
		return nil, unavailable("ChatGPT 回傳的圖片無法讀取")
	}
	if _, err := png.DecodeConfig(bytes.NewReader(data)); err != nil {
		return nil, unavailable("ChatGPT 回傳的圖片無法讀取")
	}
	return data, nil
}
