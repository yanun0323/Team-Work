package usecase_test

import (
	"encoding/json"
	"slices"
	"strings"
	"testing"

	"github.com/yanun0323/Team-Work/internal/model"
)

// schema tells the rules and fields of each target and changes nothing: no card, no write, and the tools offered stay
// the same from call to call.
func TestSaveSettingSchemaChangesNothing(t *testing.T) {
	t.Parallel()
	r, m := manageRig(t)
	before := r.world()
	var steps []func(model.ModelRequest) model.ModelReply
	for _, target := range []string{"blueprint", "workflow", "provider", "employees"} {
		steps = append(steps, func(model.ModelRequest) model.ModelReply {
			return call("save_setting", map[string]any{"target": target, "action": "schema"})
		})
	}
	m.add(steps...)
	c := startChat(t, r)
	r.wait("reply", chatDone(c.ID))
	w := r.world()
	if w.Chats[c.ID].Change != nil || len(w.Blueprints) != len(before.Blueprints) || len(w.Workflows) != len(before.Workflows) || len(w.Providers) != len(before.Providers) || len(w.Replicas) != len(before.Replicas) {
		t.Fatal("schema changed something")
	}
	var told []string
	var offered []model.ToolSpec
	for _, req := range r.fake.requests() {
		if !strings.HasPrefix(req.Session, "chat") {
			continue
		}
		if offered == nil {
			offered = req.Tools
		} else if !slices.EqualFunc(offered, req.Tools, func(a, b model.ToolSpec) bool {
			return a.Name == b.Name && a.Description == b.Description && string(a.Parameters) == string(b.Parameters)
		}) {
			t.Fatal("the tools changed between calls")
		}
		for _, msg := range req.Messages {
			for _, b := range msg.Content {
				if b.Name == "save_setting" && b.Text != "" {
					if b.IsError {
						t.Fatalf("%s", b.Text)
					}
					told = append(told, b.Text)
				}
			}
		}
	}
	slices.Sort(told)
	told = slices.Compact(told)
	want := []string{`"prompt"`, `"nodes"`, `"api_key"`, `"blueprint_id"`}
	if len(told) != 4 {
		t.Fatalf("%d answers: %v", len(told), told)
	}
	for _, field := range want {
		if !slices.ContainsFunc(told, func(s string) bool { return strings.Contains(s, field) && strings.Contains(s, "action save") }) {
			t.Fatalf("no schema with %s: %v", field, told)
		}
	}
	// the save_setting spec itself stays short: the targets' fields are not in it
	at := slices.IndexFunc(offered, func(s model.ToolSpec) bool { return s.Name == "save_setting" })
	if at < 0 || strings.Contains(string(offered[at].Parameters), "api_key") || len(offered[at].Description)+len(offered[at].Parameters) > 1200 {
		t.Fatalf("%+v", offered)
	}
}

func TestSaveSettingRefusesWhatIsNotASetting(t *testing.T) {
	t.Parallel()
	r, m := manageRig(t)
	for _, tc := range []struct {
		args map[string]any
		want string
	}{
		{map[string]any{"target": "task", "action": "schema"}, "target must be"},
		{map[string]any{"target": "blueprint", "action": "drop"}, "action must be"},
		{map[string]any{"target": "blueprint", "action": "save"}, "data is required"},
		{map[string]any{"target": "blueprint", "action": "save", "data": "x"}, "data is required"},
	} {
		inChat(t, r, m, doing("save_setting", tc.args))
		if res := lastResult(t, r); !res.IsError || !strings.Contains(res.Text, tc.want) {
			t.Fatalf("%v: %+v", tc.args, res)
		}
	}
}

// A change saved before save_setting replaced save_blueprint waits on a call by the old name; agreeing or refusing
// still answers it and writes, or not, as before.
func TestChangeWaitingOnAnOldToolNameIsStillAnswered(t *testing.T) {
	t.Parallel()
	for _, agreed := range []bool{true, false} {
		r, m := manageRig(t)
		id := r.owner.BlueprintID
		version := versionFrom(t, r, m, "read_blueprint", id)
		c := inChat(t, r, m, doing("save_blueprint", map[string]any{"id": id, "version": version, "prompt": "舊卡"}))
		r.wait("card", func(w *model.World) bool { return w.Chats[c.ID].Change != nil })
		r.e.RenameWaitingCall(c.ID, "save_blueprint")
		if err := r.e.ResolveChatChange(c.ID, agreed, ""); err != nil {
			t.Fatal(err)
		}
		r.wait("reply", func(w *model.World) bool { return w.Chats[c.ID].ReplyAt == nil && w.Chats[c.ID].Change == nil })
		res := lastResult(t, r)
		if res.Name != "save_blueprint" || res.IsError == agreed || agreed && !strings.Contains(res.Text, "agreed") || !agreed && !strings.Contains(res.Text, "refused") {
			t.Fatalf("agreed %v: %+v", agreed, res)
		}
		if got := r.world().Blueprints[id].Prompt; (got == "舊卡") != agreed {
			t.Fatalf("agreed %v: prompt %q", agreed, got)
		}
	}
}

// A key given deep in save_setting's data shows only by its last 4 characters, in the chat and in the conversation's
// tool line alike.
func TestSaveSettingMasksNestedSecrets(t *testing.T) {
	t.Parallel()
	r, m := manageRig(t)
	args := map[string]any{"name": "新供應商", "kind": "compatible", "base_url": "https://x.test/v1", "api_key": "sk-new-9999",
		"extra": []any{map[string]any{"token": "tok-SECRET-1234"}, map[string]any{"password": "pw-SECRET-5678", "secret": map[string]any{"x": "deep-SECRET-abcd"}}}}
	c := inChat(t, r, m, doing("save_provider", args))
	raw, _ := json.Marshal(r.world().Chats[c.ID].Messages)
	text := string(raw)
	if strings.Contains(text, "sk-new") || strings.Contains(text, "SECRET") {
		t.Fatalf("%s", text)
	}
	for _, tail := range []string{"…9999", "…1234", "…5678", "…abcd"} {
		if !strings.Contains(text, tail) {
			t.Fatalf("%s missing in %s", tail, text)
		}
	}
}
