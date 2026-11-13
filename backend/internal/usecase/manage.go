package usecase

import (
	"context"
	"encoding/json"
	"fmt"
	"regexp"
	"slices"
	"strings"

	"go.yaml.in/yaml/v3"

	"github.com/yanun0323/Team-Work/internal/adapter"
	"github.com/yanun0323/Team-Work/internal/i18n"
	"github.com/yanun0323/Team-Work/internal/model"
	"github.com/yanun0323/Team-Work/internal/model/enum"
)

const (
	toolListTasks      = "list_tasks"
	toolListBlueprints = "list_blueprints"
	toolListWorkflows  = "list_workflows"
	toolListEmployees  = "list_employees"
	toolListCompanies  = "list_companies"
	toolCreateTask     = "create_task"
	toolUpdateTask     = "update_task"
	toolSaveBlueprint  = "save_blueprint"
	toolSaveWorkflow   = "save_workflow"
	toolListProviders  = "list_providers"
	toolSaveProvider   = "save_provider"
	toolSaveEmployees  = "save_employees"

	optionApprove = "approve"
	optionReject  = "reject"

	changeBlueprint = "blueprint"
	changeWorkflow  = "workflow"
	changeProvider  = "provider"
	changeEmployees = "employees"

	// maxTaskDepth is how many tasks in a row employees working on tasks can make, each from the one before.
	maxTaskDepth = 3
)

// isChangeTool says whether a tool can stop to have the user agree to what it writes.
func isChangeTool(name string) bool {
	return name == toolSaveBlueprint || name == toolSaveWorkflow || name == toolSaveProvider || name == toolSaveEmployees
}

// manager is who is using the tools: an employee on a task, or in a chat.
type manager struct {
	runID string
	r     *run
	// teamID is the one company they can touch; the airport's staff have none, and reach them all.
	teamID string
	// origin says who a task they make came from. Call it holding the lock.
	origin func() model.TaskOrigin
	// pause opens what the user answers, on the task's step or in the chat.
	pause func(model.PendingChange)
	// chatID is the chat they are in, where what they create shows; empty on a task.
	chatID string
}

// pinMadeBy shows in the chat what the tool created, when they are in one. Call it holding the lock.
func (e *Engine) pinMadeBy(m manager, tool, kind, id string) {
	if m.chatID != "" {
		e.pinMade(m.chatID, tool, kind, id)
	}
}

func (e *Engine) managerOfSub(in subRun) manager {
	m := manager{runID: in.subID, r: in.r}
	e.mu.Lock()
	if t := e.w.Tasks[in.taskID]; t != nil {
		m.teamID = t.TeamID
	}
	e.mu.Unlock()
	m.origin = func() model.TaskOrigin {
		depth := 1
		if t := e.w.Tasks[in.taskID]; t != nil && t.Origin != nil {
			depth += t.Origin.Depth
		}
		return model.TaskOrigin{Kind: "employee", ID: in.r.replicaID, Name: in.spec.name, Depth: depth}
	}
	m.pause = func(change model.PendingChange) {
		e.apply(in, func(t *model.Task, s *model.SubTask) {
			e.openReview(t, s, model.Review{Kind: enum.ReviewChange, Change: &change, Options: []model.ReviewOption{{ID: optionApprove}, {ID: optionReject}}})
		})
	}
	return m
}

func (e *Engine) managerOfChat(in chatRun) manager {
	m := manager{runID: in.id, r: in.r, chatID: in.id}
	e.mu.Lock()
	if c := e.w.Chats[in.id]; c != nil {
		m.teamID = c.TeamID
	}
	e.mu.Unlock()
	kind := "chat"
	if m.teamID == "" {
		kind = "airport"
	}
	m.origin = func() model.TaskOrigin { return model.TaskOrigin{Kind: kind, ID: in.id, Name: in.spec.name} }
	m.pause = func(change model.PendingChange) {
		e.applyChat(in, func(c *model.Chat) {
			c.Change = &change
			c.Unread = true
		})
	}
	return m
}

// mayManage is what a blueprint's tools allow: read_file lists and reads tasks, blueprints, flows, employees, companies
// and providers; write_file and run_command also change them.
func mayManage(allowed []enum.Tool) (read, write bool) {
	write = slices.Contains(allowed, enum.ToolWriteFile) || slices.Contains(allowed, enum.ToolRunCommand)
	return write || slices.Contains(allowed, enum.ToolReadFile), write
}

// manageTools are the tools for tasks, blueprints and flows that what is allowed gives. A step that may change nothing
// gets the reading ones alone.
func (e *Engine) manageTools(m manager, allowed []enum.Tool, writing bool) []adapter.Tool {
	read, write := mayManage(allowed)
	var out []adapter.Tool
	if read {
		out = append(out, e.readingTools(m)...)
	}
	if write && writing {
		out = append(out,
			funcTool{model.ToolSpec{Name: toolCreateTask, Description: createTaskDescription, Parameters: createTaskSchema(m.teamID == "")}, e.createTaskTool(m)},
			funcTool{model.ToolSpec{Name: toolUpdateTask, Description: "Change a task's title, description, who works its steps, or its owner. It takes effect at once: work under way keeps what it was told, later steps see the change.", Parameters: json.RawMessage(updateTaskSchema)}, e.updateTaskTool(m)},
			funcTool{model.ToolSpec{Name: toolSaveBlueprint, Description: saveBlueprintDescription, Parameters: json.RawMessage(saveBlueprintSchema)}, e.saveBlueprintTool(m)},
			funcTool{model.ToolSpec{Name: toolSaveWorkflow, Description: saveWorkflowDescription, Parameters: json.RawMessage(saveWorkflowSchema)}, e.saveWorkflowTool(m)},
			funcTool{model.ToolSpec{Name: toolSaveProvider, Description: saveProviderDescription, Parameters: json.RawMessage(saveProviderSchema)}, e.saveProviderTool(m)},
			funcTool{model.ToolSpec{Name: toolSaveEmployees, Description: saveEmployeesDescription, Parameters: saveEmployeesSchema(m)}, e.saveEmployeesTool(m)},
		)
	}
	return out
}

// ---------- tasks ----------

const createTaskDescription = "Create a task, with no confirmation. It waits in to-do until the user starts it. Who works its steps is the user's decision: do not pick employees yourself. " +
	taskBranchRule + " If the task needs changes not yet committed, tell the user to commit them before starting it. " +
	"If steps have nobody, or no owner_id is given, this fails and lists what is missing; then ask the user with ask_user, and call again with what they chose in staff and owner_id. " +
	"For a flow this task alone needs, give it in workflow instead of workflow_id: it is the task's own and is not added to the flow list, " +
	"so do not save it with save_workflow first. Its steps and edges follow save_workflow's rules; its name is the title when left out."

const staffProperty = `"staff":{"type":"object","description":"Step id to the ids of the employees who work it","additionalProperties":{"type":"array","items":{"type":"string"}}}`

// createTaskSchema is create_task's arguments; anyCompany asks which company too, for the airport's staff.
func createTaskSchema(anyCompany bool) json.RawMessage {
	team, required := "", `"title"`
	if anyCompany {
		team, required = `"team_id":{"type":"string","description":"The company, from list_companies"},`, `"title","team_id"`
	}
	return json.RawMessage(`{"type":"object","properties":{` + team +
		`"title":{"type":"string"},"description":{"type":"string"},` +
		`"workflow_id":{"type":"string","description":"A saved flow, from list_workflows. Give this or workflow"},` +
		`"workflow":{"type":"object","description":"A flow for this task alone, not saved to the flow list. Give this or workflow_id","properties":{` + flowProperties + `}},` +
		staffProperty + `,` +
		`"owner_id":{"type":"string","description":"The employee answerable for the whole task; it does not work any step by being its owner"}},"required":[` + required + `]}`)
}

const updateTaskSchema = `{"type":"object","properties":{"task_id":{"type":"string"},"title":{"type":"string"},"description":{"type":"string"},` + staffProperty + `,"owner_id":{"type":"string"}},"required":["task_id"]}`

// act changes the world for a tool, unless its run was stopped or replaced meanwhile. A stopped run must not write.
func (e *Engine) act(m manager, settings bool, fn func() error) error {
	return e.change(settings, func() error {
		if e.runs[m.runID] != m.r {
			return model.Errorf(model.CodeConflict, "這次執行已經停止")
		}
		return fn()
	})
}

// taskArgs are what create_task takes.
type taskArgs struct {
	TeamID      string              `json:"team_id"`
	Title       string              `json:"title"`
	Description string              `json:"description"`
	WorkflowID  string              `json:"workflow_id"`
	Workflow    *workflowArgs       `json:"workflow"`
	Staff       map[string][]string `json:"staff"`
	OwnerID     *string             `json:"owner_id"`
}

func (e *Engine) createTaskTool(m manager) func(context.Context, string, json.RawMessage) model.ToolResult {
	return func(_ context.Context, _ string, raw json.RawMessage) model.ToolResult {
		var a taskArgs
		if err := json.Unmarshal(raw, &a); err != nil {
			return toolError("invalid arguments: %v", err)
		}
		if (a.WorkflowID == "") == (a.Workflow == nil) {
			return toolError("give either workflow_id, a saved flow, or workflow, a flow for this task alone")
		}
		teamID := a.TeamID
		if m.teamID != "" {
			if teamID != "" && teamID != m.teamID {
				return toolError("you can only create tasks in your own company")
			}
			teamID = m.teamID
		} else if teamID == "" {
			return toolError("team_id is required: pick a company from list_companies")
		}
		var made *model.Task
		var refused string
		err := e.act(m, false, func() error {
			var err error
			made, refused, err = e.makeTask(teamID, a, m.origin())
			return err
		})
		if err != nil {
			return toolError("%s", safeText(err))
		}
		if refused != "" {
			return toolError("%s", refused)
		}
		return model.ToolResult{Text: madeTask(made)}
	}
}

// madeTask is what the model is told of a task it created.
func madeTask(t *model.Task) string {
	return fmt.Sprintf("created task #%d, id %s; it waits in to-do until the user starts it", t.Number, t.ID)
}

// makeTask creates a task in a company from create_task's arguments. refused is what the model is told when the
// task is not made for a reason of its own making; err is anything else. Call it holding the lock.
func (e *Engine) makeTask(teamID string, a taskArgs, origin model.TaskOrigin) (*model.Task, string, error) {
	if origin.Depth > maxTaskDepth {
		return nil, fmt.Sprintf("refused: this would be %d tasks in a row made by employees, and the limit is %d. Leave it to the user", origin.Depth, maxTaskDepth), nil
	}
	in := NewTask{TeamID: teamID, Title: a.Title, Description: a.Description, WorkflowID: a.WorkflowID, Staff: a.Staff, OwnerID: a.OwnerID, Origin: &origin}
	wf, label := e.w.Workflows[a.WorkflowID], a.WorkflowID
	if a.Workflow != nil {
		flow := *a.Workflow
		flow.ID, flow.Version = "", ""
		if flow.Name == nil || strings.TrimSpace(*flow.Name) == "" {
			flow.Name = ptr(a.Title)
		}
		built, err := e.buildFlow(flow, nil)
		if err != nil {
			return nil, "", err
		}
		wf, label, in.Workflow = built, "workflow", built
	} else if e.workflowHidden(a.WorkflowID) { // a hidden flow is one employees do not know of
		return nil, "", model.Errorf(model.CodeNotFound, "找不到任務藍圖")
	}
	if refused := e.staffProblem(teamID, wf, label, a.Staff, a.OwnerID); refused != "" {
		return nil, refused, nil
	}
	made, err := e.createTask(in)
	return made, "", err
}

// staffProblem says what is wrong with who a new task would have, for the model: staff for steps the flow does not
// have, people from elsewhere, and every step left with nobody. Other mistakes are createTask's to refuse. label names
// the flow in what the model is told.
func (e *Engine) staffProblem(teamID string, wf *model.Workflow, label string, staff map[string][]string, ownerID *string) string {
	if wf == nil || e.w.Teams[teamID] == nil {
		return ""
	}
	if ownerID != nil {
		if r := e.w.Replicas[*ownerID]; !model.WorksIn(r, teamID) {
			return ""
		}
	}
	for nodeID, ids := range staff {
		if nodeOf(wf, nodeID) == nil {
			return fmt.Sprintf("flow %s has no step %s", label, nodeID)
		}
		for _, id := range ids {
			if r := e.w.Replicas[id]; !model.WorksIn(r, teamID) {
				return fmt.Sprintf("%s is not an employee of this company", id)
			}
		}
	}
	probe := &model.Task{TeamID: teamID, Workflow: clone(*wf)}
	e.staffFlow(probe, staff, ownerID)
	var missing []string
	for _, n := range probe.Workflow.Nodes {
		if !slices.ContainsFunc(n.ReplicaIDs, func(r string) bool { return e.w.Replicas[r] != nil }) {
			missing = append(missing, fmt.Sprintf("%s (%s)", n.Name, n.ID))
		}
	}
	if name := crowdedStep(&probe.Workflow); name != "" {
		return "no task was created: work step " + name + " can have only one employee; only a discussion can have several"
	}
	var lacks, asks, args []string
	if len(missing) > 0 {
		lacks, asks, args = append(lacks, "these steps have nobody to work them: "+strings.Join(missing, ", ")), append(asks, "who should work them"), append(args, "staff")
	}
	// a task with no owner cannot be started, so ask now rather than leave it for the user to find
	if ownerID == nil || *ownerID == "" {
		lacks, asks, args = append(lacks, "it has no owner (owner_id)"), append(asks, "who owns the task"), append(args, "owner_id")
	}
	if len(lacks) == 0 {
		return ""
	}
	return "no task was created: " + strings.Join(lacks, "; ") + ". Do not pick by yourself: ask the user with ask_user " +
		strings.Join(asks, " and ") + ", then call again with " + strings.Join(args, " and ")
}

func (e *Engine) updateTaskTool(m manager) func(context.Context, string, json.RawMessage) model.ToolResult {
	return func(_ context.Context, _ string, raw json.RawMessage) model.ToolResult {
		var a struct {
			TaskID      string              `json:"task_id"`
			Title       *string             `json:"title"`
			Description *string             `json:"description"`
			Staff       map[string][]string `json:"staff"`
			OwnerID     *string             `json:"owner_id"`
		}
		if err := json.Unmarshal(raw, &a); err != nil {
			return toolError("invalid arguments: %v", err)
		}
		if a.Title == nil && a.Description == nil && a.Staff == nil && a.OwnerID == nil {
			return toolError("nothing to change")
		}
		err := e.act(m, false, func() error {
			t := e.w.Tasks[a.TaskID]
			if t == nil || !m.reaches(t.TeamID) {
				return model.Errorf(model.CodeNotFound, "找不到任務")
			}
			// what the user allowed an owner-led task is theirs to change, not an employee's
			if t.OwnerLed() && started(t) {
				return model.Errorf("forbidden", "由負責人主導且已開始的任務只有使用者能修改")
			}
			return e.updateTask(a.TaskID, TaskPatch{Title: a.Title, Description: a.Description, Staff: a.Staff, OwnerID: a.OwnerID})
		})
		if err != nil {
			return toolError("%s", safeText(err))
		}
		return model.ToolResult{Text: "updated task " + a.TaskID}
	}
}

// ---------- blueprints ----------

const saveBlueprintDescription = "Without id, create a blueprint; it can be used at once. With id and the version from read_blueprint, change one: the fields you leave out stay, " +
	"and you stop until the user agrees or refuses, which is what this call then returns. Built-in blueprints cannot be changed, so make a new one instead; nor can ones from Git or a source. " +
	"A skills repo not used before is read first and kept at the version read; one that cannot be read or has no skills is refused."

const saveBlueprintSchema = `{"type":"object","properties":{"id":{"type":"string"},"version":{"type":"string"},"name":{"type":"string"},"prompt":{"type":"string"},"comment":{"type":"string"},` +
	`"tools":{"type":"array","items":{"type":"string","enum":["readFile","writeFile","webSearch","runCommand"]}},` +
	`"skills":{"type":"array","items":{"type":"object","properties":{"source":{"type":"object","description":"A folder on this computer, or a Git repo","properties":{"kind":{"type":"string","enum":["local","git"]},"path":{"type":"string","description":"local: the folder; git: a folder in the repo, or leave out for the whole repo"},"repo":{"type":"string"},"ref":{"type":"string"}},"required":["kind"]},` +
	`"include":{"type":"array","items":{"type":"string"}},"exclude":{"type":"array","items":{"type":"string"}}},"required":["source"]}}}}`

type blueprintArgs struct {
	ID      string             `json:"id"`
	Version string             `json:"version"`
	Name    *string            `json:"name"`
	Prompt  *string            `json:"prompt"`
	Comment *string            `json:"comment"`
	Tools   *[]enum.Tool       `json:"tools"`
	Skills  *[]model.SkillPack `json:"skills"`
}

// applyTo puts what the model gave over a blueprint. It sets neither id, source kind nor look. A repo in read gets
// the version read there, which the source made for it keeps.
func (a blueprintArgs) applyTo(e *Engine, b *model.Blueprint, read map[NewSource]string) error {
	if a.Name != nil {
		b.Name = *a.Name
	}
	if a.Prompt != nil {
		b.Prompt = *a.Prompt
	}
	if a.Comment != nil {
		b.Comment = *a.Comment
	}
	if a.Tools != nil {
		b.Tools = *a.Tools
	}
	if a.Skills != nil {
		packs := make([]model.SkillPack, len(*a.Skills))
		for i, p := range *a.Skills {
			if p.Source == nil {
				return model.Errorf(model.CodeInvalid, "技能要有來源")
			}
			var source model.BlueprintSource
			switch p.Source.Kind {
			case "local":
				if strings.TrimSpace(p.Source.Path) == "" {
					return model.Errorf(model.CodeInvalid, "技能要有來源")
				}
				source = model.BlueprintSource{Kind: "local", Path: strings.TrimSpace(p.Source.Path)}
			case "git":
				if strings.TrimSpace(p.Source.Repo) == "" {
					return model.Errorf(model.CodeInvalid, "技能要有來源")
				}
				source = model.BlueprintSource{Kind: "git", Repo: githubAddress(p.Source.Repo), Ref: strings.TrimSpace(p.Source.Ref), Path: strings.Trim(strings.TrimSpace(p.Source.Path), "/")}
				if commit := read[NewSource{Kind: "git", Repo: source.Repo, Ref: source.Ref}]; commit != "" {
					source.Commit, source.Latest, source.Upstream = commit, commit, true
					source.Update = &model.SourceUpdate{At: e.clock(), OK: true}
				}
			default:
				return model.Errorf(model.CodeInvalid, "技能要有來源")
			}
			packs[i] = model.SkillPack{Source: &source, Include: p.Include, Exclude: p.Exclude}
			if packs[i].Exclude == nil {
				packs[i].Exclude = []string{}
			}
		}
		b.Skills = packs
	}
	b.Source = model.BlueprintSource{Kind: "yaml", Text: blueprintYAML(b, e.writtenPacks(b.Skills))}
	if err := e.checkNewRepos(b); err != nil {
		return err
	}
	return checkBlueprint(b)
}

const githubHTTPS = "https://github.com/"

var githubShort = regexp.MustCompile(`^[\w.-]+/[\w.-]+$`)

// githubAddress is the Git address for what was given: a bare owner/repo means GitHub over HTTPS, and any
// full address, SSH included, stays as written.
func githubAddress(repo string) string {
	repo = strings.TrimSpace(repo)
	if githubShort.MatchString(repo) {
		return githubHTTPS + strings.TrimSuffix(repo, ".git")
	}
	return repo
}

// readNewRepos reads each repo the packs name that is not a source yet, as adding a source does, and gives the version
// read for each. It runs outside the lock and reads no other source. A repo that cannot be read or has no skills is the
// model's to fix, so it comes back as what to tell it.
func (e *Engine) readNewRepos(ctx context.Context, a blueprintArgs) (map[NewSource]string, string) {
	read := map[NewSource]string{}
	if a.Skills == nil {
		return read, ""
	}
	for _, p := range *a.Skills {
		if p.Source == nil || p.Source.Kind != "git" {
			continue
		}
		in, err := cleanSource(NewSource{Kind: "git", Repo: p.Source.Repo, Ref: p.Source.Ref})
		if err != nil {
			continue // applyTo refuses it
		}
		if _, done := read[in]; done || e.keepsSource(in) {
			continue
		}
		got, err := e.PreviewSource(ctx, in)
		if err != nil {
			return nil, fmt.Sprintf("nothing was written: the skills repo %s could not be read: %s", in.Repo, safeText(err))
		}
		if len(got.Items) == 0 {
			return nil, fmt.Sprintf("nothing was written: the skills repo %s has no skills", in.Repo)
		}
		read[in] = got.Commit
	}
	return read, ""
}

func (e *Engine) keepsSource(in NewSource) bool {
	e.mu.Lock()
	defer e.mu.Unlock()
	for _, s := range e.w.Sources {
		if sameSource(s, in) {
			return true
		}
	}
	return false
}

// newRepos are the repos b's packs bring with a version read for them, each once, as the source each will become.
func newRepos(b *model.Blueprint) []model.BlueprintSource {
	var out []model.BlueprintSource
	for _, p := range b.Skills {
		if p.Source == nil || p.Source.Kind != "git" || p.Source.Commit == "" {
			continue
		}
		if !slices.ContainsFunc(out, func(s model.BlueprintSource) bool { return s.Repo == p.Source.Repo && s.Ref == p.Source.Ref }) {
			out = append(out, model.BlueprintSource{Kind: "git", Repo: p.Source.Repo, Ref: p.Source.Ref, Commit: p.Source.Commit})
		}
	}
	return out
}

// checkNewRepos refuses a repo read for b that became a source at another version since, so what is kept is what was
// read and shown. Call it holding the lock.
func (e *Engine) checkNewRepos(b *model.Blueprint) error {
	for _, n := range newRepos(b) {
		for _, s := range e.w.Sources {
			if sameSource(s, NewSource{Kind: "git", Repo: n.Repo, Ref: n.Ref}) && s.Commit != n.Commit {
				return model.Errorf(model.CodeConflict, "技能來源 %s 已經在用別的版本，請重新讀取", n.Repo)
			}
		}
	}
	return nil
}

// repoText names a repo source, its branch and version, as the model and the user read it.
func repoText(s model.BlueprintSource) string {
	out := s.Repo
	if s.Ref != "" {
		out += " " + s.Ref
	}
	return out + " @ " + shortCommit(s.Commit)
}

func shortCommit(c string) string {
	if len(c) > 7 {
		return c[:7]
	}
	return c
}

// newReposSaid tells the model which sources saving b added, if any.
func newReposSaid(b *model.Blueprint) string {
	var names []string
	for _, s := range newRepos(b) {
		names = append(names, repoText(s))
	}
	if len(names) == 0 {
		return ""
	}
	return "; new skill sources kept at the version read: " + strings.Join(names, ", ")
}

var toolYAMLNames = map[enum.Tool]string{enum.ToolReadFile: "read_file", enum.ToolWriteFile: "write_file", enum.ToolWebSearch: "web_search", enum.ToolRunCommand: "run_command"}

// blueprintYAML is what a blueprint is kept as, in the form the frontend's blueprintToYaml writes it.
func blueprintYAML(b *model.Blueprint, packs []model.SkillPack) string {
	type pack struct {
		Path    string   `yaml:"path,omitempty"`
		Repo    string   `yaml:"repo,omitempty"`
		Ref     string   `yaml:"ref,omitempty"`
		Include []string `yaml:"include,omitempty"`
		Exclude []string `yaml:"exclude,omitempty"`
	}
	doc := struct {
		Name    string   `yaml:"name"`
		Prompt  string   `yaml:"prompt,omitempty"`
		Comment string   `yaml:"comment,omitempty"`
		Skills  []pack   `yaml:"skills"`
		Tools   []string `yaml:"tools"`
	}{Name: b.Name, Prompt: b.Prompt, Comment: b.Comment, Skills: []pack{}, Tools: []string{}}
	for _, p := range packs {
		if p.Source != nil {
			doc.Skills = append(doc.Skills, pack{p.Source.Path, strings.TrimPrefix(p.Source.Repo, githubHTTPS), p.Source.Ref, p.Include, p.Exclude})
		}
	}
	for _, t := range b.Tools {
		doc.Tools = append(doc.Tools, toolYAMLNames[t])
	}
	raw, err := yaml.Marshal(doc)
	if err != nil {
		return ""
	}
	return string(raw)
}

func (e *Engine) saveBlueprintTool(m manager) func(context.Context, string, json.RawMessage) model.ToolResult {
	return func(ctx context.Context, _ string, raw json.RawMessage) model.ToolResult {
		var a blueprintArgs
		if err := json.Unmarshal(raw, &a); err != nil {
			return toolError("invalid arguments: %v", err)
		}
		read, problem := e.readNewRepos(ctx, a)
		if problem != "" {
			return toolError("%s", problem)
		}
		if a.ID == "" {
			var made *model.Blueprint
			err := e.act(m, true, func() error {
				b := &model.Blueprint{Look: presets.Looks[e.w.Seq%len(presets.Looks)]}
				if err := a.applyTo(e, b, read); err != nil {
					return err
				}
				b.ID = e.uid("bp")
				e.w.Blueprints[b.ID] = b
				e.pinMadeBy(m, toolSaveBlueprint, changeBlueprint, b.ID)
				made = clone(b)
				return nil
			})
			if err != nil {
				return toolError("%s", safeText(err))
			}
			return model.ToolResult{Text: fmt.Sprintf("created blueprint %s, version %s%s", made.ID, versionOf(made), newReposSaid(made))}
		}
		var change *model.PendingChange
		err := e.act(m, false, func() error {
			old := e.w.Blueprints[a.ID]
			if old == nil || old.Owner != "" || e.blueprintHidden(a.ID) {
				return model.Errorf(model.CodeNotFound, "找不到藍圖")
			}
			if err := errLocked(a.ID); err != nil {
				return err
			}
			if old.Source.Kind == "git" {
				return model.Errorf(model.CodeConflict, "Git 來源的藍圖不能修改")
			}
			if a.Version != versionOf(old) {
				return model.Errorf(model.CodeConflict, "版本不符，內容已經被改過，請重新讀取")
			}
			next := clone(old)
			if err := a.applyTo(e, next, read); err != nil {
				return err
			}
			if lines := e.blueprintDiff(old, next); len(lines) > 0 {
				for _, s := range newRepos(next) {
					lines = append(lines, model.ChangeLine{Field: "source", After: repoText(s)})
				}
				change = &model.PendingChange{Kind: changeBlueprint, TargetID: a.ID, Name: old.Name, Version: a.Version, Lines: lines, Blueprint: next}
			}
			return nil
		})
		return waitForUser(m, change, err)
	}
}

// waitForUser ends a tool that changes something: at once if it was refused or there is nothing to change, or by
// stopping for the user.
func waitForUser(m manager, change *model.PendingChange, err error) model.ToolResult {
	if err != nil {
		return toolError("%s", safeText(err))
	}
	if change == nil {
		return model.ToolResult{Text: "that is what it already is; nothing to change"}
	}
	return model.ToolResult{Stop: true, After: func() { m.pause(*change) }}
}

func (e *Engine) blueprintDiff(before, after *model.Blueprint) []model.ChangeLine {
	var lines []model.ChangeLine
	add := func(field, was, is string) {
		if was != is {
			lines = append(lines, model.ChangeLine{Field: field, Before: was, After: is})
		}
	}
	add("name", before.Name, after.Name)
	add("prompt", before.Prompt, after.Prompt)
	add("comment", before.Comment, after.Comment)
	add("tools", toolNames(before.Tools), toolNames(after.Tools))
	add("skills", skillsText(e.writtenPacks(before.Skills)), skillsText(e.writtenPacks(after.Skills)))
	return lines
}

func toolNames(list []enum.Tool) string {
	names := make([]string, len(list))
	for i, t := range list {
		names[i] = toolYAMLNames[t]
	}
	slices.Sort(names)
	return strings.Join(names, ", ")
}

func skillsText(packs []model.SkillPack) string {
	out := make([]string, 0, len(packs))
	for _, p := range packs {
		where := ""
		if p.Source != nil {
			where = p.Source.Path + p.Source.Repo
			if p.Source.Kind == "git" && p.Source.Path != "" {
				where = p.Source.Repo + "/" + p.Source.Path
			}
		}
		if p.Include != nil {
			where += " +" + strings.Join(p.Include, ",")
		}
		if len(p.Exclude) > 0 {
			where += " -" + strings.Join(p.Exclude, ",")
		}
		out = append(out, where)
	}
	return strings.Join(out, "\n")
}

// ---------- providers ----------

const saveProviderDescription = "Without id, add a model provider; it can be used at once. With id and the version from read_provider, change one: the fields you leave out stay, " +
	"and you stop until the user agrees or refuses, which is what this call then returns. A provider with an API key is asked for its models first, so a wrong key or base URL fails here. " +
	"A subscription cannot be signed in from here: add it with login subscription, then ask the user to sign in on the settings page."

const saveProviderSchema = `{"type":"object","properties":{"id":{"type":"string"},"version":{"type":"string"},"name":{"type":"string"},` +
	`"kind":{"type":"string","enum":["anthropic","openai","google","compatible"],"description":"Only when adding; compatible is any OpenAI-compatible API and needs base_url"},` +
	`"login":{"type":"string","enum":["apiKey","subscription"],"description":"Only when adding; apiKey when left out. Subscriptions are for anthropic and openai"},` +
	`"api_key":{"type":"string","description":"Required when adding with apiKey; when changing, a new key, or leave out to keep the one there is"},` +
	`"base_url":{"type":"string"},` +
	`"context_window":{"type":"integer","description":"How many tokens its models can read, 8000 to 10000000; only for google and compatible, as anthropic and openai have their own. 0 unsets it"},` +
	`"prices":{"type":"object","description":"Model id to its price in USD per million tokens; replaces all prices","additionalProperties":{"type":"object","properties":{"input":{"type":"number"},"output":{"type":"number"},"cacheRead":{"type":"number"}}}}}}`

func (e *Engine) saveProviderTool(m manager) func(context.Context, string, json.RawMessage) model.ToolResult {
	return func(ctx context.Context, _ string, raw json.RawMessage) model.ToolResult {
		var a struct {
			ID      string                      `json:"id"`
			Version string                      `json:"version"`
			Name    *string                     `json:"name"`
			Kind    enum.ProviderKind           `json:"kind"`
			Login   string                      `json:"login"`
			APIKey  *string                     `json:"api_key"`
			BaseURL *string                     `json:"base_url"`
			Prices  map[string]model.ModelPrice `json:"prices"`
			Window  *int                        `json:"context_window"`
		}
		if err := json.Unmarshal(raw, &a); err != nil {
			return toolError("invalid arguments: %v", err)
		}
		for id, price := range a.Prices {
			if price.Input < 0 || price.Output < 0 || price.CacheRead < 0 {
				return toolError("the price of %s cannot be negative", id)
			}
		}
		if e.stopped(m) {
			return toolError("this run has stopped")
		}
		if a.ID == "" {
			in := NewProvider{Kind: a.Kind, Login: ProviderLogin{Kind: "apiKey"}, Prices: a.Prices}
			if !slices.Contains([]enum.ProviderKind{enum.ProviderAnthropic, enum.ProviderOpenAI, enum.ProviderGoogle, enum.ProviderCompatible}, a.Kind) {
				return toolError("kind must be anthropic, openai, google or compatible")
			}
			if a.Name != nil {
				in.Name = *a.Name
			}
			if a.BaseURL != nil {
				in.BaseURL = *a.BaseURL
			}
			if a.APIKey != nil {
				in.Login.APIKey = *a.APIKey
			}
			if a.Window != nil {
				in.ContextWindow = *a.Window
			}
			switch a.Login {
			case "", "apiKey":
			case "subscription":
				in.Login.Kind = "subscription"
			default:
				return toolError("login must be apiKey or subscription")
			}
			made, err := e.AddProvider(ctx, in)
			if err != nil {
				return toolError("%s", safeText(err))
			}
			_ = e.do(func() error {
				e.pinMadeBy(m, toolSaveProvider, changeProvider, made.ID)
				return nil
			})
			text := fmt.Sprintf("added provider %s, version %s, with models: %s", made.ID, versionOf(made), strings.Join(made.Models, ", "))
			if made.Auth.Kind == "subscription" {
				text = fmt.Sprintf("added provider %s; it has no models until the user signs in on the settings page", made.ID)
			}
			return model.ToolResult{Text: text}
		}
		if a.Kind != "" || a.Login != "" {
			return toolError("kind and login cannot be changed; leave them out")
		}
		e.mu.Lock()
		old := e.w.Providers[a.ID]
		var before model.ModelProvider
		if old != nil {
			before = *clone(old)
		}
		e.mu.Unlock()
		if old == nil {
			return toolError("no provider with id %s", a.ID)
		}
		if a.Version != versionOf(&before) {
			return toolError("version does not match: it was changed since; read it again with read_provider")
		}
		patch := ProviderPatch{Name: a.Name, BaseURL: a.BaseURL, Prices: a.Prices, ContextWindow: a.Window}
		newKey := a.APIKey != nil && strings.TrimSpace(*a.APIKey) != ""
		if newKey {
			patch.Login = &ProviderLogin{Kind: "apiKey", APIKey: *a.APIKey}
		}
		// The stored key goes to a new address only once the user agrees: before that, the model's address is asked
		// nothing, and the models are read again after the change is written.
		moved := a.BaseURL != nil && strings.TrimSpace(*a.BaseURL) != before.BaseURL && !newKey
		edit, err := e.prepareProvider(ctx, a.ID, patch, !moved)
		if err != nil {
			return toolError("%s", safeText(err))
		}
		var change *model.PendingChange
		err = e.act(m, false, func() error {
			if now := e.w.Providers[a.ID]; now == nil || versionOf(now) != a.Version {
				return model.Errorf(model.CodeConflict, "版本不符，內容已經被改過，請重新讀取")
			}
			lines := providerDiff(&before, &edit.provider, newKey && edit.key != e.secrets[a.ID])
			if len(lines) == 0 {
				return nil
			}
			change = &model.PendingChange{Kind: changeProvider, TargetID: a.ID, Name: before.Name, Version: a.Version, Lines: lines, Provider: clone(&edit.provider)}
			if newKey {
				change.KeyRef = e.uid("key")
				e.pendingKeys[change.KeyRef] = edit.key
			}
			return nil
		})
		return waitForUser(m, change, err)
	}
}

// stopped says whether a tool's run was stopped or replaced, for a tool that has to ask something before it writes.
func (e *Engine) stopped(m manager) bool {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.runs[m.runID] != m.r
}

func providerDiff(before, after *model.ModelProvider, newKey bool) []model.ChangeLine {
	var lines []model.ChangeLine
	add := func(field, was, is string) {
		if was != is {
			lines = append(lines, model.ChangeLine{Field: field, Before: was, After: is})
		}
	}
	hint := func(p *model.ModelProvider) string {
		if p.Auth.Kind != "apiKey" {
			return p.Auth.Kind
		}
		return "…" + p.Auth.KeyHint
	}
	add("name", before.Name, after.Name)
	add("baseUrl", before.BaseURL, after.BaseURL)
	if newKey {
		lines = append(lines, model.ChangeLine{Field: "apiKey", Before: hint(before), After: hint(after)})
	}
	add("prices", pricesText(before.Prices), pricesText(after.Prices))
	add("models", strings.Join(before.Models, ", "), strings.Join(after.Models, ", "))
	return lines
}

func pricesText(prices map[string]model.ModelPrice) string {
	out := make([]string, 0, len(prices))
	for id, p := range prices {
		out = append(out, fmt.Sprintf("%s: %g / %g / %g", id, p.Input, p.Output, p.CacheRead))
	}
	slices.Sort(out)
	return strings.Join(out, "\n")
}

// ---------- flows ----------

const saveWorkflowDescription = "Without id, create a task flow; it can be used at once. With id and the version from read_workflow, replace one: nodes and edges are the whole new list, " +
	"and in a node that has an id already what you leave out stays. Then you stop until the user agrees or refuses, which is what this call then returns. Tasks under way keep the flow they started with. Built-in flows and ones a source provides cannot be changed, so make a new one instead. " +
	"A step nothing leads to is a start: a task starts every start at once, each with the task as given. A step that leads nowhere is a last step, and the task is done once every branch that ran is done. No cycles. Kind task is only in old flows; use work. " +
	"A work step may send work back to the one step before it when that step hands on to it alone. Do not give positions: they are worked out for you. Node ids are yours to choose, unique in the flow. " +
	"Save only a flow worth keeping: for one a single task needs, give it to create_task as workflow instead."

const saveWorkflowSchema = `{"type":"object","properties":{"id":{"type":"string"},"version":{"type":"string"},` + flowProperties + `}}`

// flowProperties are a flow's name, steps and edges, as save_workflow and create_task take them.
const flowProperties = `"name":{"type":"string"},` +
	`"nodes":{"type":"array","items":{"type":"object","properties":{"id":{"type":"string"},"kind":{"type":"string","enum":["work","talk"]},"name":{"type":"string"},"prompt":{"type":"string"},` +
	`"replica_ids":{"type":"array","items":{"type":"string"},"description":"Usually left out: each task decides who works its steps. One on a work step; a talk step may have several, who hold it as a meeting, the first chairing"},` +
	`"handoff":{"type":"string","enum":["all","pickOne"]},"join":{"type":"string","enum":["all","any"]}},"required":["id"]}},` +
	`"edges":{"type":"array","items":{"type":"object","properties":{"from":{"type":"string"},"to":{"type":"string"},"condition":{"type":"string"}},"required":["from","to"]}}`

type workflowArgs struct {
	ID      string  `json:"id"`
	Version string  `json:"version"`
	Name    *string `json:"name"`
	Nodes   *[]struct {
		ID         string            `json:"id"`
		Kind       *enum.NodeKind    `json:"kind"`
		Name       *string           `json:"name"`
		Prompt     *string           `json:"prompt"`
		ReplicaIDs *[]string         `json:"replica_ids"`
		Handoff    *enum.HandoffMode `json:"handoff"`
		Join       *enum.JoinMode    `json:"join"`
	} `json:"nodes"`
	Edges *[]struct {
		From      string `json:"from"`
		To        string `json:"to"`
		Condition string `json:"condition"`
	} `json:"edges"`
}

// buildFlow makes the flow the model described over what there is, nil for a new one, and refuses what could not run.
func (e *Engine) buildFlow(a workflowArgs, old *model.Workflow) (*model.Workflow, error) {
	next := &model.Workflow{Nodes: []model.WorkflowNode{}, Edges: []model.WorkflowEdge{}}
	if old != nil {
		next = clone(old)
	}
	if a.Name != nil {
		next.Name = strings.TrimSpace(*a.Name)
	}
	known := map[string]bool{}
	if a.Nodes != nil {
		was := next.Nodes
		next.Nodes = make([]model.WorkflowNode, len(*a.Nodes))
		for i, in := range *a.Nodes {
			n := model.WorkflowNode{ID: in.ID, Kind: enum.NodeWork, ReplicaIDs: []string{}, Handoff: enum.HandoffAll, Join: enum.JoinAll}
			if at := slices.IndexFunc(was, func(x model.WorkflowNode) bool { return x.ID == in.ID }); at >= 0 {
				n = was[at]
				known[in.ID] = true
			}
			if in.Kind != nil {
				n.Kind = *in.Kind
			}
			if in.Name != nil {
				n.Name = strings.TrimSpace(*in.Name)
			}
			if in.Prompt != nil {
				n.Prompt = *in.Prompt
			}
			if in.ReplicaIDs != nil {
				n.ReplicaIDs = *in.ReplicaIDs
			}
			if in.Handoff != nil {
				n.Handoff = *in.Handoff
			}
			if in.Join != nil {
				n.Join = *in.Join
			}
			if n.Name == "" {
				return nil, model.Errorf(model.CodeInvalid, "節點要有名稱")
			}
			if !slices.Contains([]enum.NodeKind{enum.NodeTask, enum.NodeWork, enum.NodeTalk}, n.Kind) ||
				!slices.Contains([]enum.HandoffMode{enum.HandoffAll, enum.HandoffPickOne}, n.Handoff) ||
				!slices.Contains([]enum.JoinMode{enum.JoinAll, enum.JoinAny}, n.Join) {
				return nil, model.Errorf(model.CodeInvalid, "節點「%s」的設定不正確", n.Name)
			}
			if n.Kind != enum.NodeTalk && len(n.ReplicaIDs) > 1 {
				return nil, model.Errorf(model.CodeInvalid, "工作步驟「%s」只能有一位員工", n.Name)
			}
			next.Nodes[i] = n
		}
	} else {
		for _, n := range next.Nodes {
			known[n.ID] = true
		}
	}
	if a.Edges != nil {
		was := next.Edges
		next.Edges = make([]model.WorkflowEdge, len(*a.Edges))
		seen := map[string]bool{}
		for i, in := range *a.Edges {
			if seen[in.From+"\x00"+in.To] {
				return nil, model.Errorf(model.CodeInvalid, "任務藍圖的連線重複")
			}
			seen[in.From+"\x00"+in.To] = true
			edge := model.WorkflowEdge{From: in.From, To: in.To, Condition: in.Condition}
			if at := slices.IndexFunc(was, func(x model.WorkflowEdge) bool { return x.From == in.From && x.To == in.To }); at >= 0 {
				edge.ID = was[at].ID
			} else {
				edge.ID = e.uid("e")
			}
			next.Edges[i] = edge
		}
	}
	settleStarts(next)
	e.localize(next, e.w.Language)
	if err := e.checkFlow(next); err != nil {
		return nil, err
	}
	placeNodes(next, known)
	return next, nil
}

// placeNodes finds where new steps sit in the drawing: a row below the lowest step they follow, in the first free spot
// from above the first of those. Steps already placed stay. The flow has no cycle by now.
func placeNodes(wf *model.Workflow, placed map[string]bool) {
	taken := map[model.Point]bool{}
	at := map[string]model.Point{}
	for _, n := range wf.Nodes {
		if placed[n.ID] {
			taken[n.Pos], at[n.ID] = true, n.Pos
		}
	}
	var place func(id string) model.Point
	place = func(id string) model.Point {
		if p, ok := at[id]; ok {
			return p
		}
		var spot model.Point
		for i, edge := range inEdges(wf, id) {
			from := place(edge.From)
			if i == 0 {
				spot.X = from.X
			}
			spot.Y = max(spot.Y, from.Y+layoutDY)
		}
		for taken[spot] {
			spot.X += layoutDX
		}
		taken[spot], at[id] = true, spot
		return spot
	}
	for i := range wf.Nodes {
		wf.Nodes[i].Pos = place(wf.Nodes[i].ID)
	}
}

func (e *Engine) saveWorkflowTool(m manager) func(context.Context, string, json.RawMessage) model.ToolResult {
	return func(_ context.Context, _ string, raw json.RawMessage) model.ToolResult {
		var a workflowArgs
		if err := json.Unmarshal(raw, &a); err != nil {
			return toolError("invalid arguments: %v", err)
		}
		if a.ID == "" {
			var made *model.Workflow
			err := e.act(m, true, func() error {
				wf, err := e.buildFlow(a, nil)
				if err != nil {
					return err
				}
				wf.ID = e.uid("wf")
				e.w.Workflows[wf.ID] = wf
				e.pinMadeBy(m, toolSaveWorkflow, changeWorkflow, wf.ID)
				made = clone(wf)
				return nil
			})
			if err != nil {
				return toolError("%s", safeText(err))
			}
			return model.ToolResult{Text: fmt.Sprintf("created task flow %s, version %s", made.ID, versionOf(made))}
		}
		var change *model.PendingChange
		err := e.act(m, false, func() error {
			old := e.w.Workflows[a.ID]
			if old == nil || e.workflowHidden(a.ID) {
				return model.Errorf(model.CodeNotFound, "找不到任務藍圖")
			}
			if err := errLocked(a.ID); err != nil {
				return err
			}
			if a.Version != versionOf(old) {
				return model.Errorf(model.CodeConflict, "版本不符，內容已經被改過，請重新讀取")
			}
			next, err := e.buildFlow(a, old)
			if err != nil {
				return err
			}
			if lines := e.workflowDiff(old, next); len(lines) > 0 {
				change = &model.PendingChange{Kind: changeWorkflow, TargetID: a.ID, Name: old.Name, Version: a.Version, Lines: lines, Workflow: next}
			}
			return nil
		})
		return waitForUser(m, change, err)
	}
}

func (e *Engine) workflowDiff(before, after *model.Workflow) []model.ChangeLine {
	var lines []model.ChangeLine
	if before.Name != after.Name {
		lines = append(lines, model.ChangeLine{Field: "name", Before: before.Name, After: after.Name})
	}
	staff := func(ids []string) string {
		names := make([]string, len(ids))
		for i, id := range ids {
			names[i] = id
			if r := e.w.Replicas[id]; r != nil {
				names[i] = r.Name
			}
		}
		return strings.Join(names, ", ")
	}
	for _, n := range before.Nodes {
		if nodeOf(after, n.ID) == nil {
			lines = append(lines, model.ChangeLine{Field: "node", Before: n.Name})
		}
	}
	for _, n := range after.Nodes {
		was := nodeOf(before, n.ID)
		if was == nil {
			lines = append(lines, model.ChangeLine{Field: "node", After: n.Name})
			continue
		}
		add := func(field, a, b string) {
			if a != b {
				lines = append(lines, model.ChangeLine{Field: field, Node: was.Name, Before: a, After: b})
			}
		}
		add("name", was.Name, n.Name)
		add("kind", string(was.Kind), string(n.Kind))
		add("prompt", was.Prompt, n.Prompt)
		add("staff", staff(was.ReplicaIDs), staff(n.ReplicaIDs))
		add("handoff", string(was.Handoff), string(n.Handoff))
		add("join", string(was.Join), string(n.Join))
	}
	name := func(wf *model.Workflow, id string) string {
		if n := nodeOf(wf, id); n != nil {
			return n.Name
		}
		return id
	}
	link := func(wf *model.Workflow, x model.WorkflowEdge) string {
		return name(wf, x.From) + " → " + name(wf, x.To)
	}
	find := func(wf *model.Workflow, x model.WorkflowEdge) *model.WorkflowEdge {
		for i := range wf.Edges {
			if wf.Edges[i].From == x.From && wf.Edges[i].To == x.To {
				return &wf.Edges[i]
			}
		}
		return nil
	}
	for _, x := range before.Edges {
		if find(after, x) == nil {
			lines = append(lines, model.ChangeLine{Field: "edge", Before: link(before, x)})
		}
	}
	for _, x := range after.Edges {
		was := find(before, x)
		if was == nil {
			lines = append(lines, model.ChangeLine{Field: "edge", After: link(after, x)})
		} else if was.Condition != x.Condition {
			lines = append(lines, model.ChangeLine{Field: "condition", Node: link(after, x), Before: was.Condition, After: x.Condition})
		}
	}
	return lines
}

// ---------- employees ----------

const saveEmployeesDescription = "Hire or change employees, several in one call. An item without id hires one at once: name, blueprint_id from list_blueprints " +
	"and model from read_provider are needed; effort is one of the model's thinking levels, its default when left out. " +
	"An item with id and the version from read_employee changes that employee: the fields you leave out stay. " +
	"The changes are shown to the user together and you stop until they agree or refuse, which is what this call then returns. " +
	"If any item is refused, nothing is written; hires stand even when the user refuses the changes. Hire only when the user asked for it; who works a task's steps is theirs to decide."

func saveEmployeesSchema(m manager) json.RawMessage {
	team := ""
	if m.teamID == "" {
		team = `"team_id":{"type":"string","description":"The company to hire into, from list_companies"},`
	}
	return json.RawMessage(`{"type":"object","properties":{` + team + `"employees":{"type":"array","minItems":1,"items":{"type":"object","properties":{` +
		`"id":{"type":"string"},"version":{"type":"string"},"name":{"type":"string"},"blueprint_id":{"type":"string"},"model":{"type":"string"},"effort":{"type":"string"}}}}},` +
		`"required":["employees"]}`)
}

// employeeVersion is the version of what save_employees changes about an employee; their notes changing does not move it.
func employeeVersion(r *model.Replica) string {
	return versionOf(struct{ Name, BlueprintID, Model, Effort string }{r.Name, r.BlueprintID, r.Model, r.Effort})
}

func patchOf(c model.EmployeeChange) ReplicaPatch {
	return ReplicaPatch{Name: c.Name, BlueprintID: c.BlueprintID, Model: c.Model, Effort: c.Effort}
}

func (e *Engine) saveEmployeesTool(m manager) func(context.Context, string, json.RawMessage) model.ToolResult {
	return func(_ context.Context, _ string, raw json.RawMessage) model.ToolResult {
		var a struct {
			TeamID    string `json:"team_id"`
			Employees []struct {
				model.EmployeeChange
				BlueprintID *string `json:"blueprint_id"`
			} `json:"employees"`
		}
		if err := json.Unmarshal(raw, &a); err != nil {
			return toolError("invalid arguments: %v", err)
		}
		if len(a.Employees) == 0 {
			return toolError("employees is required")
		}
		var hired []string
		var change *model.PendingChange
		err := e.act(m, true, func() error {
			// everything is checked before anything is written, since a refusal does not undo what came before it
			var hires []NewReplica
			var edits []model.EmployeeChange
			var lines []model.ChangeLine
			var names []string
			for _, in := range a.Employees {
				c := in.EmployeeChange
				c.BlueprintID = in.BlueprintID
				if c.ID == "" {
					hire, err := e.hireFor(m, a.TeamID, c)
					if err != nil {
						return err
					}
					hires = append(hires, hire)
					continue
				}
				r := e.w.Replicas[c.ID]
				if r == nil || !m.reaches(r.TeamID) {
					return model.Errorf(model.CodeNotFound, "找不到員工 %s", c.ID)
				}
				if slices.ContainsFunc(edits, func(x model.EmployeeChange) bool { return x.ID == c.ID }) {
					return model.Errorf(model.CodeInvalid, "同一位員工只能出現一次：%s", r.Name)
				}
				if c.Version != employeeVersion(r) {
					return model.Errorf(model.CodeConflict, "%s 的版本不符，內容已經被改過，請重新讀取", r.Name)
				}
				effort, err := e.checkPatch(c.ID, patchOf(c))
				if err != nil {
					return err
				}
				if diff := e.employeeDiff(r, c, effort); len(diff) > 0 {
					edits, lines, names = append(edits, c), append(lines, diff...), append(names, r.Name)
				}
			}
			for _, in := range hires {
				r, err := e.hire(in)
				if err != nil {
					return err
				}
				hired = append(hired, fmt.Sprintf("%s (%s, version %s)", r.Name, r.ID, employeeVersion(r)))
			}
			if len(edits) > 0 {
				change = &model.PendingChange{Kind: changeEmployees, Name: strings.Join(names, "、"), Lines: lines, Employees: edits, Hired: strings.Join(hired, ", ")}
			}
			return nil
		})
		if err != nil {
			return toolError("%s", safeText(err))
		}
		if change != nil {
			return waitForUser(m, change, nil)
		}
		if len(hired) > 0 {
			return model.ToolResult{Text: "hired " + strings.Join(hired, ", ")}
		}
		return model.ToolResult{Text: "that is what they already are; nothing to change"}
	}
}

// hireFor is one employee save_employees would hire, into the employee's own company or, for the airport's staff, the
// one named; checked, not yet hired. Call it holding the lock.
func (e *Engine) hireFor(m manager, teamID string, c model.EmployeeChange) (NewReplica, error) {
	if c.Version != "" {
		return NewReplica{}, model.Errorf(model.CodeInvalid, "新員工沒有版本；要修改既有的員工請帶 id")
	}
	if m.teamID != "" {
		if teamID != "" && teamID != m.teamID {
			return NewReplica{}, model.Errorf(model.CodeInvalid, "只能雇用到自己的公司")
		}
		teamID = m.teamID
	} else if teamID == "" {
		return NewReplica{}, model.Errorf(model.CodeInvalid, "要用 team_id 指定公司")
	}
	in := NewReplica{TeamID: teamID}
	for _, x := range []struct {
		to   *string
		from *string
	}{{&in.Name, c.Name}, {&in.BlueprintID, c.BlueprintID}, {&in.Model, c.Model}, {&in.Effort, c.Effort}} {
		if x.from != nil {
			*x.to = *x.from
		}
	}
	if in.BlueprintID == "" || in.Model == "" {
		return NewReplica{}, model.Errorf(model.CodeInvalid, "雇用要有 name、blueprint_id 和 model")
	}
	_, _, err := e.checkHire(in)
	return in, err
}

// employeeDiff is what a change to r would do, for the user to read; effort is the level they end up with.
func (e *Engine) employeeDiff(r *model.Replica, c model.EmployeeChange, effort string) []model.ChangeLine {
	var lines []model.ChangeLine
	add := func(field, was, is string) {
		if was != is {
			lines = append(lines, model.ChangeLine{Field: field, Node: r.Name, Before: was, After: is})
		}
	}
	if c.Name != nil {
		add("name", r.Name, strings.TrimSpace(*c.Name))
	}
	if c.BlueprintID != nil {
		add("blueprint", e.blueprintName(r.BlueprintID), e.blueprintName(*c.BlueprintID))
	}
	if c.Model != nil {
		add("model", r.Model, *c.Model)
	}
	add("effort", r.Effort, effort)
	return lines
}

func (e *Engine) blueprintName(id string) string {
	if b := e.w.Blueprints[id]; b != nil {
		return b.Name
	}
	return id
}

// settleEmployees writes the changes to employees the user agreed to, all or none. Call it holding the lock.
func (e *Engine) settleEmployees(c *model.PendingChange) (string, bool) {
	for _, x := range c.Employees {
		r := e.w.Replicas[x.ID]
		if r == nil || employeeVersion(r) != x.Version {
			return staleChange, true
		}
		if _, err := e.checkPatch(x.ID, patchOf(x)); err != nil {
			return "The user agreed, but nothing was written: " + safeText(err), true
		}
	}
	var done []string
	for _, x := range c.Employees {
		_ = e.updateReplica(x.ID, patchOf(x)) // checked above
		done = append(done, fmt.Sprintf("%s is now version %s", x.ID, employeeVersion(e.w.Replicas[x.ID])))
	}
	return "The user agreed and it is written; " + strings.Join(done, ", ") + ".", false
}

// ---------- the user's answer ----------

// settleChange writes a change the user agreed to, unless what it would replace moved on while they read it. It says
// what to tell the model, which is told whatever happens. Call it holding the lock, inside a change to the settings
// when agreed.
func (e *Engine) settleChange(c *model.PendingChange, agreed bool, note string) (text string, isError bool) {
	said := ""
	if note != "" {
		said = " They said: " + note
	}
	var key string
	if c != nil && c.KeyRef != "" {
		key = e.pendingKeys[c.KeyRef]
		delete(e.pendingKeys, c.KeyRef)
	}
	if !agreed {
		return hiredToo(c, "The user refused the change, so nothing was written."+said), true
	}
	if c == nil {
		return "The change is gone, so nothing was written.", true
	}
	var err error
	var version string
	switch c.Kind {
	case changeBlueprint:
		now := e.w.Blueprints[c.TargetID]
		if now == nil || versionOf(now) != c.Version || c.Blueprint == nil {
			return staleChange, true
		}
		if err := e.checkNewRepos(c.Blueprint); err != nil {
			return "The user agreed, but nothing was written: " + safeText(err), true
		}
		if err = e.saveBlueprint(c.TargetID, *clone(c.Blueprint)); err == nil {
			version = versionOf(e.w.Blueprints[c.TargetID]) + newReposSaid(c.Blueprint)
		}
	case changeWorkflow:
		now := e.w.Workflows[c.TargetID]
		if now == nil || versionOf(now) != c.Version {
			return staleChange, true
		}
		if err = e.saveWorkflow(c.TargetID, *clone(c.Workflow)); err == nil {
			version = versionOf(e.w.Workflows[c.TargetID])
		}
	case changeEmployees:
		text, isError := e.settleEmployees(c)
		return hiredToo(c, text+said), isError
	case changeProvider:
		now := e.w.Providers[c.TargetID]
		if now == nil || versionOf(now) != c.Version || c.Provider == nil {
			return staleChange, true
		}
		if c.KeyRef != "" && key == "" {
			return "The user agreed, but nothing was written: the new API key was lost when the app restarted. Ask for it again if the change is still needed.", true
		}
		edit := providerEdit{provider: *clone(c.Provider), key: key, wasKey: now.Auth.Kind == "apiKey"}
		if c.KeyRef == "" {
			edit.key = e.secrets[c.TargetID]
		}
		moved := c.KeyRef == "" && edit.wasKey && edit.provider.Auth.Kind == "apiKey" && now.BaseURL != edit.provider.BaseURL
		if err = e.writeProvider(e.ctx, edit); err == nil {
			version = versionOf(e.w.Providers[c.TargetID])
			if moved {
				e.refreshLater(c.TargetID)
			}
		}
	default:
		return "The change is of an unknown kind, so nothing was written.", true
	}
	if err != nil {
		return "The user agreed, but it could not be written: " + safeText(err), true
	}
	return fmt.Sprintf("The user agreed and it is written; %s %s is now version %s.%s", c.Kind, c.TargetID, version, said), false
}

// hiredToo adds who the same call already hired to what the model is told.
func hiredToo(c *model.PendingChange, text string) string {
	if c == nil || c.Hired == "" {
		return text
	}
	return "Hired at once: " + c.Hired + ". The changes: " + text
}

const staleChange = "The user agreed, but nothing was written: it was edited or removed while waiting. Read it again if the change is still needed."

// ResolveChatChange is the user's answer on a chat's card: yes or no, and the employee goes on. A no is also what
// saying something else in the chat means.
func (e *Engine) ResolveChatChange(id string, agreed bool, note string) error {
	change := e.do
	if agreed {
		change = e.doSettings
	}
	return change(func() error {
		c := e.w.Chats[id]
		if c == nil {
			return model.Errorf(model.CodeNotFound, "找不到對話")
		}
		if c.Change == nil {
			return model.Errorf(model.CodeConflict, "這個對話沒有在等確認")
		}
		if e.chatLeft(c) {
			return model.Errorf(model.CodeInvalid, "%s 已經離開公司", c.Name)
		}
		note = strings.TrimSpace(note)
		if err := e.loadConversation(c.ID); err != nil {
			return err
		}
		text, isError := e.settleChange(c.Change, agreed, note)
		line := i18n.T("拒絕修改")
		if agreed {
			line = i18n.T("同意修改")
		}
		c.Messages = append(c.Messages, model.ChatMessage{At: e.w.Now, From: "tool", Text: line})
		c.Change = nil
		e.w.Conversations[c.ID] = answerChange(e.w.Conversations[c.ID], text, isError)
		e.dirty[c.ID] = true
		speaker := c.Speaker // the one who asked goes on, then the rest of the round
		if speaker == "" {
			speaker = c.ReplicaID
		}
		spec, err := e.chatSpec(c, speaker)
		if err != nil {
			e.chatSays(c, i18n.T("（回覆失敗：%s）", safeText(err)))
			return nil
		}
		e.launchChat(c, speaker, spec)
		return nil
	})
}
