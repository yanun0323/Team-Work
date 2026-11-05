package model

import (
	"encoding/json"
	"fmt"
	"slices"
)

// Preferences are shared by every client of this data directory.
type Preferences struct {
	MusicStyle       string `json:"musicStyle"`
	SoundNotice      bool   `json:"soundNotice"`
	SoundTutorial    bool   `json:"soundTutorial"`
	SoundOpenTeam    bool   `json:"soundOpenTeam"`
	SoundOpenAirport bool   `json:"soundOpenAirport"`
	SoundWaves       bool   `json:"soundWaves"`
	MusicVolume      int    `json:"musicVolume"`
	EffectsVolume    int    `json:"effectsVolume"`
	MusicMuted       bool   `json:"musicMuted"`
	EffectsMuted     bool   `json:"effectsMuted"`
	SoundTakeoff     bool   `json:"soundTakeoff"`
	SoundLanding     bool   `json:"soundLanding"`
	SoundFlyover     bool   `json:"soundFlyover"`
	SoundUI          bool   `json:"soundUI"`
	MuteInBackground bool   `json:"muteInBackground"`
	LogOrder         string `json:"logOrder"`
	Detail           bool   `json:"detail"`
	Shadows          bool   `json:"shadows"`
	Crowd            bool   `json:"crowd"`
	Planes           bool   `json:"planes"`
	Clouds           bool   `json:"clouds"`
	KeepTerminals    bool   `json:"keepTerminals"`
	AutoView         string `json:"autoView"`
	// BusyAnimation is what a company's building shows while it is at work: shout strokes, money tossed off its sides, or off for nothing.
	BusyAnimation string `json:"busyAnimation"`
	// Daylight is the time of day the town shows: the clock (real), a 20-minute day (minecraft), or always day or night.
	Daylight          string `json:"daylight"`
	ZoomSensitivity   int    `json:"zoomSensitivity"`
	TerminalCommand   string `json:"terminalCommand"`
	DefaultTab        string `json:"defaultTab"`
	DefaultAirportTab string `json:"defaultAirportTab"`
	// AutoTab opens a company or the airport on a tab with something waiting: off, chats first, or tasks first.
	AutoTab string `json:"autoTab"`
	// ChatTitleModel names each new chat from its first message; empty turns naming off.
	ChatTitleModel  string `json:"chatTitleModel"`
	ChatTitleEffort string `json:"chatTitleEffort"`
	// ImageProvider is the ChatGPT subscription every employee draws pictures with; empty gives nobody image_gen.
	ImageProvider string `json:"imageProvider"`
	// CodexSkills and ClaudeSkills let the built-in blueprints read skills from ~/.codex/ and ~/.claude/.
	CodexSkills  bool `json:"codexSkills"`
	ClaudeSkills bool `json:"claudeSkills"`
	// HiddenBlueprints and HiddenWorkflows are left out of every list to pick from and out of employees' tools; employees
	// and tasks already on them keep them, and the user can still edit them.
	HiddenBlueprints []string `json:"hiddenBlueprints"`
	HiddenWorkflows  []string `json:"hiddenWorkflows"`
	// Compact1M, Compact256K, Compact128K and CompactSmall are how full, in percent, a chat on a model of that size may
	// get before it is summed up: 1M tokens or more, 256K or more, 128K or more, and less.
	Compact1M    int `json:"compact1M"`
	Compact256K  int `json:"compact256K"`
	Compact128K  int `json:"compact128K"`
	CompactSmall int `json:"compactSmall"`
}

// CompactLeast and CompactMost bound the compaction percentages.
const (
	CompactLeast = 10
	CompactMost  = 100
)

// CompactShare is the percentage that applies to a model that reads window tokens.
func (p Preferences) CompactShare(window int) int {
	switch {
	case window >= 1_000_000:
		return p.Compact1M
	case window >= 256_000:
		return p.Compact256K
	case window >= 128_000:
		return p.Compact128K
	}
	return p.CompactSmall
}

func DefaultPreferences() Preferences {
	return Preferences{MuteInBackground: true, MusicStyle: "bossa", SoundNotice: true, SoundTutorial: true, SoundOpenTeam: true, SoundOpenAirport: true, SoundWaves: true, MusicVolume: 50, EffectsVolume: 100, SoundTakeoff: true, SoundLanding: true, SoundFlyover: true, SoundUI: true, LogOrder: "newestFirst", Detail: true, Shadows: true, Crowd: true, Planes: true, Clouds: true, AutoView: "panZoom", BusyAnimation: "money", Daylight: "minecraft", ZoomSensitivity: 100, DefaultTab: "tasks", DefaultAirportTab: "providers", AutoTab: "chats", CodexSkills: true, ClaudeSkills: true, HiddenBlueprints: []string{}, HiddenWorkflows: []string{}, Compact1M: 40, Compact256K: 90, Compact128K: 95, CompactSmall: 95}
}

// MergePreferences accepts only known, non-null fields; omitted fields keep their values.
func MergePreferences(current Preferences, patch map[string]json.RawMessage) (Preferences, error) {
	raw, _ := json.Marshal(current)
	var fields map[string]json.RawMessage
	_ = json.Unmarshal(raw, &fields)
	for key, value := range patch {
		if _, ok := fields[key]; !ok || string(value) == "null" {
			return current, fmt.Errorf("invalid preference: %s", key)
		}
		fields[key] = value
	}
	raw, _ = json.Marshal(fields)
	type plain Preferences
	var next plain
	if err := json.Unmarshal(raw, &next); err != nil {
		return current, err
	}
	// Older clients stored sound as a separate airport tab.
	if next.DefaultAirportTab == "sound" {
		next.DefaultAirportTab = "prefs"
	}
	if !slices.Contains([]string{"piano", "ambient", "bossa", "chiptune"}, next.MusicStyle) || next.MusicVolume < 0 || next.MusicVolume > 100 || next.EffectsVolume < 0 || next.EffectsVolume > 100 ||
		next.ZoomSensitivity < 20 || next.ZoomSensitivity > 300 ||
		slices.ContainsFunc([]int{next.Compact1M, next.Compact256K, next.Compact128K, next.CompactSmall}, func(n int) bool { return n < CompactLeast || n > CompactMost }) ||
		!slices.Contains([]string{"newestFirst", "newestLast"}, next.LogOrder) ||
		!slices.Contains([]string{"panZoom", "pan", "off"}, next.AutoView) ||
		!slices.Contains([]string{"shout", "money", "off"}, next.BusyAnimation) ||
		!slices.Contains([]string{"real", "minecraft", "day", "night"}, next.Daylight) ||
		!slices.Contains([]string{"off", "chats", "tasks"}, next.AutoTab) ||
		!slices.Contains([]string{"chats", "tasks", "crew", "terminal", "settings"}, next.DefaultTab) ||
		!slices.Contains([]string{"chats", "providers", "blueprints", "flows", "stats", "prefs", "about"}, next.DefaultAirportTab) {
		return current, fmt.Errorf("invalid preference value")
	}
	return Preferences(next), nil
}

// UnmarshalJSON fills omitted preferences with defaults, including future additions.
func (p *Preferences) UnmarshalJSON(raw []byte) error {
	var patch map[string]json.RawMessage
	if err := json.Unmarshal(raw, &patch); err != nil {
		return err
	}
	if patch == nil {
		return fmt.Errorf("preferences must be an object")
	}
	// Files written while this was a checkbox.
	if old, ok := patch["autoZoom"]; ok {
		delete(patch, "autoZoom")
		if _, set := patch["autoView"]; !set && string(old) == "false" {
			patch["autoView"] = json.RawMessage(`"off"`)
		}
	}
	// Files written while this was a checkbox: on takes the default.
	if old, ok := patch["openWaitingTab"]; ok {
		delete(patch, "openWaitingTab")
		if _, set := patch["autoTab"]; !set && string(old) == "false" {
			patch["autoTab"] = json.RawMessage(`"off"`)
		}
	}
	// Files written while opening a waiting task could also open its sub-task.
	delete(patch, "openWaitingSub")
	next, err := MergePreferences(DefaultPreferences(), patch)
	if err != nil {
		return err
	}
	*p = next
	return nil
}

// Plot belongs to the company runtime record, not its editable configuration.
type Plot struct {
	At    []int  `json:"at"`
	Style string `json:"style"`
	Seed  uint32 `json:"seed"`
}
