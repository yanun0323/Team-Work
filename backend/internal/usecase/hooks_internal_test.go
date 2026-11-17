package usecase

import (
	"encoding/json"
	"testing"
)

// A hook's updatedInput changes only the arguments it gives: one written for Codex or Claude Code returns just the
// command, and the call keeps the rest, such as running in the background.
func TestHookInputKeepsWhatTheHookLeftOut(t *testing.T) {
	for _, tc := range []struct{ name, args, updated, want string }{
		{"command alone", `{"command":"go test ./...","background":true,"timeout":60}`, `{"command":"rtk go test ./..."}`,
			`{"background":true,"command":"rtk go test ./...","timeout":60}`},
		{"a value the hook changes", `{"command":"ls","timeout":60}`, `{"command":"ls","timeout":5}`, `{"command":"ls","timeout":5}`},
		{"a value the hook clears", `{"command":"ls","background":true}`, `{"command":"ls","background":null}`, `{"command":"ls"}`},
		{"file_path is the path", `{"path":"a.txt","content":"x"}`, `{"file_path":"/w/b.txt"}`, `{"content":"x","path":"/w/b.txt"}`},
		{"a tool's own file_path", `{"file_path":"a.txt","content":"x"}`, `{"file_path":"b.txt"}`, `{"content":"x","file_path":"b.txt"}`},
		{"not an object", `{"command":"ls"}`, `"ls"`, `"ls"`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got := fromHookInput(json.RawMessage(tc.args), json.RawMessage(tc.updated))
			if string(got) != tc.want {
				t.Fatalf("got %s, want %s", got, tc.want)
			}
		})
	}
}
