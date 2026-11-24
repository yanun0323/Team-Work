package usecase

import (
	"strings"
	"unicode/utf8"

	"github.com/yanun0323/Team-Work/internal/model"
)

// ghostNameLimit bounds a ghost company's name, read from the other computer.
const ghostNameLimit = 200

// NewGhost is a paired computer's company to show on this island. The caller answers for PeerID being paired.
type NewGhost struct {
	PeerID string      `json:"peerId"`
	TeamID string      `json:"teamId"`
	Name   string      `json:"name"`
	Plot   *model.Plot `json:"plot"`
}

// GhostPatch changes a ghost company; a nil field stays as it is. Name and the plot's look follow the company on the
// other computer; the plot's place is this island's.
type GhostPatch struct {
	Name *string     `json:"name"`
	Plot *model.Plot `json:"plot"`
}

func ghostName(name string) (string, error) {
	name = strings.TrimSpace(name)
	if name == "" || strings.ContainsAny(name, "\r\n") || utf8.RuneCountInString(name) > ghostNameLimit {
		return "", model.Errorf(model.CodeInvalid, "投影公司的名稱不正確")
	}
	return name, nil
}

// CreateGhost puts a paired computer's company on this island. The same company stands here once at most.
func (e *Engine) CreateGhost(in NewGhost) (*model.Ghost, error) {
	in.PeerID, in.TeamID = strings.TrimSpace(in.PeerID), strings.TrimSpace(in.TeamID)
	if in.PeerID == "" || in.TeamID == "" || len(in.PeerID) > ghostNameLimit || len(in.TeamID) > ghostNameLimit {
		return nil, model.Errorf(model.CodeInvalid, "要選一位好友的公司")
	}
	name, err := ghostName(in.Name)
	if err != nil {
		return nil, err
	}
	var out *model.Ghost
	err = e.do(func() error {
		for _, g := range e.w.Ghosts {
			if g.PeerID == in.PeerID && g.TeamID == in.TeamID {
				return model.Errorf(model.CodeConflict, "這間公司已經投影在島上了")
			}
		}
		if err := e.checkPlot("", in.Plot); err != nil {
			return err
		}
		g := &model.Ghost{ID: e.uid("ghost"), PeerID: in.PeerID, TeamID: in.TeamID, Name: name, Plot: clone(in.Plot), CreatedAt: e.w.Now}
		e.w.Ghosts[g.ID] = g
		out = clone(g)
		return nil
	})
	return out, err
}

// UpdateGhost moves a ghost company here, or catches its name and look up with the company's on the other computer.
func (e *Engine) UpdateGhost(id string, p GhostPatch) error {
	var name string
	if p.Name != nil {
		var err error
		if name, err = ghostName(*p.Name); err != nil {
			return err
		}
	}
	return e.do(func() error {
		g := e.w.Ghosts[id]
		if g == nil {
			return model.Errorf(model.CodeNotFound, "找不到投影公司")
		}
		if p.Plot != nil {
			if err := e.checkPlot(id, p.Plot); err != nil {
				return err
			}
			g.Plot = clone(p.Plot)
		}
		if p.Name != nil {
			g.Name = name
		}
		return nil
	})
}

// DeleteGhost takes a ghost company off this island; the company itself, on the other computer, stays as it is.
func (e *Engine) DeleteGhost(id string) error {
	return e.do(func() error {
		if e.w.Ghosts[id] == nil {
			return model.Errorf(model.CodeNotFound, "找不到投影公司")
		}
		delete(e.w.Ghosts, id)
		return nil
	})
}
