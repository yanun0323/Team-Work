// Package config loads the server's settings.
package config

import (
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strings"

	"github.com/spf13/viper"
)

// Config is set through MHO_COMPANY_* environment variables.
type Config struct {
	Host           string
	Port           int
	DataDir        string
	AllowedOrigins []string
	Debug          bool
}

// Load reads the settings. The API has no sign-in and its employees can run commands, so it only ever
// listens on this computer.
func Load() (Config, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return Config{}, fmt.Errorf("find home folder: %w", err)
	}
	v := viper.New()
	v.SetEnvPrefix("MHO_COMPANY")
	v.AutomaticEnv()
	v.SetDefault("HOST", "127.0.0.1")
	v.SetDefault("PORT", 8787)
	v.SetDefault("DATA_DIR", filepath.Join(home, ".mho-company"))
	v.SetDefault("ALLOWED_ORIGINS", "http://localhost:5173,http://127.0.0.1:5173")
	v.SetDefault("DEBUG", false)
	c := Config{Host: v.GetString("HOST"), Port: v.GetInt("PORT"), DataDir: v.GetString("DATA_DIR"), Debug: v.GetBool("DEBUG")}
	for _, o := range strings.Split(v.GetString("ALLOWED_ORIGINS"), ",") {
		if o = strings.TrimSpace(o); o != "" {
			c.AllowedOrigins = append(c.AllowedOrigins, o)
		}
	}
	if !IsLoopback(c.Host) {
		return Config{}, fmt.Errorf("MHO_COMPANY_HOST must be this computer (127.0.0.1, ::1 or localhost), got %q", c.Host)
	}
	return c, nil
}

// IsLoopback tells whether host names this computer.
func IsLoopback(host string) bool {
	if host == "localhost" {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}
