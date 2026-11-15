package usecase

import (
	"context"
	"encoding/json"
	"fmt"
	"regexp"
	"slices"
	"strings"
	"unicode/utf8"

	"github.com/yanun0323/Team-Work/internal/adapter"
	"github.com/yanun0323/Team-Work/internal/codemode"
	"github.com/yanun0323/Team-Work/internal/model"
	"github.com/yanun0323/Team-Work/internal/usecase/tools"
)

const (
	toolExec            = "exec"
	toolReadTaskHistory = "read_task_history"
	toolReadTaskEntry   = "read_task_entry"
	toolReadStep        = "read_step"

	// reasonOwnerLimit is an exec the owner's tool limit ended.
	reasonOwnerLimit = "owner_limit"
)

// execTools are the tools exec may call, when the one running it has them: read-only ones, each giving plain data.
// Nothing here writes, runs commands, reaches the network, asks anyone or waits for the user.
var execTools = map[string]bool{
	"read_file": true, "semantic_search": true,
	toolListTasks: true, toolReadTask: true, toolListEmployees: true, toolReadEmployee: true,
	toolListBlueprints: true, toolReadBlueprint: true, toolListWorkflows: true, toolReadWorkflow: true,
	toolListCompanies: true, toolReadCompany: true, toolListProviders: true, toolReadProvider: true, toolReadChat: true,
	toolReadStep: true, toolReadTaskHistory: true, toolReadTaskEntry: true,
}

// execDescriptions replace a tool's own words where exec reads it differently.
var execDescriptions = map[string]string{
	"read_file": "Read a text file from where read_file may read, at most 2000 lines or 50KB at a time; when truncated, continue with offset endLine+1. Images are not read here.",
}

const execRules = "Run a short JavaScript script that calls your read-only tools below as tools.<name>(args), synchronously, each returning plain data, " +
	"to chain and filter many reads in one call. Only what the script writes with text(value) (console.log alike; values other than strings as JSON) " +
	"and the value it returns (as JSON) come back to you: what the tools return stays in the script. The code is a function body: use return; there is no await. " +
	"A tool's own failure throws an Error you may catch. There are no files, network, timers or modules beyond these tools; ALL_TOOLS lists them. " +
	"Each call may run 60 seconds, call tools 64 times and write 2000 lines or 50KB; passing a limit ends the script, which cannot catch it.\n\n"

var execParams = json.RawMessage(`{"type":"object","properties":{"code":{"type":"string","description":"JavaScript function body"}},"required":["code"]}`)

// codeModeSource is who runs an exec, for its log, and what the owner counts.
type codeModeSource struct {
	// Kind is step, talk, owner, chat or meeting.
	Kind                    string
	TaskID, ChatID, Replica string
	// BeforeCall, when set, comes before each tool the script calls; an error ends it.
	BeforeCall func(name string) error
}

// codeMode offers exec on the turn while the experimental setting is on, over the read-only tools the turn has. It
// checks the setting before every try at the model, so turning it on or off counts from the next call; a turn with
// no tool exec may call never gets it. Call it with the turn's tools in place, not holding the lock.
func (e *Engine) codeMode(tr *turn, src codeModeSource) {
	base := slices.Clone(tr.req.Tools)
	var fns []codemode.Func
	for _, spec := range base {
		st, ok := tr.tools[spec.Name].(tools.Structured)
		if !ok || !execTools[spec.Name] || st.Returns() == "" {
			continue
		}
		description := spec.Description
		if d, ok := execDescriptions[spec.Name]; ok {
			description = d
		}
		fns = append(fns, codemode.Func{Name: spec.Name, Description: description, Params: spec.Parameters, Returns: st.Returns(),
			Call: func(ctx context.Context, args json.RawMessage) (any, error) { return st.Structured(ctx, tr.cwd, args) }})
	}
	if len(fns) == 0 {
		return
	}
	exec := e.execTool(fns, src)
	tr.prepare = func() {
		e.mu.Lock()
		on := e.w.Preferences.CodeMode
		e.mu.Unlock()
		if on {
			tr.req.Tools = append(slices.Clone(base), exec.Spec())
			tr.tools[toolExec] = exec
		} else {
			tr.req.Tools = slices.Clone(base)
			delete(tr.tools, toolExec)
		}
	}
	tr.prepare()
}

func (e *Engine) execTool(fns []codemode.Func, src codeModeSource) adapter.Tool {
	spec := model.ToolSpec{Name: toolExec, Description: execRules + codemode.Declarations(fns), Parameters: execParams}
	return funcTool{spec, func(ctx context.Context, _ string, raw json.RawMessage) model.ToolResult {
		var res codemode.Result
		code, ok := execCode(raw)
		if ok {
			res = codemode.Run(ctx, code, fns, codemode.DefaultLimits(), codemode.Hooks{BeforeCall: src.BeforeCall})
		} else {
			res = codemode.Result{Err: &codemode.Failure{Reason: codemode.ReasonInvalid, Message: "code is required and must be a string"}}
		}
		codemode.Log(e.log, res).Str("source", src.Kind).Str("task", src.TaskID).Str("chat", src.ChatID).Str("replica", src.Replica).Send()
		if res.Err == nil {
			if res.Output == "" {
				return model.ToolResult{Text: "(no output)"}
			}
			return model.ToolResult{Text: res.Output}
		}
		text := fmt.Sprintf("exec failed (%s): %s", res.Err.Reason, res.Err.Message)
		if res.Err.Line > 0 {
			text += fmt.Sprintf(" (line %d, column %d)", res.Err.Line, res.Err.Column)
		}
		if res.Output != "" {
			text += "\nOutput before the failure:\n" + res.Output
		}
		return model.ToolResult{Text: text, IsError: true}
	}}
}

// execCode is exec's code, and false when the arguments are not an object with code a string.
func execCode(raw json.RawMessage) (string, bool) {
	var a struct {
		Code *string `json:"code"`
	}
	if json.Unmarshal(raw, &a) != nil || a.Code == nil || strings.TrimSpace(*a.Code) == "" {
		return "", false
	}
	return *a.Code, true
}

var execNames = regexp.MustCompile(`tools\s*(?:\.\s*([A-Za-z_$][\w$]*)|\[\s*["'` + "`" + `]([A-Za-z_$][\w$]*)["'` + "`" + `]\s*\])`)

// execLine is how an exec call shows in a log: the tools its script names that exec may call, and its size. Never the
// code, which may hold anything; the secrets maskSecrets hides are only those in an argument of their own.
func execLine(raw json.RawMessage) string {
	code, ok := execCode(raw)
	if !ok {
		return toolExec + " (invalid arguments)"
	}
	var names []string
	for _, m := range execNames.FindAllStringSubmatch(code, -1) {
		name := m[1] + m[2]
		if execTools[name] && !slices.Contains(names, name) {
			names = append(names, name)
		}
	}
	slices.Sort(names)
	size := fmt.Sprintf("(%d chars)", utf8.RuneCountInString(code))
	if len(names) == 0 {
		return toolExec + " " + size
	}
	return toolExec + " " + strings.Join(names, ", ") + " " + size
}
