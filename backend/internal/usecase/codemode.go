package usecase

import (
	"cmp"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"maps"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"unicode/utf8"

	"github.com/yanun0323/Team-Work/internal/adapter"
	"github.com/yanun0323/Team-Work/internal/codemode"
	"github.com/yanun0323/Team-Work/internal/model"
	"github.com/yanun0323/Team-Work/internal/model/enum"
	"github.com/yanun0323/Team-Work/internal/usecase/tools"
)

const (
	toolExec            = "exec"
	toolReadTaskHistory = "read_task_history"
	toolReadTaskEntry   = "read_task_entry"
	toolReadStep        = "read_step"

	// reasonRefused is a script whose call the turn refused, such as one past the owner's tool limit.
	reasonRefused = "refused"
	// reasonEnded is a script whose call ended the turn, such as an owner's change on a task that moved on.
	reasonEnded = "turn_ended"
)

// neverInScripts are the tools a script may not call: those that ask the user or wait for their approval, and those
// that end the step or the turn, as a script cannot stop halfway for them; nor exec, as scripts start no scripts.
var neverInScripts = map[string]bool{
	toolExec: true, toolAskUser: true, toolAskOwner: true, "submit_handoff": true, "send_back": true, "submit_complete": true,
	toolMeetingAsk: true, toolEndMeeting: true, toolChatPass: true,
	toolSaveSetting: true, toolSaveBlueprint: true, toolSaveWorkflow: true, toolSaveProvider: true, toolSaveEmployees: true,
}

// sideBySide are the tools that change nothing: a script's calls to them run at the same time. Every other tool's
// calls run one at a time, in the order the script made them.
var sideBySide = map[string]bool{
	"read_file": true, "semantic_search": true, "web_search": true, "web_fetch": true, "search_memory": true, "read_terminal": true,
	toolListTasks: true, toolReadTask: true, toolListEmployees: true, toolReadEmployee: true,
	toolListBlueprints: true, toolReadBlueprint: true, toolListWorkflows: true, toolReadWorkflow: true,
	toolListCompanies: true, toolReadCompany: true, toolListProviders: true, toolReadProvider: true, toolReadChat: true,
	toolReadStep: true, toolReadTaskHistory: true, toolReadTaskEntry: true,
}

// scriptNotes add to what a tool's description says of it in scripts.
var scriptNotes = map[string]string{"read_file": " Images are not read there."}

const execRules = "Run a JavaScript script that calls your other tools, to chain, filter and run many calls in one step. " +
	"Only what the script writes with text() or console.log() and the value it returns come back to you: what the tools return stays in the script. " +
	"The code is raw JavaScript, not JSON or a Markdown fence: the body of an async function, so await and return work at the top level. " +
	"Call a tool as `await tools.<name>(args)` with one object of its arguments; a tool's description says when it can be called from scripts and what the call resolves to, and ALL_TOOLS lists them. " +
	"Calls are real: what they did stays done when the script fails later. A call that fails rejects with an Error carrying its message; Promise.allSettled() keeps the others. " +
	"Use Promise.all() for calls that do not depend on each other: those that change nothing run at the same time, those that change something one at a time, in the order made. " +
	"text(value) adds an output item (a string as it is, anything else as JSON), and return adds the value the same way; console.log() adds a line to a console block after them. " +
	"exit() ends the script at once, successfully. store(key, value) and load(key) keep small JSON values for your later scripts in this conversation, kept only when the script succeeds. " +
	"There are no files, network, timers or modules beyond the tools; a script waiting on what nothing can settle fails at once. " +
	"It may start with an options line, its first line only: // @options: {\"max_output_tokens\": 2000, \"timeout_ms\": 60000}. " +
	"Output past max_output_tokens (10000 by default) keeps its start and end, with the whole of it in a file the result names. " +
	"There is no deadline unless timeout_ms sets one, but JavaScript that runs a minute without waiting on a tool is stopped. The script has 256 MB of memory."

var execParams = json.RawMessage(`{"type":"object","properties":{"code":{"type":"string","description":"JavaScript, the body of an async function"}},"required":["code"]}`)

// codeModeSource is who runs an exec, for its log, and where its scripts keep what they store.
type codeModeSource struct {
	// Kind is step, talk, owner, chat or meeting.
	Kind                    string
	TaskID, ChatID, Replica string
	// Scope is the conversation store() keeps values for: a step's run, a chat, an owner's decisions, a meeting turn's.
	Scope string
}

// codeMode offers exec on the turn while the experimental setting is on, or always when it has tools only scripts
// call, and then says in each tool it may call how to call it from scripts. It checks the setting before every try at the model, so turning it on or off counts from
// the next call; a turn with no tool a script may call never gets it. Call it with the turn's tools in place, not
// holding the lock.
func (e *Engine) codeMode(tr *turn, src codeModeSource) {
	base := slices.Clone(tr.req.Tools)
	noted := slices.Clone(base)
	byName := maps.Clone(tr.tools)
	var names []string
	for i, spec := range base {
		tool := byName[spec.Name]
		if tool == nil || neverInScripts[spec.Name] {
			continue
		}
		names = append(names, spec.Name)
		noted[i].Description += scriptNote(spec.Name, tool)
	}
	// tools only scripts call turn the script tool on for the turn, whatever the setting
	for _, tool := range tr.scriptOnly {
		name := tool.Spec().Name
		byName[name] = tool
		names = append(names, name)
	}
	forced := len(tr.scriptOnly) > 0
	if len(names) == 0 {
		return
	}
	exec := e.execTool(tr, names, byName, src)
	tr.prepare = func() {
		e.mu.Lock()
		on := e.w.Preferences.CodeMode || forced
		e.mu.Unlock()
		if on {
			tr.req.Tools = append(slices.Clone(noted), exec.Spec())
			tr.tools[toolExec] = exec
		} else {
			tr.req.Tools = slices.Clone(base)
			delete(tr.tools, toolExec)
		}
	}
	tr.prepare()
}

// readOnly says whether a tool's own word is that it changes nothing, as an MCP server's may.
func readOnly(tool adapter.Tool) bool {
	ro, ok := tool.(interface{ ReadOnly() bool })
	return ok && ro.ReadOnly()
}

// scriptNote is what a tool's description adds while scripts may call it: how, and what the call resolves to.
func scriptNote(name string, tool adapter.Tool) string {
	returns := "its text output, a string"
	if st, ok := tool.(tools.Structured); ok && st.Returns() != "" {
		returns = st.Returns()
	}
	return "\n\nIn exec scripts: `await tools." + name + "(args)` resolves to " + returns + "." + scriptNotes[name]
}

// execTool runs a script over the turn's tools. Each call the script makes goes as the model's own would: past the
// turn's gate, shown in its log, run with the turn's folder, and named after the exec call it came from. A call that
// ends the turn ends the script, and exec then ends the turn the same way.
func (e *Engine) execTool(tr *turn, names []string, byName map[string]adapter.Tool, src codeModeSource) adapter.Tool {
	spec := model.ToolSpec{Name: toolExec, Description: execRules + tr.scriptAbout, Parameters: execParams}
	return funcTool{spec, func(ctx context.Context, cwd string, raw json.RawMessage) model.ToolResult {
		code, ok := execCode(raw)
		if !ok {
			return toolError("code is required: the script, as a string")
		}
		parent := tr.callID
		// book keeps the turn's own record of calls (its gate, its log) to one call at a time; a call that changes
		// something holds it while it runs, so nothing else of the script is recorded meanwhile
		var book sync.Mutex
		var n atomic.Int64
		var stopMu sync.Mutex
		var stop *model.ToolResult
		// what hooks say of the script's calls goes to the model with the script's output, as it does not see the
		// calls' results
		var hooked []string
		heard := func(call model.Block, added []string) {
			if len(added) == 0 {
				return
			}
			stopMu.Lock()
			defer stopMu.Unlock()
			for _, a := range added {
				hooked = append(hooked, "[hook] "+call.Name+": "+a)
			}
		}
		fns := make([]codemode.Func, 0, len(names))
		for _, name := range names {
			tool := byName[name]
			serial := !sideBySide[name] && !readOnly(tool)
			fns = append(fns, codemode.Func{Name: name, Description: tool.Spec().Description, Serial: serial,
				Call: func(ctx context.Context, args json.RawMessage) (any, error) {
					call := model.Block{Type: enum.BlockToolCall, ID: fmt.Sprintf("%s/%d", parent, n.Add(1)), Name: name, Args: args}
					book.Lock()
					call, refused, added := tr.admit(ctx, call)
					if refused != nil {
						book.Unlock()
						return nil, &codemode.Failure{Reason: reasonRefused, Message: refused.Text}
					}
					args = call.Args
					tr.onTool(call)
					if serial {
						defer book.Unlock()
					} else {
						book.Unlock()
					}
					if st, ok := tool.(tools.Structured); ok {
						v, err := st.Structured(ctx, cwd, args)
						done := model.ToolResult{}
						if err != nil {
							done = model.ToolResult{Text: err.Error(), IsError: true}
						} else if raw, merr := json.Marshal(v); merr == nil {
							done.Text = string(raw)
						}
						heard(call, append(added, tr.hooks.after(ctx, call, done)...))
						return v, err
					}
					var res model.ToolResult
					if streamer, ok := tool.(tools.Streamer); ok && tr.onOutput != nil {
						res = streamer.RunStream(ctx, cwd, args, tr.onOutput)
						tr.onOutput("")
					} else {
						res = tool.Run(ctx, cwd, args)
					}
					if res.Stop {
						stopMu.Lock()
						if stop == nil {
							stop = &res
						}
						stopMu.Unlock()
						return nil, &codemode.Failure{Reason: reasonEnded, Message: cmp.Or(res.Text, name+" ended this turn")}
					}
					heard(call, append(added, tr.hooks.after(ctx, call, res)...))
					if res.IsError {
						return nil, errors.New(res.Text)
					}
					return res.Text, nil
				}})
		}
		res := codemode.Run(ctx, code, fns, codemode.Options{SpillDir: e.spillDir(src), Store: e.stores.get(src.Scope)})
		if res.Store != nil {
			e.stores.put(src.Scope, res.Store)
		}
		codemode.Log(e.log, res).Str("source", src.Kind).Str("task", src.TaskID).Str("chat", src.ChatID).Str("replica", src.Replica).Send()
		stopMu.Lock()
		defer stopMu.Unlock()
		if stop != nil {
			return *stop
		}
		text := res.Text
		if len(hooked) > 0 {
			text += "\n\n" + strings.Join(hooked, "\n")
		}
		return model.ToolResult{Text: text, IsError: res.Err != nil}
	}}
}

// spillDir is where a script's output too long to hand back is kept: with the task's or chat's long command output,
// which read_file reads and which goes with them.
func (e *Engine) spillDir(src codeModeSource) string {
	id := cmp.Or(src.TaskID, src.ChatID)
	if e.dataDir == "" || id == "" {
		return ""
	}
	return e.outputRoot(id)
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

// execLine is how an exec call shows in a log: its size, never its code, which may hold anything. The calls its
// script makes show on lines of their own.
func execLine(raw json.RawMessage) string {
	code, ok := execCode(raw)
	if !ok {
		return toolExec + " (invalid arguments)"
	}
	return fmt.Sprintf("%s (%d chars)", toolExec, utf8.RuneCountInString(code))
}

// maxStores bounds how many conversations' stores are kept; the oldest goes first.
const maxStores = 256

// scriptStores are what exec scripts kept with store(), by conversation, in memory: they last while the backend
// runs.
type scriptStores struct {
	mu    sync.Mutex
	by    map[string]map[string]json.RawMessage
	order []string
}

func (s *scriptStores) get(scope string) map[string]json.RawMessage {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.by[scope]
}

func (s *scriptStores) put(scope string, values map[string]json.RawMessage) {
	if scope == "" {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.by == nil {
		s.by = map[string]map[string]json.RawMessage{}
	}
	if _, ok := s.by[scope]; !ok {
		s.order = append(s.order, scope)
		if len(s.order) > maxStores {
			delete(s.by, s.order[0])
			s.order = s.order[1:]
		}
	}
	s.by[scope] = values
}
