package usecase

import (
	"context"
	"fmt"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"slices"
	"strings"

	"github.com/yanun0323/Team-Work/internal/model"
)

const mentionLimit = 50

const mentionRule = "A word like #path or #\"path with spaces\" in what the user writes names a file or folder in the project; older messages wrote @path for the same."

// SkillInfo is a skill an employee can be asked to use with "$name".
type SkillInfo struct {
	Name        string `json:"name"`
	Description string `json:"description"`
}

// FileInfo is a file or folder that "#" can name, relative to the company's folder.
type FileInfo struct {
	Path string `json:"path"`
	Dir  bool   `json:"dir"`
}

// ReplicaSkills lists the skills of an employee: their company's own, then their blueprint's.
func (e *Engine) ReplicaSkills(ctx context.Context, id string) ([]SkillInfo, error) {
	e.mu.Lock()
	r := e.w.Replicas[id]
	var packs []packRoot
	if r != nil {
		if team := e.w.Teams[r.TeamID]; team != nil {
			packs = projectPacks(team.Folder, e.w.Preferences)
		}
		if bp := e.w.Blueprints[r.BlueprintID]; bp != nil {
			packs = append(packs, packsOf(bp)...)
		}
	}
	e.mu.Unlock()
	if r == nil {
		return nil, model.Errorf(model.CodeNotFound, "找不到員工")
	}
	return e.skillInfos(ctx, packs), nil
}

// AirportSkills lists the skills of the airport staff's blueprint.
func (e *Engine) AirportSkills(ctx context.Context) []SkillInfo {
	e.mu.Lock()
	var packs []packRoot
	if bp := e.w.Blueprints[airportBlueprintID]; bp != nil {
		packs = packsOf(bp)
	}
	e.mu.Unlock()
	return e.skillInfos(ctx, packs)
}

func (e *Engine) skillInfos(ctx context.Context, packs []packRoot) []SkillInfo {
	found, _, _ := e.loadSkills(ctx, packs) // reading them can take a while: not under the lock
	out := make([]SkillInfo, len(found))
	for i, s := range found {
		out[i] = SkillInfo{Name: s.name, Description: s.description}
	}
	return out
}

// BlueprintSkills names the skills each of a blueprint's packs brings, in the order of its packs; a pack that
// cannot be read is null.
func (e *Engine) BlueprintSkills(ctx context.Context, id string) ([][]string, error) {
	e.mu.Lock()
	var packs []packRoot
	bp := e.w.Blueprints[id]
	if bp != nil {
		packs = packsOf(bp)
	}
	e.mu.Unlock()
	if bp == nil {
		return nil, model.Errorf(model.CodeNotFound, "找不到藍圖")
	}
	out := make([][]string, len(packs))
	for i, p := range packs {
		found, _, problems := e.loadSkills(ctx, []packRoot{p}) // reading them can take a while: not under the lock
		if len(problems) > 0 {
			continue
		}
		out[i] = []string{}
		for _, s := range found {
			out[i] = append(out[i], s.name)
		}
	}
	return out, nil
}

// SearchFiles lists what "#" should offer from a company's folder, or from home with no company, as at the airport.
func (e *Engine) SearchFiles(ctx context.Context, teamID, query string) ([]FileInfo, error) {
	if teamID == "" {
		return e.airportFiles(query)
	}
	e.mu.Lock()
	team := e.w.Teams[teamID]
	folder := ""
	if team != nil {
		folder = team.Folder
	}
	e.mu.Unlock()
	if team == nil {
		return nil, model.Errorf(model.CodeNotFound, "找不到公司")
	}
	if folder == "" {
		return []FileInfo{}, nil
	}
	return searchFiles(e.git.Files(ctx, folder), query, mentionLimit), nil
}

// airportFiles lists what "#" offers in an airport chat: one folder of the user's home folder at a time. "dir/pre"
// lists inside dir what starts with pre, folders first; hidden ones only when pre starts with a dot. Only that one
// folder is read, so nothing else under home is touched.
func (e *Engine) airportFiles(query string) ([]FileInfo, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return nil, err
	}
	return listFolder(home, query, mentionLimit), nil
}

func listFolder(root, query string, limit int) []FileInfo {
	query = strings.TrimPrefix(query, "./")
	dir, prefix := "", query
	if i := strings.LastIndex(query, "/"); i >= 0 {
		dir, prefix = path.Clean(query[:i]), query[i+1:]
	}
	if dir == "." {
		dir = ""
	}
	if path.IsAbs(dir) || dir == ".." || strings.HasPrefix(dir, "../") {
		return []FileInfo{}
	}
	entries, err := os.ReadDir(filepath.Join(root, filepath.FromSlash(dir)))
	if err != nil {
		return []FileInfo{}
	}
	found := []FileInfo{}
	for _, entry := range entries {
		name := entry.Name()
		if strings.ContainsAny(name, "\r\n") || (strings.HasPrefix(name, ".") && !strings.HasPrefix(prefix, ".")) ||
			!strings.HasPrefix(strings.ToLower(name), strings.ToLower(prefix)) {
			continue
		}
		isDir := entry.IsDir()
		if entry.Type()&fs.ModeSymlink != 0 { // a link to a folder is browsed as one
			info, err := os.Stat(filepath.Join(root, filepath.FromSlash(dir), name))
			isDir = err == nil && info.IsDir()
		}
		found = append(found, FileInfo{Path: path.Join(dir, name), Dir: isDir})
	}
	slices.SortStableFunc(found, func(a, b FileInfo) int {
		if a.Dir != b.Dir {
			if a.Dir {
				return -1
			}
			return 1
		}
		return strings.Compare(strings.ToLower(a.Path), strings.ToLower(b.Path))
	})
	return found[:min(limit, len(found))]
}

type scoredFile struct {
	FileInfo
	score int
}

// searchFiles picks from the files under a folder. An empty query lists the top level and "dir/" or "dir/pre" lists
// inside dir; anything else is searched for anywhere, by name first and then loosely along the whole path.
func searchFiles(files []string, query string, limit int) []FileInfo {
	query = strings.TrimPrefix(query, "./")
	// folders are not listed by git: they are every leading part of a file's path
	seen := map[string]bool{}
	var entries []FileInfo
	for _, f := range files {
		if strings.ContainsAny(f, "\r\n") { // a mention is one line
			continue
		}
		entries = append(entries, FileInfo{Path: f})
		for dir := path.Dir(f); dir != "." && !seen[dir]; dir = path.Dir(dir) {
			seen[dir] = true
			entries = append(entries, FileInfo{Path: dir, Dir: true})
		}
	}

	var found []scoredFile
	listing := false
	if i := strings.LastIndex(query, "/"); i >= 0 || query == "" || strings.HasPrefix(query, ".") {
		dir, prefix := ".", query
		if i >= 0 {
			dir, prefix = path.Clean(query[:i]), query[i+1:]
		}
		for _, entry := range entries {
			name := path.Base(entry.Path)
			hidden := strings.HasPrefix(name, ".") && !strings.HasPrefix(prefix, ".")
			if path.Dir(entry.Path) == dir && !hidden && strings.HasPrefix(strings.ToLower(name), strings.ToLower(prefix)) {
				found = append(found, scoredFile{entry, 0})
			}
		}
		listing = len(found) > 0
	}
	// a query with a slash that names no folder is still worth a search: "tui/app" finds internal/tui/app.go
	if len(found) == 0 && query != "" {
		for _, entry := range entries {
			if score, ok := scoreFile(query, entry.Path); ok {
				found = append(found, scoredFile{entry, score})
			}
		}
	}
	slices.SortStableFunc(found, func(a, b scoredFile) int {
		switch {
		case a.score != b.score:
			return a.score - b.score
		case a.Dir != b.Dir: // folders first among equals
			if a.Dir {
				return -1
			}
			return 1
		case listing:
			return strings.Compare(strings.ToLower(a.Path), strings.ToLower(b.Path))
		case len(a.Path) != len(b.Path):
			return len(a.Path) - len(b.Path)
		}
		return strings.Compare(a.Path, b.Path)
	})
	out := make([]FileInfo, 0, min(limit, len(found)))
	for _, f := range found[:min(limit, len(found))] {
		out = append(out, f.FileInfo)
	}
	return out
}

// scoreFile ranks a match, lower being better: the name starts with the query, the name contains it, the path
// contains it, and last the query's letters appear in order along the path.
func scoreFile(query, rel string) (int, bool) {
	q, p := strings.ToLower(query), strings.ToLower(rel)
	name := path.Base(p)
	switch {
	case strings.HasPrefix(name, q):
		return 0, true
	case strings.Contains(name, q):
		return 1, true
	case strings.Contains(p, q):
		return 2, true
	}
	rest := []rune(q)
	for _, r := range p {
		if len(rest) > 0 && rest[0] == r {
			rest = rest[1:]
		}
	}
	return 3, len(rest) == 0
}

// mentionedSkills finds the skills the user's words name with "$name" and returns their instructions, so the employee
// has them without having to read the files. A skill the employee does not have is left out.
func mentionedSkills(text string, skills []skill) []string {
	var out []string
	seen := map[string]bool{}
	for _, word := range strings.Fields(text) {
		name, ok := strings.CutPrefix(word, "$")
		if !ok {
			continue
		}
		name = strings.TrimRight(name, ".,;:!?)，。；：！？）")
		at := slices.IndexFunc(skills, func(s skill) bool { return s.name == name })
		if at < 0 || seen[name] {
			continue
		}
		raw, err := os.ReadFile(skills[at].path)
		if err != nil {
			continue
		}
		seen[name] = true
		out = append(out, fmt.Sprintf("The user asked you to use the skill %q. Follow its instructions.\nSkill file: %s\n<skill>\n%s\n</skill>", name, skills[at].path, strings.TrimSpace(string(raw))))
	}
	return out
}
