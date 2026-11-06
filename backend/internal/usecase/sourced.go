package usecase

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"hash/fnv"
	"io"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"slices"
	"strings"

	"go.yaml.in/yaml/v3"

	"github.com/yanun0323/Team-Work/internal/i18n"
	"github.com/yanun0323/Team-Work/internal/model"
	"github.com/yanun0323/Team-Work/internal/model/enum"
)

// The folders at the top of a source that hold the blueprints and flows it brings, one YAML file each.
const (
	sourcedBlueprints = "blueprints"
	sourcedWorkflows  = "workflows"
)

// sourcedSet is what a source brings besides skills, as read at one version: blueprints and flows, and what was wrong
// with the files that could not be read. Packs are left to place until the set is put in the world, holding the lock.
type sourcedSet struct {
	Blueprints []sourcedBlueprint
	Workflows  []sourcedFlow
	Problems   []string
}

// sourcedBlueprint is a blueprint file as read: bp holds its texts in English, or the first language written, and
// name, prompt and comment every language the file writes them in.
type sourcedBlueprint struct {
	bp                    model.Blueprint
	packs                 []sourcedPack
	name, prompt, comment sourcedText
}

// in is the blueprint in a language, its skill packs left to place.
func (b sourcedBlueprint) in(language string) *model.Blueprint {
	out := clone(&b.bp)
	out.Name = strings.TrimSpace(b.name.in(language))
	out.Prompt = strings.TrimSpace(b.prompt.in(language))
	out.Comment = strings.TrimSpace(b.comment.in(language))
	return out
}

// sourcedFlow is a flow file as read: wf holds its texts in English, or the first language written, and name and
// steps every language the file writes them in, the steps by id.
type sourcedFlow struct {
	wf    *model.Workflow
	name  sourcedText
	steps map[string]sourcedStep
}

type sourcedStep struct{ name, prompt sourcedText }

// localize puts a flow, or a task's copy of it, into a language: its name, and a step's name and instructions while
// its name is still one the file wrote for it. A step renamed since keeps what it says.
func (f sourcedFlow) localize(wf *model.Workflow, language string) {
	wf.Name = f.name.in(language)
	for i := range wf.Nodes {
		n := &wf.Nodes[i]
		s, ok := f.steps[n.ID]
		if !ok || !s.name.is(n.Name) {
			continue
		}
		n.Name = s.name.in(language)
		if len(s.prompt.langs) > 0 {
			n.Prompt = s.prompt.in(language)
		}
	}
}

// sourcedLanguages are the languages a source's file can write a text in, by the codes the app uses.
var sourcedLanguages = []string{model.LanguageEn, model.LanguageZh, model.LanguageZhHans, model.LanguageJa, model.LanguageKo}

// sourcedText is a text a source's file writes: one text whatever the language, or one for each language by its code.
type sourcedText struct {
	langs []string // in the order written; "" for the one text of any language
	texts map[string]string
}

func (t *sourcedText) UnmarshalYAML(n *yaml.Node) error {
	t.langs, t.texts = nil, map[string]string{}
	switch n.Kind {
	case yaml.ScalarNode:
		var s string
		if err := n.Decode(&s); err != nil {
			return err
		}
		t.langs, t.texts[""] = []string{""}, s
		return nil
	case yaml.MappingNode:
		for i := 0; i+1 < len(n.Content); i += 2 {
			key, value := n.Content[i], n.Content[i+1]
			if !slices.Contains(sourcedLanguages, key.Value) {
				return i18n.Errorf("第 %d 行：不認識的語言 %s", key.Line, key.Value)
			}
			var s string
			if value.Kind != yaml.ScalarNode || value.Decode(&s) != nil {
				return i18n.Errorf("第 %d 行要是一段文字，或用 en、zh、zh-Hans、ja、ko 各寫一段", value.Line)
			}
			if _, seen := t.texts[key.Value]; !seen {
				t.langs = append(t.langs, key.Value)
			}
			t.texts[key.Value] = s
		}
		return nil
	}
	return i18n.Errorf("第 %d 行要是一段文字，或用 en、zh、zh-Hans、ja、ko 各寫一段", n.Line)
}

// in is the text in a language, or else in English, or else the first one written.
func (t sourcedText) in(language string) string {
	for _, l := range []string{language, model.LanguageEn} {
		if s, ok := t.texts[l]; ok {
			return s
		}
	}
	if len(t.langs) == 0 {
		return ""
	}
	return t.texts[t.langs[0]]
}

// is says whether s is this text in any language.
func (t sourcedText) is(s string) bool {
	for _, text := range t.texts {
		if text == s {
			return true
		}
	}
	return false
}

// sourcedPack is a skill pack as a source's blueprint file writes it: a repo, a folder on this computer, or with
// neither, a folder in the source itself ("" the whole of it).
type sourcedPack struct {
	Repo    string   `yaml:"repo"`
	Ref     string   `yaml:"ref"`
	Path    string   `yaml:"path"`
	Include []string `yaml:"include"`
	Exclude []string `yaml:"exclude"`
}

// sourcedBlueprintFile is a blueprint file in a source: the same as a blueprint made on the form is kept as.
type sourcedBlueprintFile struct {
	Name    sourcedText   `yaml:"name"`
	Prompt  sourcedText   `yaml:"prompt"`
	Comment sourcedText   `yaml:"comment"`
	Skills  []sourcedPack `yaml:"skills"`
	Tools   []string      `yaml:"tools"`
	Look    *model.Look   `yaml:"look"`
}

// readsSourced says whether a source is read for blueprints and flows. The app's own folder is listed as a source
// for its skills, but the blueprints and flows in it are the user's own, already listed as theirs.
func (e *Engine) readsSourced(s model.Source) bool {
	if s.Kind == "local" {
		return e.dataDir == "" || filepath.Clean(expandHome(s.Path)) != filepath.Clean(e.dataDir)
	}
	return s.Commit != ""
}

// readSourced reads the blueprints and flows of source s at commit. A file that cannot be read is left out, and said
// why in the set's problems; only a source that cannot be read at all fails.
func (e *Engine) readSourced(ctx context.Context, s model.Source, commit string) (sourcedSet, error) {
	set := sourcedSet{}
	if !e.readsSourced(model.Source{Kind: s.Kind, Path: s.Path, Commit: commit}) {
		return set, nil
	}
	fsys, err := e.sourcedFS(ctx, s, commit)
	if err != nil {
		return set, err
	}
	for _, f := range sourcedFiles(fsys, sourcedBlueprints) {
		b, err := readSourcedBlueprint(s.ID, f.name, f.raw)
		if err != nil {
			set.Problems = append(set.Problems, fmt.Sprintf("%s/%s.yaml: %s", sourcedBlueprints, f.name, fileProblem(err)))
			continue
		}
		set.Blueprints = append(set.Blueprints, b)
	}
	for _, f := range sourcedFiles(fsys, sourcedWorkflows) {
		wf, err := readSourcedWorkflow(s.ID, f.name, f.raw)
		if err != nil {
			set.Problems = append(set.Problems, fmt.Sprintf("%s/%s.yaml: %s", sourcedWorkflows, f.name, fileProblem(err)))
			continue
		}
		set.Workflows = append(set.Workflows, wf)
	}
	return set, nil
}

// fileProblem is what is wrong with a file of a source, in words the one who wrote it can act on: what the YAML
// reader or the checks said of it. It names nothing but the file's own content.
func fileProblem(err error) string {
	var known *model.Error
	if errors.As(err, &known) {
		return known.Message
	}
	return err.Error()
}

type sourcedFile struct {
	name string
	raw  []byte
}

// sourcedFS is the folder a source's blueprints and flows are read from, at commit for a repo.
func (e *Engine) sourcedFS(ctx context.Context, s model.Source, commit string) (fs.FS, error) {
	root, err := e.sourceRoot(ctx, s, commit)
	if err != nil {
		return nil, err
	}
	return os.DirFS(root), nil
}

// sourcedFiles are the YAML files right in folder dir of fsys, by name without the extension. One whose name cannot
// be part of an id is left out, as is anything that is not a plain file.
func sourcedFiles(fsys fs.FS, dir string) []sourcedFile {
	entries, err := fs.ReadDir(fsys, dir)
	if err != nil {
		return nil
	}
	var out []sourcedFile
	for _, ent := range entries {
		name, ok := strings.CutSuffix(ent.Name(), ".yaml")
		if !ok {
			name, ok = strings.CutSuffix(ent.Name(), ".yml")
		}
		if !ok || !ent.Type().IsRegular() || !sourcedName(name) {
			continue
		}
		raw, err := fs.ReadFile(fsys, path.Join(dir, ent.Name()))
		if err != nil {
			continue
		}
		out = append(out, sourcedFile{name, raw})
	}
	slices.SortFunc(out, func(a, b sourcedFile) int { return strings.Compare(a.name, b.name) })
	return out
}

// sourcedName says whether a file's name can be part of an id: letters, digits, - and _, and no --.
func sourcedName(name string) bool {
	if name == "" || strings.Contains(name, model.SourcedSep) {
		return false
	}
	for _, r := range name {
		if !(r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '-' || r == '_') {
			return false
		}
	}
	return true
}

// decodeYAML reads one YAML document into v, refusing fields v does not have.
func decodeYAML(raw []byte, v any) error {
	d := yaml.NewDecoder(bytes.NewReader(raw))
	d.KnownFields(true)
	if err := d.Decode(v); err != nil {
		if err == io.EOF {
			return i18n.Errorf("檔案是空的")
		}
		return err
	}
	var extra any
	if err := d.Decode(&extra); err != io.EOF {
		return i18n.Errorf("只能有一份 YAML 文件")
	}
	return nil
}

// toolOfName reads a blueprint file's tools, as the YAML a blueprint is kept as names them or as the app does.
var toolOfName = func() map[string]enum.Tool {
	out := map[string]enum.Tool{}
	for t, name := range toolYAMLNames {
		out[name], out[string(t)] = t, t
	}
	return out
}()

func readSourcedBlueprint(sourceID, name string, raw []byte) (sourcedBlueprint, error) {
	var f sourcedBlueprintFile
	if err := decodeYAML(raw, &f); err != nil {
		return sourcedBlueprint{}, err
	}
	for _, l := range f.Name.langs {
		if strings.TrimSpace(f.Name.texts[l]) == "" {
			return sourcedBlueprint{}, model.Errorf(model.CodeInvalid, "藍圖要有名稱")
		}
	}
	b := model.Blueprint{
		ID: model.SourcedID(sourceID, name), Name: f.Name.in(model.LanguageEn), Prompt: strings.TrimSpace(f.Prompt.in(model.LanguageEn)),
		Comment: strings.TrimSpace(f.Comment.in(model.LanguageEn)),
		Source:  model.BlueprintSource{Kind: "yaml", Text: string(raw)}, Skills: []model.SkillPack{}, Tools: []enum.Tool{},
	}
	for _, t := range f.Tools {
		tool, ok := toolOfName[t]
		if !ok {
			return sourcedBlueprint{}, i18n.Errorf("不認識的工具 %s", t)
		}
		if !slices.Contains(b.Tools, tool) {
			b.Tools = append(b.Tools, tool)
		}
	}
	if err := checkBlueprint(&b); err != nil {
		return sourcedBlueprint{}, err
	}
	b.Look = lookFor(b.Name)
	if f.Look != nil {
		b.Look = *f.Look
	}
	for _, p := range f.Skills {
		if p.Repo == "" && !strings.HasPrefix(p.Path, "/") && !strings.HasPrefix(p.Path, "~") {
			if _, ok := insidePath(p.Path); !ok {
				return sourcedBlueprint{}, i18n.Errorf("技能的資料夾 %s 不在來源裡", p.Path)
			}
		}
	}
	return sourcedBlueprint{bp: b, packs: f.Skills, name: f.Name, prompt: f.Prompt, comment: f.Comment}, nil
}

// insidePath cleans a folder named inside a source, slashes between its parts; ok is false for one reaching out.
func insidePath(p string) (string, bool) {
	clean := path.Clean("/" + strings.ReplaceAll(p, "\\", "/"))
	return strings.Trim(clean, "/"), !slices.Contains(strings.Split(strings.ReplaceAll(p, "\\", "/"), "/"), "..")
}

// lookFor is how a blueprint whose file says nothing of it looks: colors picked by its name, so they stay the same.
func lookFor(name string) model.Look {
	h := fnv.New32a()
	_, _ = h.Write([]byte(name))
	n := h.Sum32()
	skins := []string{"#f2d3b3", "#e8b48a", "#c68e62", "#8d5a3b", "#6b4330"}
	hairs := []string{"#1f1a24", "#4a3426", "#8a5a2b", "#d9b36c", "#9a9aa3", "#c2452d"}
	shirts := []string{"#3f6fb5", "#4f8a5b", "#b5523f", "#7a5ab5", "#d1a23a", "#4a4a52"}
	pants := []string{"#2c2c3a", "#4f6a4a", "#3d4f6e", "#5a4636"}
	return model.Look{Skin: skins[n%5], Hair: hairs[n/5%6], Shirt: shirts[n/30%6], Pants: pants[n/180%4], Extra: "none"}
}

// pullText takes the text at key of mapping m, in one language or several, and leaves it there in English, or the first
// language written, for the rest of the file to be read as a flow kept in the settings files is.
func pullText(m *yaml.Node, key string) (sourcedText, error) {
	var t sourcedText
	if m == nil || m.Kind != yaml.MappingNode {
		return t, nil
	}
	for i := 0; i+1 < len(m.Content); i += 2 {
		if m.Content[i].Value != key {
			continue
		}
		v := m.Content[i+1]
		if err := v.Decode(&t); err != nil {
			return t, err
		}
		*v = yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: t.in(model.LanguageEn), Line: v.Line, Column: v.Column}
	}
	return t, nil
}

// valueOf is the value at key of mapping m; nil when there is none.
func valueOf(m *yaml.Node, key string) *yaml.Node {
	if m == nil || m.Kind != yaml.MappingNode {
		return nil
	}
	for i := 0; i+1 < len(m.Content); i += 2 {
		if m.Content[i].Value == key {
			return m.Content[i+1]
		}
	}
	return nil
}

func readSourcedWorkflow(sourceID, name string, raw []byte) (sourcedFlow, error) {
	// the same fields as a flow is kept with in the settings files, so one can be copied from there, and the texts
	// in several languages
	var doc yaml.Node
	if err := decodeYAML(raw, &doc); err != nil {
		return sourcedFlow{}, err
	}
	out := sourcedFlow{steps: map[string]sourcedStep{}}
	var root *yaml.Node
	if len(doc.Content) == 1 {
		root = doc.Content[0]
	}
	var err error
	if out.name, err = pullText(root, "name"); err != nil {
		return sourcedFlow{}, err
	}
	if nodes := valueOf(root, "nodes"); nodes != nil && nodes.Kind == yaml.SequenceNode {
		for _, n := range nodes.Content {
			var s sourcedStep
			if s.name, err = pullText(n, "name"); err != nil {
				return sourcedFlow{}, err
			}
			if s.prompt, err = pullText(n, "prompt"); err != nil {
				return sourcedFlow{}, err
			}
			if id := valueOf(n, "id"); id != nil && id.Kind == yaml.ScalarNode {
				out.steps[id.Value] = s
			}
		}
	}
	var v any
	if err := doc.Decode(&v); err != nil {
		return sourcedFlow{}, err
	}
	js, err := json.Marshal(v)
	if err != nil {
		return sourcedFlow{}, err
	}
	var wf model.Workflow
	d := json.NewDecoder(bytes.NewReader(js))
	d.DisallowUnknownFields()
	if err := d.Decode(&wf); err != nil {
		return sourcedFlow{}, err
	}
	wf.ID = model.SourcedID(sourceID, name)
	placed := map[string]bool{}
	for i := range wf.Nodes {
		n := &wf.Nodes[i]
		n.ReplicaIDs = []string{} // who works a step is each task's to pick
		if n.Kind == "" {
			n.Kind = enum.NodeWork
		}
		if n.Handoff == "" {
			n.Handoff = enum.HandoffAll
		}
		if n.Join == "" {
			n.Join = enum.JoinAll
		}
		if n.Pos != (model.Point{}) {
			placed[n.ID] = true
		}
	}
	for i := range wf.Edges {
		if wf.Edges[i].ID == "" {
			wf.Edges[i].ID = fmt.Sprintf("edge-%d", i+1)
		}
	}
	settleStarts(&wf)
	if err := (&Engine{w: model.NewWorld()}).checkFlow(&wf); err != nil {
		return sourcedFlow{}, err
	}
	for _, l := range out.name.langs {
		if strings.TrimSpace(out.name.texts[l]) == "" {
			return sourcedFlow{}, model.Errorf(model.CodeInvalid, "任務藍圖要有名稱")
		}
	}
	if len(placed) == 0 {
		placeNodes(&wf, placed)
	}
	out.wf = &wf
	return out, nil
}

// putSourced puts what source id brings at its version in use in the world, in place of what it brought before.
// Employees whose blueprint is no longer there keep it as their own settings. Call it holding the lock, inside a
// change.
func (e *Engine) putSourced(id string, set sourcedSet) {
	if e.sourced == nil {
		e.sourced = map[string]sourcedSet{}
	}
	was := map[string]*model.Blueprint{}
	for bid, b := range e.w.Blueprints {
		if model.SourceOfID(bid) == id {
			was[bid] = b
		}
	}
	e.sourced[id] = set
	e.installSourced()
	for _, r := range e.w.Replicas {
		old := was[r.BlueprintID]
		if old == nil || e.w.Blueprints[r.BlueprintID] != nil {
			continue
		}
		own := *clone(old)
		own.From = ""
		if err := e.ownBlueprint(r, own); err != nil {
			e.log.Warn().Err(err).Str("replica", r.ID).Msg("keep a blueprint gone from its source")
		}
	}
}

// installSourced puts every kept source's blueprints and flows in the world, and takes out those of sources gone or
// no longer bringing them. Call it holding the lock.
func (e *Engine) installSourced() {
	for id := range e.w.Blueprints {
		if model.SourceOfID(id) != "" {
			delete(e.w.Blueprints, id)
		}
	}
	for id := range e.w.Workflows {
		if model.SourceOfID(id) != "" {
			delete(e.w.Workflows, id)
		}
	}
	ids := make([]string, 0, len(e.sourced))
	for id := range e.sourced {
		ids = append(ids, id)
	}
	slices.Sort(ids) // a pack naming a new source makes it the same way each time
	for _, id := range ids {
		s := e.w.Sources[id]
		if s == nil {
			delete(e.sourced, id)
			continue
		}
		set := e.sourced[id]
		for _, sb := range set.Blueprints {
			b := sb.in(e.w.Language)
			b.Skills = e.placeSourcedPacks(s, sb.packs)
			e.w.Blueprints[b.ID] = b
		}
		for _, f := range set.Workflows {
			wf := clone(f.wf)
			e.localize(wf, e.w.Language)
			e.w.Workflows[wf.ID] = wf
		}
	}
}

// language is the language picked, for what runs outside the lock.
func (e *Engine) language() string {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.w.Language
}

// sourcedFlowOf is the flow a source brings by id, at the version in use. Call it holding the lock.
func (e *Engine) sourcedFlowOf(id string) (sourcedFlow, bool) {
	for _, f := range e.sourced[model.SourceOfID(id)].Workflows {
		if f.wf.ID == id {
			return f, true
		}
	}
	return sourcedFlow{}, false
}

// localize puts what the app and the flow's source wrote in a flow, or a task's copy of one, into a language. What
// the user wrote stays as written. Call it holding the lock.
func (e *Engine) localize(wf *model.Workflow, language string) {
	if f, ok := e.sourcedFlowOf(wf.ID); ok {
		f.localize(wf, language)
	}
	localizeFlow(wf, language)
}

// agentFlow is a flow as employees are told it: what the app wrote is in English, and what a source wrote too when
// it wrote English. Call it holding the lock.
func (e *Engine) agentFlow(wf *model.Workflow) *model.Workflow {
	c := clone(*wf)
	e.localize(&c, model.LanguageEn)
	return &c
}

// agentRole is a blueprint's prompt as employees are told it: a built-in one in English, one a source wrote in
// English when it did, and a user's as written. Call it holding the lock.
func (e *Engine) agentRole(bp *model.Blueprint) string {
	for _, p := range presets.Blueprints {
		if p.ID == bp.ID {
			return p.Prompt[model.LanguageEn]
		}
	}
	for _, sb := range e.sourced[model.SourceOfID(bp.ID)].Blueprints {
		if sb.bp.ID == bp.ID {
			return strings.TrimSpace(sb.prompt.in(model.LanguageEn))
		}
	}
	return bp.Prompt
}

// placeSourcedPacks turns the packs a source's blueprint file writes into packs reading the sources kept, keeping a
// new one for a repo or folder not kept yet. Call it holding the lock, inside a change.
func (e *Engine) placeSourcedPacks(s *model.Source, packs []sourcedPack) []model.SkillPack {
	out := []model.SkillPack{}
	for _, p := range packs {
		pack := model.SkillPack{Include: p.Include, Exclude: p.Exclude}
		if pack.Exclude == nil {
			pack.Exclude = []string{}
		}
		switch {
		case p.Repo != "":
			in, err := cleanSource(NewSource{Kind: "git", Repo: p.Repo, Ref: p.Ref})
			if err != nil {
				continue
			}
			pack.SourceID = e.sourceFor(in).ID
			pack.Path, _ = insidePath(p.Path)
		case strings.HasPrefix(p.Path, "/") || strings.HasPrefix(p.Path, "~"):
			pack.SourceID = e.sourceFor(NewSource{Kind: "local", Path: p.Path}).ID
		default:
			pack.SourceID = s.ID
			pack.Path, _ = insidePath(p.Path)
		}
		out = append(out, pack)
	}
	return out
}

// loadSourced reads what every kept source brings at its version in use, at start. Only what is on this computer is
// read: a repo version not downloaded yet is read once it is, when the source is next checked or applied.
func (e *Engine) loadSourced(ctx context.Context) {
	for _, s := range e.w.Sources {
		if !e.readsSourced(*s) {
			continue
		}
		if s.Kind == "git" && !e.git.Cached(s.Repo, s.Commit) {
			continue
		}
		set, err := e.readSourced(ctx, *s, s.Commit)
		if err != nil {
			e.log.Warn().Err(err).Str("source", s.ID).Msg("read blueprints and flows of a source")
			continue
		}
		e.putSourced(s.ID, set)
	}
}

// refreshSourced reads again what source id brings at its version in use, and puts it in the world.
func (e *Engine) refreshSourced(ctx context.Context, id string) error {
	e.mu.Lock()
	s := e.w.Sources[id]
	var src model.Source
	if s != nil {
		src = *s
	}
	e.mu.Unlock()
	if s == nil {
		return model.Errorf(model.CodeNotFound, "找不到來源")
	}
	set, err := e.readSourced(ctx, src, src.Commit)
	if err != nil {
		return model.Errorf(model.CodeInvalid, "%s", sourceProblem(err))
	}
	return e.doSettings(func() error {
		// a version that moved meanwhile is read by whatever moved it
		if s := e.w.Sources[id]; s != nil && s.Commit == src.Commit {
			e.putSourced(id, set)
		}
		return nil
	})
}

// SourceProblems are the blueprint and flow files of source id that could not be read, and why.
func (e *Engine) SourceProblems(id string) ([]string, error) {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.w.Sources[id] == nil {
		return nil, model.Errorf(model.CodeNotFound, "找不到來源")
	}
	out := slices.Clone(e.sourced[id].Problems)
	if out == nil {
		out = []string{}
	}
	return out, nil
}

// sourcedChanges fills in the blueprints and flows a repo source brings that come and go between its version in use
// and its newest, and the employees who would keep theirs as their own settings.
func (e *Engine) sourcedChanges(ctx context.Context, src model.Source, out *SourceChanges) error {
	was, err := e.readSourced(ctx, src, src.Commit)
	if err != nil {
		return err
	}
	is, err := e.readSourced(ctx, src, src.Latest)
	if err != nil {
		return err
	}
	language := e.language()
	bps := func(set sourcedSet) map[string]string {
		m := map[string]string{}
		for _, b := range set.Blueprints {
			m[b.bp.ID] = b.name.in(language)
		}
		return m
	}
	wfs := func(set sourcedSet) map[string]string {
		m := map[string]string{}
		for _, f := range set.Workflows {
			m[f.wf.ID] = f.name.in(language)
		}
		return m
	}
	diff := func(before, after map[string]string) (added, removed []string) {
		added, removed = []string{}, []string{}
		for id, name := range after {
			if _, ok := before[id]; !ok {
				added = append(added, name)
			}
		}
		for id, name := range before {
			if _, ok := after[id]; !ok {
				removed = append(removed, name)
			}
		}
		slices.Sort(added)
		slices.Sort(removed)
		return added, removed
	}
	beforeBps, afterBps := bps(was), bps(is)
	out.AddedBlueprints, out.RemovedBlueprints = diff(beforeBps, afterBps)
	out.AddedWorkflows, out.RemovedWorkflows = diff(wfs(was), wfs(is))
	e.mu.Lock()
	defer e.mu.Unlock()
	for _, r := range e.w.Replicas {
		if _, gone := afterBps[r.BlueprintID]; !gone && model.SourceOfID(r.BlueprintID) == src.ID {
			out.Kept = append(out.Kept, r.ID)
		}
	}
	slices.Sort(out.Kept)
	return nil
}
