package usecase

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/yanun0323/Team-Work/internal/model"
)

// Findings left in the model's thinking never reach the user, so every employee must be told to write them out.
func TestEveryEmployeeIsToldTheUserCannotSeeTheirThinking(t *testing.T) {
	for name, rules := range map[string]string{"task step": systemRules, "chat": chatRules, "airport chat": airportChatRules} {
		if !strings.Contains(rules, unseenThinkingRule) {
			t.Errorf("%s rules lack unseenThinkingRule", name)
		}
	}
}

// The model decides what to ask while filling in the prompt, so the reminder to spell out its findings sits on that field.
func TestAskUserPromptMustMakeSenseOnItsOwn(t *testing.T) {
	var schema struct {
		Properties map[string]struct {
			Description string `json:"description"`
		} `json:"properties"`
	}
	if err := json.Unmarshal([]byte(askUserSchema), &schema); err != nil {
		t.Fatalf("askUserSchema is not valid JSON: %v", err)
	}
	if got := schema.Properties["prompt"].Description; got != askPromptHow {
		t.Errorf("prompt description = %q, want askPromptHow", got)
	}
}

// The notes a model writes between tool calls are shown in the chat, so the language rule must cover them too.
func TestLanguageRuleCoversNotesBetweenToolCalls(t *testing.T) {
	rule := languageRule(model.LanguageZh)
	for _, want := range []string{"Traditional Chinese", "between tool calls"} {
		if !strings.Contains(rule, want) {
			t.Errorf("languageRule(zh) = %q, want it to mention %q", rule, want)
		}
	}
}
