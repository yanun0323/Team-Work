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

func TestSystemNoticesAreOnForOldFiles(t *testing.T) {
	var p Preferences
	if err := json.Unmarshal([]byte(`{"shadows":false}`), &p); err != nil {
		t.Fatal(err)
	}
	if !p.SystemNotices {
		t.Fatal("a file from before this preference should send system notices")
	}
	next, err := MergePreferences(p, map[string]json.RawMessage{"systemNotices": json.RawMessage(`false`)})
	if err != nil || next.SystemNotices {
		t.Fatalf("%v %+v", err, next)
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

func TestBusyAnimation(t *testing.T) {
	var p Preferences
	if err := json.Unmarshal([]byte(`{"shadows":false}`), &p); err != nil || p.BusyAnimation != "money" {
		t.Fatalf("old file: busyAnimation %q, err %v", p.BusyAnimation, err)
	}
	next, err := MergePreferences(p, map[string]json.RawMessage{"busyAnimation": json.RawMessage(`"shout"`)})
	if err != nil || next.BusyAnimation != "shout" {
		t.Fatalf("shout: %q, err %v", next.BusyAnimation, err)
	}
	if next, err := MergePreferences(p, map[string]json.RawMessage{"busyAnimation": json.RawMessage(`"off"`)}); err != nil || next.BusyAnimation != "off" {
		t.Fatalf("off: %q, err %v", next.BusyAnimation, err)
	}
	if _, err := MergePreferences(p, map[string]json.RawMessage{"busyAnimation": json.RawMessage(`"confetti"`)}); err == nil {
		t.Fatal("unknown busyAnimation accepted")
	}
}

func TestDaylight(t *testing.T) {
	var p Preferences
	if err := json.Unmarshal([]byte(`{"shadows":false}`), &p); err != nil || p.Daylight != "minecraft" {
		t.Fatalf("old file: daylight %q, err %v", p.Daylight, err)
	}
	for _, mode := range []string{"real", "minecraft", "day", "night"} {
		next, err := MergePreferences(p, map[string]json.RawMessage{"daylight": json.RawMessage(`"` + mode + `"`)})
		if err != nil || next.Daylight != mode {
			t.Fatalf("%s: %q, err %v", mode, next.Daylight, err)
		}
	}
	if _, err := MergePreferences(p, map[string]json.RawMessage{"daylight": json.RawMessage(`"dusk"`)}); err == nil {
		t.Fatal("unknown daylight accepted")
	}
}

func TestAutoTab(t *testing.T) {
	for raw, want := range map[string]string{
		`{"shadows":false}`:                          "chats",
		`{"openWaitingTab":true}`:                    "chats",
		`{"openWaitingTab":false}`:                   "off",
		`{"openWaitingTab":false,"autoTab":"chats"}`: "chats",
	} {
		var p Preferences
		if err := json.Unmarshal([]byte(raw), &p); err != nil {
			t.Fatalf("%s: %v", raw, err)
		}
		if p.AutoTab != want {
			t.Errorf("%s: autoTab %q, want %q", raw, p.AutoTab, want)
		}
	}
	if _, err := MergePreferences(DefaultPreferences(), map[string]json.RawMessage{"autoTab": json.RawMessage(`"crew"`)}); err == nil {
		t.Fatal("unknown autoTab accepted")
	}
	if _, err := MergePreferences(DefaultPreferences(), map[string]json.RawMessage{"openWaitingTab": json.RawMessage(`true`)}); err == nil {
		t.Fatal("removed preference accepted in a patch")
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

func TestCompactSharesStayInRange(t *testing.T) {
	var p Preferences
	if err := json.Unmarshal([]byte(`{"shadows":false}`), &p); err != nil {
		t.Fatal(err)
	}
	if p.Compact1M != 40 || p.Compact256K != 90 || p.Compact128K != 95 || p.CompactSmall != 95 {
		t.Fatalf("defaults for an old file: %+v", p)
	}
	for _, c := range []struct{ window, share int }{{1_000_000, 40}, {999_999, 90}, {256_000, 90}, {255_999, 95}, {128_000, 95}, {127_999, 95}} {
		if got := p.CompactShare(c.window); got != c.share {
			t.Errorf("CompactShare(%d) = %d", c.window, got)
		}
	}
	for _, bad := range []string{`9`, `101`} {
		if _, err := MergePreferences(p, map[string]json.RawMessage{"compact1M": json.RawMessage(bad)}); err == nil {
			t.Fatalf("compact1M %s accepted", bad)
		}
	}
	if next, err := MergePreferences(p, map[string]json.RawMessage{"compactSmall": json.RawMessage(`60`)}); err != nil || next.CompactSmall != 60 {
		t.Fatalf("%v %+v", err, next)
	}
}

func TestContextWindowOfEachKind(t *testing.T) {
	for _, c := range []struct {
		p    ModelProvider
		want int
	}{
		{ModelProvider{Kind: "anthropic", ContextWindow: 50_000}, 1_000_000},
		{ModelProvider{Kind: "openai"}, 272_000},
		{ModelProvider{Kind: "google", ContextWindow: 200_000}, 200_000},
		{ModelProvider{Kind: "compatible"}, 128_000},
	} {
		if got := ContextWindow(c.p); got != c.want {
			t.Errorf("%s: %d", c.p.Kind, got)
		}
	}
}
