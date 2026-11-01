package model

import (
	"encoding/json"
	"fmt"
	"slices"
)

// Preferences are shared by every client of this data directory.
type Preferences struct {
	LogOrder          string `json:"logOrder"`
	Detail            bool   `json:"detail"`
	Shadows           bool   `json:"shadows"`
	Crowd             bool   `json:"crowd"`
	Planes            bool   `json:"planes"`
	Clouds            bool   `json:"clouds"`
	KeepTerminals     bool   `json:"keepTerminals"`
	DefaultTab        string `json:"defaultTab"`
	DefaultAirportTab string `json:"defaultAirportTab"`
}

func DefaultPreferences() Preferences {
	return Preferences{LogOrder: "newestFirst", Detail: true, Shadows: true, Crowd: true, Planes: true, Clouds: true, DefaultTab: "tasks", DefaultAirportTab: "providers"}
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
	if !slices.Contains([]string{"newestFirst", "newestLast"}, next.LogOrder) ||
		!slices.Contains([]string{"chats", "tasks", "crew", "terminal", "settings"}, next.DefaultTab) ||
		!slices.Contains([]string{"providers", "blueprints", "flows", "prefs", "about"}, next.DefaultAirportTab) {
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
