package model

import (
	"encoding/json"
	"fmt"
	"slices"
)

// Preferences are shared by every client of this data directory.
type Preferences struct {
	MusicStyle        string `json:"musicStyle"`
	SoundNotice       bool   `json:"soundNotice"`
	MusicVolume       int    `json:"musicVolume"`
	EffectsVolume     int    `json:"effectsVolume"`
	MusicMuted        bool   `json:"musicMuted"`
	EffectsMuted      bool   `json:"effectsMuted"`
	SoundTakeoff      bool   `json:"soundTakeoff"`
	SoundLanding      bool   `json:"soundLanding"`
	SoundFlyover      bool   `json:"soundFlyover"`
	SoundUI           bool   `json:"soundUI"`
	MuteInBackground  bool   `json:"muteInBackground"`
	LogOrder          string `json:"logOrder"`
	Detail            bool   `json:"detail"`
	Shadows           bool   `json:"shadows"`
	Crowd             bool   `json:"crowd"`
	Planes            bool   `json:"planes"`
	Clouds            bool   `json:"clouds"`
	KeepTerminals     bool   `json:"keepTerminals"`
	AutoView          string `json:"autoView"`
	ZoomSensitivity   int    `json:"zoomSensitivity"`
	TerminalCommand   string `json:"terminalCommand"`
	DefaultTab        string `json:"defaultTab"`
	DefaultAirportTab string `json:"defaultAirportTab"`
	OpenWaitingTab    bool   `json:"openWaitingTab"`
	OpenWaitingSub    bool   `json:"openWaitingSub"`
}

func DefaultPreferences() Preferences {
	return Preferences{MuteInBackground: true, MusicStyle: "bossa", SoundNotice: true, MusicVolume: 100, EffectsVolume: 100, SoundTakeoff: true, SoundLanding: true, SoundFlyover: true, SoundUI: true, LogOrder: "newestFirst", Detail: true, Shadows: true, Crowd: true, Planes: true, Clouds: true, AutoView: "panZoom", ZoomSensitivity: 100, DefaultTab: "tasks", DefaultAirportTab: "providers", OpenWaitingTab: true, OpenWaitingSub: true}
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
		!slices.Contains([]string{"newestFirst", "newestLast"}, next.LogOrder) ||
		!slices.Contains([]string{"panZoom", "pan", "off"}, next.AutoView) ||
		!slices.Contains([]string{"chats", "tasks", "crew", "terminal", "settings"}, next.DefaultTab) ||
		!slices.Contains([]string{"chats", "providers", "blueprints", "flows", "prefs", "about"}, next.DefaultAirportTab) {
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
