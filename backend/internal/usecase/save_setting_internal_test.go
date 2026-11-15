package usecase

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/yanun0323/Team-Work/internal/model"
)

// Only the round's actor writes settings in a meeting, under the new name and the old ones alike.
func TestSaveSettingActsOutsideTheMeeting(t *testing.T) {
	for _, name := range []string{toolSaveSetting, toolSaveBlueprint, toolSaveWorkflow, toolSaveProvider, toolSaveEmployees} {
		if !actsOutside(name) || !isChangeTool(name) {
			t.Fatal(name)
		}
	}
	if isChangeTool("read_blueprint") {
		t.Fatal("read_blueprint waits for the user")
	}
}

// Secrets are hidden wherever they are in the arguments, in a task's log as in a chat: nested in objects, in arrays,
// and as a whole object under a secret's name.
func TestToolLineMasksNestedSecrets(t *testing.T) {
	raw, _ := json.Marshal(map[string]any{"target": "provider", "action": "save", "data": map[string]any{
		"api_key": "sk-live-SECRET9999", "list": []any{map[string]any{"token": "tok-SECRET1234"}, "plain"},
		"password": map[string]any{"a": "pw-SECRET5678", "b": []any{"x-SECRET0000"}}, "Client-Secret": "cs-SECRETabcd"}})
	line := toolLine(model.Block{Name: toolSaveSetting, Args: raw})
	if strings.Contains(line, "SECRET") || !strings.HasPrefix(line, `save_setting {"target":"provider","action":"save","data":`) {
		t.Fatal(line)
	}
	for _, tail := range []string{"…9999", "…1234", "…5678", "…0000", "…abcd", `"plain"`} {
		if !strings.Contains(line, tail) {
			t.Fatalf("%s missing: %s", tail, line)
		}
	}
	// any tool, nested or not
	line = toolLine(model.Block{Name: "x", Args: json.RawMessage(`[{"a":{"secret":"s-SECRET7777"}}]`)})
	if strings.Contains(line, "SECRET") || !strings.Contains(line, "…7777") {
		t.Fatal(line)
	}
	if got := maskSecrets([]byte(`{"path":"a"}`)); got != `{"path":"a"}` {
		t.Fatal(got)
	}
}
