package usecase

import (
	"context"
	"errors"
	"fmt"
	"testing"

	"github.com/yanun0323/Team-Work/internal/model"
)

func TestGithubAddressDefaultsToHTTPS(t *testing.T) {
	t.Parallel()
	for in, want := range map[string]string{
		"mattpocock/skills":                    "https://github.com/mattpocock/skills",
		" acme/release-bot.git ":               "https://github.com/acme/release-bot",
		"git@github.com:mattpocock/skills":     "git@github.com:mattpocock/skills",
		"https://github.com/mattpocock/skills": "https://github.com/mattpocock/skills",
		"https://example.com/x.git":            "https://example.com/x.git",
	} {
		if got := githubAddress(in); got != want {
			t.Errorf("githubAddress(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestSourceProblemSaysWhy(t *testing.T) {
	t.Parallel()
	gitErr := func(stderr string) error {
		return fmt.Errorf("git ls-remote: exit status 128: %s", stderr)
	}
	for name, c := range map[string]struct {
		err  error
		want string
	}{
		"host not trusted": {gitErr("Host key verification failed.\nfatal: Could not read from remote repository."), "這台電腦還不信任這個 SSH 主機：請在終端機連線一次並確認信任，或改用 HTTPS 網址"},
		"key refused":      {gitErr("git@github.com: Permission denied (publickey)."), "SSH 金鑰沒有讀取權限：請確認金鑰已加到 GitHub，或改用 HTTPS 網址"},
		"no network":       {gitErr("fatal: unable to access 'https://github.com/a/b/': Could not resolve host: github.com"), "連不上主機，請檢查網路"},
		"no repo":          {gitErr("remote: Repository not found.\nfatal: repository 'https://github.com/a/b/' not found"), "找不到這個 repo，或它是私人 repo 而這台電腦沒有讀取權限"},
		"private over web": {gitErr("fatal: could not read Username for 'https://github.com': terminal prompts disabled"), "找不到這個 repo，或它是私人 repo 而這台電腦沒有讀取權限"},
		"timeout":          {fmt.Errorf("git ls-remote: %w", context.DeadlineExceeded), "連線逾時，請稍後再試"},
		"no such version":  {model.Errorf(model.CodeNotFound, "找不到版本 %s", "main"), "找不到版本 main"},
		"anything else":    {errors.New("boom"), "找不到上游，或沒有讀取權限"},
	} {
		if got := sourceProblem(c.err); got != c.want {
			t.Errorf("%s: got %q, want %q", name, got, c.want)
		}
	}
}
