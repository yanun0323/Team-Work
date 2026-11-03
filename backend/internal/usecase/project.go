package usecase

import (
	"context"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"unicode/utf8"

	"github.com/yanun0323/Team-Work/internal/model"
)

const (
	// maxProjectText and maxProjectImage are the most of a file in a company's folder the app reads to show.
	maxProjectText  = 1 << 20
	maxProjectImage = 25 << 20
)

// projectPath is where a path a message mentions is in its company's folder, as it is now on disk. A path that leads
// out of the folder, by "..", by being absolute or through a link, is refused.
func (e *Engine) projectPath(teamID, rel string) (string, error) {
	rel = strings.TrimSpace(rel)
	clean := filepath.ToSlash(filepath.Clean(rel))
	if rel == "" || filepath.IsAbs(rel) || clean == ".." || strings.HasPrefix(clean, "../") {
		return "", model.Errorf(model.CodeInvalid, "檔案路徑不正確：%s", rel)
	}
	e.mu.Lock()
	t := e.w.Teams[teamID]
	folder := ""
	if t != nil {
		folder = t.Folder
	}
	e.mu.Unlock()
	if t == nil {
		return "", model.Errorf(model.CodeNotFound, "找不到公司")
	}
	root, err := filepath.EvalSymlinks(folder)
	if err != nil {
		return "", model.Errorf(model.CodeInvalid, "找不到專案資料夾 %s", folder)
	}
	at, err := filepath.EvalSymlinks(filepath.Join(root, filepath.FromSlash(clean)))
	if err != nil {
		return "", model.Errorf(model.CodeNotFound, "專案資料夾裡沒有 %s", rel)
	}
	if inside, err := filepath.Rel(root, at); err != nil || inside == ".." || strings.HasPrefix(inside, ".."+string(filepath.Separator)) {
		return "", model.Errorf(model.CodeInvalid, "檔案路徑不正確：%s", rel)
	}
	return at, nil
}

// ProjectFile is a text file in a company's folder as it is now, for a "#" mention to show.
func (e *Engine) ProjectFile(teamID, rel string) (string, error) {
	at, err := e.projectPath(teamID, rel)
	if err != nil {
		return "", err
	}
	info, err := os.Stat(at)
	if err != nil || info.IsDir() {
		return "", model.Errorf(model.CodeNotFound, "專案資料夾裡沒有 %s", rel)
	}
	if info.Size() > maxProjectText {
		return "", model.Errorf(model.CodeInvalid, "%s 太大，請到專案資料夾打開", rel)
	}
	raw, err := os.ReadFile(at)
	if err != nil {
		return "", model.Errorf(model.CodeNotFound, "專案資料夾裡沒有 %s", rel)
	}
	if slices.Contains(raw, 0) || !utf8.Valid(raw) {
		return "", model.Errorf(model.CodeInvalid, "%s 不是文字檔，請到專案資料夾打開", rel)
	}
	return string(raw), nil
}

// ProjectImage is a picture in a company's folder as it is now, with its media type; anything else is refused.
func (e *Engine) ProjectImage(teamID, rel string) ([]byte, string, error) {
	at, err := e.projectPath(teamID, rel)
	if err != nil {
		return nil, "", err
	}
	info, err := os.Stat(at)
	if err != nil || info.IsDir() {
		return nil, "", model.Errorf(model.CodeNotFound, "專案資料夾裡沒有 %s", rel)
	}
	if info.Size() > maxProjectImage {
		return nil, "", model.Errorf(model.CodeInvalid, "%s 太大，請到專案資料夾打開", rel)
	}
	data, err := os.ReadFile(at)
	if err != nil {
		return nil, "", model.Errorf(model.CodeNotFound, "專案資料夾裡沒有 %s", rel)
	}
	switch kind := http.DetectContentType(data); kind {
	case "image/png", "image/jpeg", "image/gif", "image/webp":
		return data, kind, nil
	}
	return nil, "", model.Errorf(model.CodeInvalid, "%s 不是圖片，請到專案資料夾打開", rel)
}

// ProjectFolder is a folder in a company's folder, or the company's folder itself for an empty path, to show in Finder.
func (e *Engine) ProjectFolder(teamID, rel string) (string, error) {
	if strings.Trim(rel, "/ ") == "" {
		return e.TeamFolder(teamID)
	}
	at, err := e.projectPath(teamID, rel)
	if err != nil {
		return "", err
	}
	if info, err := os.Stat(at); err != nil || !info.IsDir() {
		return "", model.Errorf(model.CodeNotFound, "專案資料夾裡沒有 %s", rel)
	}
	return at, nil
}

// SkillText is a skill as "$" names it in a chat: what it says it is for and its instructions.
type SkillText struct {
	Name        string `json:"name"`
	Description string `json:"description"`
	Path        string `json:"path"`
	Text        string `json:"text"`
}

// ChatSkill is the skill named in a chat, from the first of its people who has one by that name, the chair first.
func (e *Engine) ChatSkill(ctx context.Context, chatID, name string) (SkillText, error) {
	e.mu.Lock()
	c := e.w.Chats[chatID]
	var packs [][]packRoot
	if c != nil {
		ids := []string{c.ReplicaID}
		for _, g := range c.Guests {
			ids = append(ids, g.ReplicaID)
		}
		for _, id := range ids {
			if r := e.w.Replicas[id]; r != nil {
				if bp := e.w.Blueprints[r.BlueprintID]; bp != nil {
					packs = append(packs, packsOf(bp))
				}
			}
		}
	}
	e.mu.Unlock()
	if c == nil {
		return SkillText{}, model.Errorf(model.CodeNotFound, "找不到對話")
	}
	for _, p := range packs {
		found, _, _ := e.loadSkills(ctx, p) // reading them can take a while: not under the lock
		at := slices.IndexFunc(found, func(s skill) bool { return s.name == name })
		if at < 0 {
			continue
		}
		raw, err := os.ReadFile(found[at].path)
		if err != nil {
			break
		}
		return SkillText{Name: name, Description: found[at].description, Path: found[at].path, Text: string(raw)}, nil
	}
	return SkillText{}, model.Errorf(model.CodeNotFound, "找不到技能 %s", name)
}
