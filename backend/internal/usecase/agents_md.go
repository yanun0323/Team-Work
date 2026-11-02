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
	if err := saveAgentsFile(path, prompt); err != nil {
		e.log.Error().Err(err).Str("folder", t.Folder).Msg("write AGENTS.md")
		return model.Errorf(model.CodeUnavailable, "寫不進 %s，請檢查專案資料夾", path)
	}
	return nil
}

// saveAgentsFile writes a prompt unless the file already says it, or there is neither a file nor a prompt.
func saveAgentsFile(path, prompt string) error {
	raw, err := os.ReadFile(path)
	if (err == nil && string(raw) == prompt) || (errors.Is(err, fs.ErrNotExist) && prompt == "") {
		return nil
	}
	return os.WriteFile(path, []byte(prompt), 0o644)
}

// readGlobalPrompt reads the instructions every employee gets; no file means none. It is read for each run, so
// edits made outside the app apply from the next one. Call it holding the lock.
func (e *Engine) readGlobalPrompt() (string, error) {
	raw, err := os.ReadFile(filepath.Join(e.dataDir, agentsFile))
	if errors.Is(err, fs.ErrNotExist) {
		return "", nil
	}
	return string(raw), err
}

// runGlobalPrompt is the global prompt for a run. An unreadable file must not stop the work, so it is only logged.
func (e *Engine) runGlobalPrompt() string {
	prompt, err := e.readGlobalPrompt()
	if err != nil {
		e.log.Warn().Err(err).Msg("read global AGENTS.md")
	}
	return prompt
}

// GlobalPrompt returns the global AGENTS.md as it is now.
func (e *Engine) GlobalPrompt() (string, error) {
	e.mu.Lock()
	defer e.mu.Unlock()
	prompt, err := e.readGlobalPrompt()
	if err != nil {
		e.log.Error().Err(err).Msg("read global AGENTS.md")
		return "", model.Errorf(model.CodeUnavailable, "讀不到 %s", filepath.Join(e.dataDir, agentsFile))
	}
	return prompt, nil
}

// SetGlobalPrompt saves the global AGENTS.md. Emptying it keeps the file, as with a company's.
func (e *Engine) SetGlobalPrompt(prompt string) error {
	return e.do(func() error {
		path := filepath.Join(e.dataDir, agentsFile)
		if err := saveAgentsFile(path, prompt); err != nil {
			e.log.Error().Err(err).Msg("write global AGENTS.md")
			return model.Errorf(model.CodeUnavailable, "寫不進 %s", path)
		}
		return nil
	})
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
