package usecase

import (
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

// The notes a model writes between tool calls are shown in the chat, so the language rule must cover them too.
func TestLanguageRuleCoversNotesBetweenToolCalls(t *testing.T) {
	rule := languageRule(model.LanguageZh)
	for _, want := range []string{"Traditional Chinese", "between tool calls"} {
		if !strings.Contains(rule, want) {
			t.Errorf("languageRule(zh) = %q, want it to mention %q", rule, want)
		}
	}
}
