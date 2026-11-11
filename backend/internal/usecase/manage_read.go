package usecase

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"slices"
	"strings"
	"time"

	"github.com/yanun0323/Team-Work/internal/adapter"
	"github.com/yanun0323/Team-Work/internal/model"
	"github.com/yanun0323/Team-Work/internal/model/enum"
)

const (
	toolReadTask      = "read_task"
	toolReadBlueprint = "read_blueprint"
	toolReadWorkflow  = "read_workflow"
	toolReadEmployee  = "read_employee"
	toolReadCompany   = "read_company"
	toolReadProvider  = "read_provider"

	// readTaskEntries is how many entries of a task's conversation read_task gives when not asked.
	readTaskEntries = 30
	// readTaskDescription is how much of a task's description read_task gives, in bytes, so the conversation fits too.
	readTaskDescription = 32 << 10
)

// readTaskSchema is read_task's arguments; the owner may leave task_id out for their own task.
func readTaskSchema(own bool) string {
	required, task := `,"required":["task_id"]`, "The task's id, from list_tasks"
	if own {
		required, task = "", "The task's id, from list_tasks; leave out for your own task"
	}
	return `{"type":"object","properties":{` +
		`"task_id":{"type":"string","description":"` + task + `"},` +
		`"before":{"type":"integer","minimum":1,"description":"Read the conversation's entries before this number, for older ones"},` +
		`"limit":{"type":"integer","minimum":1,"maximum":100,"description":"Most entries of the conversation to read"}}` + required + `}`
}

const readTaskDescriptionText = "Read a task in full by its id: its description, steps and who works them, how each step went with its handoff's headline, " +
	"then its conversation, the latest entries first fitting in 50KB. With before, read older entries of the conversation alone."

// readArgs are what read_task and the other read_* tools take.
type readArgs struct {
	ID     string `json:"id"`
	TaskID string `json:"task_id"`
	Before int    `json:"before"`
	Limit  int    `json:"limit"`
}

func parseRead(raw json.RawMessage) (readArgs, error) {
	var a readArgs
	if err := json.Unmarshal(raw, &a); err != nil {
		return a, err
	}
	a.ID = strings.TrimPrefix(strings.TrimSpace(a.ID), "#")
	a.TaskID = strings.TrimPrefix(strings.TrimSpace(a.TaskID), "#")
	if a.Before < 0 || a.Limit < 0 {
		return a, fmt.Errorf("before and limit must be positive")
	}
	return a, nil
}

// readingTools are list_* and read_*: lists give what tells items apart, and read_* one item in full.
func (e *Engine) readingTools(m manager) []adapter.Tool {
	noArgs := json.RawMessage(`{"type":"object","properties":{}}`)
	lister := func(name, description string, list func() any) adapter.Tool {
		return funcTool{model.ToolSpec{Name: name, Description: description, Parameters: noArgs}, func(context.Context, string, json.RawMessage) model.ToolResult {
			e.mu.Lock()
			defer e.mu.Unlock()
			return jsonResult(list())
		}}
	}
	// reader reads one item by id; ok false is one that is not there or not theirs, told the same way
	reader := func(name, kind, description string, read func(id string) (any, bool)) adapter.Tool {
		schema := json.RawMessage(`{"type":"object","properties":{"id":{"type":"string","description":"The ` + kind + `'s id, from list_` + kind + `s"}},"required":["id"]}`)
		if kind == "company" {
			schema = json.RawMessage(`{"type":"object","properties":{"id":{"type":"string","description":"The company's id, from list_companies"}},"required":["id"]}`)
		}
		return funcTool{model.ToolSpec{Name: name, Description: description, Parameters: schema}, func(_ context.Context, _ string, raw json.RawMessage) model.ToolResult {
			a, err := parseRead(raw)
			if err != nil {
				return toolError("bad arguments: %v", err)
			}
			if a.ID == "" {
				return toolError("id is required")
			}
			e.mu.Lock()
			defer e.mu.Unlock()
			v, ok := read(a.ID)
			if !ok {
				return toolError("no %s %s", kind, a.ID)
			}
			return jsonResult(v)
		}}
	}
	return []adapter.Tool{
		lister(toolListTasks, "List the tasks you can reach: id, number, title, stage and status. read_task reads one in full.", func() any { return e.listTasks(m) }),
		funcTool{model.ToolSpec{Name: toolReadTask, Description: readTaskDescriptionText, Parameters: json.RawMessage(readTaskSchema(false))}, func(_ context.Context, _ string, raw json.RawMessage) model.ToolResult {
			a, err := parseRead(raw)
			if err != nil {
				return toolError("bad arguments: %v", err)
			}
			if a.TaskID == "" {
				return toolError("task_id is required")
			}
			e.mu.Lock()
			defer e.mu.Unlock()
			return e.readTask(m, a)
		}},
		lister(toolListBlueprints, "List the blueprints by id and name. read_blueprint reads one in full, with the version to pass to save_blueprint.", e.listBlueprints),
		reader(toolReadBlueprint, "blueprint", "Read a blueprint in full by its id: its prompt, tools, skills, whether it can be changed, and the version to pass to save_blueprint. Built-in blueprints, ones from Git and ones a source provides cannot be changed.", e.readBlueprint),
		lister(toolListWorkflows, "List the task flows by id and name. read_workflow reads one in full, with the version to pass to save_workflow.", e.listWorkflows),
		reader(toolReadWorkflow, "workflow", "Read a task flow in full by its id: its steps with their prompts, its edges, whether it can be changed, and the version to pass to save_workflow. Built-in flows and ones a source provides cannot be changed.", e.readWorkflow),
		lister(toolListEmployees, "List the employees you can reach by id and name. read_employee reads one in full, with the version to pass to save_employees.", func() any { return e.listEmployees(m) }),
		reader(toolReadEmployee, "employee", "Read an employee you can reach by their id: blueprint, model, thinking level, and the version to pass to save_employees.", func(id string) (any, bool) { return e.readEmployee(m, id) }),
		lister(toolListCompanies, "List the companies you can reach by id and name. read_company reads one in full.", func() any { return e.listCompanies(m) }),
		reader(toolReadCompany, "company", "Read a company you can reach by its id: its folder and target branch.", func(id string) (any, bool) { return e.readCompany(m, id) }),
		lister(toolListProviders, "List the model providers by id and name. read_provider reads one in full, with the version to pass to save_provider.", e.listProviders),
		reader(toolReadProvider, "provider", "Read a model provider in full by its id: its models, each model's thinking levels, prices, and the version to pass to save_provider. API keys are never shown, only their last 4 characters.", e.readProvider),
		e.readChatTool(),
	}
}

func jsonResult(v any) model.ToolResult {
	raw, err := json.Marshal(v)
	if err != nil {
		return toolError("could not read: %v", err)
	}
	return model.ToolResult{Text: string(raw)}
}

// versionOf is a blueprint's or flow's version, from its content: any edit gives a new one.
func versionOf(v any) string {
	raw, _ := json.Marshal(v)
	sum := sha256.Sum256(raw)
	return hex.EncodeToString(sum[:8])
}

func (m manager) reaches(teamID string) bool { return m.teamID == "" || m.teamID == teamID }

// teamShown is the company of an item, said only to the airport's staff, who reach them all.
func (m manager) teamShown(teamID string) string {
	if m.teamID == "" {
		return teamID
	}
	return ""
}

// item is a row of a list: what tells it apart.
type item struct {
	ID     string `json:"id"`
	TeamID string `json:"teamId,omitempty"`
	Name   string `json:"name"`
}

func sortedItems(out []item) []item {
	slices.SortFunc(out, func(a, b item) int { return strings.Compare(a.ID, b.ID) })
	return out
}

// ---------- tasks ----------

func (e *Engine) listTasks(m manager) any {
	type row struct {
		ID     string         `json:"id"`
		TeamID string         `json:"teamId,omitempty"`
		Number int            `json:"number"`
		Title  string         `json:"title"`
		Stage  enum.TaskStage `json:"stage"`
		Status enum.Status    `json:"status"`
	}
	out := []row{}
	for _, t := range e.w.Tasks {
		if m.reaches(t.TeamID) {
			out = append(out, row{t.ID, m.teamShown(t.TeamID), t.Number, t.Title, t.Stage, e.statusOf(t)})
		}
	}
	slices.SortFunc(out, func(a, b row) int {
		if c := strings.Compare(a.TeamID, b.TeamID); c != 0 {
			return c
		}
		return a.Number - b.Number
	})
	return out
}

// reachableTask is a task they may read, by id. Call it holding the lock.
func (e *Engine) reachableTask(m manager, id string) *model.Task {
	if t := e.w.Tasks[id]; t != nil && m.reaches(t.TeamID) {
		return t
	}
	return nil
}

// readTask is read_task for employees, and for the owner on a task not their own. Call it holding the lock.
func (e *Engine) readTask(m manager, a readArgs) model.ToolResult {
	t := e.reachableTask(m, a.TaskID)
	if t == nil {
		return toolError("no task %s", a.TaskID)
	}
	head := fmt.Sprintf("Task #%d %q (%s).\n", t.Number, t.Title, t.ID)
	if a.Before == 0 {
		head = e.taskDetails(t)
	}
	text, err := e.taskConversation(t, head, a.Before, a.Limit)
	if err != nil {
		return toolError("%s", safeText(err))
	}
	return model.ToolResult{Text: text}
}

// taskDetails is a task as employees read it: what list_tasks used to give, then how each step went.
// Call it holding the lock.
func (e *Engine) taskDetails(t *model.Task) string {
	type step struct {
		ID         string        `json:"id"`
		Kind       enum.NodeKind `json:"kind"`
		Name       string        `json:"name"`
		ReplicaIDs []string      `json:"replicaIds"`
	}
	type details struct {
		ID          string            `json:"id"`
		TeamID      string            `json:"teamId"`
		Number      int               `json:"number"`
		Title       string            `json:"title"`
		Description string            `json:"description"`
		Stage       enum.TaskStage    `json:"stage"`
		Status      enum.Status       `json:"status"`
		Paused      bool              `json:"paused"`
		OwnerLed    bool              `json:"ownerLed"`
		WorkflowID  string            `json:"workflowId"`
		OwnerID     *string           `json:"ownerId"`
		Steps       []step            `json:"steps"`
		Origin      *model.TaskOrigin `json:"origin,omitempty"`
	}
	steps := make([]step, len(t.Workflow.Nodes))
	for i, n := range t.Workflow.Nodes {
		steps[i] = step{n.ID, n.Kind, n.Name, n.ReplicaIDs}
	}
	description := t.Description
	if len(description) > readTaskDescription {
		description = strings.ToValidUTF8(description[:readTaskDescription], "") + fmt.Sprintf("…[description cut: %d bytes in all]", len(t.Description))
	}
	raw, _ := json.Marshal(details{t.ID, t.TeamID, t.Number, t.Title, description, t.Stage, e.statusOf(t), t.Paused, t.OwnerLed(),
		t.WorkflowID, t.OwnerID, steps, t.Origin})
	var b strings.Builder
	b.Write(raw)
	b.WriteString("\n\n# How the steps went\n")
	subs := e.subsOf(t.ID)
	for _, n := range t.Workflow.Nodes {
		fmt.Fprintf(&b, "- %s %q:", n.ID, n.Name)
		ran := false
		for _, s := range subs {
			if s.NodeID != n.ID {
				continue
			}
			ran = true
			who := ""
			if s.ReplicaID != nil {
				who = " by " + e.replicaName(*s.ReplicaID) + " (" + *s.ReplicaID + ")"
			}
			fmt.Fprintf(&b, "\n  - %s%s: %s", s.ID, who, s.Status)
			if s.Cancelled {
				b.WriteString(", cancelled")
			}
			if s.Handoff != nil && s.Handoff.Human.Headline != "" {
				fmt.Fprintf(&b, "; handoff: %s", clip(s.Handoff.Human.Headline, 600))
			}
		}
		if !ran {
			b.WriteString(" not run yet")
		}
		b.WriteString("\n")
	}
	return b.String()
}

// taskConversation is head, then an owner-led task's conversation: the latest entries before seq before (0: the
// latest), at most limit of them, all in readChatBytes. A task not led by an owner has none. Call it holding the lock.
func (e *Engine) taskConversation(t *model.Task, head string, before, limit int) (string, error) {
	var b strings.Builder
	b.WriteString(head)
	if !t.OwnerLed() {
		b.WriteString("\n# Conversation\nThis task is not led by an owner, so it has no conversation: how its steps went is above.\n")
		return b.String(), nil
	}
	all, err := e.activities(t.ID)
	if err != nil {
		return "", err
	}
	if len(all) == 0 {
		b.WriteString("\n# Conversation\nIt has no entries yet.\n")
		return b.String(), nil
	}
	if limit <= 0 || limit > activityMost {
		limit = readTaskEntries
	}
	end := len(all)
	if before > 0 {
		end = min(before-1, end)
	}
	if end <= 0 {
		fmt.Fprintf(&b, "\n# Conversation\nIt has %d entries; none is before %d.\n", len(all), before)
		return b.String(), nil
	}
	// room for the conversation, after the head and the lines around it
	room := max(readChatBytes-b.Len()-300, 1<<10)
	lines := []string{}
	used, start := 0, end
	for i := end - 1; i >= 0 && end-i <= limit; i-- {
		if !ownerSees(all[i]) { // a meeting's words stay in the meeting; its conclusion is read
			continue
		}
		line := e.entryLine(t, i, all[i])
		if used+len(line) > room {
			if len(lines) > 0 {
				break
			}
			// one entry larger than a whole read: show its start
			line = strings.ToValidUTF8(line[:room], "") + "…[entry cut]\n"
		}
		lines = append(lines, line)
		used += len(line)
		start = i
	}
	slices.Reverse(lines)
	fmt.Fprintf(&b, "\n# Conversation\nEntries %d-%d of %d, oldest first.\n", start+1, end, len(all))
	for _, line := range lines {
		b.WriteString(line)
	}
	if start > 0 {
		fmt.Fprintf(&b, "\n[%d earlier; read them with read_task and before=%d]\n", start, start+1)
	}
	return b.String(), nil
}

// entryLine is entry i of a task's conversation, in full.
func (e *Engine) entryLine(t *model.Task, i int, a model.TaskActivity) string {
	at := time.UnixMilli(int64(a.At * 1000)).Local().Format("2006-01-02 15:04")
	who := a.From
	if a.Name != "" {
		who = a.Name
	}
	where := ""
	if a.NodeID != "" {
		where = " in step " + a.NodeID
	}
	return fmt.Sprintf("[%d] %s %s %s%s: %s%s\n", i+1, at, a.Kind, who, where, a.Text, attachmentNote(a.Images, a.Files))
}

// ---------- blueprints ----------

// readableBlueprint is a blueprint employees may read: an employee's own settings are theirs, not one to hire from;
// nor are the airport staff's, nor hidden ones. Call it holding the lock.
func (e *Engine) readableBlueprint(id string) *model.Blueprint {
	b := e.w.Blueprints[id]
	if b == nil || b.Owner != "" || b.ID == airportBlueprintID || e.blueprintHidden(b.ID) {
		return nil
	}
	return b
}

func (e *Engine) listBlueprints() any {
	out := []item{}
	for id := range e.w.Blueprints {
		if b := e.readableBlueprint(id); b != nil {
			out = append(out, item{ID: b.ID, Name: b.Name})
		}
	}
	return sortedItems(out)
}

func (e *Engine) readBlueprint(id string) (any, bool) {
	b := e.readableBlueprint(id)
	if b == nil {
		return nil, false
	}
	return struct {
		ID       string            `json:"id"`
		Version  string            `json:"version"`
		Name     string            `json:"name"`
		Source   string            `json:"source"`
		Editable bool              `json:"editable"`
		Prompt   string            `json:"prompt"`
		Comment  string            `json:"comment"`
		Tools    []enum.Tool       `json:"tools"`
		Skills   []model.SkillPack `json:"skills"`
	}{b.ID, versionOf(b), b.Name, b.Source.Kind, !model.IsLockedID(b.ID) && b.Source.Kind != "git", b.Prompt, b.Comment, b.Tools, e.writtenPacks(b.Skills)}, true
}

// ---------- flows ----------

func (e *Engine) listWorkflows() any {
	out := []item{}
	for _, wf := range e.w.Workflows {
		if !e.workflowHidden(wf.ID) {
			out = append(out, item{ID: wf.ID, Name: wf.Name})
		}
	}
	return sortedItems(out)
}

func (e *Engine) readWorkflow(id string) (any, bool) {
	wf := e.w.Workflows[id]
	if wf == nil || e.workflowHidden(wf.ID) {
		return nil, false
	}
	type node struct {
		ID         string           `json:"id"`
		Kind       enum.NodeKind    `json:"kind"`
		Name       string           `json:"name"`
		Prompt     string           `json:"prompt"`
		ReplicaIDs []string         `json:"replicaIds"`
		Handoff    enum.HandoffMode `json:"handoff"`
		Join       enum.JoinMode    `json:"join"`
	}
	type edge struct {
		From      string `json:"from"`
		To        string `json:"to"`
		Condition string `json:"condition,omitempty"`
	}
	out := struct {
		ID       string `json:"id"`
		Version  string `json:"version"`
		Name     string `json:"name"`
		Editable bool   `json:"editable"`
		Nodes    []node `json:"nodes"`
		Edges    []edge `json:"edges"`
	}{ID: wf.ID, Version: versionOf(wf), Name: wf.Name, Editable: !model.IsLockedID(wf.ID), Nodes: []node{}, Edges: []edge{}}
	for _, n := range wf.Nodes {
		out.Nodes = append(out.Nodes, node{n.ID, n.Kind, n.Name, n.Prompt, n.ReplicaIDs, n.Handoff, n.Join})
	}
	for _, x := range wf.Edges {
		out.Edges = append(out.Edges, edge{x.From, x.To, x.Condition})
	}
	return out, true
}

// ---------- employees and companies ----------

func (e *Engine) listEmployees(m manager) any {
	out := []item{}
	for _, r := range e.w.Replicas {
		if m.reaches(r.TeamID) {
			out = append(out, item{r.ID, m.teamShown(r.TeamID), r.Name})
		}
	}
	return sortedItems(out)
}

func (e *Engine) readEmployee(m manager, id string) (any, bool) {
	r := e.w.Replicas[id]
	if r == nil || !m.reaches(r.TeamID) {
		return nil, false
	}
	blueprint := ""
	if b := e.w.Blueprints[r.BlueprintID]; b != nil {
		blueprint = b.Name
		if b.Owner != "" {
			blueprint = "(custom)"
		}
	}
	return struct {
		ID          string `json:"id"`
		TeamID      string `json:"teamId"`
		Name        string `json:"name"`
		BlueprintID string `json:"blueprintId"`
		Blueprint   string `json:"blueprint"`
		Model       string `json:"model"`
		Effort      string `json:"effort"`
		Version     string `json:"version"`
	}{r.ID, r.TeamID, r.Name, r.BlueprintID, blueprint, r.Model, r.Effort, employeeVersion(r)}, true
}

func (e *Engine) listCompanies(m manager) any {
	out := []item{}
	for _, t := range e.w.Teams {
		if m.reaches(t.ID) {
			out = append(out, item{ID: t.ID, Name: t.Name})
		}
	}
	return sortedItems(out)
}

func (e *Engine) readCompany(m manager, id string) (any, bool) {
	t := e.w.Teams[id]
	if t == nil || !m.reaches(t.ID) {
		return nil, false
	}
	return struct {
		ID           string `json:"id"`
		Name         string `json:"name"`
		Folder       string `json:"folder"`
		TargetBranch string `json:"targetBranch"`
	}{t.ID, t.Name, t.Folder, t.TargetBranch}, true
}

// ---------- providers ----------

func (e *Engine) listProviders() any {
	out := []item{}
	for _, p := range e.w.Providers {
		out = append(out, item{ID: p.ID, Name: p.Name})
	}
	return sortedItems(out)
}

func (e *Engine) readProvider(id string) (any, bool) {
	p := e.w.Providers[id]
	if p == nil {
		return nil, false
	}
	return struct {
		ID       string                      `json:"id"`
		Version  string                      `json:"version"`
		Name     string                      `json:"name"`
		Kind     enum.ProviderKind           `json:"kind"`
		Login    string                      `json:"login"`
		KeyHint  string                      `json:"keyHint,omitempty"`
		SignedIn bool                        `json:"signedIn,omitempty"`
		BaseURL  string                      `json:"baseUrl"`
		Models   []string                    `json:"models"`
		Thinking map[string][]string         `json:"thinking,omitempty"`
		Prices   map[string]model.ModelPrice `json:"prices,omitempty"`
		Window   int                         `json:"contextWindow"`
	}{p.ID, versionOf(p), p.Name, p.Kind, p.Auth.Kind, p.Auth.KeyHint, p.Auth.SignedIn, p.BaseURL, p.Models, p.Thinking, p.Prices, model.ContextWindow(*p)}, true
}
