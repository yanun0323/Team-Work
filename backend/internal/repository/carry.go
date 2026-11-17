package repository

import (
	"context"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
)

// carryIgnored copies into a task's new tree what git leaves out of the project folder (local settings such as .env,
// build outputs, caches), so the task starts from the folder as the user has it rather than a bare checkout. Where
// the disk can clone, each file shares its blocks with the original until one side changes it, so gigabytes cost
// next to nothing; where it cannot, only single files come, not whole folders.
//
// Left out, as copying them would reach back into the project or go stale:
//   - the app's own files (AppIgnores),
//   - any folder holding a .git: another repo or work tree, which git run in the copy would act on as the original,
//   - Python environments (pyvenv.cfg): their scripts name the folder they were made in, so an install from the task
//     would land in the project,
//   - node_modules beside a tracked lock: PrepareEnvironment brings those, checked against the task's own lock,
//   - links naming a place inside the project by its full path, and sockets and other special files,
//   - anything the task's own rules do not ignore, or that the task already has: it would be committed with the task.
//
// Nothing here fails the tree: whatever cannot be copied is skipped and the task runs without it.
func (g *Git) carryIgnored(ctx context.Context, folder, dir string) {
	listed, err := gitRaw(ctx, folder, "ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z")
	if err != nil || listed == "" {
		return
	}
	tracked, err := gitRaw(ctx, dir, "ls-files", "-z")
	if err != nil {
		return
	}
	c := carrier{folder: folder, dir: dir, skip: map[string]bool{}, mixed: map[string]bool{}}
	if c.folderAbs, err = filepath.Abs(folder); err != nil {
		return
	}
	if c.dirAbs, err = filepath.Abs(dir); err != nil {
		return
	}
	files := strings.FieldsFunc(tracked, func(r rune) bool { return r == 0 })
	for _, path := range files {
		switch filepath.Base(path) {
		case "package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock":
			c.skip[filepath.Join(filepath.Dir(path), "node_modules")] = true
		}
	}

	var entries, asked []string
	for _, entry := range strings.FieldsFunc(listed, func(r rune) bool { return r == 0 }) {
		rel := filepath.FromSlash(strings.TrimSuffix(entry, "/"))
		if rel == "" || appOwned(rel) || c.skip[rel] {
			continue
		}
		if _, err := os.Lstat(filepath.Join(dir, rel)); err == nil {
			continue
		}
		entries = append(entries, rel)
		asked = append(asked, entry)
	}
	if len(entries) == 0 {
		return
	}
	ignored := g.Ignored(ctx, dir, asked)
	c.cow = canClone(ctx, folder, dir, files)
	for i, rel := range entries {
		if ctx.Err() != nil {
			return
		}
		if !ignored[asked[i]] {
			continue
		}
		info, err := os.Lstat(filepath.Join(folder, rel))
		if err != nil {
			continue
		}
		if info.IsDir() && !c.cow {
			continue
		}
		c.survey(ctx, rel)
		c.copy(ctx, rel)
	}
}

type carrier struct {
	folder, dir       string
	folderAbs, dirAbs string
	cow               bool
	// skip is what is never copied; mixed is a folder holding something skipped, made and filled entry by entry.
	skip, mixed map[string]bool
}

// survey walks a folder before it is copied, marking what in it is left out and every folder on the way there.
func (c *carrier) survey(ctx context.Context, top string) {
	_ = filepath.WalkDir(filepath.Join(c.folder, top), func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		rel, err := filepath.Rel(c.folder, path)
		if err != nil {
			return nil
		}
		leave := c.skip[rel]
		switch {
		case leave:
		case d.IsDir():
			abs, _ := filepath.Abs(path)
			leave = abs == c.dirAbs || present(filepath.Join(path, ".git")) || present(filepath.Join(path, "pyvenv.cfg"))
		case d.Type()&fs.ModeSymlink != 0:
			link, err := os.Readlink(path)
			leave = err != nil || (filepath.IsAbs(link) && within(c.folderAbs, link))
		default:
			leave = !d.Type().IsRegular()
		}
		if !leave {
			return nil
		}
		c.skip[rel] = true
		for up := filepath.Dir(rel); up != "." && up != string(filepath.Separator); up = filepath.Dir(up) {
			c.mixed[up] = true
		}
		if d.IsDir() {
			return fs.SkipDir
		}
		return nil
	})
}

func (c *carrier) copy(ctx context.Context, rel string) {
	if c.skip[rel] {
		return
	}
	src, dst := filepath.Join(c.folder, rel), filepath.Join(c.dir, rel)
	if c.mixed[rel] {
		info, err := os.Stat(src)
		if err != nil || os.MkdirAll(dst, info.Mode().Perm()) != nil {
			return
		}
		items, err := os.ReadDir(src)
		if err != nil {
			return
		}
		for _, item := range items {
			c.copy(ctx, filepath.Join(rel, item.Name()))
		}
		return
	}
	if os.MkdirAll(filepath.Dir(dst), 0o755) != nil {
		return
	}
	if environmentCommand(ctx, c.dir, "cp", append(cloneFlags(c.cow), src, dst)...) != nil {
		// half a folder is worse than none: the task would build against pieces
		_ = os.RemoveAll(dst)
	}
}

// canClone tries cloning one of the project's tracked files into the tree's private git directory, which says
// whether the two sit on one disk that can clone.
func canClone(ctx context.Context, folder, dir string, tracked []string) bool {
	gitDir, err := git(ctx, dir, "rev-parse", "--absolute-git-dir")
	if err != nil {
		return false
	}
	for _, path := range tracked {
		src := filepath.Join(folder, path)
		if info, err := os.Lstat(src); err != nil || !info.Mode().IsRegular() {
			continue
		}
		probe, err := os.MkdirTemp(gitDir, "team-work-clone-")
		if err != nil {
			return false
		}
		defer os.RemoveAll(probe)
		return environmentCommand(ctx, dir, "cp", append(cloneFlags(true), src, filepath.Join(probe, "probe"))...) == nil
	}
	return false
}

// cloneFlags keeps links as links and files' times, which builds compare. A clone that cannot be made fails rather
// than quietly writing a full copy.
func cloneFlags(cow bool) []string {
	switch {
	case !cow:
		return []string{"-Rp"}
	case runtime.GOOS == "darwin":
		return []string{"-cRp"}
	default:
		return []string{"-Rp", "--reflink=always"}
	}
}

func appOwned(rel string) bool {
	first := strings.Split(filepath.ToSlash(rel), "/")[0]
	return slices.ContainsFunc(AppIgnores, func(p string) bool {
		ok, _ := filepath.Match(strings.TrimSuffix(p, "/"), first)
		return ok
	})
}

func present(path string) bool { _, err := os.Lstat(path); return err == nil }

func within(root, path string) bool {
	rel, err := filepath.Rel(root, filepath.Clean(path))
	return err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator))
}
