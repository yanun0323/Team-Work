package usecase

import (
	"context"
	"crypto/sha256"
	"fmt"
	"io"
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

// mentionRoot is the folder a message's "#" paths are relative to: its company's, or the user's home folder for
// the airport's, which has no company.
func (e *Engine) mentionRoot(teamID string) (string, error) {
	if teamID == "" {
		return os.UserHomeDir()
	}
	return e.TeamFolder(teamID)
}

// projectPath is where a path a message mentions is in its company's folder, or at home for the airport's, as it is
// now on disk. A path that leads out of the folder, by "..", by being absolute or through a link, is refused.
func (e *Engine) projectPath(teamID, rel string) (string, error) {
	clean := filepath.ToSlash(filepath.Clean(rel))
	if rel == "" || strings.ContainsRune(rel, 0) || filepath.IsAbs(rel) || slices.Contains(strings.Split(filepath.ToSlash(rel), "/"), "..") {
		return "", model.Errorf(model.CodeInvalid, "檔案路徑不正確：%s", rel)
	}
	folder, err := e.mentionRoot(teamID)
	if err != nil {
		return "", err
	}
	if folder == "" {
		return "", model.Errorf(model.CodeInvalid, "找不到專案資料夾 %s", folder)
	}
	root, err := filepath.EvalSymlinks(folder)
	if err != nil {
		return "", model.Errorf(model.CodeInvalid, "找不到專案資料夾 %s", folder)
	}
	at, err := filepath.EvalSymlinks(filepath.Join(root, filepath.FromSlash(clean)))
	if err != nil {
		return "", missing(teamID, rel)
	}
	if inside, err := filepath.Rel(root, at); err != nil || inside == ".." || strings.HasPrefix(inside, ".."+string(filepath.Separator)) {
		return "", model.Errorf(model.CodeInvalid, "檔案路徑不正確：%s", rel)
	}
	return at, nil
}

// ProjectText keeps the text and fingerprint from the same read of the original bytes.
type ProjectText struct {
	Text string `json:"text"`
	Hash string `json:"hash"`
}

func projectHash(raw []byte) string { return fmt.Sprintf("%x", sha256.Sum256(raw)) }

// ProjectFile is a text file in a company's folder, or at home for an airport mention.
func (e *Engine) ProjectFile(teamID, rel string) (ProjectText, error) {
	at, err := e.projectPath(teamID, rel)
	if err != nil {
		return ProjectText{}, err
	}
	info, err := os.Stat(at)
	if err != nil {
		return ProjectText{}, missing(teamID, rel)
	}
	if info.IsDir() {
		return ProjectText{}, missing(teamID, rel)
	}
	if !info.Mode().IsRegular() {
		return ProjectText{}, notText(teamID, rel)
	}
	f, err := os.Open(at)
	if err != nil {
		return ProjectText{}, missing(teamID, rel)
	}
	defer f.Close()
	raw, _, err := readProjectText(f, teamID, rel)
	if err != nil {
		return ProjectText{}, err
	}
	return ProjectText{Text: string(raw), Hash: projectHash(raw)}, nil
}

func readProjectText(f *os.File, teamID, rel string) ([]byte, os.FileInfo, error) {
	info, err := f.Stat()
	if err != nil {
		return nil, nil, missing(teamID, rel)
	}
	if !info.Mode().IsRegular() {
		return nil, nil, model.Errorf(model.CodeInvalid, "必須是一般檔案")
	}
	if info.Size() > maxProjectText {
		return nil, nil, tooLarge(teamID, rel, model.CodeUnsupported)
	}
	raw, err := io.ReadAll(io.LimitReader(f, maxProjectText+1))
	if err != nil {
		return nil, nil, model.Errorf(model.CodeUnavailable, "讀不到檔案 %s", rel)
	}
	if len(raw) > maxProjectText {
		return nil, nil, tooLarge(teamID, rel, model.CodeUnsupported)
	}
	if slices.Contains(raw, 0) || !utf8.Valid(raw) {
		return nil, nil, notText(teamID, rel)
	}
	return raw, info, nil
}

// ProjectImage is a picture in a company's folder as it is now, with its media type; anything else is refused.
func (e *Engine) ProjectImage(teamID, rel string) ([]byte, string, error) {
	at, err := e.projectPath(teamID, rel)
	if err != nil {
		return nil, "", err
	}
	info, err := os.Stat(at)
	if err != nil || info.IsDir() {
		return nil, "", missing(teamID, rel)
	}
	if info.Size() > maxProjectImage {
		return nil, "", tooLarge(teamID, rel, model.CodeInvalid)
	}
	data, err := os.ReadFile(at)
	if err != nil {
		return nil, "", missing(teamID, rel)
	}
	switch kind := http.DetectContentType(data); kind {
	case "image/png", "image/jpeg", "image/gif", "image/webp":
		return data, kind, nil
	}
	return nil, "", notImage(teamID, rel)
}

// ProjectFolder is a folder in a company's folder, or the company's folder itself for an empty path, to show in Finder.
// With no company it is one at home, as the airport's "#" names.
func (e *Engine) ProjectFolder(teamID, rel string) (string, error) {
	if strings.Trim(rel, "/ ") == "" {
		return e.mentionRoot(teamID)
	}
	at, err := e.projectPath(teamID, rel)
	if err != nil {
		return "", err
	}
	if info, err := os.Stat(at); err != nil || !info.IsDir() {
		return "", missing(teamID, rel)
	}
	return at, nil
}

// missing, tooLarge, notText and notImage say what is wrong with a file a message names, by where it is: a company's
// folder, or the user's home folder for the airport's.
func missing(teamID, rel string) error {
	if teamID == "" {
		return model.Errorf(model.CodeNotFound, "家目錄裡沒有 %s", rel)
	}
	return model.Errorf(model.CodeNotFound, "專案資料夾裡沒有 %s", rel)
}

func tooLarge(teamID, rel, code string) error {
	if teamID == "" {
		return model.Errorf(code, "%s 太大，請到 Finder 打開", rel)
	}
	return model.Errorf(code, "%s 太大，請到專案資料夾打開", rel)
}

func notText(teamID, rel string) error {
	if teamID == "" {
		return model.Errorf(model.CodeUnsupported, "%s 不是文字檔，請到 Finder 打開", rel)
	}
	return model.Errorf(model.CodeUnsupported, "%s 不是文字檔，請到專案資料夾打開", rel)
}

func notImage(teamID, rel string) error {
	if teamID == "" {
		return model.Errorf(model.CodeInvalid, "%s 不是圖片，請到 Finder 打開", rel)
	}
	return model.Errorf(model.CodeInvalid, "%s 不是圖片，請到專案資料夾打開", rel)
}

// SkillText is a skill as "$" names it in a chat: what it says it is for and its instructions.
type SkillText struct {
	Name        string `json:"name"`
	Description string `json:"description"`
	Path        string `json:"path"`
	Text        string `json:"text"`
}

// ChatSkill is the skill named in a chat: the company's own, or else from the first of its people who has one by that
// name, the chair first.
func (e *Engine) ChatSkill(ctx context.Context, chatID, name string) (SkillText, error) {
	e.mu.Lock()
	c := e.w.Chats[chatID]
	var packs [][]packRoot
	if c != nil && c.AtAirport() {
		if bp := e.w.Blueprints[airportBlueprintID]; bp != nil {
			packs = append(packs, e.packsOf(bp))
		}
	} else if c != nil {
		if team := e.w.Teams[c.TeamID]; team != nil {
			packs = append(packs, projectPacks(team.Folder, e.w.Preferences))
		}
		ids := []string{c.ReplicaID}
		for _, g := range c.Guests {
			ids = append(ids, g.ReplicaID)
		}
		for _, id := range ids {
			if r := e.w.Replicas[id]; r != nil {
				if bp := e.w.Blueprints[r.BlueprintID]; bp != nil {
					packs = append(packs, e.packsOf(bp))
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
