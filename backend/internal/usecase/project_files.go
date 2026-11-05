package usecase

import (
	"cmp"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"os"
	"path"
	"path/filepath"
	"slices"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/yanun0323/Team-Work/internal/model"
)

const maxProjectEntries = 5000

type ProjectEntry struct {
	Name string `json:"name"`
	Path string `json:"path"`
	Kind string `json:"kind"`
}

type ProjectTree struct {
	Entries   []ProjectEntry `json:"entries"`
	Truncated bool           `json:"truncated"`
}

// projectDirectory applies the shared sandbox, allowing the empty root path only for directories.
func (e *Engine) projectDirectory(teamID, rel string) (string, error) {
	// Never browse the airport.
	if _, err := e.TeamFolder(teamID); err != nil {
		return "", err
	}
	if rel == "" {
		rel = "."
	}
	at, err := e.projectPath(teamID, rel)
	if err != nil {
		return "", err
	}
	info, err := os.Stat(at)
	if err != nil {
		return "", missing(teamID, rel)
	}
	if !info.IsDir() {
		return "", model.Errorf(model.CodeInvalid, "%s 不是資料夾", rel)
	}
	return at, nil
}

// ProjectTree reads just this directory, including ignored and hidden entries, never its descendants.
func (e *Engine) ProjectTree(teamID, rel string) (ProjectTree, error) {
	result := ProjectTree{Entries: []ProjectEntry{}}
	at, err := e.projectDirectory(teamID, rel)
	if err != nil {
		return result, err
	}
	entries, err := os.ReadDir(at)
	if err != nil {
		return result, model.Errorf(model.CodeUnavailable, "讀不到資料夾 %s", rel)
	}
	for _, entry := range entries {
		kind := "file"
		if entry.IsDir() {
			kind = "dir"
		} else if entry.Type()&os.ModeSymlink != 0 {
			if target, err := e.projectPath(teamID, path.Join(rel, entry.Name())); err == nil {
				if info, err := os.Stat(target); err == nil && info.IsDir() {
					kind = "dir"
				}
			}
		}
		result.Entries = append(result.Entries, ProjectEntry{Name: entry.Name(), Path: path.Join(rel, entry.Name()), Kind: kind})
	}
	slices.SortFunc(result.Entries, func(a, b ProjectEntry) int {
		if n := cmp.Compare(a.Kind, b.Kind); n != 0 {
			return n
		}
		if n := cmp.Compare(strings.ToLower(a.Name), strings.ToLower(b.Name)); n != 0 {
			return n
		}
		return cmp.Compare(a.Name, b.Name)
	})
	if len(result.Entries) > maxProjectEntries {
		result.Entries = result.Entries[:maxProjectEntries]
		result.Truncated = true
	}
	return result, nil
}

// projectWriteParent pins the validated directory to a handle. Root operations also reject
// symlink escapes if directories are replaced after projectPath's check.
func (e *Engine) projectWriteParent(teamID, at string) (*os.Root, error) {
	rootPath, err := e.projectPath(teamID, ".")
	if err != nil {
		return nil, err
	}
	rel, err := filepath.Rel(rootPath, at)
	if err != nil {
		return nil, model.Errorf(model.CodeInvalid, "檔案路徑不正確：%s", at)
	}
	root, err := os.OpenRoot(rootPath)
	if err != nil {
		return nil, model.Errorf(model.CodeUnavailable, "寫不進專案資料夾")
	}
	defer root.Close()
	parent, err := root.OpenRoot(rel)
	if err != nil {
		return nil, model.Errorf(model.CodeUnavailable, "寫不進專案資料夾")
	}
	return parent, nil
}

func (e *Engine) CreateProjectEntry(teamID, parent, name, kind string) (ProjectEntry, error) {
	result := ProjectEntry{}
	if strings.TrimSpace(name) == "" || name == "." || name == ".." || len(name) > 255 || !utf8.ValidString(name) || strings.ContainsAny(name, "/\\") || strings.ContainsFunc(name, unicode.IsControl) || (kind != "file" && kind != "dir") {
		return result, model.Errorf(model.CodeInvalid, "名稱不正確：%s", name)
	}
	at, err := e.projectDirectory(teamID, parent)
	if err != nil {
		return result, err
	}
	dir, err := e.projectWriteParent(teamID, at)
	if err != nil {
		return result, err
	}
	defer dir.Close()
	if kind == "dir" {
		err = dir.Mkdir(name, 0755)
	} else {
		var f *os.File
		f, err = dir.OpenFile(name, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0644)
		if err == nil {
			err = f.Close()
		}
	}
	if errors.Is(err, os.ErrExist) {
		return result, model.Errorf(model.CodeConflict, "已經有 %s", name)
	}
	if err != nil {
		return result, model.Errorf(model.CodeUnavailable, "寫不進專案資料夾")
	}
	return ProjectEntry{Name: name, Path: path.Join(parent, name), Kind: kind}, nil
}

// SaveProjectFile checks the opened revision before replacing the file atomically.
// The lock prevents two browser saves from both accepting the same revision.
func (e *Engine) SaveProjectFile(teamID, rel, text, hash string) (string, error) {
	if _, err := e.TeamFolder(teamID); err != nil {
		return "", err
	}
	decoded, err := hex.DecodeString(hash)
	if err != nil || len(decoded) != 32 || hash != strings.ToLower(hash) {
		return "", model.Errorf(model.CodeInvalid, "檔案指紋不正確")
	}
	if len(text) > maxProjectText {
		return "", model.Errorf(model.CodeInvalid, "儲存內容不能超過 1 MiB")
	}
	if !utf8.ValidString(text) || strings.ContainsRune(text, 0) {
		return "", model.Errorf(model.CodeInvalid, "儲存內容必須是文字")
	}
	e.projectMu.Lock()
	defer e.projectMu.Unlock()
	at, err := e.projectPath(teamID, rel)
	if err != nil {
		var known *model.Error
		if errors.As(err, &known) && known.Code == model.CodeNotFound {
			return "", model.Errorf(model.CodeConflict, "檔案已不在，請重新讀取")
		}
		return "", err
	}
	info, err := os.Stat(at)
	if err != nil {
		return "", model.Errorf(model.CodeConflict, "檔案已不在，請重新讀取")
	}
	if !info.Mode().IsRegular() {
		return "", model.Errorf(model.CodeInvalid, "必須是一般檔案")
	}
	dir, err := e.projectWriteParent(teamID, filepath.Dir(at))
	if err != nil {
		return "", err
	}
	defer dir.Close()
	name := filepath.Base(at)
	read := func() ([]byte, os.FileInfo, error) {
		info, err := dir.Stat(name)
		if errors.Is(err, os.ErrNotExist) {
			return nil, nil, model.Errorf(model.CodeConflict, "檔案已不在，請重新讀取")
		}
		if err != nil {
			return nil, nil, model.Errorf(model.CodeUnavailable, "讀不到檔案 %s", rel)
		}
		if !info.Mode().IsRegular() {
			return nil, nil, model.Errorf(model.CodeInvalid, "必須是一般檔案")
		}
		f, err := dir.Open(name)
		if err != nil {
			return nil, nil, model.Errorf(model.CodeUnavailable, "讀不到檔案 %s", rel)
		}
		defer f.Close()
		return readProjectText(f, teamID, rel)
	}
	raw, info, err := read()
	if err != nil {
		return "", err
	}
	if projectHash(raw) != hash {
		return "", model.Errorf(model.CodeConflict, "檔案已在別處被修改，請重新讀取")
	}
	tmp := ".team-work-save-" + rand.Text()
	f, err := dir.OpenFile(tmp, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		return "", model.Errorf(model.CodeUnavailable, "寫不進專案資料夾")
	}
	defer dir.Remove(tmp)
	_, err = f.WriteString(text)
	if err == nil {
		err = f.Chmod(info.Mode().Perm() | info.Mode()&(os.ModeSetuid|os.ModeSetgid|os.ModeSticky))
	}
	if err == nil {
		err = f.Sync()
	}
	closeErr := f.Close()
	if err != nil || closeErr != nil {
		return "", model.Errorf(model.CodeUnavailable, "寫不進專案資料夾")
	}
	// Recheck after preparing the replacement so external edits during that work are not lost.
	current, currentInfo, err := read()
	if err != nil {
		return "", err
	}
	if projectHash(current) != hash || !os.SameFile(info, currentInfo) {
		return "", model.Errorf(model.CodeConflict, "檔案已在別處被修改，請重新讀取")
	}
	if err := dir.Rename(tmp, name); err != nil {
		return "", model.Errorf(model.CodeUnavailable, "寫不進專案資料夾")
	}
	return projectHash([]byte(text)), nil
}
