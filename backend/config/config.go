// Package config loads global server settings from TEAM_WORK_HOME/config.yaml.
package config

import (
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"

	"github.com/spf13/viper"
)

// Config contains startup settings; editing config.yaml requires a restart.
type Config struct {
	Host              string   `mapstructure:"host"`
	Port              int      `mapstructure:"port"`
	DataDir           string   `mapstructure:"-"`
	AllowedOrigins    []string `mapstructure:"allowedOrigins"`
	Debug             bool     `mapstructure:"debug"`
	MemoryDiagnostics bool     `mapstructure:"memoryDiagnostics"`
}

const defaultConfig = "host: 127.0.0.1\nport: 8787\nallowedOrigins:\n  - http://localhost:5173\n  - http://127.0.0.1:5173\ndebug: false\nmemoryDiagnostics: false\n"

func Load() (Config, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return Config{}, err
	}
	dir := os.Getenv("TEAM_WORK_HOME")
	if dir == "" {
		dir = filepath.Join(home, ".team-work")
	}
	if !filepath.IsAbs(dir) {
		return Config{}, fmt.Errorf("TEAM_WORK_HOME must be an absolute path")
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return Config{}, err
	}
	path := filepath.Join(dir, "config.yaml")
	// O_EXCL ensures startup never overwrites the user's configuration.
	f, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err == nil {
		_, err = f.WriteString(defaultConfig)
		closeErr := f.Close()
		if err != nil {
			return Config{}, err
		}
		if closeErr != nil {
			return Config{}, closeErr
		}
	} else if !errors.Is(err, os.ErrExist) {
		return Config{}, err
	}
	info, err := os.Lstat(path)
	if err != nil {
		return Config{}, err
	}
	if !info.Mode().IsRegular() || info.Size() > 1<<20 {
		return Config{}, fmt.Errorf("config.yaml must be a regular file no larger than 1 MB")
	}
	v := viper.New()
	v.SetConfigFile(path)
	v.SetDefault("host", "127.0.0.1")
	v.SetDefault("port", 8787)
	v.SetDefault("allowedOrigins", []string{"http://localhost:5173", "http://127.0.0.1:5173"})
	v.SetDefault("debug", false)
	v.SetDefault("memoryDiagnostics", false)
	if err := v.ReadInConfig(); err != nil {
		return Config{}, err
	}
	// Desktop launch overrides its loopback listener without rewriting global YAML.
	for key, env := range map[string]string{"host": "TEAM_WORK_HOST", "port": "TEAM_WORK_PORT", "allowedOrigins": "TEAM_WORK_ALLOWED_ORIGINS", "debug": "TEAM_WORK_DEBUG", "memoryDiagnostics": "TEAM_WORK_MEMORY_DIAGNOSTICS"} {
		if err := v.BindEnv(key, env); err != nil {
			return Config{}, err
		}
	}
	var c Config
	if err := v.UnmarshalExact(&c); err != nil {
		return Config{}, fmt.Errorf("config.yaml: %w", err)
	}
	c.DataDir = dir
	if !IsLoopback(c.Host) {
		return Config{}, fmt.Errorf("host must be this computer (127.0.0.1, ::1 or localhost)")
	}
	if c.Port < 1 || c.Port > 65535 {
		return Config{}, fmt.Errorf("port must be between 1 and 65535")
	}
	return c, nil
}

func IsLoopback(host string) bool {
	if host == "localhost" {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}
