package usecase

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"

	"github.com/yanun0323/mho-company/internal/model"
)

// agentsFile is where a company's prompt lives: the project's own instructions, shared with other tools.
const agentsFile = "AGENTS.md"

// readPrompt brings a company's prompt up to date with its file; no file means no prompt. While the file can't be
// read, or the folder is gone, the last known prompt stays. Call it holding the lock.
func (e *Engine) readPrompt(t *model.Team) {
	raw, err := os.ReadFile(filepath.Join(t.Folder, agentsFile))
	if errors.Is(err, fs.ErrNotExist) {
		if _, statErr := os.Stat(t.Folder); statErr == nil {
			t.Prompt = ""
		}
		return
	}
	if err != nil {
		e.log.Warn().Err(err).Str("folder", t.Folder).Msg("read AGENTS.md")
		return
	}
	t.Prompt = string(raw)
}

// writePrompt saves a company's prompt to its file. Emptying the prompt empties the file rather than deleting it,
// and a company with neither gets no file.
func (e *Engine) writePrompt(t *model.Team, prompt string) error {
	path := filepath.Join(t.Folder, agentsFile)
	raw, err := os.ReadFile(path)
	if err == nil && string(raw) == prompt {
		return nil
	}
	if errors.Is(err, fs.ErrNotExist) && prompt == "" {
		return nil
	}
	if err := os.WriteFile(path, []byte(prompt), 0o644); err != nil {
		e.log.Error().Err(err).Str("folder", t.Folder).Msg("write AGENTS.md")
		return model.Errorf(model.CodeUnavailable, "寫不進 %s，請檢查專案資料夾", path)
	}
	return nil
}

// movePromptsToFiles runs once per data folder, for prompts saved before they lived in AGENTS.md. A project that has
// no file gets the saved prompt; one that has a file keeps it, as it is what the project's other tools read.
func (e *Engine) movePromptsToFiles() {
	for _, t := range e.w.Teams {
		_, err := os.Stat(filepath.Join(t.Folder, agentsFile))
		if t.Prompt == "" || !errors.Is(err, fs.ErrNotExist) {
			continue
		}
		if _, err := os.Stat(t.Folder); err != nil {
			continue
		}
		if err := e.writePrompt(t, t.Prompt); err != nil {
			e.log.Warn().Err(err).Str("team", t.ID).Msg("move prompt to AGENTS.md")
		}
	}
	e.w.PromptFiles = true
}

// RefreshPrompt rereads a company's AGENTS.md, for when it may have changed outside the app.
func (e *Engine) RefreshPrompt(id string) error {
	return e.do(func() error {
		t := e.w.Teams[id]
		if t == nil {
			return model.Errorf(model.CodeNotFound, "找不到公司")
		}
		e.readPrompt(t)
		return nil
	})
}
