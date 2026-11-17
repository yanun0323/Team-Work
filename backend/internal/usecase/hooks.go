package usecase

import (
	"context"
	"encoding/json"
	"path/filepath"
	"slices"
	"strings"
	"sync"

	"github.com/yanun0323/Team-Work/internal/hooks"
	"github.com/yanun0323/Team-Work/internal/i18n"
	"github.com/yanun0323/Team-Work/internal/model"
	"github.com/yanun0323/Team-Work/internal/model/enum"
)

// toolAliases are the names Claude Code gives the tools that do what these do, so a hook written for it matches them
// and reads the name it knows. Its matcher is tried against both names.
var toolAliases = map[string]string{
	"run_command": "Bash", "write_file": "Write", "edit_file": "Edit", "read_file": "Read",
	"web_fetch": "WebFetch", "web_search": "WebSearch", toolAskUser: "AskUserQuestion",
}

// maxStopBlocks is how many times Stop hooks may send the model back to work in one turn, so two that disagree do
// not go round for ever.
const maxStopBlocks = 5

// hookRun is a turn's hooks: who works where, and where what they tell the user goes. A nil hookRun runs none.
type hookRun struct {
	runner                     *hooks.Runner
	session, cwd, model, agent string
	notice                     func(string)
	mu                         sync.Mutex
	halt                       string
	stopBlocks                 int
}

// hookUp gives a turn the hooks of hooks.json; notice is where what they say to the user goes. Call it with the
// turn's request in place, not holding the lock.
func (e *Engine) hookUp(tr *turn, src codeModeSource, notice func(string)) {
	agent := ""
	e.mu.Lock()
	if r := e.w.Replicas[src.Replica]; r != nil {
		agent = r.Name
	}
	e.mu.Unlock()
	if notice == nil {
		notice = func(text string) {
			e.log.Info().Str("source", src.Kind).Str("task", src.TaskID).Str("chat", src.ChatID).Str("hook", text).Msg("hook notice")
		}
	}
	tr.hooks = &hookRun{runner: e.hooks, session: src.Scope, cwd: tr.cwd, model: tr.req.Model, agent: agent, notice: notice}
}

func (h *hookRun) input(ev hooks.Event) hooks.Input {
	return hooks.Input{SessionID: h.session, Cwd: h.cwd, HookEventName: ev, Model: h.model, Agent: h.agent}
}

// heard passes on what hooks told the user, and keeps a hook's word to stop.
func (h *hookRun) heard(out hooks.Outcome) {
	for _, n := range out.Notices {
		h.notice("Hook: " + n)
	}
	if out.Halt {
		h.mu.Lock()
		if h.halt == "" {
			h.halt = out.HaltReason
		}
		h.mu.Unlock()
	}
}

// halted is why a hook said to stop the work, "" when none did.
func (h *hookRun) halted() string {
	if h == nil {
		return ""
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.halt
}

// haltError is the error a turn ends with when a hook stopped it.
func haltError(reason string) error {
	return model.Errorf(model.CodeInvalid, "Hook 要求停止：%s", reason)
}

// pre runs the PreToolUse hooks on a call: the call to run, its arguments perhaps rewritten, or the result to give the
// model in its place; and what the hooks added for the model to read with the result.
func (h *hookRun) pre(ctx context.Context, call model.Block) (model.Block, *model.ToolResult, []string) {
	if h == nil || !h.runner.Has(hooks.PreToolUse) {
		return call, nil, nil
	}
	in := h.input(hooks.PreToolUse)
	in.ToolName, in.ToolInput, in.ToolUseID = hookToolName(call.Name), hookToolInput(call.Args, h.cwd), call.ID
	out := h.runner.Run(ctx, in, call.Name, in.ToolName)
	h.heard(out)
	if out.Block {
		res := toolError("A hook blocked this call: %s", out.Reason)
		return call, &res, nil
	}
	if out.UpdatedInput != nil {
		call.Args = fromHookInput(call.Args, out.UpdatedInput)
	}
	return call, nil, out.Context
}

// post runs the PostToolUse hooks, or PostToolUseFailure's for a call that failed, and adds what they say for the
// model to the result, with what the PreToolUse hooks added.
func (h *hookRun) post(ctx context.Context, call model.Block, res model.ToolResult, added []string) model.ToolResult {
	for _, a := range append(added, h.after(ctx, call, res)...) {
		res.Text += "\n\n[hook] " + a
	}
	return res
}

// after runs the PostToolUse hooks, or PostToolUseFailure's for a call that failed: what they say for the model.
func (h *hookRun) after(ctx context.Context, call model.Block, res model.ToolResult) []string {
	if h == nil {
		return nil
	}
	var added []string
	ev := hooks.PostToolUse
	if res.IsError {
		ev = hooks.PostToolUseFailure
	}
	if h.runner.Has(ev) {
		in := h.input(ev)
		in.ToolName, in.ToolInput, in.ToolUseID = hookToolName(call.Name), hookToolInput(call.Args, h.cwd), call.ID
		if res.IsError {
			in.Error = res.Text
		} else {
			in.ToolResponse = res.Text
		}
		out := h.runner.Run(ctx, in, call.Name, in.ToolName)
		h.heard(out)
		added = append(added, out.Context...)
		if out.Block {
			added = append(added, out.Reason)
		}
	}
	return added
}

// stop runs the Stop hooks as the model ends its turn: what to tell it to go on working, "" to let it stop.
func (h *hookRun) stop(ctx context.Context) string {
	if h == nil || !h.runner.Has(hooks.Stop) {
		return ""
	}
	h.mu.Lock()
	blocks := h.stopBlocks
	h.mu.Unlock()
	in := h.input(hooks.Stop)
	active := blocks > 0
	in.StopHookActive = &active
	out := h.runner.Run(ctx, in)
	h.heard(out)
	if !out.Block {
		return ""
	}
	if blocks >= maxStopBlocks {
		h.notice(i18n.T("Hook：Stop hook 已要求繼續 %d 次，這次讓工作停下", maxStopBlocks))
		return ""
	}
	h.mu.Lock()
	h.stopBlocks++
	h.mu.Unlock()
	h.notice("Hook: Stop hook asked to go on: " + out.Reason)
	return out.Reason
}

// start runs the SessionStart hooks as a run begins, source being startup or resume: what they add for the model.
func (h *hookRun) start(ctx context.Context, source string) string {
	if h == nil || !h.runner.Has(hooks.SessionStart) {
		return ""
	}
	in := h.input(hooks.SessionStart)
	in.Source = source
	out := h.runner.Run(ctx, in, source)
	h.heard(out)
	return strings.Join(out.Context, "\n\n")
}

// prompt runs the UserPromptSubmit hooks on what the user said: whether it may go to the model, why not, and what
// they add for it.
func (h *hookRun) prompt(ctx context.Context, said string) (bool, string, string) {
	if h == nil || !h.runner.Has(hooks.UserPromptSubmit) {
		return true, "", ""
	}
	in := h.input(hooks.UserPromptSubmit)
	in.Prompt = said
	out := h.runner.Run(ctx, in)
	h.heard(out)
	return !out.Block, out.Reason, strings.Join(out.Context, "\n\n")
}

// chatHooksAllow runs the hooks as a chat's reply begins: SessionStart's, and UserPromptSubmit's on what the user just
// said. False when a hook kept the reply from being written, which the chat then says; an error when a hook stopped
// the work.
func (e *Engine) chatHooksAllow(ctx context.Context, in chatRun, t *turn) (bool, error) {
	source := "resume"
	if !slices.ContainsFunc(in.conv, func(m model.Message) bool { return m.Role == enum.RoleAssistant }) {
		source = "startup"
	}
	t.req.System += hookContext(t.hooks.start(ctx, source))
	if in.said != "" {
		ok, reason, added := t.hooks.prompt(ctx, in.said)
		if !ok {
			// the message stays in its place, so the conversation still lines up with the chat, but the model does
			// not read it; the user still sees what they wrote
			e.applyChat(in, func(c *model.Chat) {
				if conv := e.w.Conversations[c.ID]; len(conv) > 0 && conv[len(conv)-1].Role == enum.RoleUser {
					conv[len(conv)-1].Content = []model.Block{{Type: enum.BlockText, Text: "[The user's hook blocked this message, so it is not shown: " + reason + "]"}}
					e.dirty[c.ID] = true
				}
				e.chatSays(c, i18n.T("（Hook 擋下了這則訊息：%s）", reason))
			})
			return false, nil
		}
		if added != "" {
			// kept with the message, as the skills it names are, so what the model was told does not change later
			block := model.Block{Type: enum.BlockText, Text: "[Hook context]\n" + added}
			if n := len(t.req.Messages); n > 0 && t.req.Messages[n-1].Role == enum.RoleUser {
				t.req.Messages[n-1].Content = append(slices.Clip(t.req.Messages[n-1].Content), block)
			}
			e.applyChat(in, func(c *model.Chat) {
				if conv := e.w.Conversations[c.ID]; len(conv) > 0 && conv[len(conv)-1].Role == enum.RoleUser {
					conv[len(conv)-1].Content = append(slices.Clip(conv[len(conv)-1].Content), block)
					e.dirty[c.ID] = true
				}
			})
		}
	}
	if reason := t.hooks.halted(); reason != "" {
		return false, haltError(reason)
	}
	return true, nil
}

// hookContext is what hooks added for the model, as it is put in the system prompt.
func hookContext(text string) string {
	if text == "" {
		return ""
	}
	return "\n# Hook context\nWhat the user's hooks added when this run began:\n" + text + "\n"
}

func hookToolName(name string) string {
	if alias, ok := toolAliases[name]; ok {
		return alias
	}
	return name
}

// hookToolInput is a call's arguments as hooks read them: as they are, with file_path, Claude Code's name for the
// file a tool works on, added as an absolute path where path names one.
func hookToolInput(args json.RawMessage, cwd string) json.RawMessage {
	var m map[string]any
	if json.Unmarshal(args, &m) != nil || m == nil {
		return args
	}
	path, ok := m["path"].(string)
	if !ok || path == "" {
		return args
	}
	if _, taken := m["file_path"]; taken {
		return args
	}
	if !filepath.IsAbs(path) {
		path = filepath.Join(cwd, path)
	}
	m["file_path"] = path
	out, err := json.Marshal(m)
	if err != nil {
		return args
	}
	return out
}

// fromHookInput is a call's arguments as a hook's updatedInput changes them: what it gives replaces what was there,
// null clears it, and what it leaves out stays, as hooks written for Codex or Claude Code often give only the command.
// file_path, when hookToolInput added it, is the path.
func fromHookInput(args, updated json.RawMessage) json.RawMessage {
	var was, m map[string]any
	if json.Unmarshal(args, &was) != nil || json.Unmarshal(updated, &m) != nil || m == nil {
		return updated
	}
	if was == nil {
		was = map[string]any{}
	}
	_, hadPath := was["path"]
	_, hadFilePath := was["file_path"]
	if fp, ok := m["file_path"].(string); ok && hadPath && !hadFilePath {
		delete(m, "file_path")
		m["path"] = fp
	}
	for k, v := range m {
		if v == nil {
			delete(was, k)
		} else {
			was[k] = v
		}
	}
	out, err := json.Marshal(was)
	if err != nil {
		return updated
	}
	return out
}
