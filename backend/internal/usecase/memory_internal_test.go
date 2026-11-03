package usecase

import (
	"fmt"
	"strings"
	"testing"

	"github.com/yanun0323/Team-Work/internal/model"
)

func notes(n int, text func(i int) string) []model.MemoryEntry {
	out := make([]model.MemoryEntry, n)
	for i := range out {
		out[i] = model.MemoryEntry{ID: fmt.Sprintf("mem-%d", i), Text: text(i), Source: "work", At: 86400}
	}
	return out
}

func TestMemorySectionKeepsToItsBudget(t *testing.T) {
	long := strings.Repeat("字", 200)
	r := &model.Replica{Memory: notes(40, func(int) string { return long })}
	got := memorySection(r)
	if !strings.Contains(got, "[mem-0,") || strings.Contains(got, "[mem-39,") {
		t.Fatalf("not newest first within the budget:\n%s", got)
	}
	shown := strings.Count(got, "\n- [")
	if shown == 0 || shown == 40 {
		t.Fatalf("shown %d of 40", shown)
	}
	if want := fmt.Sprintf("%d older notes are not shown", 40-shown); !strings.Contains(got, want) || !strings.Contains(got, "search_memory") {
		t.Fatalf("does not say what is left out:\n%s", got)
	}
}

func TestMemorySectionShowsAllThatFit(t *testing.T) {
	r := &model.Replica{Memory: notes(3, func(i int) string { return fmt.Sprint("note ", i) })}
	if got := memorySection(r); strings.Count(got, "\n- [") != 3 || strings.Contains(got, "not shown") {
		t.Fatalf("%s", got)
	}
}

func TestMemorySectionShowsOneNoteOverTheBudget(t *testing.T) {
	r := &model.Replica{Memory: notes(1, func(int) string { return strings.Repeat("x", memoryBudget*2) })}
	if got := memorySection(r); !strings.Contains(got, "[mem-0,") || strings.Contains(got, "not shown") {
		t.Fatalf("a lone long note went missing")
	}
}

func TestSearchMemoryRanksByWordsThenRecency(t *testing.T) {
	all := []model.MemoryEntry{
		{ID: "a", Text: "Use npm for the frontend"},
		{ID: "b", Text: "frontend tests need -race? no, Go tests do"},
		{ID: "c", Text: "Notarize with notarytool"},
		{ID: "d", Text: "The FRONTEND uses NPM workspaces"},
	}
	got := searchMemory(all, "npm frontend")
	lines := strings.Split(strings.TrimSpace(got), "\n")
	if len(lines) != 3 || !strings.Contains(lines[0], "[a,") || !strings.Contains(lines[1], "[d,") || !strings.Contains(lines[2], "[b,") {
		t.Fatalf("%s", got)
	}
	if got := searchMemory(all, "docker"); got != "No notes match." {
		t.Fatalf("%q", got)
	}
}

func TestSearchMemoryCapsItsResults(t *testing.T) {
	got := searchMemory(notes(memorySearchLimit+5, func(int) string { return "same" }), "same")
	if strings.Count(got, "\n- [")+1 != memorySearchLimit || !strings.Contains(got, "5 more match") {
		t.Fatalf("%s", got)
	}
}
