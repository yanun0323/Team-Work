package usecase

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"time"

	"github.com/yanun0323/Team-Work/internal/adapter"
	"github.com/yanun0323/Team-Work/internal/i18n"
	"github.com/yanun0323/Team-Work/internal/model"
	"github.com/yanun0323/Team-Work/internal/model/enum"
)

const discoveryTimeout = 30 * time.Second

// ---------- companies ----------

// NewTeam is what a company is made from.
type NewTeam struct {
	Plot         *model.Plot `json:"plot,omitempty"`
	Name         string      `json:"name"`
	Folder       string      `json:"folder"`
	TargetBranch string      `json:"targetBranch"`
}

func (e *Engine) CreateTeam(ctx context.Context, in NewTeam) (*model.Team, error) {
	in.Name = strings.TrimSpace(in.Name)
	if in.Name == "" {
		return nil, model.Errorf(model.CodeInvalid, "公司要有名稱")
	}
	in.Folder = expandHome(strings.TrimSpace(in.Folder))
	if !filepath.IsAbs(in.Folder) {
		return nil, model.Errorf(model.CodeInvalid, "資料夾要是絕對路徑")
	}
	if info, err := os.Stat(in.Folder); err != nil || !info.IsDir() {
		return nil, model.Errorf(model.CodeInvalid, "找不到資料夾")
	}
	branches, initialized, err := e.git.Prepare(ctx, in.Folder)
	if err != nil {
		e.log.Error().Err(err).Str("folder", in.Folder).Msg("prepare repo")
		return nil, model.Errorf(model.CodeInvalid, "無法使用這個資料夾的 git repo")
	}
	if initialized || in.TargetBranch == "" {
		if initialized {
			in.TargetBranch = "master"
		} else if len(branches) > 0 {
			in.TargetBranch = branches[0]
		}
	}
	if !slices.Contains(branches, in.TargetBranch) {
		return nil, model.Errorf(model.CodeInvalid, "目標分支 %s 不存在", in.TargetBranch)
	}
	var out *model.Team
	err = e.doSettings(func() error {
		plot := in.Plot
		if plot == nil {
			plot = e.defaultPlot()
		}
		if err := e.checkPlot("", plot); err != nil {
			return err
		}
		id := e.uid("team")
		t := &model.Team{ID: id, Name: in.Name, Folder: in.Folder, TargetBranch: in.TargetBranch, Branches: branches, InitializedGit: initialized,
			Plot: clone(plot), CreatedAt: e.w.Now, Settings: model.TeamSettings{TimeoutMin: 30, CostLimitUSD: 3, Retries: 1}}
		e.readPrompt(t)
		e.w.Teams[id] = t
		out = clone(t)
		return nil
	})
	return out, err
}

// TeamFolder is where a company's project lives.
func (e *Engine) TeamFolder(id string) (string, error) {
	e.mu.Lock()
	defer e.mu.Unlock()
	t := e.w.Teams[id]
	if t == nil {
		return "", model.Errorf(model.CodeNotFound, "找不到公司")
	}
	return t.Folder, nil
}

// TeamHealth is what a company's folder is like now; it can change outside the app at any time.
type TeamHealth struct {
	Folder       bool `json:"folder"`
	Repo         bool `json:"repo"`
	TargetBranch bool `json:"targetBranch"`
}

// TeamHealth looks at a company's folder. A repo with no commits yet has no branches to have lost.
func (e *Engine) TeamHealth(ctx context.Context, id string) (TeamHealth, error) {
	e.mu.Lock()
	t := e.w.Teams[id]
	if t == nil {
		e.mu.Unlock()
		return TeamHealth{}, model.Errorf(model.CodeNotFound, "找不到公司")
	}
	folder, target := t.Folder, t.TargetBranch
	e.mu.Unlock()
	if info, err := os.Stat(folder); err != nil || !info.IsDir() {
		return TeamHealth{}, nil
	}
	branches, repo, err := e.git.Branches(ctx, folder)
	if err != nil {
		return TeamHealth{}, err
	}
	return TeamHealth{Folder: true, Repo: repo, TargetBranch: repo && (len(branches) == 0 || slices.Contains(branches, target))}, nil
}

// Branches lists the branches of the repo at folder, without changing anything. A folder that is no repo
// yet has none, and repo is false.
func (e *Engine) Branches(ctx context.Context, folder string) (branches []string, repo bool, err error) {
	folder = expandHome(strings.TrimSpace(folder))
	if !filepath.IsAbs(folder) {
		return []string{}, false, nil
	}
	if info, statErr := os.Stat(folder); statErr != nil || !info.IsDir() {
		return []string{}, false, nil
	}
	return e.git.Branches(ctx, folder)
}

// HandedFile reads a file a sub-task handed on, as it was at that sub-task's commit.
func (e *Engine) HandedFile(ctx context.Context, subID, path string) (string, error) {
	folder, commit, path, err := e.handedAt(subID, path)
	if err != nil {
		return "", err
	}
	return e.git.ReadFile(ctx, folder, commit, path)
}

// HandedImage is a picture from a sub-task's handoff commit, with its media type.
func (e *Engine) HandedImage(ctx context.Context, subID, path string) ([]byte, string, error) {
	folder, commit, path, err := e.handedAt(subID, path)
	if err != nil {
		return nil, "", err
	}
	return e.git.ReadImage(ctx, folder, commit, path)
}

// handedAt is where a sub-task's handed file can be read: its company's folder and handoff commit.
func (e *Engine) handedAt(subID, path string) (folder, commit, clean string, err error) {
	path = strings.TrimSpace(path)
	if clean := filepath.ToSlash(filepath.Clean(path)); path == "" || filepath.IsAbs(path) || strings.HasPrefix(path, "-") || clean == ".." || strings.HasPrefix(clean, "../") {
		return "", "", "", model.Errorf(model.CodeInvalid, "檔案路徑不正確：%s", path)
	}
	e.mu.Lock()
	if s := e.w.SubTasks[subID]; s != nil && s.Handoff != nil {
		if t := e.w.Tasks[s.TaskID]; t != nil && e.w.Teams[t.TeamID] != nil {
			folder, commit = e.w.Teams[t.TeamID].Folder, s.Handoff.Commit
		}
	}
	e.mu.Unlock()
	if commit == "" {
		return "", "", "", model.Errorf(model.CodeInvalid, "這個子任務沒有交接的檔案")
	}
	if info, err := os.Stat(folder); err != nil || !info.IsDir() {
		return "", "", "", model.Errorf(model.CodeInvalid, "找不到專案資料夾 %s", folder)
	}
	return folder, commit, path, nil
}

// TeamPatch changes a company; a nil field stays as it is.
type TeamPatch struct {
	Plot         *model.Plot         `json:"plot"`
	Name         *string             `json:"name"`
	Prompt       *string             `json:"prompt"`
	TargetBranch *string             `json:"targetBranch"`
	Settings     *model.TeamSettings `json:"settings"`
}

func (e *Engine) UpdateTeam(id string, p TeamPatch) error {
	return e.doSettings(func() error {
		t := e.w.Teams[id]
		if t == nil {
			return model.Errorf(model.CodeNotFound, "找不到公司")
		}
		if p.Name != nil && strings.TrimSpace(*p.Name) == "" {
			return model.Errorf(model.CodeInvalid, "公司要有名稱")
		}
		if p.TargetBranch != nil && !slices.Contains(t.Branches, *p.TargetBranch) {
			return model.Errorf(model.CodeInvalid, "目標分支不存在")
		}
		if s := p.Settings; s != nil && (s.TimeoutMin < 0 || s.CostLimitUSD < 0 || s.Retries < 0) {
			return model.Errorf(model.CodeInvalid, "設定不能是負數")
		}
		if p.Plot != nil {
			if err := e.checkPlot(id, p.Plot); err != nil {
				return err
			}
		}
		if p.Prompt != nil {
			if err := e.writePrompt(t, *p.Prompt); err != nil {
				return err
			}
			t.Prompt = *p.Prompt
		}
		if p.Plot != nil {
			t.Plot = clone(p.Plot)
		}
		if p.Name != nil {
			t.Name = strings.TrimSpace(*p.Name)
		}
		if p.TargetBranch != nil {
			t.TargetBranch = *p.TargetBranch
		}
		if p.Settings != nil {
			t.Settings = *p.Settings
		}
		return nil
	})
}

// DeleteTeam closes a company: its people, flows and tasks go, as do the tasks' work trees and branches.
// The folder itself stays.
func (e *Engine) DeleteTeam(id string) error {
	return e.doSettings(func() error {
		if e.w.Teams[id] == nil {
			return model.Errorf(model.CodeNotFound, "找不到公司")
		}
		for _, t := range e.w.Tasks {
			if t.TeamID == id {
				e.stopRun("merge:" + t.ID)
				e.dropSubs(t)
				e.removeTree(t)
				delete(e.w.Tasks, t.ID)
			}
		}
		for rid, r := range e.w.Replicas {
			if r.TeamID == id {
				e.dropOwnBlueprint(r)
				delete(e.w.Replicas, rid)
			}
		}
		// flows are shared by every company: a step loses the people who are gone, or the flow would no longer load
		for _, wf := range e.w.Workflows {
			for i := range wf.Nodes {
				wf.Nodes[i].ReplicaIDs = slices.DeleteFunc(wf.Nodes[i].ReplicaIDs, func(rid string) bool { return e.w.Replicas[rid] == nil })
			}
		}
		for _, c := range e.w.Chats {
			if c.TeamID == id {
				e.dropChat(c.ID)
			}
		}
		delete(e.w.Teams, id)
		return nil
	})
}

// ---------- flows ----------

// errPreset answers any attempt to change what is built into the app.
func errPreset() error {
	return model.Errorf(model.CodeConflict, "內建的項目不能修改，請複製後再改")
}

// newWorkflow is a flow of one blank step, to be written.
func (e *Engine) newWorkflow(name string) *model.Workflow {
	wf := &model.Workflow{ID: e.uid("wf"), Name: name,
		Nodes: []model.WorkflowNode{{ID: e.uid("n"), Kind: enum.NodeWork, Name: i18n.T("新步驟%d", 1), Prompt: "", ReplicaIDs: []string{},
			Handoff: enum.HandoffAll, Join: enum.JoinAll}},
		Edges: []model.WorkflowEdge{},
	}
	e.w.Workflows[wf.ID] = wf
	return wf
}

func (e *Engine) CreateWorkflow(name string) (*model.Workflow, error) {
	var out *model.Workflow
	err := e.doSettings(func() error {
		if strings.TrimSpace(name) == "" {
			return model.Errorf(model.CodeInvalid, "任務藍圖要有名稱")
		}
		out = clone(e.newWorkflow(strings.TrimSpace(name)))
		return nil
	})
	return out, err
}

// SaveWorkflow replaces a flow. Running tasks keep the copy they started with.
func (e *Engine) SaveWorkflow(id string, wf model.Workflow) error {
	return e.doSettings(func() error { return e.saveWorkflow(id, wf) })
}

// saveWorkflow does it holding the lock, inside a change.
func (e *Engine) saveWorkflow(id string, wf model.Workflow) error {
	if e.w.Workflows[id] == nil {
		return model.Errorf(model.CodeNotFound, "找不到任務藍圖")
	}
	if model.IsPresetID(id) {
		return errPreset()
	}
	wf.ID = id
	settleStarts(&wf)
	if err := e.checkFlow(&wf); err != nil {
		return err
	}
	localizeFlow(&wf, e.w.Language)
	e.w.Workflows[id] = &wf
	if e.w.Tutorial.ChangedCopy(id) {
		e.w.Tutorial.Learn("copyFlow")
	}
	return nil
}

// checkFlow is everything a flow has to be before it is kept.
func (e *Engine) checkFlow(wf *model.Workflow) error {
	if strings.TrimSpace(wf.Name) == "" {
		return model.Errorf(model.CodeInvalid, "任務藍圖要有名稱")
	}
	if name := crowdedStep(wf); name != "" {
		return model.Errorf(model.CodeInvalid, "工作步驟「%s」只能有一位員工", name)
	}
	wf.Nodes = slices.Clone(wf.Nodes)
	settleStaff(wf) // drops what an older client still sends
	if err := checkWorkflow(wf); err != nil {
		return err
	}
	for _, n := range wf.Nodes {
		for _, r := range n.ReplicaIDs {
			if e.w.Replicas[r] == nil {
				return model.Errorf(model.CodeInvalid, "節點「%s」指派了不存在的員工", n.Name)
			}
		}
	}
	return nil
}

// DuplicateWorkflow copies a flow, named after it with the first free -1, -2…; it is not the default.
func (e *Engine) DuplicateWorkflow(id string) (*model.Workflow, error) {
	var out *model.Workflow
	err := e.doSettings(func() error {
		from := e.w.Workflows[id]
		if from == nil {
			return model.Errorf(model.CodeNotFound, "找不到任務藍圖")
		}
		taken := map[string]bool{}
		for _, wf := range e.w.Workflows {
			taken[wf.Name] = true
		}
		n := 1
		for taken[fmt.Sprintf("%s-%d", from.Name, n)] {
			n++
		}
		wf := clone(from)
		wf.ID, wf.Name = e.uid("wf"), fmt.Sprintf("%s-%d", from.Name, n)
		e.w.Workflows[wf.ID] = wf
		e.w.Tutorial.Copied(wf.ID)
		out = clone(wf)
		return nil
	})
	return out, err
}

// DeleteWorkflow removes a flow.
func (e *Engine) DeleteWorkflow(id string) error {
	return e.doSettings(func() error {
		if e.w.Workflows[id] == nil {
			return model.Errorf(model.CodeNotFound, "找不到任務藍圖")
		}
		if model.IsPresetID(id) {
			return errPreset()
		}
		delete(e.w.Workflows, id)
		return nil
	})
}

// SetLanguage picks the language of the app and of what employees write to the user. It takes effect from their next reply.
func (e *Engine) SetLanguage(language string) error {
	if languageNames[language] == "" {
		return model.Errorf(model.CodeInvalid, "不支援這個語言")
	}
	err := e.doSettings(func() error {
		e.w.Language = language
		i18n.Set(language)
		e.installPresets()
		for _, t := range e.w.Tasks {
			localizeFlow(&t.Workflow, language)
		}
		return nil
	})
	if err != nil {
		return err
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	e.publish(Event{Type: "language", Language: language})
	return nil
}

// ---------- model providers ----------

// ProviderLogin is how a provider is signed in to. The key is kept apart and only its last 4 characters are shown.
type ProviderLogin struct {
	Kind   string `json:"kind"`
	APIKey string `json:"apiKey"`
}

// NewProvider is what a provider is made from; its models come from asking it.
type NewProvider struct {
	Name    string                      `json:"name"`
	Kind    enum.ProviderKind           `json:"kind"`
	BaseURL string                      `json:"baseUrl"`
	Login   ProviderLogin               `json:"login"`
	Prices  map[string]model.ModelPrice `json:"prices"`
	// ImageDefault makes a ChatGPT subscription the one every employee draws pictures with.
	ImageDefault bool `json:"imageDefault"`
}

func authOf(l ProviderLogin) model.ProviderAuth {
	if l.Kind != "apiKey" {
		return model.ProviderAuth{Kind: "subscription"}
	}
	key := strings.TrimSpace(l.APIKey)
	return model.ProviderAuth{Kind: "apiKey", KeyHint: key[max(len(key)-4, 0):]}
}

func (e *Engine) discover(ctx context.Context, p model.ModelProvider, key string) ([]model.ModelSpec, error) {
	provider, err := e.providers.For(p, key)
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(ctx, discoveryTimeout)
	defer cancel()
	return provider.Models(ctx)
}

// setModels records what a provider reported, and puts employees on a level their model no longer takes back on
// the default. Call it on a provider in the world, holding the lock.
func (e *Engine) setModels(p *model.ModelProvider, specs []model.ModelSpec) {
	p.Models, p.Thinking = modelsOf(specs)
	e.resetEfforts()
}

func modelsOf(specs []model.ModelSpec) ([]string, map[string][]string) {
	models := make([]string, 0, len(specs))
	thinking := make(map[string][]string, len(specs))
	for _, m := range specs {
		models = append(models, m.ID)
		if len(m.Thinking) > 0 {
			thinking[m.ID] = m.Thinking
		}
	}
	slices.Sort(models)
	return slices.Compact(models), thinking
}

// resetEfforts skips a provider not asked yet: its employees keep their level until it has answered.
func (e *Engine) resetEfforts() {
	for _, r := range e.w.Replicas {
		if p := e.providerFor(r.Model); p != nil && p.Thinking != nil && !e.takesEffort(r.Model, r.Effort) {
			r.Effort = model.ThinkingDefault
		}
	}
}

// takesEffort accepts reported levels, or the compatible API fallback when none were reported.
func (e *Engine) takesEffort(modelID, effort string) bool {
	if effort == model.ThinkingDefault {
		return true
	}
	p := e.providerFor(modelID)
	if p == nil {
		return false
	}
	levels := p.Thinking[modelID]
	if len(levels) == 0 && p.Kind == enum.ProviderCompatible {
		levels = []string{"none", "low", "medium", "high", "xhigh", "max"}
	}
	return slices.Contains(levels, effort)
}

func (e *Engine) AddProvider(ctx context.Context, in NewProvider) (*model.ModelProvider, error) {
	in.Name = strings.TrimSpace(in.Name)
	key := strings.TrimSpace(in.Login.APIKey)
	if in.Name == "" {
		return nil, model.Errorf(model.CodeInvalid, "供應商要有名稱")
	}
	if in.Login.Kind == "apiKey" && key == "" {
		return nil, model.Errorf(model.CodeInvalid, "要填 API Key")
	}
	if in.Login.Kind != "apiKey" && in.Kind != enum.ProviderAnthropic && in.Kind != enum.ProviderOpenAI {
		return nil, model.Errorf(model.CodeInvalid, "只有 Anthropic 和 OpenAI 可以用訂閱登入")
	}
	p := model.ModelProvider{Name: in.Name, Kind: in.Kind, Auth: authOf(in.Login), BaseURL: strings.TrimSpace(in.BaseURL), Models: []string{}, Prices: in.Prices}
	if p.Auth.Kind == "apiKey" {
		specs, err := e.discover(ctx, p, key)
		if err != nil {
			return nil, err
		}
		p.Models, p.Thinking = modelsOf(specs)
	} else {
		p.BaseURL = ""
	}
	var out *model.ModelProvider
	err := e.doSettings(func() error {
		p.ID = e.uid("mp")
		if p.Auth.Kind == "apiKey" {
			if err := e.store.SetSecret(ctx, p.ID, key); err != nil {
				return err
			}
			e.secrets[p.ID] = key
		}
		e.w.Providers[p.ID] = &p
		if in.ImageDefault && model.MakesImages(p) {
			e.w.Preferences.ImageProvider = p.ID
		}
		out = clone(&p)
		return nil
	})
	return out, err
}

// ProviderPatch changes a provider; a nil login, or an empty key on a provider with a key, keeps the login.
type ProviderPatch struct {
	Name    *string                     `json:"name"`
	BaseURL *string                     `json:"baseUrl"`
	Login   *ProviderLogin              `json:"login"`
	Prices  map[string]model.ModelPrice `json:"prices"`
	// ImageDefault true makes it the provider that draws pictures; false, when it is that one, leaves none.
	ImageDefault *bool `json:"imageDefault"`
}

func (e *Engine) UpdateProvider(ctx context.Context, id string, in ProviderPatch) error {
	next, err := e.prepareProvider(ctx, id, in)
	if err != nil {
		return err
	}
	return e.doSettings(func() error {
		if err := e.writeProvider(ctx, next); err != nil {
			return err
		}
		if in.ImageDefault != nil && *in.ImageDefault && model.MakesImages(next.provider) {
			e.w.Preferences.ImageProvider = id
		} else if in.ImageDefault != nil && !*in.ImageDefault && e.w.Preferences.ImageProvider == id {
			e.w.Preferences.ImageProvider = ""
		}
		return nil
	})
}

// providerEdit is a provider as it will be once written, and the key it will use. It is checked with its provider
// already, so writing it asks nobody.
type providerEdit struct {
	provider model.ModelProvider
	key      string
	wasKey   bool
}

// prepareProvider works out what a patch makes of a provider, asking it for its models when it uses a key. It takes
// the lock only to read; call it without.
func (e *Engine) prepareProvider(ctx context.Context, id string, in ProviderPatch) (providerEdit, error) {
	e.mu.Lock()
	old := e.w.Providers[id]
	if old == nil {
		e.mu.Unlock()
		return providerEdit{}, model.Errorf(model.CodeNotFound, "找不到供應商")
	}
	next := *clone(old)
	key := e.secrets[id]
	wasKey := old.Auth.Kind == "apiKey"
	e.mu.Unlock()
	if in.Name != nil {
		next.Name = strings.TrimSpace(*in.Name)
		if next.Name == "" {
			return providerEdit{}, model.Errorf(model.CodeInvalid, "供應商要有名稱")
		}
	}
	if in.BaseURL != nil {
		next.BaseURL = strings.TrimSpace(*in.BaseURL)
	}
	if in.Prices != nil {
		next.Prices = in.Prices
	}
	if l := in.Login; l != nil && !(l.Kind == "apiKey" && strings.TrimSpace(l.APIKey) == "" && next.Auth.Kind == "apiKey") {
		if l.Kind == "apiKey" && strings.TrimSpace(l.APIKey) == "" {
			return providerEdit{}, model.Errorf(model.CodeInvalid, "要填 API Key")
		}
		if l.Kind != "apiKey" && next.Auth.Kind != "subscription" && next.Kind != enum.ProviderAnthropic && next.Kind != enum.ProviderOpenAI {
			return providerEdit{}, model.Errorf(model.CodeInvalid, "只有 Anthropic 和 OpenAI 可以用訂閱登入")
		}
		if l.Kind == "apiKey" || wasKey { // already on a subscription: stay signed in
			next.Auth = authOf(*l)
			next.Models, next.Thinking = []string{}, nil
		}
		key = strings.TrimSpace(l.APIKey)
	}
	if next.Auth.Kind == "apiKey" {
		specs, err := e.discover(ctx, next, key)
		if err != nil {
			return providerEdit{}, err
		}
		next.Models, next.Thinking = modelsOf(specs)
	} else {
		next.BaseURL, key = "", ""
	}
	return providerEdit{provider: next, key: key, wasKey: wasKey}, nil
}

// writeProvider puts a prepared provider in the world and its key in the store. Call it holding the lock, inside a
// change to the settings.
func (e *Engine) writeProvider(ctx context.Context, edit providerEdit) error {
	next, id := edit.provider, edit.provider.ID
	now := e.w.Providers[id]
	if now == nil {
		return model.Errorf(model.CodeNotFound, "找不到供應商")
	}
	if next.Auth.Kind == "subscription" {
		if edit.wasKey { // the tokens of a subscription are not this function's to touch
			if err := e.store.DeleteSecret(ctx, id); err != nil {
				return err
			}
			delete(e.secrets, id)
		} else {
			next.Auth, next.Models, next.Thinking = now.Auth, now.Models, now.Thinking // a sign-in may have ended meanwhile
		}
	} else {
		if err := e.store.SetSecret(ctx, id, edit.key); err != nil {
			return err
		}
		e.secrets[id] = edit.key
	}
	e.w.Providers[id] = &next
	if e.w.Preferences.ImageProvider == id && !model.MakesImages(next) {
		e.w.Preferences.ImageProvider = ""
	}
	return nil
}

// DeleteProvider removes a provider nobody runs on, and its key.
func (e *Engine) DeleteProvider(ctx context.Context, id string) error {
	return e.doSettings(func() error {
		p := e.w.Providers[id]
		if p == nil {
			return model.Errorf(model.CodeNotFound, "找不到供應商")
		}
		for _, r := range e.w.Replicas {
			if slices.Contains(p.Models, r.Model) {
				return model.Errorf(model.CodeConflict, "還有員工在用「%s」的模型", p.Name)
			}
		}
		e.stopLogin(id)
		if err := e.store.DeleteSecret(ctx, id); err != nil {
			return err
		}
		delete(e.secrets, id)
		delete(e.w.Providers, id)
		if e.w.Preferences.ImageProvider == id {
			e.w.Preferences.ImageProvider = ""
		}
		return nil
	})
}

// ---------- signing in to a subscription ----------

// loginRun is a sign-in under way. Its goroutine is owned by the engine and ends with its context.
type loginRun struct {
	flow   *adapter.LoginFlow
	cancel context.CancelFunc
}

func (e *Engine) stopLogin(id string) {
	if l := e.logins[id]; l != nil {
		delete(e.logins, id)
		l.cancel()
	}
}

// StartLogin signs a subscription in; it replaces one already under way. What the user has to do comes
// back here and in the provider's auth.login, which also reports how it ends.
func (e *Engine) StartLogin(ctx context.Context, id, method string) (model.LoginPrompt, error) {
	if method != "" && method != "browser" && method != "device" {
		return model.LoginPrompt{}, model.Errorf(model.CodeInvalid, "不認識的登入方式 %s", method)
	}
	e.mu.Lock()
	p := e.w.Providers[id]
	if p == nil {
		e.mu.Unlock()
		return model.LoginPrompt{}, model.Errorf(model.CodeNotFound, "找不到供應商")
	}
	if p.Auth.Kind != "subscription" {
		e.mu.Unlock()
		return model.LoginPrompt{}, model.Errorf(model.CodeConflict, "這個供應商用 API Key，不用登入")
	}
	e.stopLogin(id) // frees the callback port before the next one asks for it
	copied := *clone(p)
	e.mu.Unlock()

	flow, err := e.providers.Login(ctx, copied, method)
	if err != nil {
		return model.LoginPrompt{}, err
	}
	loginCtx, cancel := context.WithCancel(e.ctx)
	l := &loginRun{flow: flow, cancel: cancel}
	err = e.do(func() error {
		p := e.w.Providers[id]
		if p == nil {
			return model.Errorf(model.CodeNotFound, "找不到供應商")
		}
		e.stopLogin(id)
		e.logins[id] = l
		prompt := flow.Prompt
		p.Auth.Login = &prompt
		e.wg.Add(1)
		go e.waitLogin(loginCtx, id, copied, l)
		return nil
	})
	if err != nil {
		cancel()
		return model.LoginPrompt{}, err
	}
	return flow.Prompt, nil
}

func (e *Engine) waitLogin(ctx context.Context, id string, p model.ModelProvider, l *loginRun) {
	defer e.wg.Done()
	defer l.cancel()
	err := l.flow.Wait(ctx)
	var models []model.ModelSpec
	if err == nil {
		p.Auth.SignedIn = true
		var provider adapter.Provider
		if provider, err = e.providers.For(p, ""); err == nil {
			discoverCtx, cancel := context.WithTimeout(ctx, discoveryTimeout)
			models, err = provider.Models(discoverCtx)
			cancel()
		}
	}
	if ctx.Err() != nil {
		return // cancelled, replaced, or the server is closing
	}
	var known *model.Error
	if err != nil && !errors.As(err, &known) {
		e.log.Error().Err(err).Str("provider", id).Msg("sign in")
	}
	saveErr := e.doSettings(func() error {
		now := e.w.Providers[id]
		if e.logins[id] != l || now == nil {
			return nil
		}
		delete(e.logins, id)
		if err != nil {
			prompt := l.flow.Prompt
			prompt.Error = safeText(err)
			now.Auth.Login = &prompt
			return nil
		}
		now.Auth.SignedIn, now.Auth.Login = true, nil
		e.setModels(now, models)
		return nil
	})
	if saveErr != nil {
		// Credentials may already be saved. Preserve the login outcome even when
		// an external settings edit prevents updating the discovered models.
		_ = e.do(func() error {
			now := e.w.Providers[id]
			if now == nil || e.logins[id] != l {
				return nil
			}
			delete(e.logins, id)
			now.Auth.SignedIn = err == nil
			now.Auth.Login = &model.LoginPrompt{Error: safeText(saveErr)}
			return nil
		})
	}
}

// PasteLogin hands over what the browser ended on, when it could not come back by itself.
func (e *Engine) PasteLogin(id, value string) error {
	e.mu.Lock()
	l := e.logins[id]
	e.mu.Unlock()
	if l == nil {
		return model.Errorf(model.CodeConflict, "沒有進行中的登入")
	}
	return l.flow.Paste(value)
}

// CancelLogin gives up a sign-in; nothing is saved.
func (e *Engine) CancelLogin(id string) error {
	return e.do(func() error {
		p := e.w.Providers[id]
		if p == nil {
			return model.Errorf(model.CodeNotFound, "找不到供應商")
		}
		e.stopLogin(id)
		p.Auth.Login = nil
		return nil
	})
}

// Logout signs a subscription out. Employees on its models fail with a message until it is signed in again.
func (e *Engine) Logout(ctx context.Context, id string) error {
	return e.do(func() error {
		p := e.w.Providers[id]
		if p == nil {
			return model.Errorf(model.CodeNotFound, "找不到供應商")
		}
		if p.Auth.Kind != "subscription" {
			return model.Errorf(model.CodeConflict, "這個供應商用 API Key，不用登出")
		}
		e.stopLogin(id)
		if err := e.providers.Logout(ctx, *p); err != nil {
			return err
		}
		p.Auth.SignedIn, p.Auth.Login = false, nil
		return nil
	})
}

// noteSignedOut marks a subscription signed out when err says its sign-in is gone, say after signing out
// elsewhere, so the Airport offers to sign in again. A sign-in under way is left to finish.
func (e *Engine) noteSignedOut(id string, err error) {
	var known *model.Error
	if !errors.As(err, &known) || known.Code != model.CodeSignedOut {
		return
	}
	_ = e.do(func() error {
		if p := e.w.Providers[id]; p != nil && p.Auth.Kind == "subscription" && e.logins[id] == nil {
			p.Auth.SignedIn = false
		}
		return nil
	})
}

// RefreshModels asks a provider again what it offers. A failure keeps the list it has.
func (e *Engine) RefreshModels(ctx context.Context, id string) error {
	e.mu.Lock()
	p := e.w.Providers[id]
	if p == nil {
		e.mu.Unlock()
		return model.Errorf(model.CodeNotFound, "找不到供應商")
	}
	copied, key := *clone(p), e.secrets[id]
	e.mu.Unlock()
	models, err := e.discover(ctx, copied, key)
	if err != nil {
		e.noteSignedOut(id, err)
		return err
	}
	return e.doSettings(func() error {
		if now := e.w.Providers[id]; now != nil {
			e.setModels(now, models)
		}
		return nil
	})
}

// ---------- blueprints ----------

func checkBlueprint(b *model.Blueprint) error {
	b.Name = strings.TrimSpace(b.Name)
	if b.Name == "" {
		return model.Errorf(model.CodeInvalid, "藍圖要有名稱")
	}
	for _, t := range b.Tools {
		if !slices.Contains([]enum.Tool{enum.ToolReadFile, enum.ToolWriteFile, enum.ToolWebSearch, enum.ToolRunCommand}, t) {
			return model.Errorf(model.CodeInvalid, "不認識的工具 %s", t)
		}
	}
	if b.Source.Kind == model.SourcePreset {
		return errPreset()
	}
	if b.Skills == nil {
		b.Skills = []model.SkillPack{}
	}
	if b.Tools == nil {
		b.Tools = []enum.Tool{}
	}
	return nil
}

func (e *Engine) CreateBlueprint(b model.Blueprint) (*model.Blueprint, error) {
	var out *model.Blueprint
	err := e.doSettings(func() error {
		if err := checkBlueprint(&b); err != nil {
			return err
		}
		b.ID, b.Owner = e.uid("bp"), ""
		e.w.Blueprints[b.ID] = &b
		out = clone(&b)
		return nil
	})
	return out, err
}

func (e *Engine) SaveBlueprint(id string, b model.Blueprint) error {
	return e.doSettings(func() error { return e.saveBlueprint(id, b) })
}

// saveBlueprint does it holding the lock, inside a change.
func (e *Engine) saveBlueprint(id string, b model.Blueprint) error {
	if e.w.Blueprints[id] == nil {
		return model.Errorf(model.CodeNotFound, "找不到藍圖")
	}
	if model.IsPresetID(id) {
		return errPreset()
	}
	if err := checkBlueprint(&b); err != nil {
		return err
	}
	b.ID, b.Owner = id, e.w.Blueprints[id].Owner
	e.w.Blueprints[id] = &b
	return nil
}

// hireableBlueprint is a blueprint employee rid may work by: one anyone can be hired from, or their own.
func (e *Engine) hireableBlueprint(id, rid string) *model.Blueprint {
	if b := e.w.Blueprints[id]; b != nil && (b.Owner == "" || b.Owner == rid) {
		return b
	}
	return nil
}

// ownBlueprint gives r settings of their own, b, in place of the ones they had; their own already are rewritten.
// They are named after r and never update themselves, so a copy keeps the versions it was made with.
func (e *Engine) ownBlueprint(r *model.Replica, b model.Blueprint) error {
	b.Name, b.Look, b.Owner = r.Name, r.Look, r.ID
	if err := checkBlueprint(&b); err != nil {
		return err
	}
	if old := e.w.Blueprints[r.BlueprintID]; old != nil && old.Owner == r.ID {
		b.ID = old.ID
	} else {
		b.ID = e.uid("bp")
	}
	e.w.Blueprints[b.ID] = &b
	r.BlueprintID = b.ID
	return nil
}

// PinOwnSources finds the version of each Git source without one, as the app does once a blueprint is saved.
func (e *Engine) PinOwnSources(ctx context.Context, _ string) error { return e.PinSources(ctx) }

// dropOwnBlueprint removes r's own settings, which go with them.
func (e *Engine) dropOwnBlueprint(r *model.Replica) {
	if b := e.w.Blueprints[r.BlueprintID]; b != nil && b.Owner == r.ID {
		delete(e.w.Blueprints, b.ID)
	}
}

func (e *Engine) DeleteBlueprint(id string) error {
	return e.doSettings(func() error {
		if e.w.Blueprints[id] == nil {
			return model.Errorf(model.CodeNotFound, "找不到藍圖")
		}
		if model.IsPresetID(id) {
			return errPreset()
		}
		for _, r := range e.w.Replicas {
			if r.BlueprintID == id {
				return model.Errorf(model.CodeConflict, "還有員工是用這個藍圖建立的")
			}
		}
		delete(e.w.Blueprints, id)
		return nil
	})
}

// UpdateBlueprint moves a blueprint from Git to its repo's newest version, and finds a version for each source its
// packs read that has none yet. A repo that cannot be reached keeps the version in use; each attempt is recorded.
func (e *Engine) UpdateBlueprint(ctx context.Context, id string) error {
	e.mu.Lock()
	b := e.w.Blueprints[id]
	if b == nil {
		e.mu.Unlock()
		return model.Errorf(model.CodeNotFound, "找不到藍圖")
	}
	own := b.Source
	e.mu.Unlock()
	if own.Kind == "git" {
		latest, err := e.git.Latest(ctx, own.Repo, own.Ref)
		own.Upstream = err == nil
		own.Update = &model.SourceUpdate{At: e.clock(), OK: err == nil}
		if err != nil {
			e.log.Warn().Err(err).Str("repo", own.Repo).Msg("check source")
			own.Update.Error = sourceProblem(err)
		} else {
			own.Latest, own.Commit = latest, latest
		}
		err = e.doSettings(func() error {
			b := e.w.Blueprints[id]
			if b == nil {
				return model.Errorf(model.CodeNotFound, "找不到藍圖")
			}
			b.Source = own
			return nil
		})
		if err != nil {
			return err
		}
	}
	return e.PinSources(ctx)
}

// sourceProblem says why a Git source could not be read, in words the user can act on, from what git printed.
func sourceProblem(err error) string {
	var known *model.Error
	if errors.As(err, &known) {
		return known.Message
	}
	text := err.Error()
	switch {
	case errors.Is(err, context.DeadlineExceeded):
		return i18n.T("連線逾時，請稍後再試")
	case strings.Contains(text, "Host key verification failed"):
		return i18n.T("這台電腦還不信任這個 SSH 主機：請在終端機連線一次並確認信任，或改用 HTTPS 網址")
	case strings.Contains(text, "Permission denied (publickey"):
		return i18n.T("SSH 金鑰沒有讀取權限：請確認金鑰已加到 GitHub，或改用 HTTPS 網址")
	case strings.Contains(text, "Could not resolve host"), strings.Contains(text, "Could not resolve hostname"):
		return i18n.T("連不上主機，請檢查網路")
	case strings.Contains(text, "Repository not found"), strings.Contains(text, "could not read Username"):
		return i18n.T("找不到這個 repo，或它是私人 repo 而這台電腦沒有讀取權限")
	}
	return i18n.T("找不到上游，或沒有讀取權限")
}

// ---------- employees ----------

// NewReplica is who a company hires.
type NewReplica struct {
	TeamID      string      `json:"teamId"`
	BlueprintID string      `json:"blueprintId"`
	Name        string      `json:"name"`
	Look        *model.Look `json:"look"`
	Model       string      `json:"model"`
	Effort      string      `json:"effort"`
	// Custom, when given, is their own settings, in place of a blueprint to be hired from.
	Custom *model.Blueprint `json:"custom"`
}

func (e *Engine) Hire(in NewReplica) (*model.Replica, error) {
	var out *model.Replica
	err := e.doSettings(func() error {
		bp := e.hireableBlueprint(in.BlueprintID, "")
		if in.Custom != nil {
			bp = in.Custom
		}
		if e.w.Teams[in.TeamID] == nil || bp == nil {
			return model.Errorf(model.CodeNotFound, "找不到公司或藍圖")
		}
		if strings.TrimSpace(in.Name) == "" {
			return model.Errorf(model.CodeInvalid, "員工要有名字")
		}
		if e.providerFor(in.Model) == nil {
			return model.Errorf(model.CodeInvalid, "沒有模型供應商提供 %s", in.Model)
		}
		effort := in.Effort
		if effort == "" {
			effort = model.ThinkingDefault
		}
		if !e.takesEffort(in.Model, effort) {
			return model.Errorf(model.CodeInvalid, "%s 沒有思考等級 %s", in.Model, effort)
		}
		look := bp.Look
		if in.Look != nil {
			look = *in.Look
		}
		r := &model.Replica{ID: e.uid("rep"), TeamID: in.TeamID, BlueprintID: in.BlueprintID, Name: strings.TrimSpace(in.Name), Look: look,
			Model: in.Model, Effort: effort, Memory: []model.MemoryEntry{}, HiredAt: e.w.Now}
		if in.Custom != nil {
			if err := e.ownBlueprint(r, *in.Custom); err != nil {
				return err
			}
		}
		e.w.Replicas[r.ID] = r
		out = clone(r)
		return nil
	})
	return out, err
}

// ReplicaPatch changes an employee; a nil field stays. Memory replaces all of it, for the user's own edits.
type ReplicaPatch struct {
	Name        *string              `json:"name"`
	BlueprintID *string              `json:"blueprintId"`
	Model       *string              `json:"model"`
	Effort      *string              `json:"effort"`
	Look        *model.Look          `json:"look"`
	Memory      *[]model.MemoryEntry `json:"memory"`
	// Custom gives them settings of their own, or rewrites theirs; BlueprintID instead lets their own go.
	Custom *model.Blueprint `json:"custom"`
}

func (e *Engine) UpdateReplica(id string, p ReplicaPatch) error {
	change := e.doSettings
	if p.Name == nil && p.BlueprintID == nil && p.Model == nil && p.Effort == nil && p.Look == nil && p.Custom == nil {
		change = e.do
	}
	return change(func() error {
		r := e.w.Replicas[id]
		if r == nil {
			return model.Errorf(model.CodeNotFound, "找不到員工")
		}
		if p.Name != nil && strings.TrimSpace(*p.Name) == "" {
			return model.Errorf(model.CodeInvalid, "員工要有名字")
		}
		if p.Model != nil && e.providerFor(*p.Model) == nil {
			return model.Errorf(model.CodeInvalid, "沒有模型供應商提供 %s", *p.Model)
		}
		if p.BlueprintID != nil && e.hireableBlueprint(*p.BlueprintID, id) == nil {
			return model.Errorf(model.CodeNotFound, "找不到藍圖")
		}
		if p.Custom != nil {
			try := *p.Custom
			try.Name = r.Name
			if err := checkBlueprint(&try); err != nil {
				return err
			}
		}
		// a level goes with its model: without a new one, a new model may have to fall back on the default
		modelID, effort := r.Model, r.Effort
		if p.Model != nil {
			modelID = *p.Model
		}
		if p.Effort != nil {
			effort = *p.Effort
		} else if !e.takesEffort(modelID, effort) {
			effort = model.ThinkingDefault
		}
		if !e.takesEffort(modelID, effort) {
			return model.Errorf(model.CodeInvalid, "%s 沒有思考等級 %s", modelID, effort)
		}
		r.Effort = effort
		if p.BlueprintID != nil && p.Custom == nil && *p.BlueprintID != r.BlueprintID {
			e.dropOwnBlueprint(r)
			r.BlueprintID = *p.BlueprintID
		}
		if p.Name != nil {
			r.Name = strings.TrimSpace(*p.Name)
		}
		if p.Model != nil {
			r.Model = *p.Model
		}
		if p.Look != nil {
			r.Look = *p.Look
		}
		if p.Memory != nil {
			r.Memory = *p.Memory
		}
		if p.Custom != nil {
			return e.ownBlueprint(r, *p.Custom)
		}
		// their own settings go by their name and look
		if b := e.w.Blueprints[r.BlueprintID]; b != nil && b.Owner == r.ID {
			b.Name, b.Look = r.Name, r.Look
		}
		return nil
	})
}

// Fire lets an employee go, handing everything still theirs to the heir; a job under way starts again with them.
func (e *Engine) Fire(id, heirID string) error {
	return e.doSettings(func() error {
		r, heir := e.w.Replicas[id], e.w.Replicas[heirID]
		if r == nil || heir == nil {
			return model.Errorf(model.CodeNotFound, "找不到員工")
		}
		if id == heirID || heir.TeamID != r.TeamID {
			return model.Errorf(model.CodeInvalid, "要交接給同公司的另一位員工")
		}
		e.endChatsOf(id)
		swap := func(ids []string) []string {
			out := make([]string, 0, len(ids))
			for _, x := range ids {
				if x == id {
					x = heirID
				}
				if !slices.Contains(out, x) {
					out = append(out, x)
				}
			}
			return out
		}
		for _, wf := range e.w.Workflows {
			for i := range wf.Nodes {
				wf.Nodes[i].ReplicaIDs = swap(wf.Nodes[i].ReplicaIDs)
			}
		}
		for _, t := range e.w.Tasks {
			if t.Stage == enum.StageDone || t.Stage == enum.StageCancelled {
				continue
			}
			for i := range t.Workflow.Nodes {
				t.Workflow.Nodes[i].ReplicaIDs = swap(t.Workflow.Nodes[i].ReplicaIDs)
			}
			if t.OwnerID != nil && *t.OwnerID == id {
				t.OwnerID = ptr(heirID)
			}
			if m := t.Merge; m != nil && m.ReplicaID != nil && *m.ReplicaID == id {
				m.ReplicaID = ptr(heirID)
				if m.StartedAt != nil && t.Stage == enum.StageMerging {
					e.stopRun("merge:" + t.ID)
					m.StartedAt = nil
				}
			}
		}
		for _, s := range e.w.SubTasks {
			if s.ReplicaID == nil || *s.ReplicaID != id || s.Cancelled || s.Status == enum.StatusComplete {
				continue
			}
			e.stopRun(s.ID)
			s.ReplicaID = ptr(heirID)
			if s.Status == enum.StatusProgressing {
				s.Status = enum.StatusTodo
			}
			e.logLine(s, enum.LogSystem, i18n.T("%s 離職，交給 %s", r.Name, heir.Name), "handover", map[string]any{"from": r.Name, "to": heir.Name})
		}
		e.dropOwnBlueprint(r)
		delete(e.w.Replicas, id)
		return nil
	})
}
