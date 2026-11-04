package usecase_test

import (
	"fmt"
	"slices"
	"strings"
	"testing"

	"github.com/yanun0323/Team-Work/internal/model"
	"github.com/yanun0323/Team-Work/internal/model/enum"
	"github.com/yanun0323/Team-Work/internal/usecase"
)

func TestTerminalLogReadsAsTheScreenDoes(t *testing.T) {
	for _, tc := range []struct {
		name   string
		chunks []string
		want   []string
	}{
		{"colors and titles go", []string{"\x1b]0;~/proj\x07\x1b[1;32mok\x1b[0m done\r\n"}, []string{"ok done"}},
		{"a progress bar keeps its last state", []string{"10%\r50%\r100%\r\n"}, []string{"100%"}},
		{"the line editor's own erasing", []string{"$ gti\b\b\x1b[Kit status\r\n"}, []string{"$ git status"}},
		{"wide characters take two columns", []string{"$ 中文x\x1b[3D\x1b[K字\r\n"}, []string{"$ 中字"}},
		{"what a full-screen program shows is left out", []string{"$ vim\r\n\x1b[?1049h\x1b[Hfile body\r\n\x1b[?1049l$ \r\n"}, []string{"$ vim", "$"}},
		{"pieces may split a character or a sequence", []string{"中"[:2], "中"[2:] + "\x1b[3", "1mred\x1b", "[0m\r\n"}, []string{"中red"}},
		{"decomposed marks stay with their character", []string{"が\r\n"}, []string{"が"}},
		{"the line being typed counts", []string{"one\r\n$ make"}, []string{"one", "$ make"}},
		{"a cleared screen keeps its history", []string{"old\r\n$ clear\r\n\x1b[H\x1b[2J\x1b[3J$ "}, []string{"old", "$ clear", "$"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var l usecase.TerminalLog
			for _, c := range tc.chunks {
				_, _ = l.Write([]byte(c))
			}
			got, ended := l.Tail(100)
			if !slices.Equal(got, tc.want) || ended {
				t.Fatalf("%q %v, want %q", got, ended, tc.want)
			}
		})
	}
}

func TestTerminalLogKeepsTheLastLines(t *testing.T) {
	var l usecase.TerminalLog
	for i := range 12000 {
		_, _ = fmt.Fprintf(&l, "line %d\r\n", i)
	}
	l.End()
	got, ended := l.Tail(3)
	if !slices.Equal(got, []string{"line 11997", "line 11998", "line 11999"}) || !ended {
		t.Fatalf("%q %v", got, ended)
	}
	if all, _ := l.Tail(1 << 20); len(all) < 5000 || len(all) > 10000 {
		t.Fatalf("kept %d lines", len(all))
	}
}

func TestEmployeesWhoReadFilesOrRunCommandsReadTheTerminal(t *testing.T) {
	r, m := manageRig(t)
	inChat(t, r, m, doing("read_terminal", map[string]any{}))
	if got := lastResult(t, r).Text; !strings.Contains(got, "not been opened") {
		t.Fatalf("before any terminal: %q", got)
	}

	log := r.e.TerminalOutput(r.team.ID)
	_, _ = log.Write([]byte("$ make test\r\n\x1b[31mFAIL\x1b[0m x_test.go\r\n$ "))
	inChat(t, r, m, doing("read_terminal", map[string]any{"lines": 2}))
	if got := lastResult(t, r).Text; got != "FAIL x_test.go\n$" {
		t.Fatalf("read %q", got)
	}
	log.End()
	inChat(t, r, m, doing("read_terminal", map[string]any{}))
	if got := lastResult(t, r).Text; !strings.HasSuffix(got, "[the shell has ended]") {
		t.Fatalf("after the shell: %q", got)
	}

	// running commands gives it too; neither gives none
	for _, tc := range []struct {
		tool enum.Tool
		gets bool
	}{{enum.ToolRunCommand, true}, {enum.ToolWebSearch, false}} {
		bp, err := r.e.CreateBlueprint(model.Blueprint{Name: string(tc.tool), Tools: []enum.Tool{tc.tool}})
		if err != nil {
			t.Fatal(err)
		}
		hired, err := r.e.Hire(usecase.NewReplica{TeamID: r.team.ID, BlueprintID: bp.ID, Name: "X", Model: "fake"})
		if err != nil {
			t.Fatal(err)
		}
		c, err := r.e.CreateChat(usecase.NewChat{TeamID: r.team.ID, ReplicaID: hired.ID, Text: "嗨"})
		if err != nil {
			t.Fatal(err)
		}
		r.wait("reply", chatDone(c.ID))
		reqs := r.fake.requests()
		if got := toolsOf(reqs[len(reqs)-1]); slices.Contains(got, "read_terminal") != tc.gets {
			t.Fatalf("%s: %v", tc.tool, got)
		}
	}
}
