package repository

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"runtime"
	"slices"
	"strings"
	"syscall"
	"time"

	"github.com/yanun0323/Team-Work/internal/i18n"
	"github.com/yanun0323/Team-Work/internal/model"
)

// PrepareEnvironment runs before a task's employees, never in the company's folder.
// The worktree's private git directory keeps fingerprints across steps and app restarts.
func (g *Git) PrepareEnvironment(ctx context.Context, source, dir string, report func(string)) error {
	defer g.lock(dir)()
	ctx, cancel := context.WithTimeout(ctx, 10*time.Minute)
	defer cancel()
	files, err := gitRaw(ctx, dir, "ls-files", "-z")
	if err != nil {
		return err
	}
	tracked := strings.Split(strings.TrimSuffix(files, "\x00"), "\x00")
	roots := map[string][]string{}
	for _, path := range tracked {
		switch filepath.Base(path) {
		case "package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock":
			roots[filepath.Dir(path)] = append(roots[filepath.Dir(path)], filepath.Base(path))
		}
	}
	ordered := make([]string, 0, len(roots))
	for root := range roots {
		ordered = append(ordered, root)
	}
	slices.Sort(ordered)
	for _, root := range ordered {
		if err := ctx.Err(); err != nil {
			return err
		}
		if err := g.preparePackages(ctx, source, dir, root, roots[root], tracked, report); err != nil {
			return err
		}
	}
	return nil
}

func (g *Git) preparePackages(ctx context.Context, source, dir, root string, locks, tracked []string, report func(string)) error {
	cwd := filepath.Join(dir, root)
	// A tracked lock without a manifest is not an installable project (for example a fixture).
	if _, err := os.Stat(filepath.Join(cwd, "package.json")); os.IsNotExist(err) {
		return nil
	}
	if !insideDirectory(dir, cwd) {
		return model.Errorf(model.CodeInvalid, "套件路徑超出任務資料夾：%s", root)
	}
	manager, lock, args, err := packageCommand(cwd, locks)
	if err != nil {
		return err
	}
	paths := []string{"package.json", lock, ".npmrc", ".yarnrc", ".yarnrc.yml", "pnpm-workspace.yaml", "pnpmfile.cjs", ".pnpmfile.cjs"}
	// Workspace manifests and checked-in package-manager settings affect installation too.
	for _, path := range tracked {
		rel, err := filepath.Rel(root, path)
		if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
			continue
		}
		if filepath.Base(rel) == "package.json" || strings.HasPrefix(filepath.ToSlash(rel), ".yarn/") || strings.HasPrefix(filepath.ToSlash(rel), "patches/") {
			paths = append(paths, rel)
		}
	}
	slices.Sort(paths)
	paths = slices.Compact(paths)
	fingerprint, err := packageFingerprint(cwd, paths)
	if err != nil {
		return err
	}
	// Refuse to let an install overwrite tracked dependencies or create committable packages.
	generated := []string{filepath.ToSlash(filepath.Join(root, "node_modules")) + "/"}
	for _, path := range paths {
		if filepath.Base(path) == "package.json" {
			generated = append(generated, filepath.ToSlash(filepath.Join(root, filepath.Dir(path), "node_modules"))+"/")
		}
	}
	if manager == "yarn" && slices.Contains(args, "--immutable") {
		generated = append(generated, filepath.ToSlash(filepath.Join(root, ".pnp.cjs")), filepath.ToSlash(filepath.Join(root, ".pnp.loader.mjs")), filepath.ToSlash(filepath.Join(root, ".yarn/install-state.gz")))
	}
	ignored := g.Ignored(ctx, dir, generated)
	for _, path := range generated {
		if !ignored[path] {
			return model.Errorf(model.CodeInvalid, "套件產物未被 Git 忽略，已停止準備：%s", path)
		}
		for _, file := range tracked {
			if file == strings.TrimSuffix(path, "/") || strings.HasPrefix(file, strings.TrimSuffix(path, "/")+"/") {
				return model.Errorf(model.CodeInvalid, "套件產物未被 Git 忽略，已停止準備：%s", file)
			}
		}
	}
	modules := filepath.Join(cwd, "node_modules")
	if info, err := os.Lstat(modules); err == nil && (!info.IsDir() || info.Mode()&os.ModeSymlink != 0) {
		return model.Errorf(model.CodeInvalid, "套件路徑超出任務資料夾：%s", filepath.Join(root, "node_modules"))
	}
	gitDir, err := git(ctx, dir, "rev-parse", "--absolute-git-dir")
	if err != nil {
		return err
	}
	key := sha256.Sum256([]byte(root))
	stamp := filepath.Join(gitDir, "team-work-env-"+hex.EncodeToString(key[:8]))
	prior, _ := os.ReadFile(stamp)
	ready := directoryExists(modules)
	if manager == "yarn" {
		_, err := os.Stat(filepath.Join(cwd, ".pnp.cjs"))
		ready = ready || err == nil
	}
	if string(prior) == fingerprint && ready {
		return nil
	}
	report(i18n.T("準備環境中：%s（%s）", root, manager))
	// Invalidate before attempting anything: a cancelled/failed install is never ready.
	if err := os.Remove(stamp); err != nil && !os.IsNotExist(err) {
		return err
	}
	copied := false
	src := filepath.Join(source, root)
	if manager == "npm" && !directoryExists(modules) {
		if same, err := packageFingerprint(src, paths); err == nil && same == fingerprint && copyableNPM(ctx, src, lock) {
			copied = g.copyPackages(ctx, dir, src, cwd, root)
		}
	}
	if !copied {
		if err := environmentCommand(ctx, cwd, manager, args...); err != nil {
			// Do not echo package-manager output: registry URLs and install scripts may print credentials.
			return model.Errorf(model.CodeUnavailable, "環境準備失敗：%s；請確認 %s 可執行、網路及套件設定，再重試（%s）", root, manager, err.Error())
		}
	}
	after, err := packageFingerprint(cwd, paths)
	if err != nil {
		return err
	}
	if after != fingerprint {
		return model.Errorf(model.CodeInvalid, "準備期間套件設定已變更，請重試：%s", root)
	}
	if err := os.WriteFile(stamp, []byte(fingerprint), 0o600); err != nil {
		return err
	}
	report(i18n.T("環境已就緒：%s", root))
	return nil
}

func packageCommand(cwd string, locks []string) (string, string, []string, error) {
	var manifest struct {
		PackageManager string `json:"packageManager"`
	}
	raw, err := os.ReadFile(filepath.Join(cwd, "package.json"))
	if err != nil {
		return "", "", nil, err
	}
	if err := json.Unmarshal(raw, &manifest); err != nil {
		return "", "", nil, model.Errorf(model.CodeInvalid, "無法判讀套件設定：%s", filepath.Join(cwd, "package.json"))
	}
	// npm-shrinkwrap takes precedence over package-lock, just as npm does.
	if slices.Contains(locks, "npm-shrinkwrap.json") {
		locks = slices.DeleteFunc(slices.Clone(locks), func(s string) bool { return s == "package-lock.json" })
	}
	if len(locks) != 1 {
		return "", "", nil, model.Errorf(model.CodeInvalid, "套件鎖定檔不明確，請只保留使用中的套件管理器：%s", cwd)
	}
	lock := locks[0]
	manager, args := "npm", []string{"ci", "--no-audit", "--no-fund"}
	switch lock {
	case "pnpm-lock.yaml":
		manager, args = "pnpm", []string{"install", "--frozen-lockfile"}
	case "yarn.lock":
		manager, args = "yarn", []string{"install", "--frozen-lockfile", "--non-interactive"}
		if _, err := os.Stat(filepath.Join(cwd, ".yarnrc.yml")); err == nil || (strings.HasPrefix(manifest.PackageManager, "yarn@") && !strings.HasPrefix(manifest.PackageManager, "yarn@1.")) {
			args = []string{"install", "--immutable"}
		}
	}
	if manifest.PackageManager != "" && !strings.HasPrefix(manifest.PackageManager, manager+"@") {
		return "", "", nil, model.Errorf(model.CodeInvalid, "套件鎖定檔不明確，請只保留使用中的套件管理器：%s", cwd)
	}
	return manager, lock, args, nil
}

func insideDirectory(root, path string) bool {
	resolved, err := filepath.EvalSymlinks(path)
	if err != nil {
		return false
	}
	base, err := filepath.EvalSymlinks(root)
	if err != nil {
		return false
	}
	rel, err := filepath.Rel(base, resolved)
	return err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator))
}

func directoryExists(path string) bool { info, err := os.Stat(path); return err == nil && info.IsDir() }

func packageFingerprint(cwd string, paths []string) (string, error) {
	h := sha256.New()
	for _, path := range paths {
		full := filepath.Join(cwd, path)
		raw, err := os.ReadFile(full)
		if os.IsNotExist(err) {
			fmt.Fprintf(h, "%s\x00missing\x00", path)
			continue
		}
		if err != nil {
			return "", err
		}
		if !insideDirectory(cwd, full) {
			return "", model.Errorf(model.CodeInvalid, "套件路徑超出任務資料夾：%s", path)
		}
		fmt.Fprintf(h, "%s\x00%d\x00", path, len(raw))
		h.Write(raw)
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

// npm's hidden lock identifies what was actually installed, not only what was requested.
// pnpm/Yarn layouts and workspace/file links are rebuilt rather than transplanted.
func copyableNPM(ctx context.Context, cwd, lock string) bool {
	read := func(path string) map[string]json.RawMessage {
		var v struct {
			Packages map[string]json.RawMessage `json:"packages"`
		}
		raw, err := os.ReadFile(path)
		if err != nil || json.Unmarshal(raw, &v) != nil {
			return nil
		}
		return v.Packages
	}
	wanted := read(filepath.Join(cwd, lock))
	actual := read(filepath.Join(cwd, "node_modules", ".package-lock.json"))
	if wanted == nil || actual == nil {
		return false
	}
	delete(wanted, "")
	for name := range actual {
		if _, ok := wanted[name]; !ok {
			return false
		}
	}
	for name, raw := range wanted {
		var item struct {
			Link     bool     `json:"link"`
			Resolved string   `json:"resolved"`
			Optional bool     `json:"optional"`
			OS       []string `json:"os"`
			CPU      []string `json:"cpu"`
		}
		if json.Unmarshal(raw, &item) != nil || item.Link || strings.HasPrefix(item.Resolved, "file:") {
			return false
		}
		cpu := runtime.GOARCH
		if cpu == "amd64" {
			cpu = "x64"
		}
		if cpu == "386" {
			cpu = "ia32"
		}
		// Locks include optional native packages for other platforms; their absence is expected.
		if _, ok := actual[name]; !ok && item.Optional && (!packagePlatform(item.OS, runtime.GOOS) || !packagePlatform(item.CPU, cpu)) {
			continue
		}
		var a, b any
		if json.Unmarshal(raw, &a) != nil || json.Unmarshal(actual[name], &b) != nil || !reflect.DeepEqual(a, b) {
			return false
		}
		if !directoryExists(filepath.Join(cwd, name)) {
			return false
		}
	}
	modules := filepath.Join(cwd, "node_modules")
	if info, err := os.Lstat(modules); err != nil || !info.IsDir() {
		return false
	}
	return filepath.WalkDir(modules, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		if d.Type()&os.ModeSymlink != 0 {
			link, err := os.Readlink(path)
			if err != nil {
				return err
			}
			if filepath.IsAbs(link) || !insideDirectory(modules, path) {
				return fmt.Errorf("external package link")
			}
		} else if !d.IsDir() && !d.Type().IsRegular() {
			return fmt.Errorf("special package file")
		}
		return nil
	}) == nil
}

func packagePlatform(values []string, platform string) bool {
	if slices.Contains(values, "!"+platform) {
		return false
	}
	positive := false
	for _, value := range values {
		if !strings.HasPrefix(value, "!") {
			positive = true
		}
	}
	return !positive || slices.Contains(values, platform) || slices.Contains(values, "any")
}

// Stage a copy before renaming it: a failed clone never leaves half a node_modules.
func (g *Git) copyPackages(ctx context.Context, dir, src, cwd, root string) bool {
	gitDir, err := git(ctx, dir, "rev-parse", "--absolute-git-dir")
	if err != nil {
		return false
	}
	// Keep partial copies out of git add -A while parallel task steps are running.
	stage, err := os.MkdirTemp(gitDir, "team-work-packages-")
	if err != nil {
		return false
	}
	defer os.RemoveAll(stage)
	dest := filepath.Join(stage, "node_modules")
	from := filepath.Join(src, "node_modules")
	if runtime.GOOS != "darwin" || environmentCommand(ctx, cwd, "cp", "-cR", from, dest) != nil {
		if ctx.Err() != nil {
			return false
		}
		if err := os.RemoveAll(dest); err != nil {
			return false
		}
		if environmentCommand(ctx, cwd, "cp", "-R", from, dest) != nil {
			return false
		}
	}
	// Recheck the actual copied paths against the task's rules, including negations.
	var paths []string
	err = filepath.WalkDir(dest, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		if !d.IsDir() {
			rel, _ := filepath.Rel(dest, path)
			paths = append(paths, filepath.ToSlash(filepath.Join(root, "node_modules", rel)))
		}
		return nil
	})
	if err != nil {
		return false
	}
	ignored := g.Ignored(ctx, dir, paths)
	for _, path := range paths {
		if !ignored[path] {
			return false
		}
	}
	return os.Rename(dest, filepath.Join(cwd, "node_modules")) == nil
}

// Stop the whole installer process group when a task pauses, cancels or times out.
func environmentCommand(ctx context.Context, cwd, name string, args ...string) error {
	cmd := exec.CommandContext(ctx, name, args...)
	cmd.Dir = cwd
	cmd.Env = append(os.Environ(), "CI=1", "npm_config_update_notifier=false", "COREPACK_ENABLE_DOWNLOAD_PROMPT=0")
	cmd.Stdin = bytes.NewReader(nil)
	cmd.Stdout, cmd.Stderr = io.Discard, io.Discard
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Cancel = func() error { return syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL) }
	cmd.WaitDelay = 300 * time.Millisecond
	err := cmd.Run()
	if ctx.Err() != nil {
		return ctx.Err()
	}
	return err
}
