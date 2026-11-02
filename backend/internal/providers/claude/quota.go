package claude

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/yanun0323/mho-company/internal/model"
)

// usageURL is the endpoint behind Claude Code's /usage (not a published API). Tests replace it.
var usageURL = "https://api.anthropic.com/api/oauth/usage"

// accessToken reads the token Claude Code signed in with. Tests replace it.
var accessToken = claudeToken

var usageHTTP = &http.Client{Timeout: 15 * time.Second}

// Quota reads how much of the 5-hour and weekly limits is used. A token Claude Code has not refreshed yet
// is turned down; the next run of Claude Code refreshes it.
func (c *Client) Quota(ctx context.Context) (model.Quota, error) {
	token, err := accessToken(ctx)
	if err != nil || token == "" {
		return model.Quota{}, model.Errorf(model.CodeInvalid, "還沒登入 Claude Code")
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, usageURL, nil)
	if err != nil {
		return model.Quota{}, err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("anthropic-beta", "oauth-2025-04-20")
	req.Header.Set("Accept", "application/json")
	res, err := usageHTTP.Do(req)
	if err != nil {
		if ctx.Err() != nil {
			return model.Quota{}, ctx.Err()
		}
		return model.Quota{}, model.Errorf(model.CodeUnavailable, "連不上 Claude")
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return model.Quota{}, model.Errorf(model.CodeUnavailable, "Claude 無法提供用量（%d）", res.StatusCode)
	}
	type window struct {
		Used    *float64 `json:"utilization"`
		ResetAt string   `json:"resets_at"`
	}
	var body struct {
		FiveHour *window `json:"five_hour"`
		SevenDay *window `json:"seven_day"`
	}
	if json.NewDecoder(io.LimitReader(res.Body, 1<<20)).Decode(&body) != nil {
		return model.Quota{}, model.Errorf(model.CodeUnavailable, "Claude 回了無法讀取的用量")
	}
	used := func(w *window) *float64 {
		if w == nil || w.Used == nil {
			return nil
		}
		v := min(max(*w.Used, 0), 100)
		return &v
	}
	resetAt := func(w *window) int64 {
		if w == nil {
			return 0
		}
		t, err := time.Parse(time.RFC3339Nano, w.ResetAt)
		if err != nil {
			return 0
		}
		return t.Unix()
	}
	return model.Quota{FiveHour: used(body.FiveHour), Weekly: used(body.SevenDay),
		FiveHourResetAt: resetAt(body.FiveHour), WeeklyResetAt: resetAt(body.SevenDay)}, nil
}

// claudeToken finds Claude Code's credentials: in the login keychain on macOS when its folder is the
// default one, otherwise in the folder's .credentials.json.
func claudeToken(ctx context.Context) (string, error) {
	var raw []byte
	if runtime.GOOS == "darwin" && os.Getenv("CLAUDE_CONFIG_DIR") == "" {
		out, err := exec.CommandContext(ctx, "security", "find-generic-password", "-s", "Claude Code-credentials", "-w").Output()
		if err == nil {
			raw = []byte(strings.TrimSpace(string(out)))
		}
	}
	if raw == nil {
		b, err := os.ReadFile(filepath.Join(claudeDir(), ".credentials.json"))
		if err != nil {
			return "", err
		}
		raw = b
	}
	var creds struct {
		OAuth struct {
			AccessToken string `json:"accessToken"`
		} `json:"claudeAiOauth"`
	}
	if err := json.Unmarshal(raw, &creds); err != nil {
		return "", err
	}
	return creds.OAuth.AccessToken, nil
}
