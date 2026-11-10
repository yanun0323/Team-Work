package delivery

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"

	"github.com/yanun0323/Team-Work/internal/adapter"
)

// officialRepo is where the official source lives; a test reads the copy in usecase/testdata/official in its place.
const officialRepo = "https://github.com/yanun0323/Team-Work-Source"

// offline is git as a test has it: the official source is the usecase tests' copy, at the version written there,
// and no other repo on GitHub can be reached. Repos in folders, and everything else, are the wrapped git's own.
// Without it, hiring pins the official sources and a test waits on GitHub for minutes.
type offline struct{ adapter.Git }

func officialCopy() (dir, commit string) {
	dir, _ = filepath.Abs(filepath.Join("..", "usecase", "testdata", "official"))
	raw, _ := os.ReadFile(filepath.Join(dir, "commit"))
	return dir, strings.TrimSpace(string(raw))
}

var errNoNetwork = errors.New("no network in tests")

func (g offline) Latest(ctx context.Context, repo, ref string) (string, error) {
	if repo == officialRepo {
		_, commit := officialCopy()
		return commit, nil
	}
	if strings.HasPrefix(repo, "https://github.com/") {
		return "", errNoNetwork
	}
	return g.Git.Latest(ctx, repo, ref)
}

func (g offline) Fetch(ctx context.Context, repo, commit string) (string, error) {
	if repo == officialRepo {
		dir, _ := officialCopy()
		return dir, nil
	}
	if strings.HasPrefix(repo, "https://github.com/") {
		return "", errNoNetwork
	}
	return g.Git.Fetch(ctx, repo, commit)
}

func (g offline) Cached(repo, commit string) bool {
	if repo == officialRepo {
		_, at := officialCopy()
		return commit == at
	}
	return g.Git.Cached(repo, commit)
}
