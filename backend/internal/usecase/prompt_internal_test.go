package usecase

import (
	"encoding/json"
	"fmt"
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

// The owner reads runs and employees by id, and the user would read those ids back unless told to use names.
func TestOwnerIsToldToNameEmployeesNotIds(t *testing.T) {
	if !strings.Contains(ownerRules, "call employees by their names") {
		t.Error("ownerRules do not tell the owner to name employees, not their ids, to the user")
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

// Long English tool output made a chat drift into English (chat-766), so the rule names that case.
func TestLanguageRuleHoldsAfterEnglishToolOutput(t *testing.T) {
	rule := languageRule(model.LanguageZh)
	if !strings.Contains(rule, "Long English tool output, code diffs, test logs and skill files do not change it either: after them, go on writing in Traditional Chinese.") {
		t.Errorf("languageRule(zh) = %q", rule)
	}
}

// The reminder comes in every chat turn, before a meeting's round note so that note still ends the message.
func TestChatNoteRemindsOfLanguage(t *testing.T) {
	want := "[Language] Write your reply, and every note while you work, in Japanese; keep code, identifiers, paths and commands unchanged."
	if got := chatNote(model.LanguageJa, ""); got != want {
		t.Errorf("chatNote without a meeting = %q", got)
	}
	if got := chatNote(model.LanguageJa, "[Meeting] In it: Ada."); got != want+"\n[Meeting] In it: Ada." {
		t.Errorf("chatNote in a meeting = %q", got)
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

func TestReviewMayPrepareIgnoredDependenciesButNotChangeSource(t *testing.T) {
	for _, want := range []string{"including read-only code review", "without changing tracked source, manifests or lockfiles", "Discussion steps remain read-only", "Report environment preparation failures separately", "If package manifests or lockfiles change"} {
		if !strings.Contains(workTreeRule, want) {
			t.Errorf("missing environment rule: %s", want)
		}
	}
}

func TestNewMemoryLeavesThePromptBeforeItUnchanged(t *testing.T) {
	parts := func(notes ...string) promptParts {
		r := &model.Replica{}
		for i, n := range notes {
			r.Memory = append(r.Memory, model.MemoryEntry{ID: fmt.Sprint("m", i), Text: n, Source: "work", At: 86400})
		}
		return promptParts{rules: "fixed rules\n", shared: "\n# Company rules\nshared\n", role: "\n# Your role\nrole\n", memory: memorySection(r), step: "\n# This step: x\ndo it\n"}
	}
	skills := []skill{{name: "tdd", description: "tests first", path: "/s/tdd/SKILL.md"}}
	before, after := parts("old note"), parts("old note", "new note")
	a, b := before.compose("\n# Repo role\n", skills), after.compose("\n# Repo role\n", skills)
	head := strings.TrimSuffix(a, before.memory)
	if head == a || !strings.HasPrefix(b, head) || b != head+after.memory {
		t.Fatalf("memory must come last, after an unchanged start:\n%s\n---\n%s", a, b)
	}
	// Only the order changed: the employee is told the same sections as before.
	for _, part := range []string{before.rules, before.shared, before.role, "\n# Repo role\n", skillsPrompt(skills), before.memory, before.step} {
		if strings.Count(a, part) != 1 {
			t.Fatalf("%q should appear once in:\n%s", part, a)
		}
	}
	if len(a) != len(before.rules+before.shared+before.role+"\n# Repo role\n"+skillsPrompt(skills)+before.memory+before.step) {
		t.Fatal("compose added or dropped text")
	}
}
