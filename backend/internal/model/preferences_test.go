package model

import (
	"encoding/json"
	"testing"
)

func TestMuteInBackgroundIsOnForOldFiles(t *testing.T) {
	var p Preferences
	if err := json.Unmarshal([]byte(`{"shadows":false}`), &p); err != nil {
		t.Fatal(err)
	}
	if !p.MuteInBackground {
		t.Fatal("a file from before this preference should mute")
	}
	if err := json.Unmarshal([]byte(`{"muteInBackground":false}`), &p); err != nil || p.MuteInBackground {
		t.Fatalf("%v %+v", err, p)
	}
}

func TestZoomSensitivityStaysInRange(t *testing.T) {
	var p Preferences
	if err := json.Unmarshal([]byte(`{"shadows":false}`), &p); err != nil {
		t.Fatal(err)
	}
	if p.ZoomSensitivity != 100 || p.TerminalCommand != "" {
		t.Fatalf("defaults: %+v", p)
	}
	for _, bad := range []string{`19`, `301`} {
		if _, err := MergePreferences(p, map[string]json.RawMessage{"zoomSensitivity": json.RawMessage(bad)}); err == nil {
			t.Fatalf("zoomSensitivity %s accepted", bad)
		}
	}
}

func TestAutoView(t *testing.T) {
	read := func(raw string) Preferences {
		t.Helper()
		var p Preferences
		if err := json.Unmarshal([]byte(raw), &p); err != nil {
			t.Fatal(err)
		}
		return p
	}
	for raw, want := range map[string]string{
		`{"shadows":false}`:  "panZoom",
		`{"autoView":"pan"}`: "pan",
		`{"autoZoom":true}`:  "panZoom",
		`{"autoZoom":false}`: "off",
	} {
		if got := read(raw).AutoView; got != want {
			t.Errorf("%s: autoView %q, want %q", raw, got, want)
		}
	}
	if _, err := MergePreferences(DefaultPreferences(), map[string]json.RawMessage{"autoView": json.RawMessage(`"zoom"`)}); err == nil {
		t.Fatal("unknown autoView accepted")
	}
}

func TestWaitingTabIsOnForOldFiles(t *testing.T) {
	var p Preferences
	if err := json.Unmarshal([]byte(`{"shadows":false}`), &p); err != nil {
		t.Fatal(err)
	}
	if !p.OpenWaitingTab {
		t.Fatalf("waiting tab should default to on: %+v", p)
	}
}

func TestRemovedWaitingSubIsIgnoredInOldFiles(t *testing.T) {
	var p Preferences
	if err := json.Unmarshal([]byte(`{"openWaitingSub":false}`), &p); err != nil {
		t.Fatalf("old file rejected: %v", err)
	}
	if _, err := MergePreferences(DefaultPreferences(), map[string]json.RawMessage{"openWaitingSub": json.RawMessage(`true`)}); err == nil {
		t.Fatal("removed preference accepted in a patch")
	}
}
