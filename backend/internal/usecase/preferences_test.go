package usecase_test

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/yanun0323/Team-Work/internal/model"
	"github.com/yanun0323/Team-Work/internal/usecase"
)

func TestSharedPreferencesAndPlots(t *testing.T) {
	t.Parallel()
	r := newRig(t, func(model.ModelRequest) (model.ModelReply, error) { return say("ok"), nil })
	_, events, cancel, err := r.e.Subscribe()
	if err != nil {
		t.Fatal(err)
	}
	defer cancel()
	patch := map[string]json.RawMessage{"idleFollowTarget": json.RawMessage(`"all"`), "musicStyle": json.RawMessage(`"bossa"`), "soundNotice": json.RawMessage(`false`), "musicVolume": json.RawMessage(`0`), "effectsVolume": json.RawMessage(`73`), "soundTakeoff": json.RawMessage(`false`), "defaultAirportTab": json.RawMessage(`"sound"`), "shadows": json.RawMessage(`false`), "defaultTab": json.RawMessage(`"crew"`)}
	if err := r.e.UpdatePreferences(patch); err != nil {
		t.Fatal(err)
	}
	select {
	case ev := <-events:
		found := false
		for _, p := range ev.Upserts {
			if p.Kind == "preferences" {
				found = true
			}
		}
		if !found {
			t.Fatalf("preferences not broadcast: %+v", ev)
		}
	case <-time.After(time.Second):
		t.Fatal("no preference event")
	}
	plot := &model.Plot{At: []int{10, 10}, Style: "villa", Seed: 123}
	if err := r.e.UpdateTeam(r.team.ID, usecase.TeamPatch{Plot: plot}); err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(filepath.Join(r.data, "preferences.yaml"))
	if err != nil || !strings.Contains(string(raw), "shadows: false") || !strings.Contains(string(raw), "idleFollowTarget: all") {
		t.Fatalf("preferences YAML: %s %v", raw, err)
	}
	docs, err := r.store.LoadDocs(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, d := range docs {
		if d.Kind == "preferences" || strings.Contains(string(d.Data), "defaultTab") {
			t.Fatal("preferences duplicated in SQLite")
		}
		if d.Kind == "team" && d.ID == r.team.ID {
			found = strings.Contains(string(d.Data), `"seed":123`)
		}
	}
	if !found {
		t.Fatal("plot not stored in SQLite")
	}
	snapshot, err := r.store.LoadSettings(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(snapshot.Data), `"plot"`) {
		t.Fatal("plot leaked into configuration")
	}
	r.e.Close()
	newEngine(t, r)
	w := r.world()
	if w.Preferences.IdleFollowTarget != "all" || w.Preferences.MusicStyle != "bossa" || w.Preferences.SoundNotice || w.Preferences.MusicVolume != 0 || w.Preferences.EffectsVolume != 73 || w.Preferences.SoundTakeoff || !w.Preferences.SoundLanding || w.Preferences.DefaultAirportTab != "prefs" || w.Preferences.Shadows || w.Preferences.DefaultTab != "crew" || !reflect.DeepEqual(w.Teams[r.team.ID].Plot, plot) {
		t.Fatalf("restart lost preferences or plot: %+v %+v", w.Preferences, w.Teams[r.team.ID].Plot)
	}
	if err := r.e.DeleteTeam(r.team.ID); err != nil {
		t.Fatal(err)
	}
	r.e.Close()
	newEngine(t, r)
	if r.world().Teams[r.team.ID] != nil {
		t.Fatal("deleted company and plot returned")
	}
}

func TestPreferencesReloadDefaultsValidationAndConflict(t *testing.T) {
	t.Parallel()
	r := newRig(t, func(model.ModelRequest) (model.ModelReply, error) { return say("ok"), nil })
	path := filepath.Join(r.data, "preferences.yaml")
	write := func(raw string) {
		t.Helper()
		if err := os.WriteFile(path, []byte(raw), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	write("shadows: false\ndefaultAirportTab: about\n")
	if err := r.e.UpdatePreferences(map[string]json.RawMessage{"clouds": json.RawMessage(`false`)}); err == nil {
		t.Fatal("overwrote external edit")
	}
	if err := r.e.ReloadSettings(context.Background()); err != nil {
		t.Fatal(err)
	}
	want := model.DefaultPreferences()
	want.Shadows, want.DefaultAirportTab = false, "about"
	if !reflect.DeepEqual(r.world().Preferences, want) {
		t.Fatalf("partial YAML lost defaults: %+v", r.world().Preferences)
	}
	for _, invalid := range []string{"shadows: null\n", "shadows: nope\n", "defaultTab: nope\n", "typo: true\n", "null\n"} {
		write(invalid)
		if err := r.e.ReloadSettings(context.Background()); err == nil {
			t.Fatalf("accepted %q", invalid)
		}
		if !reflect.DeepEqual(r.world().Preferences, want) {
			t.Fatal("invalid reload changed live preferences")
		}
	}
	write("shadows: false\ndefaultAirportTab: about\n")
	if err := r.e.UpdatePreferences(map[string]json.RawMessage{"clouds": json.RawMessage(`false`)}); err != nil {
		t.Fatal(err)
	}
	if r.world().Preferences.Shadows || r.world().Preferences.Clouds {
		t.Fatal("partial patch lost existing values")
	}
}
