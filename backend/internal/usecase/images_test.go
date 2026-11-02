package usecase_test

import (
	"context"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/yanun0323/mho-company/internal/adapter"
	"github.com/yanun0323/mho-company/internal/model"
	"github.com/yanun0323/mho-company/internal/model/enum"
	"github.com/yanun0323/mho-company/internal/usecase"
)

func toolNames(req model.ModelRequest) []string {
	var names []string
	for _, t := range req.Tools {
		names = append(names, t.Name)
	}
	return names
}

func TestImageProviderFollowsTheProviders(t *testing.T) {
	r := newRig(t, func(model.ModelRequest) (model.ModelReply, error) { return call("submit_handoff", handoff), nil })
	ctx := context.Background()
	imageProvider := func() string { return r.world().Preferences.ImageProvider }

	first, err := r.e.AddProvider(ctx, usecase.NewProvider{Name: "a", Kind: enum.ProviderOpenAI, Login: usecase.ProviderLogin{Kind: "subscription"}, ImageDefault: true})
	if err != nil {
		t.Fatal(err)
	}
	if got := imageProvider(); got != first.ID {
		t.Fatalf("image provider %q, want %q", got, first.ID)
	}
	// unchecked, a second subscription leaves the first one drawing
	second, err := r.e.AddProvider(ctx, usecase.NewProvider{Name: "b", Kind: enum.ProviderOpenAI, Login: usecase.ProviderLogin{Kind: "subscription"}})
	if err != nil {
		t.Fatal(err)
	}
	if got := imageProvider(); got != first.ID {
		t.Fatalf("image provider %q, want %q", got, first.ID)
	}
	// only a ChatGPT subscription can draw
	claude, err := r.e.AddProvider(ctx, usecase.NewProvider{Name: "c", Kind: enum.ProviderAnthropic, Login: usecase.ProviderLogin{Kind: "subscription"}, ImageDefault: true})
	if err != nil {
		t.Fatal(err)
	}
	if got := imageProvider(); got != first.ID {
		t.Fatalf("a Claude subscription took images: %q", got)
	}
	if err := r.e.UpdatePreferences(map[string]json.RawMessage{"imageProvider": json.RawMessage(`"` + claude.ID + `"`)}); err == nil {
		t.Fatal("a Claude subscription was set to draw")
	}

	yes, no := true, false
	if err := r.e.UpdateProvider(ctx, second.ID, usecase.ProviderPatch{ImageDefault: &yes}); err != nil {
		t.Fatal(err)
	}
	if got := imageProvider(); got != second.ID {
		t.Fatalf("image provider %q, want %q", got, second.ID)
	}
	// unchecking another provider changes nothing
	if err := r.e.UpdateProvider(ctx, first.ID, usecase.ProviderPatch{ImageDefault: &no}); err != nil {
		t.Fatal(err)
	}
	if got := imageProvider(); got != second.ID {
		t.Fatalf("image provider %q, want %q", got, second.ID)
	}
	if err := r.e.UpdateProvider(ctx, second.ID, usecase.ProviderPatch{ImageDefault: &no}); err != nil {
		t.Fatal(err)
	}
	if got := imageProvider(); got != "" {
		t.Fatalf("image provider %q after unchecking it", got)
	}

	if err := r.e.UpdatePreferences(map[string]json.RawMessage{"imageProvider": json.RawMessage(`"` + first.ID + `"`)}); err != nil {
		t.Fatal(err)
	}
	if err := r.e.DeleteProvider(ctx, first.ID); err != nil {
		t.Fatal(err)
	}
	if got := imageProvider(); got != "" {
		t.Fatalf("image provider %q after deleting it", got)
	}
}

func TestImageGenGoesToEveryEmployeeOnceSignedIn(t *testing.T) {
	r := newRig(t, func(model.ModelRequest) (model.ModelReply, error) { return call("submit_handoff", handoff), nil })
	ctx := context.Background()

	task := r.task(r.flow.ID)
	r.wait("await merge", stage(task.ID, enum.StageAwaitMerge))
	r.fake.mu.Lock()
	before := toolNames(r.fake.seen[0])
	r.fake.login = &adapter.LoginFlow{Wait: func(context.Context) error { return nil }, Paste: func(string) error { return nil }}
	r.fake.mu.Unlock()
	if slices.Contains(before, "image_gen") {
		t.Fatal("image_gen offered with no image provider")
	}

	// the employee runs on an API key; the subscription only draws
	p, err := r.e.AddProvider(ctx, usecase.NewProvider{Name: "ChatGPT", Kind: enum.ProviderOpenAI, Login: usecase.ProviderLogin{Kind: "subscription"}, ImageDefault: true})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := r.e.StartLogin(ctx, p.ID, ""); err != nil {
		t.Fatal(err)
	}
	r.wait("signed in", func(w *model.World) bool { return w.Providers[p.ID].Auth.SignedIn })
	r.fake.mu.Lock()
	r.fake.seen = nil
	r.fake.mu.Unlock()
	task = r.task(r.flow.ID)
	r.wait("await merge", stage(task.ID, enum.StageAwaitMerge))
	r.fake.mu.Lock()
	after := toolNames(r.fake.seen[0])
	r.fake.mu.Unlock()
	if !slices.Contains(after, "image_gen") {
		t.Fatalf("image_gen missing: %v", after)
	}
}

// drawWith signs in a ChatGPT subscription and makes it the image provider.
func drawWith(t *testing.T, r *rig) {
	t.Helper()
	ctx := context.Background()
	r.fake.mu.Lock()
	r.fake.login = &adapter.LoginFlow{Wait: func(context.Context) error { return nil }, Paste: func(string) error { return nil }}
	r.fake.mu.Unlock()
	p, err := r.e.AddProvider(ctx, usecase.NewProvider{Name: "ChatGPT", Kind: enum.ProviderOpenAI, Login: usecase.ProviderLogin{Kind: "subscription"}, ImageDefault: true})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := r.e.StartLogin(ctx, p.ID, ""); err != nil {
		t.Fatal(err)
	}
	r.wait("signed in", func(w *model.World) bool { return w.Providers[p.ID].Auth.SignedIn })
}

func TestChatShowsTheImageItDrew(t *testing.T) {
	calls := 0
	r := newRig(t, func(req model.ModelRequest) (model.ModelReply, error) {
		calls++
		if calls == 1 {
			return call("image_gen", map[string]any{"prompt": "a cat", "output_path": "art/cat.png"}), nil
		}
		return say("畫好了"), nil
	})
	drawWith(t, r)
	c, err := r.e.CreateChat(usecase.NewChat{TeamID: r.team.ID, ReplicaID: r.owner.ID, Text: "畫一隻貓"})
	if err != nil {
		t.Fatal(err)
	}
	r.wait("reply", chatDone(c.ID))
	var shown *model.ChatMessage
	for _, m := range r.world().Chats[c.ID].Messages {
		if m.From == "tool" && len(m.Images) == 1 {
			shown = &m
		}
	}
	if shown == nil || shown.Text != "art/cat.png" || shown.Images[0].Name != "cat.png" {
		t.Fatalf("no picture in the chat: %+v", r.world().Chats[c.ID].Messages)
	}
	// the chat keeps its own copy, apart from the file in the folder
	if err := os.Remove(filepath.Join(r.folder, "art", "cat.png")); err != nil {
		t.Fatal(err)
	}
	f, err := r.e.UploadFile(strings.TrimPrefix(shown.Images[0].URL, "/api/v1/attachments/"))
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	if raw, _ := io.ReadAll(f); !strings.HasPrefix(string(raw), "\x89PNG") {
		t.Fatalf("the copy is no PNG: %q", raw)
	}
}

func TestHandedImageReadsTheCommit(t *testing.T) {
	r := newRig(t, func(req model.ModelRequest) (model.ModelReply, error) {
		if lastIsResult(req) {
			return call("submit_handoff", handoff), nil
		}
		if stepOf(req) == "Clarify requirements" {
			return call("image_gen", map[string]any{"prompt": "a logo", "output_path": "docs/logo.png"}), nil
		}
		return call("submit_handoff", handoff), nil
	})
	drawWith(t, r)
	task := r.task(r.flow.ID)
	w := r.wait("await merge", stage(task.ID, enum.StageAwaitMerge))
	sub := subAt(w, task.ID, "整理需求")
	ctx := context.Background()
	data, kind, err := r.e.HandedImage(ctx, sub.ID, "docs/logo.png")
	if err != nil || kind != "image/png" || !strings.HasPrefix(string(data), "\x89PNG") {
		t.Fatalf("kind %q err %v", kind, err)
	}
	for _, path := range []string{"missing.png", "../secret.png", "/etc/hosts", ""} {
		if _, _, err := r.e.HandedImage(ctx, sub.ID, path); err == nil {
			t.Errorf("%q read", path)
		}
	}
}
