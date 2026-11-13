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

func TestMapClick(t *testing.T) {
	for raw, want := range map[string]string{
		`{"shadows":false}`:                          "sheets",
		`{"mapClickLeaves":true}`:                    "sheets",
		`{"mapClickLeaves":false}`:                   "sheets",
		`{"mapClickLeaves":false,"mapClick":"home"}`: "home",
	} {
		var p Preferences
		if err := json.Unmarshal([]byte(raw), &p); err != nil || p.MapClick != want {
			t.Fatalf("%s: %v %q", raw, err, p.MapClick)
		}
	}
	next, err := MergePreferences(DefaultPreferences(), map[string]json.RawMessage{"mapClick": json.RawMessage(`"home"`)})
	if err != nil || next.MapClick != "home" {
		t.Fatalf("%v %+v", err, next)
	}
	if _, err := MergePreferences(DefaultPreferences(), map[string]json.RawMessage{"mapClick": json.RawMessage(`"off"`)}); err == nil {
		t.Fatal("mapClick off accepted")
	}
	if _, err := MergePreferences(DefaultPreferences(), map[string]json.RawMessage{"mapClickLeaves": json.RawMessage(`false`)}); err == nil {
		t.Fatal("the old field is only read from files")
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

func TestIdleFollow(t *testing.T) {
	var p Preferences
	if err := json.Unmarshal([]byte(`{"shadows":false}`), &p); err != nil {
		t.Fatal(err)
	}
	if p.IdleFollow != 15 {
		t.Fatalf("a file from before this preference should wait 15 seconds, got %d", p.IdleFollow)
	}
	for _, ok := range []string{`0`, `5`, `15`, `10800`} {
		if _, err := MergePreferences(p, map[string]json.RawMessage{"idleFollow": json.RawMessage(ok)}); err != nil {
			t.Fatalf("idleFollow %s refused: %v", ok, err)
		}
	}
	for _, bad := range []string{`-1`, `10`, `61`, `86400`, `"60"`} {
		if _, err := MergePreferences(p, map[string]json.RawMessage{"idleFollow": json.RawMessage(bad)}); err == nil {
			t.Fatalf("idleFollow %s accepted", bad)
		}
	}
	// files written while 10 seconds was a choice take the nearest one now
	if err := json.Unmarshal([]byte(`{"idleFollow":10}`), &p); err != nil || p.IdleFollow != 15 {
		t.Fatalf("%v %d", err, p.IdleFollow)
	}
}

func TestIdleFollowTarget(t *testing.T) {
	var p Preferences
	if err := json.Unmarshal([]byte(`{"idleFollow":30}`), &p); err != nil {
		t.Fatal(err)
	}
	if p.IdleFollowTarget != "map" {
		t.Fatalf("old files must default to map people: %+v", p)
	}
	for _, choice := range []string{`"map"`, `"all"`} {
		next, err := MergePreferences(p, map[string]json.RawMessage{"idleFollowTarget": json.RawMessage(choice)})
		if err != nil || `"`+next.IdleFollowTarget+`"` != choice || next.IdleFollow != 30 {
			t.Fatalf("%s: %+v %v", choice, next, err)
		}
	}
	for _, bad := range []string{`""`, `"crew"`, `true`, `null`, `1`} {
		if _, err := MergePreferences(p, map[string]json.RawMessage{"idleFollowTarget": json.RawMessage(bad)}); err == nil {
			t.Fatalf("accepted %s", bad)
		}
	}
}

func TestSemanticSearchIsOffByDefaultAndForOldFiles(t *testing.T) {
	if DefaultPreferences().SemanticSearch {
		t.Fatal("semantic search is on by default")
	}
	var p Preferences
	if err := json.Unmarshal([]byte(`{"shadows":false}`), &p); err != nil || p.SemanticSearch {
		t.Fatalf("%v %+v", err, p)
	}
	next, err := MergePreferences(p, map[string]json.RawMessage{"semanticSearch": json.RawMessage(`true`)})
	if err != nil || !next.SemanticSearch {
		t.Fatalf("%v %+v", err, next)
	}
	for _, bad := range []string{`null`, `"yes"`, `1`} {
		if _, err := MergePreferences(p, map[string]json.RawMessage{"semanticSearch": json.RawMessage(bad)}); err == nil {
			t.Fatalf("%s was accepted", bad)
		}
	}
}
