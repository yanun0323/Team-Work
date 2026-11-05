package usecase

import (
	"strings"
	"testing"

	"github.com/yanun0323/Team-Work/internal/model"
)

// The notes a model writes between tool calls are shown in the chat, so the language rule must cover them too.
func TestLanguageRuleCoversNotesBetweenToolCalls(t *testing.T) {
	rule := languageRule(model.LanguageZh)
	for _, want := range []string{"Traditional Chinese", "between tool calls"} {
		if !strings.Contains(rule, want) {
			t.Errorf("languageRule(zh) = %q, want it to mention %q", rule, want)
		}
	}
}
