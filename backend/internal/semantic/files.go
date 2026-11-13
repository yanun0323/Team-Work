package semantic

import (
	"bytes"
	"context"
	"errors"
	"io/fs"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"strings"
	"unicode/utf8"
)

// maxFileBytes is the largest file indexed or searched.
const maxFileBytes = 1 << 20

// skipDirs are dependency, build output and private settings folders, wherever they are in the tree.
var skipDirs = map[string]bool{
	".git": true, "node_modules": true, "vendor": true, "dist": true, "build": true, ".cache": true, ".next": true,
	"coverage": true, ".venv": true, "venv": true, "Pods": true, "DerivedData": true, "__pycache__": true, "target": true,
}

var secretDirs = map[string]bool{".aws": true, ".ssh": true, ".gnupg": true, ".kube": true, ".docker": true, ".secrets": true}

// secretStems are settings files named for what they hold, in a settings format rather than code.
var secretStems = map[string]bool{"secret": true, "secrets": true, "credential": true, "credentials": true}
var settingsExts = map[string]bool{"": true, ".json": true, ".yaml": true, ".yml": true, ".toml": true, ".txt": true, ".ini": true, ".conf": true, ".cfg": true, ".xml": true, ".plist": true, ".properties": true}

var lockFiles = map[string]bool{
	"package-lock.json": true, "npm-shrinkwrap.json": true, "pnpm-lock.yaml": true, "yarn.lock": true, "bun.lock": true,
	"bun.lockb": true, "Cargo.lock": true, "go.sum": true, "Gemfile.lock": true, "poetry.lock": true, "uv.lock": true,
	"Pipfile.lock": true, "Package.resolved": true, "composer.lock": true, "mix.lock": true, "flake.lock": true, "Podfile.lock": true,
}

var secretNames = map[string]bool{
	".envrc": true, "id_rsa": true, "id_dsa": true, "id_ecdsa": true, "id_ed25519": true, ".netrc": true, ".npmrc": true,
	".pypirc": true, "credentials": true, "credentials.json": true, "secrets.json": true, "secrets.yaml": true,
	"secrets.yml": true, "secrets.toml": true, ".htpasswd": true, "service-account.json": true,
}

var secretExts = map[string]bool{".key": true, ".pem": true, ".p12": true, ".pfx": true, ".keystore": true, ".jks": true, ".p8": true, ".mobileprovision": true, ".cer": true, ".crt": true}

// notes are the agent instructions read even when Git ignores them.
var notes = map[string]bool{"AGENTS.md": true, "CONTEXT.md": true}

// excluded says why a path relative to the root is never indexed, or "" when it may be.
func excluded(rel string) string {
	parts := strings.Split(rel, "/")
	for _, p := range parts[:len(parts)-1] {
		if secretDirs[p] {
			return "secret"
		}
		if skipDirs[p] {
			return "dependency_or_output"
		}
	}
	name := parts[len(parts)-1]
	lower := strings.ToLower(name)
	switch {
	case lockFiles[name]:
		return "lockfile"
	case name == ".env" || strings.HasPrefix(name, ".env."):
		return "secret"
	case secretNames[lower] || secretExts[strings.ToLower(path.Ext(name))]:
		return "secret"
	case secretStems[strings.TrimSuffix(lower, path.Ext(lower))] && settingsExts[path.Ext(lower)]:
		return "secret"
	}
	return ""
}

// listing is what a root holds that may be searched, and how many files were left out for each reason.
type listing struct {
	files    []string
	excluded map[string]int
}

// list asks Git which files belong to root: tracked and untracked, without what .gitignore leaves out; then adds
// ignored AGENTS.md and CONTEXT.md. Symlinks and anything outside the root are left out.
func list(ctx context.Context, root string) (listing, error) {
	out := listing{excluded: map[string]int{}}
	cmd := exec.CommandContext(ctx, "git", "-C", root, "ls-files", "-co", "--exclude-standard", "-z")
	raw, err := cmd.Output()
	if err != nil {
		return out, errNotGit
	}
	seen := map[string]bool{}
	add := func(rel string) {
		if rel == "" || seen[rel] {
			return
		}
		seen[rel] = true
		if why := excluded(rel); why != "" {
			out.excluded[why]++
			return
		}
		info, err := os.Lstat(filepath.Join(root, filepath.FromSlash(rel)))
		switch {
		case err != nil:
			out.excluded["missing"]++
		case info.Mode()&fs.ModeSymlink != 0:
			out.excluded["symlink"]++
		case !info.Mode().IsRegular():
			out.excluded["not_regular"]++
		case info.Size() > maxFileBytes:
			out.excluded["too_large"]++
		default:
			out.files = append(out.files, rel)
		}
	}
	for _, rel := range bytes.Split(raw, []byte{0}) {
		add(string(rel))
	}
	ignored := exec.CommandContext(ctx, "git", "-C", root, "ls-files", "-o", "-i", "--exclude-standard", "-z", "--", "AGENTS.md", "CONTEXT.md", "**/AGENTS.md", "**/CONTEXT.md")
	if raw, err := ignored.Output(); err == nil {
		for _, rel := range bytes.Split(raw, []byte{0}) {
			if notes[path.Base(string(rel))] {
				add(string(rel))
			}
		}
	}
	return out, nil
}

var errNotGit = errors.New("not a Git work tree")

// readText reads a file that is plain UTF-8 text, or says why it is not one.
func readText(root, rel string) ([]byte, string) {
	full := filepath.Join(root, filepath.FromSlash(rel))
	info, err := os.Lstat(full)
	if err != nil {
		return nil, "missing"
	}
	if !info.Mode().IsRegular() {
		return nil, "not_regular"
	}
	if info.Size() > maxFileBytes {
		return nil, "too_large"
	}
	data, err := os.ReadFile(full)
	if err != nil {
		return nil, "unreadable"
	}
	if len(data) > maxFileBytes {
		return nil, "too_large"
	}
	if bytes.IndexByte(data, 0) >= 0 || !utf8.Valid(data) {
		return nil, "binary"
	}
	return data, ""
}
