package usecase

import (
	"slices"
	"strings"

	"github.com/yanun0323/Team-Work/internal/model"
)

// AddCompanyNote keeps a note the user wrote in company teamID's memory, newest first.
func (e *Engine) AddCompanyNote(teamID, text string) (*model.MemoryEntry, error) {
	var out *model.MemoryEntry
	err := e.do(func() error {
		t, text, err := e.noteTarget(teamID, text)
		if err != nil {
			return err
		}
		note := model.MemoryEntry{ID: e.uid("mem"), Text: text, Source: "user", At: e.w.Now, CreatedAt: e.w.Now}
		t.Memory = append([]model.MemoryEntry{note}, t.Memory...)
		out = &note
		return nil
	})
	return out, err
}

// UpdateCompanyNote rewrites one of company teamID's notes: it is the user's from then on.
func (e *Engine) UpdateCompanyNote(teamID, id, text string) (*model.MemoryEntry, error) {
	var out *model.MemoryEntry
	err := e.do(func() error {
		t, text, err := e.noteTarget(teamID, text)
		if err != nil {
			return err
		}
		i := slices.IndexFunc(t.Memory, func(m model.MemoryEntry) bool { return m.ID == id })
		if i < 0 {
			return model.Errorf(model.CodeNotFound, "找不到這則記憶")
		}
		t.Memory = slices.Clone(t.Memory)
		note := &t.Memory[i]
		if note.CreatedAt == 0 {
			note.CreatedAt = note.At
		}
		note.Text, note.Source, note.By, note.At = text, "user", "", e.w.Now
		out = new(*note)
		return nil
	})
	return out, err
}

// DeleteCompanyNote drops one of company teamID's notes.
func (e *Engine) DeleteCompanyNote(teamID, id string) error {
	return e.do(func() error {
		t := e.w.Teams[teamID]
		if t == nil {
			return model.Errorf(model.CodeNotFound, "找不到公司")
		}
		if _, ok := dropNote(&t.Memory, id); !ok {
			return model.Errorf(model.CodeNotFound, "找不到這則記憶")
		}
		return nil
	})
}

// noteTarget is the company a note the user writes goes to, and the note's text trimmed; an error for no such company
// or no text.
func (e *Engine) noteTarget(teamID, text string) (*model.Team, string, error) {
	t := e.w.Teams[teamID]
	if t == nil {
		return nil, "", model.Errorf(model.CodeNotFound, "找不到公司")
	}
	if text = strings.TrimSpace(text); text == "" {
		return nil, "", model.Errorf(model.CodeInvalid, "記憶內容不能是空白")
	}
	return t, text, nil
}
