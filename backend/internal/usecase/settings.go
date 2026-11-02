package usecase

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/url"
	"reflect"
	"slices"
	"strings"

	"github.com/yanun0323/mho-company/internal/i18n"
	"github.com/yanun0323/mho-company/internal/model"
	"github.com/yanun0323/mho-company/internal/model/enum"
)

func settingsBytes(w *model.World) []byte {
	raw, _ := json.MarshalIndent(model.SettingsOf(w), "", "  ")
	return append(raw, '\n')
}

func settingsError(field string, err error) error {
	parts := strings.SplitN(field, ".", 3)
	if len(parts) >= 2 {
		switch parts[0] {
		case "teams":
			field = "teams/" + parts[1] + "/config.yaml"
		case "replicas":
			field = "teams/<team_id>/replicas/" + parts[1] + ".json"
		case "blueprints", "workflows":
			field = parts[0] + "/" + parts[1] + ".yaml"
		case "providers":
			field = "provider.json " + parts[1]
		}
		if len(parts) == 3 {
			field += " " + parts[2]
		}
	}
	return model.Errorf(model.CodeInvalid, "設定 %s：%v", field, err)
}

func sameIDs[T, U any](field string, next map[string]T, old map[string]U, imports ...bool) error {
	if next == nil {
		return settingsError(field, i18n.Errorf("不能省略或設為 null"))
	}
	for id := range old {
		if _, ok := next[id]; !ok {
			return settingsError(field+"."+id, i18n.Errorf("不能以刪除設定的方式刪除資料，請使用介面"))
		}
	}
	for id := range next {
		if _, ok := old[id]; !ok && len(imports) == 0 {
			return settingsError(field+"."+id, i18n.Errorf("請先從介面建立項目，再編輯設定"))
		}
	}
	return nil
}

func (e *Engine) parseSettings(raw []byte) (model.Settings, error) {
	var s model.Settings
	d := json.NewDecoder(bytes.NewReader(raw))
	d.DisallowUnknownFields()
	if err := d.Decode(&s); err != nil {
		return s, settingsError("", err)
	}
	var extra any
	if err := d.Decode(&extra); err != io.EOF {
		return s, settingsError("", i18n.Errorf("只能有一個 JSON 物件"))
	}
	if s.Version != 1 {
		return s, settingsError("version", i18n.Errorf("必須是 1"))
	}
	if _, err := model.MergePreferences(s.Preferences, nil); err != nil {
		return s, settingsError("preferences.yaml", err)
	}
	if err := model.CheckTutorial(s.Tutorial); err != nil {
		return s, settingsError("tutorial.yaml", err)
	}
	for _, err := range []error{
		sameIDs("teams", s.Teams, e.w.Teams), sameIDs("replicas", s.Replicas, e.w.Replicas),
		sameIDs("providers", s.Providers, e.w.Providers), sameIDs("blueprints", s.Blueprints, model.WithoutPresets(e.w.Blueprints), true),
		sameIDs("workflows", s.Workflows, model.WithoutPresets(e.w.Workflows), true),
	} {
		if err != nil {
			return s, err
		}
	}
	bad := func(field, text string) (model.Settings, error) {
		return s, settingsError(field, i18n.Errorf(text))
	}
	for id, t := range s.Teams {
		field := "teams." + id
		old := e.w.Teams[id]
		if t.ID != id {
			return bad(field+".id", "不能修改 id")
		}
		if strings.TrimSpace(t.Name) == "" {
			return bad(field+".name", "不能是空的")
		}
		if t.Folder != old.Folder {
			return bad(field+".folder", "不能在設定檔搬移公司資料夾")
		}
		if !slices.Contains(old.Branches, t.TargetBranch) {
			return bad(field+".targetBranch", "目標分支不存在於公司的分支清單")
		}
		if t.Settings.TimeoutMin < 0 || t.Settings.CostLimitUSD < 0 || t.Settings.Retries < 0 {
			return bad(field+".settings", "設定不能是負數")
		}
	}
	for id, p := range s.Providers {
		field := "providers." + id
		old := e.w.Providers[id]
		if p.ID != id {
			return bad(field+".id", "不能修改 id")
		}
		if strings.TrimSpace(p.Name) == "" {
			return bad(field+".name", "不能是空的")
		}
		if p.Kind != old.Kind || p.AuthKind != old.Auth.Kind {
			return bad(field, "供應商種類與登入方式請從介面修改")
		}
		if p.BaseURL != "" {
			u, err := url.Parse(p.BaseURL)
			if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
				return bad(field+".baseUrl", "需要不含帳密、查詢參數或 fragment 的 HTTP(S) 網址")
			}
			if p.AuthKind != "apiKey" {
				return bad(field+".baseUrl", "訂閱登入不能指定 API 網址")
			}
		}
		seen := map[string]bool{}
		for _, m := range p.Models {
			if strings.TrimSpace(m) == "" || seen[m] {
				return bad(field+".models", "模型不能空白或重複")
			}
			seen[m] = true
		}
		for m, levels := range p.Thinking {
			if !seen[m] {
				return bad(field+".thinking."+m, "模型不在 models 清單")
			}
			used := map[string]bool{}
			for _, level := range levels {
				if strings.TrimSpace(level) == "" || level == model.ThinkingDefault || used[level] {
					return bad(field+".thinking."+m, "等級不能空白、重複或包含 default")
				}
				used[level] = true
			}
		}
		for m, price := range p.Prices {
			if price.Input < 0 || price.Output < 0 || price.CacheRead < 0 {
				return bad(field+".prices."+m, "價格不能是負數")
			}
		}
	}
	for id, b := range s.Blueprints {
		field := "blueprints." + id
		if b == nil || b.ID != id {
			return bad(field+".id", "不能為 null 或修改 id")
		}
		if model.IsPresetID(id) {
			return bad(field+".id", "preset- 開頭的 id 保留給內建項目")
		}
		if err := checkBlueprint(b); err != nil {
			return s, settingsError(field, err)
		}
	}
	// Use the same provider selection and effort validation as the execution path.
	candidate := model.NewWorld()
	for id, p := range s.Providers {
		candidate.Providers[id] = &model.ModelProvider{ID: id, Kind: p.Kind, Models: p.Models, Thinking: p.Thinking}
	}
	probe := Engine{w: candidate}
	for id, r := range s.Replicas {
		field := "replicas." + id
		if r.ID != id {
			return bad(field+".id", "不能修改 id")
		}
		if r.TeamID != e.w.Replicas[id].TeamID {
			return bad(field+".teamId", "不能搬移員工到別間公司")
		}
		if strings.TrimSpace(r.Name) == "" {
			return bad(field+".name", "不能是空的")
		}
		if s.Blueprints[r.BlueprintID] == nil && !isPresetBlueprint(r.BlueprintID) {
			return bad(field+".blueprintId", "藍圖不存在")
		}
		if probe.providerFor(r.Model) == nil {
			return bad(field+".model", "沒有供應商提供這個模型")
		}
		if !probe.takesEffort(r.Model, r.Effort) {
			return bad(field+".effort", "模型沒有這個思考等級")
		}
	}
	for id, wf := range s.Workflows {
		field := "workflows." + id
		if wf == nil || wf.ID != id {
			return bad(field+".id", "不能為 null 或修改 id")
		}
		if model.IsPresetID(id) {
			return bad(field+".id", "preset- 開頭的 id 保留給內建項目")
		}
		if strings.TrimSpace(wf.Name) == "" {
			return bad(field+".name", "不能是空的")
		}
		if err := checkWorkflow(wf); err != nil {
			return s, settingsError(field, err)
		}
		for i, n := range wf.Nodes {
			f := fmt.Sprintf("%s.nodes[%d]", field, i)
			if !slices.Contains([]enum.NodeKind{enum.NodeTask, enum.NodeWork, enum.NodeTalk}, n.Kind) {
				return bad(f+".kind", "不認識的節點種類")
			}
			if !slices.Contains([]enum.Assignment{enum.AssignFirstAvailable, enum.AssignEveryone}, n.Assignment) {
				return bad(f+".assignment", "不認識的分派模式")
			}
			if !slices.Contains([]enum.HandoffMode{enum.HandoffAll, enum.HandoffPickOne}, n.Handoff) {
				return bad(f+".handoff", "不認識的交接模式")
			}
			if !slices.Contains([]enum.JoinMode{enum.JoinAll, enum.JoinAny}, n.Join) {
				return bad(f+".join", "不認識的匯合模式")
			}
			for _, rid := range n.ReplicaIDs {
				if _, ok := s.Replicas[rid]; !ok {
					return bad(f+".replicaIds", "員工不存在")
				}
			}
		}
		seen := map[string]bool{}
		for _, edge := range wf.Edges {
			if edge.ID == "" || seen[edge.ID] {
				return bad(field+".edges", "連線 id 不能空白或重複")
			}
			seen[edge.ID] = true
		}
	}
	return s, nil
}

// ReloadSettings validates the whole file before changing anything. Task workflow
// snapshots, running model requests and runtime records are deliberately untouched.
func (e *Engine) ReloadSettings(ctx context.Context) error {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.closed {
		return model.Errorf(model.CodeUnavailable, "伺服器已停止，請重新啟動")
	}
	raw, err := e.store.LoadSettings(ctx)
	if err != nil {
		return err
	}
	s, err := e.parseSettings(raw.Data)
	if err != nil {
		return err
	}
	if err := e.store.CheckSettings(raw); err != nil {
		return err
	}
	for id := range e.logins {
		if !reflect.DeepEqual(s.Providers[id], model.SettingsOf(e.w).Providers[id]) {
			return model.Errorf(model.CodeConflict, "供應商正在登入，請完成或取消後再重新載入設定")
		}
	}
	before := model.SettingsOf(e.w)
	oldRaw, oldEncoded := e.settingsRaw, e.settingsEncoded
	s.Install(e.w)
	e.installPresets()
	e.settingsRaw, e.settingsEncoded = raw, settingsBytes(e.w)
	// Broadcast the changed entities without advancing the task graph.
	if err := e.sync(); err != nil {
		before.Install(e.w)
		e.installPresets()
		e.settingsRaw, e.settingsEncoded = oldRaw, oldEncoded
		return err
	}
	return nil
}

// prepareSettings writes initial defaults before any employee may start.
func (e *Engine) prepareSettings(ctx context.Context) error {
	if e.settingsRaw.Data != nil && e.settingsRaw.Files["preferences.yaml"] != nil {
		return nil
	}
	e.settingsEncoded = nil
	return e.sync()
}

// UpdatePreferences merges only the submitted fields, so clients cannot overwrite unrelated changes.
func (e *Engine) UpdatePreferences(patch map[string]json.RawMessage) error {
	if patch == nil {
		return model.Errorf(model.CodeInvalid, "preferences must be an object")
	}
	return e.doSettings(func() error {
		next, err := model.MergePreferences(e.w.Preferences, patch)
		if err != nil {
			return settingsError("preferences.yaml", err)
		}
		e.w.Preferences = next
		for key := range patch {
			if soundPreference(key) {
				e.w.Tutorial.Learn("sound")
			}
		}
		return nil
	})
}

// soundPreference says whether a preference is one of the music and sound settings.
func soundPreference(key string) bool {
	return strings.HasPrefix(key, "music") || strings.HasPrefix(key, "sound") || strings.HasPrefix(key, "effects")
}

// UpdateTutorial adds to how far the user has come through the tutorial.
func (e *Engine) UpdateTutorial(patch model.TutorialPatch) error {
	return e.doSettings(func() error {
		if err := e.w.Tutorial.Apply(patch); err != nil {
			return settingsError("tutorial.yaml", err)
		}
		return nil
	})
}

// Learn records something the user did for the tutorial, from outside a change.
func (e *Engine) Learn(action string) error {
	return e.do(func() error {
		e.w.Tutorial.Learn(action)
		return nil
	})
}
