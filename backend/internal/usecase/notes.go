package usecase

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"

	"github.com/yanun0323/Team-Work/internal/model"
)

// notesFile is where a company's notes live: in its folder, so they go wherever the project goes.
const notesFile = ".team-work/NOTES.md"

// notesPath is the notes file of a company.
func (e *Engine) notesPath(id string) (string, error) {
	e.mu.Lock()
	defer e.mu.Unlock()
	t := e.w.Teams[id]
	if t == nil {
		return "", model.Errorf(model.CodeNotFound, "找不到公司")
	}
	return filepath.Join(t.Folder, notesFile), nil
}

// Notes reads a company's notes as they are now; no file means none.
func (e *Engine) Notes(id string) (string, error) {
	path, err := e.notesPath(id)
	if err != nil {
		return "", err
	}
	raw, err := os.ReadFile(path)
	if errors.Is(err, fs.ErrNotExist) {
		return "", nil
	}
	if err != nil {
		e.log.Error().Err(err).Str("path", path).Msg("read notes")
		return "", model.Errorf(model.CodeUnavailable, "讀不到 %s", path)
	}
	return string(raw), nil
}

// SetNotes saves a company's notes. As with AGENTS.md, emptying them empties the file, and no notes make no file.
func (e *Engine) SetNotes(id, text string) error {
	path, err := e.notesPath(id)
	if err != nil {
		return err
	}
	raw, err := os.ReadFile(path)
	if (err == nil && string(raw) == text) || (errors.Is(err, fs.ErrNotExist) && text == "") {
		return nil
	}
	err = os.MkdirAll(filepath.Dir(path), 0o755)
	if err == nil {
		err = os.WriteFile(path, []byte(text), 0o644)
	}
	if err != nil {
		e.log.Error().Err(err).Str("path", path).Msg("write notes")
		return model.Errorf(model.CodeUnavailable, "寫不進 %s，請檢查專案資料夾", path)
	}
	return nil
}
