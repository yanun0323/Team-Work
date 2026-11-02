package usecase_test

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/yanun0323/mho-company/internal/model"
)

func providerNamed(w *model.World, name string) *model.ModelProvider {
	for _, p := range w.Providers {
		if p.Name == name {
			return p
		}
	}
	return nil
}

func secretOf(t *testing.T, r *rig, id string) string {
	t.Helper()
	secrets, err := r.store.LoadSecrets(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	return secrets[id]
}

func TestAddingAProviderTakesEffectAtOnce(t *testing.T) {
	r, m := manageRig(t)
	c := inChat(t, r, m, doing("save_provider", map[string]any{"name": "新供應商", "kind": "compatible", "base_url": "https://x.test/v1", "api_key": "sk-new-9999"}))
	if res := lastResult(t, r); res.IsError || !strings.Contains(res.Text, "fake") {
		t.Fatalf("%+v", res)
	}
	w := r.world()
	if w.Chats[c.ID].Change != nil {
		t.Fatal("adding asked for a confirmation")
	}
	p := providerNamed(w, "新供應商")
	if p == nil || p.Auth.Kind != "apiKey" || p.Auth.KeyHint != "9999" || p.BaseURL != "https://x.test/v1" {
		t.Fatalf("%+v", p)
	}
	if got := secretOf(t, r, p.ID); got != "sk-new-9999" {
		t.Fatalf("key %q", got)
	}

	inChat(t, r, m, doing("list_providers", map[string]any{}))
	if res := lastResult(t, r); strings.Contains(res.Text, "sk-new-9999") || strings.Contains(res.Text, "sk-secret-1234") {
		t.Fatalf("a key was listed: %s", res.Text)
	}

	inChat(t, r, m, doing("save_provider", map[string]any{"name": "沒 key", "kind": "compatible"}))
	if res := lastResult(t, r); !res.IsError {
		t.Fatalf("%+v", res)
	}
}

func TestChangingAProviderWaitsForTheUser(t *testing.T) {
	r, m := manageRig(t)
	p := providerNamed(r.world(), "p")
	version := versionFrom(t, r, m, "list_providers", p.ID)
	args := map[string]any{"id": p.ID, "version": version, "name": "改名", "api_key": "sk-changed-4321"}

	c := inChat(t, r, m, doing("save_provider", args))
	w := r.wait("card", func(w *model.World) bool { return w.Chats[c.ID].Change != nil })
	card := w.Chats[c.ID].Change
	if w.Providers[p.ID].Name != "p" || secretOf(t, r, p.ID) != "sk-secret-1234" {
		t.Fatal("written before agreeing")
	}
	if raw, _ := json.Marshal(card); strings.Contains(string(raw), "sk-changed-4321") {
		t.Fatal("the card holds the new key")
	}
	fields := []string{}
	for _, l := range card.Lines {
		fields = append(fields, l.Field)
	}
	if strings.Join(fields, ",") != "name,apiKey" || card.Lines[1].Before != "…1234" || card.Lines[1].After != "…4321" {
		t.Fatalf("%+v", card.Lines)
	}

	// no: nothing changes
	if err := r.e.ResolveChatChange(c.ID, false, ""); err != nil {
		t.Fatal(err)
	}
	r.wait("reply after no", func(w *model.World) bool { return w.Chats[c.ID].ReplyAt == nil && w.Chats[c.ID].Change == nil })
	if got := r.world().Providers[p.ID]; got.Name != "p" || secretOf(t, r, p.ID) != "sk-secret-1234" {
		t.Fatalf("%+v", got)
	}

	// yes: written, key and all
	c = inChat(t, r, m, doing("save_provider", args))
	r.wait("card", func(w *model.World) bool { return w.Chats[c.ID].Change != nil })
	if err := r.e.ResolveChatChange(c.ID, true, ""); err != nil {
		t.Fatal(err)
	}
	r.wait("reply after yes", func(w *model.World) bool { return w.Chats[c.ID].ReplyAt == nil && w.Chats[c.ID].Change == nil })
	if res := lastResult(t, r); res.IsError || !strings.Contains(res.Text, "agreed") {
		t.Fatalf("%+v", res)
	}
	if got := r.world().Providers[p.ID]; got.Name != "改名" || got.Auth.KeyHint != "4321" || secretOf(t, r, p.ID) != "sk-changed-4321" {
		t.Fatalf("%+v", got)
	}

	// an old version is refused
	inChat(t, r, m, doing("save_provider", args))
	if res := lastResult(t, r); !res.IsError || !strings.Contains(res.Text, "version") {
		t.Fatalf("%+v", res)
	}
}

func TestAskingForATypedAnswerInAChat(t *testing.T) {
	r, m := manageRig(t)
	c := inChat(t, r, m, doing("ask_user", map[string]any{"prompt": "API Key 是什麼？"}))
	w := r.wait("question", func(w *model.World) bool { return w.Chats[c.ID].Question != nil })
	if q := w.Chats[c.ID].Question; len(q.Options) != 0 {
		t.Fatalf("%+v", q)
	}
	for _, s := range r.fake.requests()[0].Tools {
		if s.Name == "ask_user" && !strings.Contains(s.Description, "type an answer") {
			t.Fatalf("%s", s.Description)
		}
	}
}
