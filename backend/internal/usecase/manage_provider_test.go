package usecase_test

import (
	"context"
	"encoding/json"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/yanun0323/Team-Work/internal/model"
	"github.com/yanun0323/Team-Work/internal/model/enum"
	"github.com/yanun0323/Team-Work/internal/usecase"
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
	// it shows under the save_provider line
	pinned := slices.IndexFunc(w.Chats[c.ID].Messages, func(x model.ChatMessage) bool {
		return slices.Equal(x.Made, []model.Made{{Kind: "provider", ID: p.ID}})
	})
	if pinned < 0 || !strings.HasPrefix(w.Chats[c.ID].Messages[pinned].Text, "save_provider ") {
		t.Fatalf("%+v", w.Chats[c.ID].Messages)
	}

	inChat(t, r, m, doing("read_provider", map[string]any{"id": p.ID}))
	if res := lastResult(t, r); res.IsError || strings.Contains(res.Text, "sk-new-9999") || !strings.Contains(res.Text, `"keyHint":"9999"`) {
		t.Fatalf("a key was shown: %s", res.Text)
	}

	inChat(t, r, m, doing("save_provider", map[string]any{"name": "沒 key", "kind": "compatible"}))
	if res := lastResult(t, r); !res.IsError {
		t.Fatalf("%+v", res)
	}
}

func TestChangingAProviderWaitsForTheUser(t *testing.T) {
	r, m := manageRig(t)
	p := providerNamed(r.world(), "p")
	version := versionFrom(t, r, m, "read_provider", p.ID)
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
	if raw, _ := r.e.Snapshot(); strings.Contains(string(raw), "sk-changed") || !strings.Contains(string(raw), `\"api_key\":\"…4321\"`) {
		t.Fatalf("the tool log shows the key: %+v", w.Chats[c.ID].Messages)
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

func TestANewAddressGetsTheStoredKeyOnlyOnceAgreed(t *testing.T) {
	r, m := manageRig(t)
	p := providerNamed(r.world(), "p")
	version := versionFrom(t, r, m, "read_provider", p.ID)
	args := map[string]any{"id": p.ID, "version": version, "base_url": "https://evil.test/v1"}
	sentTo := func() []string {
		var out []string
		for _, a := range r.fake.askedWith("sk-secret-1234") {
			if strings.HasPrefix(a, "https://evil.test") {
				out = append(out, a)
			}
		}
		return out
	}

	c := inChat(t, r, m, doing("save_provider", args))
	r.wait("card", func(w *model.World) bool { return w.Chats[c.ID].Change != nil })
	if got := sentTo(); len(got) > 0 {
		t.Fatalf("the key went to the new address before the user agreed: %v", got)
	}
	if err := r.e.ResolveChatChange(c.ID, false, ""); err != nil {
		t.Fatal(err)
	}
	r.wait("reply after no", func(w *model.World) bool { return w.Chats[c.ID].ReplyAt == nil && w.Chats[c.ID].Change == nil })
	if got := sentTo(); len(got) > 0 || r.world().Providers[p.ID].BaseURL != "" {
		t.Fatalf("refused, yet %v", got)
	}

	c = inChat(t, r, m, doing("save_provider", args))
	r.wait("card", func(w *model.World) bool { return w.Chats[c.ID].Change != nil })
	if err := r.e.ResolveChatChange(c.ID, true, ""); err != nil {
		t.Fatal(err)
	}
	r.wait("written", func(w *model.World) bool { return w.Providers[p.ID].BaseURL == "https://evil.test/v1" })
	deadline := time.Now().Add(5 * time.Second)
	for len(sentTo()) == 0 && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if len(sentTo()) == 0 {
		t.Fatal("the models were not read again after the user agreed")
	}
}

// A typed answer, such as an API key, is asked for in the reply: ask_user is only for picking.
func TestAskingForATypedAnswerInAChat(t *testing.T) {
	r, m := manageRig(t)
	inChat(t, r, m)
	for _, s := range r.fake.requests()[0].Tools {
		if s.Name == "ask_user" && !strings.Contains(s.Description, "type an answer, such as a name or an API key, ask in your reply") {
			t.Fatalf("%s", s.Description)
		}
	}
}

// A provider the settings file would refuse is refused before it is asked for its models, so what is saved loads
// again.
func TestAProviderIsCheckedBeforeItIsAsked(t *testing.T) {
	r, _ := manageRig(t)
	ctx := context.Background()
	key := "sk-check-0000"
	add := func(base string, prices map[string]model.ModelPrice, login string) error {
		_, err := r.e.AddProvider(ctx, usecase.NewProvider{Name: "x", Kind: enum.ProviderCompatible, BaseURL: base, Prices: prices,
			Login: usecase.ProviderLogin{Kind: login, APIKey: key}})
		return err
	}
	for name, err := range map[string]error{
		"userinfo":       add("https://u:p@x.test/v1", nil, "apiKey"),
		"query":          add("https://x.test/v1?k=1", nil, "apiKey"),
		"fragment":       add("https://x.test/v1#a", nil, "apiKey"),
		"not http":       add("ftp://x.test", nil, "apiKey"),
		"negative price": add("https://x.test/v1", map[string]model.ModelPrice{"fake": {Input: -1}}, "apiKey"),
		"unknown login":  add("https://x.test/v1", nil, "token"),
	} {
		if err == nil {
			t.Errorf("%s: added", name)
		}
	}
	if got := r.fake.askedWith(key); len(got) > 0 {
		t.Fatalf("asked before the check: %v", got)
	}

	p := providerNamed(r.world(), "p")
	bad := "https://u:p@x.test/v1"
	if err := r.e.UpdateProvider(ctx, p.ID, usecase.ProviderPatch{BaseURL: &bad}); err == nil {
		t.Fatal("a base url with a password was kept")
	}
	if err := r.e.UpdateProvider(ctx, p.ID, usecase.ProviderPatch{Prices: map[string]model.ModelPrice{"fake": {Output: -2}}}); err == nil {
		t.Fatal("a negative price was kept")
	}
	local := "http://127.0.0.1:11434/v1"
	if err := r.e.UpdateProvider(ctx, p.ID, usecase.ProviderPatch{BaseURL: &local}); err != nil {
		t.Fatalf("a local address was refused: %v", err)
	}
	r.e.Close()
	newEngine(t, r)
	if got := providerNamed(r.world(), "p"); got == nil || got.BaseURL != local {
		t.Fatalf("%+v", got)
	}
}

// A context window is the user's to set only where the kind has none of its own, and it outlives a restart.
func TestAProviderKeepsTheContextWindowSetForIt(t *testing.T) {
	r, _ := manageRig(t)
	ctx := context.Background()
	p := providerNamed(r.world(), "p")
	for _, bad := range []int{7_999, 10_000_001} {
		if err := r.e.UpdateProvider(ctx, p.ID, usecase.ProviderPatch{ContextWindow: ptrTo(bad)}); err == nil {
			t.Fatalf("%d was kept", bad)
		}
	}
	if err := r.e.UpdateProvider(ctx, p.ID, usecase.ProviderPatch{ContextWindow: ptrTo(200_000)}); err != nil {
		t.Fatal(err)
	}
	claude, err := r.e.AddProvider(ctx, usecase.NewProvider{Name: "c", Kind: enum.ProviderAnthropic, ContextWindow: 50_000,
		Login: usecase.ProviderLogin{Kind: "apiKey", APIKey: "sk-ant-0000"}})
	if err != nil {
		t.Fatal(err)
	}
	if claude.ContextWindow != 0 {
		t.Fatalf("anthropic kept %d", claude.ContextWindow)
	}
	r.e.Close()
	newEngine(t, r)
	if got := providerNamed(r.world(), "p").ContextWindow; got != 200_000 {
		t.Fatalf("after a restart: %d", got)
	}
}
