package usecase

import (
	"encoding/json"
	"slices"
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

// This checks the instructions sent to the model, not whether a model follows them.
func TestChatAskUserDescriptionRequiresAnAnswerBeforeChoices(t *testing.T) {
	e := &Engine{}
	spec := e.chatAskUser(chatRun{}).Spec()
	var schema struct {
		Properties map[string]struct {
			Description string `json:"description"`
		} `json:"properties"`
		Required []string `json:"required"`
	}
	if err := json.Unmarshal(spec.Parameters, &schema); err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(schema.Required, []string{"reply", "options"}) {
		t.Fatalf("required = %v", schema.Required)
	}
	description := spec.Description + " " + schema.Properties["reply"].Description
	for _, want := range []string{
		"answer what you can of the user's current question",
		"Put the complete reply in reply instead of repeating it as a separate message",
		"The user should be able to understand and choose from this reply and the options alone",
		"the information needed to choose, your recommendation, and what the user must decide",
		"Asking only 'Should I do that?' is not an explanation",
		"If the user only asks for your opinion, answer without requiring a choice",
		"Call it alone, once other tools' results are in",
		"type an answer, such as a name or an API key, ask in your reply",
		askUserHow,
	} {
		if !strings.Contains(description, want) {
			t.Errorf("ask_user description lacks %q", want)
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

// Employees are told by name which language the user reads, in each language the app can be set to.
func TestLanguageRuleNamesEveryLanguage(t *testing.T) {
	for code, name := range map[string]string{
		model.LanguageZh: "Traditional Chinese", model.LanguageEn: "English", model.LanguageZhHans: "Simplified Chinese",
		model.LanguageJa: "Japanese", model.LanguageKo: "Korean",
	} {
		if rule := languageRule(code); !strings.Contains(rule, "Write everything the user reads in "+name+":") {
			t.Errorf("languageRule(%s) = %q", code, rule)
		}
	}
}
