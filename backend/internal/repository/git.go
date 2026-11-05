package repository

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io/fs"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/yanun0323/Team-Work/internal/model"
)

const (
	remoteTimeout = 2 * time.Minute
	maxReadFile   = 1 << 20
	maxReadImage  = 25 << 20
	// maxWalkedFiles bounds how much of a folder that is not a repo gets walked.
	maxWalkedFiles = 20_000
)

var conflictMarks = regexp.MustCompile(`(?m)^(<<<<<<<|>>>>>>>) `)

// Git runs the git command. Commands on one repo run one at a time, as git locks its own index and refs.
type Git struct {
	cacheDir string
	mu       sync.Mutex
	locks    map[string]*sync.Mutex
}

func NewGit(dataDir string) *Git {
	// cache/sources held a clone checked out in place, before each version had a folder of its own
	return &Git{cacheDir: filepath.Join(dataDir, "cache", "repos"), locks: map[string]*sync.Mutex{}}
}

func (g *Git) lock(key string) func() {
	g.mu.Lock()
	l := g.locks[key]
	if l == nil {
		l = &sync.Mutex{}
		g.locks[key] = l
	}
	g.mu.Unlock()
	l.Lock()
	return l.Unlock
}

func git(ctx context.Context, dir string, args ...string) (string, error) {
	path, err := tool.path(ctx)
	if err != nil {
		return "", err
	}
	cmd := exec.CommandContext(ctx, path, args...)
	cmd.Dir = dir
	// never stop to ask for a password, and only over transports that cannot run commands
	cmd.Env = append(os.Environ(), "GIT_TERMINAL_PROMPT=0", "GIT_ALLOW_PROTOCOL=https:ssh:file")
	var out, errOut bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &errOut
	if err := cmd.Run(); err != nil {
		if ctx.Err() != nil {
			return "", fmt.Errorf("git %s: %w", args[0], ctx.Err())
		}
		return "", fmt.Errorf("git %s: %w: %s", args[0], err, strings.TrimSpace(errOut.String()))
	}
	return strings.TrimSpace(out.String()), nil
}

func identity(author string) []string {
	return []string{"-c", "user.name=" + author, "-c", "user.email=replica@mho-company.local"}
}

func (g *Git) Prepare(ctx context.Context, folder string) ([]string, bool, error) {
	defer g.lock(folder)()
	initialized := false
	if _, err := git(ctx, folder, "rev-parse", "--git-dir"); err != nil {
		if _, err := git(ctx, folder, "init", "--initial-branch=master"); err != nil {
			return nil, false, err
		}
		args := append(identity("Team Work"), "commit", "--allow-empty", "-m", "chore: start repository")
		if _, err := git(ctx, folder, args...); err != nil {
			return nil, false, err
		}
		initialized = true
	}
	branches, err := listBranches(ctx, folder)
	return branches, initialized, err
}

func listBranches(ctx context.Context, folder string) ([]string, error) {
	out, err := git(ctx, folder, "for-each-ref", "--format=%(refname:short)", "refs/heads")
	if err != nil {
		return nil, err
	}
	if out == "" {
		return []string{}, nil
	}
	return strings.Split(out, "\n"), nil
}

func (g *Git) Branches(ctx context.Context, folder string) ([]string, bool, error) {
	// without git no folder can be told to be a repo, and saying it is not one would be wrong
	if _, err := tool.path(ctx); err != nil {
		return []string{}, false, err
	}
	if _, err := git(ctx, folder, "rev-parse", "--git-dir"); err != nil {
		return []string{}, false, nil
	}
	branches, err := listBranches(ctx, folder)
	return branches, err == nil, err
}

func (g *Git) Uncommitted(ctx context.Context, folder string) (bool, error) {
	if _, err := git(ctx, folder, "rev-parse", "--git-dir"); err != nil {
		return false, nil
	}
	out, err := git(ctx, folder, "status", "--porcelain")
	return out != "", err
}

// Tip is the commit branch points at, or HEAD's when branch is "". It is "" when folder is no repo or has no such commit
// yet.
func (g *Git) Tip(ctx context.Context, folder, branch string) (string, error) {
	if _, err := tool.path(ctx); err != nil {
		return "", err
	}
	if _, err := git(ctx, folder, "rev-parse", "--git-dir"); err != nil {
		return "", nil
	}
	ref := "HEAD"
	if branch != "" {
		ref = "refs/heads/" + branch
	}
	sha, err := git(ctx, folder, "rev-parse", "-q", "--verify", "--end-of-options", ref+"^{commit}")
	if err != nil {
		return "", nil
	}
	return sha, nil
}

// TreeBytes adds up the sizes of the files in a commit, as git records them, without reading any file.
func (g *Git) TreeBytes(ctx context.Context, folder, commit string) (int64, error) {
	out, err := git(ctx, folder, "ls-tree", "-r", "-l", "-z", "--end-of-options", commit)
	if err != nil {
		return 0, err
	}
	var total int64
	for entry := range strings.SplitSeq(out, "\x00") {
		// <mode> <type> <object> <size>\t<path>; the size is "-" for a submodule
		meta, _, ok := strings.Cut(entry, "\t")
		if !ok {
			continue
		}
		fields := strings.Fields(meta)
		if len(fields) < 4 {
			continue
		}
		if n, err := strconv.ParseInt(fields[3], 10, 64); err == nil {
			total += n
		}
	}
	return total, nil
}

// Files lists every file under folder for "#" mentions, ignored ones too: someone may well want to point at a .env
// or a build output. Only .git is left out. Nothing else lists files this way, so git's ignore rules hold elsewhere.
func (g *Git) Files(ctx context.Context, folder string) []string {
	if path, err := tool.path(ctx); err == nil {
		if out, err := exec.CommandContext(ctx, path, "-C", folder, "ls-files", "--cached", "--others", "-z").Output(); err == nil {
			return strings.FieldsFunc(string(out), func(r rune) bool { return r == 0 })
		}
	}
	var files []string
	_ = filepath.WalkDir(folder, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if d.IsDir() {
			if d.Name() == ".git" {
				return fs.SkipDir
			}
			return nil
		}
		if rel, err := filepath.Rel(folder, p); err == nil {
			files = append(files, filepath.ToSlash(rel))
		}
		if len(files) >= maxWalkedFiles {
			return fs.SkipAll
		}
		return ctx.Err()
	})
	return files
}

// Ignored says which of paths, relative to folder with "/" separators, git's ignore rules leave out; a folder ends in
// "/" so rules for folders only apply. None are when folder is no repo or git cannot run, except that .git and
// everything in it always is: git's own data is never part of the repo, though check-ignore does not say so.
func (g *Git) Ignored(ctx context.Context, folder string, paths []string) map[string]bool {
	ignored := map[string]bool{}
	for _, p := range paths {
		if slices.Contains(strings.Split(strings.TrimSuffix(p, "/"), "/"), ".git") {
			ignored[p] = true
		}
	}
	path, err := tool.path(ctx)
	if err != nil || len(paths) == 0 {
		return ignored
	}
	cmd := exec.CommandContext(ctx, path, "-C", folder, "check-ignore", "--stdin", "-z")
	cmd.Stdin = strings.NewReader(strings.Join(paths, "\x00") + "\x00")
	// exits 1 when none is ignored, and 128 outside a repo: either way what it printed is the answer
	out, _ := cmd.Output()
	for _, p := range strings.FieldsFunc(string(out), func(r rune) bool { return r == 0 }) {
		ignored[p] = true
	}
	return ignored
}

func (g *Git) Worktree(ctx context.Context, folder, dir, branch, target string) error {
	defer g.lock(folder)()
	if _, err := os.Stat(filepath.Join(dir, ".git")); err == nil {
		return nil
	}
	if err := os.MkdirAll(filepath.Dir(dir), 0o700); err != nil {
		return err
	}
	_, err := git(ctx, folder, "worktree", "add", "-b", branch, dir, target)
	return err
}

// ReadFile takes the file from git's history, not the work tree, so it still reads after a merge removed the tree.
func (g *Git) ReadFile(ctx context.Context, folder, commit, path string) (string, error) {
	object := commit + ":" + path
	size, err := git(ctx, folder, "cat-file", "-s", object)
	if err != nil {
		return "", model.Errorf(model.CodeInvalid, "這次交接的版本裡沒有 %s", path)
	}
	if n, err := strconv.Atoi(size); err != nil || n > maxReadFile {
		return "", model.Errorf(model.CodeInvalid, "%s 太大，請到專案資料夾打開", path)
	}
	text, err := git(ctx, folder, "cat-file", "blob", object)
	if err != nil {
		return "", model.Errorf(model.CodeInvalid, "這次交接的版本裡沒有 %s", path)
	}
	if strings.IndexByte(text, 0) >= 0 || !utf8.ValidString(text) {
		return "", model.Errorf(model.CodeInvalid, "%s 不是文字檔，請到專案資料夾打開", path)
	}
	return text, nil
}

// ReadImage takes a picture from git's history the same way, with its media type; anything else is refused.
func (g *Git) ReadImage(ctx context.Context, folder, commit, path string) ([]byte, string, error) {
	object := commit + ":" + path
	size, err := git(ctx, folder, "cat-file", "-s", object)
	if err != nil {
		return nil, "", model.Errorf(model.CodeInvalid, "這次交接的版本裡沒有 %s", path)
	}
	if n, err := strconv.Atoi(size); err != nil || n > maxReadImage {
		return nil, "", model.Errorf(model.CodeInvalid, "%s 太大，請到專案資料夾打開", path)
	}
	// git() trims its output, which would cut a picture's bytes
	bin, err := tool.path(ctx)
	if err != nil {
		return nil, "", err
	}
	cmd := exec.CommandContext(ctx, bin, "cat-file", "blob", object)
	cmd.Dir = folder
	cmd.Env = append(os.Environ(), "GIT_TERMINAL_PROMPT=0")
	data, err := cmd.Output()
	if err != nil {
		return nil, "", model.Errorf(model.CodeInvalid, "這次交接的版本裡沒有 %s", path)
	}
	switch kind := http.DetectContentType(data); kind {
	case "image/png", "image/jpeg", "image/gif", "image/webp":
		return data, kind, nil
	}
	return nil, "", model.Errorf(model.CodeInvalid, "%s 不是圖片，請到專案資料夾打開", path)
}

func (g *Git) Commit(ctx context.Context, dir, author, message string) (string, error) {
	defer g.lock(dir)()
	if _, err := git(ctx, dir, "add", "-A"); err != nil {
		return "", err
	}
	if _, err := git(ctx, dir, "diff", "--cached", "--quiet"); err != nil {
		args := append(identity(author), "commit", "-m", message)
		if _, err := git(ctx, dir, args...); err != nil {
			return "", err
		}
	}
	return git(ctx, dir, "rev-parse", "--short", "HEAD")
}

func (g *Git) MergeTarget(ctx context.Context, dir, target string) (bool, error) {
	defer g.lock(dir)()
	if _, err := git(ctx, dir, "rev-parse", "-q", "--verify", "MERGE_HEAD"); err == nil {
		return true, nil // an earlier try left it open
	}
	args := append(identity("Team Work"), "merge", "--no-edit", target)
	if _, err := git(ctx, dir, args...); err == nil {
		return false, nil
	} else if unmerged, _ := git(ctx, dir, "diff", "--name-only", "--diff-filter=U"); unmerged == "" {
		return false, err
	}
	return true, nil
}

func (g *Git) FinishMerge(ctx context.Context, dir, author string) error {
	defer g.lock(dir)()
	// git cannot tell: a file stays "unmerged" until added, and adding it marks it resolved whatever is in it
	if _, err := git(ctx, dir, "add", "-A"); err != nil {
		return err
	}
	changed, err := git(ctx, dir, "diff", "--cached", "--name-only", "--diff-filter=d")
	if err != nil {
		return err
	}
	for _, name := range strings.Split(changed, "\n") {
		raw, err := os.ReadFile(filepath.Join(dir, name))
		if name != "" && err == nil && conflictMarks.Match(raw) {
			return model.Errorf(model.CodeConflict, "還有檔案沒解完衝突：%s", name)
		}
	}
	if _, err := git(ctx, dir, "rev-parse", "-q", "--verify", "MERGE_HEAD"); err != nil {
		return nil // whoever resolved it committed it too
	}
	args := append(identity(author), "commit", "--no-edit")
	_, err = git(ctx, dir, args...)
	return err
}

func (g *Git) Land(ctx context.Context, folder, branch, target string) error {
	defer g.lock(folder)()
	current, err := git(ctx, folder, "branch", "--show-current")
	if err != nil {
		return err
	}
	if current == target {
		_, err = git(ctx, folder, "merge", "--ff-only", branch)
		return err
	}
	_, err = git(ctx, folder, "fetch", ".", branch+":"+target)
	return err
}

// Remove takes away a task's work tree, and its branch only when that work tree was made on it: a branch of the same
// name the task never made, as one the user already had, or another company's on the same repo, stays.
func (g *Git) Remove(ctx context.Context, folder, dir, branch string) error {
	defer g.lock(folder)()
	if _, err := os.Stat(dir); err != nil {
		return nil
	}
	current, _ := git(ctx, dir, "branch", "--show-current")
	if _, err := git(ctx, folder, "worktree", "remove", "--force", dir); err != nil {
		return err
	}
	if current != branch {
		return nil
	}
	if _, err := git(ctx, folder, "rev-parse", "-q", "--verify", "refs/heads/"+branch); err != nil {
		return nil
	}
	_, err := git(ctx, folder, "branch", "-D", branch)
	return err
}

func checkRepo(repo string) error {
	if repo == "" || strings.HasPrefix(repo, "-") {
		return model.Errorf(model.CodeInvalid, "Git 位址不正確")
	}
	return nil
}

var fullCommit = regexp.MustCompile(`^[0-9a-f]{40}([0-9a-f]{24})?$`)

// versionDir is where repo at commit, a full commit id, is kept.
func (g *Git) versionDir(repo, commit string) string {
	sum := sha256.Sum256([]byte(repo))
	return filepath.Join(g.cacheDir, hex.EncodeToString(sum[:8]), commit)
}

func (g *Git) Cached(repo, commit string) bool {
	if checkRepo(repo) != nil || !fullCommit.MatchString(commit) {
		return false
	}
	_, err := os.Stat(filepath.Join(g.versionDir(repo, commit), ".git"))
	return err == nil
}

// Fetch gives a folder holding repo at commit, or at its default branch's newest when commit is empty. Each repo is
// cloned once, and each version read gets a folder of its own that never changes afterwards, so work under way keeps
// the version it started with when a newer one is put in place. A version already here is read without the network.
func (g *Git) Fetch(ctx context.Context, repo, commit string) (string, error) {
	if err := checkRepo(repo); err != nil {
		return "", err
	}
	if g.Cached(repo, commit) {
		return g.versionDir(repo, commit), nil
	}
	base := filepath.Dir(g.versionDir(repo, "x"))
	ctx, cancel := context.WithTimeout(ctx, remoteTimeout)
	defer cancel()
	defer g.lock(base)()
	clone := filepath.Join(base, "repo.git")
	if _, err := os.Stat(filepath.Join(clone, "HEAD")); err != nil {
		if err := os.MkdirAll(base, 0o700); err != nil {
			return "", err
		}
		_ = os.RemoveAll(clone) // what a clone cut short left
		if _, err := git(ctx, base, "clone", "--mirror", "--", repo, clone); err != nil {
			return "", err
		}
	} else if _, err := git(ctx, clone, "cat-file", "-e", "--end-of-options", commit+"^{commit}"); commit == "" || err != nil {
		if _, err := git(ctx, clone, "fetch", "--prune", "origin"); err != nil {
			return "", err
		}
	}
	if commit == "" {
		commit = "HEAD"
	}
	sha, err := git(ctx, clone, "rev-parse", "--verify", "--end-of-options", commit+"^{commit}")
	if err != nil {
		return "", model.Errorf(model.CodeNotFound, "找不到版本 %s", commit)
	}
	dir := filepath.Join(base, sha)
	if _, err := os.Stat(filepath.Join(dir, ".git")); err == nil {
		return dir, nil
	}
	_ = os.RemoveAll(dir)
	_, _ = git(ctx, clone, "worktree", "prune")
	if _, err := git(ctx, clone, "worktree", "add", "--detach", dir, sha); err != nil {
		return "", err
	}
	return dir, nil
}

func (g *Git) Latest(ctx context.Context, repo, ref string) (string, error) {
	if err := checkRepo(repo); err != nil {
		return "", err
	}
	ctx, cancel := context.WithTimeout(ctx, remoteTimeout)
	defer cancel()
	if ref == "" {
		ref = "HEAD"
	}
	out, err := git(ctx, "", "ls-remote", "--", repo, ref, ref+"^{}")
	if err != nil {
		return "", err
	}
	// ls-remote matches the pattern against the tail of every ref, so "main" also lists changeset-release/main;
	// take the ref named exactly, a branch before a tag, and a tag's commit rather than the tag itself.
	found := map[string]string{}
	for _, line := range strings.Split(out, "\n") {
		if f := strings.Fields(line); len(f) == 2 {
			found[f[1]] = f[0]
		}
	}
	for _, name := range []string{ref, "refs/heads/" + ref, "refs/tags/" + ref + "^{}", "refs/tags/" + ref} {
		if sha := found[name]; sha != "" {
			return sha, nil
		}
	}
	return "", model.Errorf(model.CodeNotFound, "找不到版本 %s", ref)
}
