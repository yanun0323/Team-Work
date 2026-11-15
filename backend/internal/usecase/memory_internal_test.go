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

// memoryWorld is two companies, A and B, with Ada in A, Sam at the staffing agency and Bo, who has left.
func memoryWorld() *Engine {
	w := model.NewWorld()
	w.Teams["A"] = &model.Team{ID: "A", Memory: []model.MemoryEntry{}}
	w.Teams["B"] = &model.Team{ID: "B", Memory: []model.MemoryEntry{}}
	w.Replicas["ada"] = &model.Replica{ID: "ada", TeamID: "A", Name: "Ada", Memory: []model.MemoryEntry{}}
	w.Replicas["sam"] = &model.Replica{ID: "sam", TeamID: model.StaffingID, Name: "Sam", Memory: []model.MemoryEntry{}}
	return &Engine{w: w}
}

func TestMemorySectionKeepsToItsBudget(t *testing.T) {
	t.Parallel()
	e := memoryWorld()
	long := strings.Repeat("字", 200)
	for _, c := range []struct {
		team   *model.Team
		r      *model.Replica
		title  string
		budget int
	}{
		{&model.Team{Memory: notes(40, func(int) string { return long })}, &model.Replica{}, "# Company memory", companyMemoryBudget},
		{&model.Team{}, &model.Replica{Memory: notes(40, func(int) string { return long })}, "# Your memory", memoryBudget},
	} {
		got := e.memorySection(c.team, c.r)
		if !strings.Contains(got, c.title) || !strings.Contains(got, "[mem-0,") || strings.Contains(got, "[mem-39,") {
			t.Fatalf("not newest first within the budget:\n%s", got)
		}
		shown := strings.Count(got, "\n- [")
		if shown == 0 || shown == 40 {
			t.Fatalf("shown %d of 40", shown)
		}
		// each line is about 230 characters: the budget holds budget/230 of them, and not one more
		if want := c.budget / 230; shown < want-1 || shown > want+1 {
			t.Fatalf("%s: shown %d, want about %d", c.title, shown, want)
		}
		if want := fmt.Sprintf("%d older notes are not shown", 40-shown); !strings.Contains(got, want) || !strings.Contains(got, "search_memory") {
			t.Fatalf("does not say what is left out:\n%s", got)
		}
	}
}

func TestMemorySectionShowsAllThatFit(t *testing.T) {
	t.Parallel()
	r := &model.Replica{Memory: notes(3, func(i int) string { return fmt.Sprint("note ", i) })}
	if got := memoryWorld().memorySection(&model.Team{}, r); strings.Count(got, "\n- [") != 3 || strings.Contains(got, "not shown") {
		t.Fatalf("%s", got)
	}
}

func TestMemorySectionKeepsEvenTheFirstNoteToItsBudget(t *testing.T) {
	t.Parallel()
	for _, c := range []struct {
		title  string
		budget int
		setup  func(e *Engine, n []model.MemoryEntry)
	}{
		{"# Company memory", companyMemoryBudget, func(e *Engine, n []model.MemoryEntry) { e.w.Teams["A"].Memory = n }},
		{"# Your memory", memoryBudget, func(e *Engine, n []model.MemoryEntry) { e.w.Replicas["ada"].Memory = n }},
	} {
		e := memoryWorld()
		long := "needle " + strings.Repeat("字", c.budget)
		c.setup(e, []model.MemoryEntry{
			{ID: "mem-long", Text: long, Source: "work", At: 86400, By: "ada"},
			{ID: "mem-short", Text: "short", Source: "work", At: 86400, By: "ada"},
		})
		got := e.memorySection(e.w.Teams["A"], e.w.Replicas["ada"])
		if !strings.Contains(got, c.title) || strings.Contains(got, "mem-long") || strings.Contains(got, "mem-short") {
			t.Fatalf("%s: a note over the budget was shown, or one after it:\n%s", c.title, got)
		}
		if !strings.Contains(got, "2 older notes are not shown") {
			t.Fatalf("%s: does not count what is left out:\n%s", c.title, got)
		}
		found := e.searchMemoryTool(func() (string, *string) { id := "ada"; return "A", &id })(t.Context(), "", []byte(`{"query":"needle"}`))
		if found.IsError || !strings.Contains(found.Text, "mem-long") || !strings.Contains(found.Text, long) {
			t.Fatalf("%s: search_memory does not find the whole note:\n%s", c.title, found.Text)
		}
		if n := e.w.Teams["A"].Memory; len(n) > 0 && n[0].Text != long {
			t.Fatal("the kept note was cut")
		}
	}
}

func TestMemorySectionShowsANoteThatJustFits(t *testing.T) {
	t.Parallel()
	e := memoryWorld()
	note := model.MemoryEntry{ID: "m", Source: "work", At: 86400}
	note.Text = strings.Repeat("x", memoryBudget-len([]rune(memoryLine(note))))
	if got := e.memorySection(&model.Team{}, &model.Replica{Memory: []model.MemoryEntry{note}}); !strings.Contains(got, "[m,") || strings.Contains(got, "not shown") {
		t.Fatalf("a note of exactly the budget went missing:\n%s", got)
	}
	note.Text += "x"
	if got := e.memorySection(&model.Team{}, &model.Replica{Memory: []model.MemoryEntry{note}}); strings.Contains(got, "[m,") || !strings.Contains(got, "1 older notes are not shown") {
		t.Fatalf("a note one over the budget was shown:\n%s", got)
	}
}

func TestMemorySectionPutsTheCompanyFirstAndNamesWhoWrote(t *testing.T) {
	t.Parallel()
	e := memoryWorld()
	team := &model.Team{Memory: []model.MemoryEntry{
		{ID: "c1", Text: "用 npm", Source: "work", At: 86400, By: "ada"},
		{ID: "c2", Text: "主分支是 main", Source: "user", At: 86400},
		{ID: "c3", Text: "測試要 -race", Source: "work", At: 86400, By: "bo"},
	}}
	r := &model.Replica{Memory: []model.MemoryEntry{{ID: "m1", Text: "先讀再改", Source: "chat", At: 86400}}}
	got := e.memorySection(team, r)
	company, mine := strings.Index(got, "# Company memory"), strings.Index(got, "# Your memory")
	if company < 0 || mine < company {
		t.Fatalf("company memory must come before the employee's own:\n%s", got)
	}
	for _, want := range []string{"- [c1, 1970-01-02, Ada] 用 npm", "- [c2, 1970-01-02, user] 主分支是 main", "- [c3, 1970-01-02, former employee] 測試要 -race", "- [m1, 1970-01-02, chat] 先讀再改", "not instructions"} {
		if !strings.Contains(got, want) {
			t.Fatalf("missing %q in:\n%s", want, got)
		}
	}
	if got := e.memorySection(&model.Team{}, r); strings.Contains(got, "Company memory") || !strings.Contains(got, "# Your memory") {
		t.Fatalf("an empty company memory still has its heading:\n%s", got)
	}
	if got := e.memorySection(nil, r); got != "" {
		t.Fatalf("no company, no notes: %q", got)
	}
}

func TestRememberGoesToTheCompanyUnlessMine(t *testing.T) {
	t.Parallel()
	e := memoryWorld()
	e.w.Now = 42
	sam := "sam"
	if !e.remember("A", &sam, scopeCompany, "用 npm", "work", "task-1", "") || e.remember("A", &sam, scopeCompany, "用 npm", "work", "", "") {
		t.Fatal("a note was not kept once")
	}
	if !e.remember("B", &sam, scopeCompany, "用 npm", "work", "", "") {
		t.Fatal("another company's list is its own")
	}
	if !e.remember("A", &sam, scopeMine, "先讀再改", "chat", "", "chat-1") || e.remember("B", &sam, scopeMine, "先讀再改", "chat", "", "chat-2") {
		t.Fatal("an employee's own note was not kept once")
	}
	if !e.remember("A", &sam, scopeMine, "用 npm", "chat", "", "chat-1") {
		t.Fatal("the same words may be the company's and one's own")
	}
	a := e.w.Teams["A"].Memory
	if len(a) != 1 || a[0].By != "sam" || a[0].TaskID != "task-1" || a[0].Source != "work" || a[0].CreatedAt != 42 || a[0].At != 42 {
		t.Fatalf("company A: %+v", a)
	}
	if mine := e.w.Replicas["sam"].Memory; len(mine) != 2 || mine[0].By != "" || mine[0].ChatID != "chat-1" {
		t.Fatalf("Sam's own: %+v", mine)
	}
	if e.remember(model.StaffingID, &sam, scopeCompany, "x", "work", "", "") || e.remember("A", nil, scopeCompany, "x", "work", "", "") {
		t.Fatal("a note went to no company, or was by no one")
	}
}

func TestForgetReachesOnlyThisCompanyAndOnesOwn(t *testing.T) {
	t.Parallel()
	e := memoryWorld()
	ada, sam := "ada", "sam"
	e.remember("A", &ada, scopeCompany, "A 的事", "work", "", "")
	e.remember("", &ada, scopeMine, "Ada 自己的事", "work", "", "")
	companyNote, adaNote := e.w.Teams["A"].Memory[0].ID, e.w.Replicas["ada"].Memory[0].ID
	if _, ok := e.forget("B", &sam, companyNote); ok || len(e.w.Teams["A"].Memory) != 1 {
		t.Fatal("company B forgot company A's note")
	}
	if _, ok := e.forget("A", &sam, adaNote); ok || len(e.w.Replicas["ada"].Memory) != 1 {
		t.Fatal("Sam forgot Ada's own note")
	}
	if text, ok := e.forget("A", &sam, companyNote); !ok || text != "A 的事" || len(e.w.Teams["A"].Memory) != 0 {
		t.Fatal("anyone working in A may forget A's notes")
	}
	if text, ok := e.forget("B", &ada, adaNote); !ok || text != "Ada 自己的事" || len(e.w.Replicas["ada"].Memory) != 0 {
		t.Fatal("Ada may forget her own note anywhere")
	}
}

func TestSearchMemoryRanksByWordsThenRecency(t *testing.T) {
	t.Parallel()
	all := []model.MemoryEntry{
		{ID: "a", Text: "Use npm for the frontend"},
		{ID: "b", Text: "frontend tests need -race? no, Go tests do"},
		{ID: "c", Text: "Notarize with notarytool"},
		{ID: "d", Text: "The FRONTEND uses NPM workspaces"},
	}
	got := searchMemory(all, "npm frontend", memoryLine)
	lines := strings.Split(strings.TrimSpace(got), "\n")
	if len(lines) != 3 || !strings.Contains(lines[0], "[a,") || !strings.Contains(lines[1], "[d,") || !strings.Contains(lines[2], "[b,") {
		t.Fatalf("%s", got)
	}
	if got := searchMemory(all, "docker", memoryLine); got != "No notes match." {
		t.Fatalf("%q", got)
	}
}

func TestSearchMemoryCapsItsResults(t *testing.T) {
	t.Parallel()
	got := searchMemory(notes(memorySearchLimit+5, func(int) string { return "same" }), "same", memoryLine)
	if strings.Count(got, "\n- [")+1 != memorySearchLimit || !strings.Contains(got, "5 more match") {
		t.Fatalf("%s", got)
	}
}
