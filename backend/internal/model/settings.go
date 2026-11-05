package model

import (
	"encoding/json"

	"github.com/yanun0323/Team-Work/internal/i18n"
	"github.com/yanun0323/Team-Work/internal/model/enum"
)

// Settings is the editable configuration. IDs bind it to runtime records in SQLite.
// Credentials, employee memory, task snapshots and project instructions never belong here.
type Settings struct {
	Preferences Preferences               `json:"preferences"`
	Tutorial    Tutorial                  `json:"tutorial"`
	Version     int                       `json:"version"`
	Teams       map[string]TeamConfig     `json:"teams"`
	Replicas    map[string]ReplicaConfig  `json:"replicas"`
	Providers   map[string]ProviderConfig `json:"providers"`
	Blueprints  map[string]*Blueprint     `json:"blueprints"`
	Sources     map[string]*Source        `json:"sources"`
	Workflows   map[string]*Workflow      `json:"workflows"`
}

type TeamConfig struct {
	ID           string       `json:"id"`
	Name         string       `json:"name"`
	Folder       string       `json:"folder"`
	TargetBranch string       `json:"targetBranch"`
	Settings     TeamSettings `json:"settings"`
}

type ReplicaConfig struct {
	ID          string `json:"id"`
	TeamID      string `json:"teamId"`
	BlueprintID string `json:"blueprintId"`
	Name        string `json:"name"`
	Look        Look   `json:"look"`
	Model       string `json:"model"`
	Effort      string `json:"effort"`
}

type ProviderConfig struct {
	ID       string                `json:"id"`
	Name     string                `json:"name"`
	Kind     enum.ProviderKind     `json:"kind"`
	AuthKind string                `json:"authKind"`
	BaseURL  string                `json:"baseUrl"`
	Models   []string              `json:"models"`
	Thinking map[string][]string   `json:"thinking"`
	Prices   map[string]ModelPrice `json:"prices,omitempty"`
	// ContextWindow is the size set for a kind with none of its own; 0 when it was never set.
	ContextWindow int `json:"contextWindow,omitempty"`
}

func WithoutPresets[T any](all map[string]T) map[string]T {
	out := make(map[string]T, len(all))
	for id, v := range all {
		if !IsPresetID(id) {
			out[id] = v
		}
	}
	return out
}

func SettingsOf(w *World) Settings {
	s := Settings{Version: 1, Preferences: w.Preferences, Tutorial: w.Tutorial, Teams: map[string]TeamConfig{}, Replicas: map[string]ReplicaConfig{}, Providers: map[string]ProviderConfig{}, Blueprints: WithoutPresets(w.Blueprints), Sources: map[string]*Source{}, Workflows: WithoutPresets(w.Workflows)}
	for id, src := range w.Sources {
		s.Sources[id] = src
	}
	for id, t := range w.Teams {
		s.Teams[id] = TeamConfig{t.ID, t.Name, t.Folder, t.TargetBranch, t.Settings}
	}
	for id, r := range w.Replicas {
		s.Replicas[id] = ReplicaConfig{r.ID, r.TeamID, r.BlueprintID, r.Name, r.Look, r.Model, r.Effort}
	}
	for id, p := range w.Providers {
		s.Providers[id] = ProviderConfig{p.ID, p.Name, p.Kind, p.Auth.Kind, p.BaseURL, p.Models, p.Thinking, p.Prices, p.ContextWindow}
	}
	return s
}

// Install changes configuration only; the caller has validated IDs and references.
func (s Settings) Install(w *World) {
	w.Preferences = s.Preferences
	w.Tutorial = s.Tutorial
	w.Tutorial.Normalize()
	for id, c := range s.Teams {
		t := w.Teams[id]
		t.Name, t.Folder, t.TargetBranch, t.Settings = c.Name, c.Folder, c.TargetBranch, c.Settings
	}
	for id, c := range s.Replicas {
		r := w.Replicas[id]
		r.TeamID, r.BlueprintID, r.Name, r.Look, r.Model, r.Effort = c.TeamID, c.BlueprintID, c.Name, c.Look, c.Model, c.Effort
	}
	for id, c := range s.Providers {
		p := w.Providers[id]
		p.Name, p.Kind, p.Auth.Kind, p.BaseURL = c.Name, c.Kind, c.AuthKind, c.BaseURL
		p.Models, p.Thinking, p.Prices, p.ContextWindow = c.Models, c.Thinking, c.Prices, c.ContextWindow
	}
	w.Blueprints, w.Workflows = s.Blueprints, s.Workflows
	w.Sources = s.Sources
	if w.Sources == nil {
		w.Sources = map[string]*Source{}
	}
}

// RuntimeDoc removes editable fields from a world document. Identity records remain so
// deleting a file entry cannot silently close a company or orphan an employee's memory.
func RuntimeDoc(d Doc) (Doc, error) {
	var v any
	switch d.Kind {
	case "team":
		var t Team
		if err := json.Unmarshal(d.Data, &t); err != nil {
			return d, err
		}
		// Folder is a binding to an existing repo, not an invitation to move active work.
		v = struct {
			Plot           *Plot    `json:"plot,omitempty"`
			ID             string   `json:"id"`
			Folder         string   `json:"folder"`
			Branches       []string `json:"branches"`
			InitializedGit bool     `json:"initializedGit"`
			CreatedAt      float64  `json:"createdAt"`
		}{t.Plot, t.ID, t.Folder, t.Branches, t.InitializedGit, t.CreatedAt}
	case "replica":
		var r Replica
		if err := json.Unmarshal(d.Data, &r); err != nil {
			return d, err
		}
		v = struct {
			ID      string        `json:"id"`
			TeamID  string        `json:"teamId"`
			Memory  []MemoryEntry `json:"memory"`
			HiredAt float64       `json:"hiredAt"`
		}{r.ID, r.TeamID, r.Memory, r.HiredAt}
	case "provider":
		var p ModelProvider
		if err := json.Unmarshal(d.Data, &p); err != nil {
			return d, err
		}
		v = struct {
			ID   string            `json:"id"`
			Kind enum.ProviderKind `json:"kind"`
			Auth ProviderAuth      `json:"auth"`
		}{p.ID, p.Kind, p.Auth}
	case "blueprint", "workflow", "source":
		v = struct {
			ID string `json:"id"`
		}{d.ID}
	default:
		return d, nil
	}
	var err error
	d.Data, err = json.Marshal(v)
	return d, err
}

// SettingsChange compares the exact bytes last loaded before replacing the file.
// SecretChange is a provider's key written, or removed when Delete, in the same transaction as the documents and
// settings it goes with, so a failed change leaves the key as it was.
type SecretChange struct {
	ID     string
	Value  string
	Delete bool
}

type SettingsChange struct {
	Before  SettingsSnapshot
	After   []byte
	Written *SettingsSnapshot
}

// SettingsPending means SQLite committed but the settings file could not be installed.
// Stop further mutations until a restart replays the journal; never roll back memory
// and then overwrite the already committed runtime records with stale data.
type SettingsPending struct{ Err error }

func (e *SettingsPending) Error() string {
	return i18n.T("設定儲存尚未完成，請重新啟動伺服器：%s", e.Err.Error())
}
func (e *SettingsPending) Unwrap() error { return e.Err }

// SettingsSnapshot keeps exact file bytes for optimistic conflict checks; Data is
// the assembled configuration used internally, never a combined file on disk.
type SettingsSnapshot struct {
	Data  []byte
	Files map[string][]byte
}
