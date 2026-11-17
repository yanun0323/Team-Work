package codex

import (
	"context"
	"net/http"
	"path"
	"regexp"
	"strings"
	"time"
)

const (
	// ReleasesURL redirects to the Codex CLI's latest stable release, whose tag names its version.
	ReleasesURL = "https://github.com/openai/codex/releases/latest"
	// versionKey keeps the last version read from ReleasesURL in the secrets table, beside the providers' tokens.
	versionKey = "codex/client_version"
	// fallbackClientVersion is used when the latest release cannot be read and none was kept.
	fallbackClientVersion = "0.169.0"
	versionTimeout        = 10 * time.Second
)

var stableVersion = regexp.MustCompile(`^\d+\.\d+\.\d+$`)

// clientVersion is the client_version the model catalog is asked with: the backend lists only the models whose
// minimal_client_version it reaches. It is the Codex CLI's latest release, then the one last read, then
// fallbackClientVersion.
func (c *Client) clientVersion(ctx context.Context) string {
	if v := c.latestRelease(ctx); v != "" {
		if kept, _ := c.Secrets.Secret(ctx, versionKey); kept != v {
			_ = c.Secrets.SetSecret(ctx, versionKey, v)
		}
		return v
	}
	if kept, err := c.Secrets.Secret(ctx, versionKey); err == nil && stableVersion.MatchString(kept) {
		return kept
	}
	return fallbackClientVersion
}

// latestRelease reads the version from where ReleasesURL redirects, such as .../releases/tag/rust-v0.169.0; "" when
// it cannot.
func (c *Client) latestRelease(ctx context.Context) string {
	ctx, cancel := context.WithTimeout(ctx, versionTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.ReleasesURL, nil)
	if err != nil {
		return ""
	}
	res, err := c.HTTP.Do(req) // follows no redirect
	if err != nil {
		return ""
	}
	res.Body.Close()
	if res.StatusCode < 300 || res.StatusCode >= 400 {
		return ""
	}
	v := strings.TrimPrefix(path.Base(res.Header.Get("Location")), "rust-v")
	if !stableVersion.MatchString(v) {
		return ""
	}
	return v
}
