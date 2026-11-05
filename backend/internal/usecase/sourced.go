package usecase

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"hash/fnv"
	"io"
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
	Workflows  []*model.Workflow
	Problems   []string
}

type sourcedBlueprint struct {
	bp    model.Blueprint
	packs []sourcedPack
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
	Name    string        `yaml:"name"`
	Prompt  string        `yaml:"prompt"`
	Comment string        `yaml:"comment"`
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
	root, err := e.sourceRoot(ctx, s, commit)
	if err != nil {
		return set, err
	}
	for _, f := range sourcedFiles(root, sourcedBlueprints) {
		b, err := readSourcedBlueprint(s.ID, f.name, f.raw)
		if err != nil {
			set.Problems = append(set.Problems, fmt.Sprintf("%s/%s.yaml: %s", sourcedBlueprints, f.name, fileProblem(err)))
			continue
		}
		set.Blueprints = append(set.Blueprints, b)
	}
	for _, f := range sourcedFiles(root, sourcedWorkflows) {
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

// sourcedFiles are the YAML files right in folder dir of root, by name without the extension. One whose name cannot
// be part of an id is left out, as is anything reaching out of root.
func sourcedFiles(root, dir string) []sourcedFile {
	entries, err := os.ReadDir(filepath.Join(root, dir))
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
		raw, err := os.ReadFile(filepath.Join(root, dir, ent.Name()))
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
	b := model.Blueprint{
		ID: model.SourcedID(sourceID, name), Name: f.Name, Prompt: strings.TrimSpace(f.Prompt), Comment: strings.TrimSpace(f.Comment),
		Source: model.BlueprintSource{Kind: "yaml", Text: string(raw)}, Skills: []model.SkillPack{}, Tools: []enum.Tool{},
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
	return sourcedBlueprint{bp: b, packs: f.Skills}, nil
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

func readSourcedWorkflow(sourceID, name string, raw []byte) (*model.Workflow, error) {
	// the same fields as a flow is kept with in the settings files, so one can be copied from there
	var v any
	if err := decodeYAML(raw, &v); err != nil {
		return nil, err
	}
	js, err := json.Marshal(v)
	if err != nil {
		return nil, err
	}
	var wf model.Workflow
	d := json.NewDecoder(bytes.NewReader(js))
	d.DisallowUnknownFields()
	if err := d.Decode(&wf); err != nil {
		return nil, err
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
		return nil, err
	}
	if len(placed) == 0 {
		placeNodes(&wf, placed)
	}
	return &wf, nil
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
			b := clone(&sb.bp)
			b.Skills = e.placeSourcedPacks(s, sb.packs)
			e.w.Blueprints[b.ID] = b
		}
		for _, wf := range set.Workflows {
			e.w.Workflows[wf.ID] = clone(wf)
		}
	}
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
	bps := func(set sourcedSet) map[string]string {
		m := map[string]string{}
		for _, b := range set.Blueprints {
			m[b.bp.ID] = b.bp.Name
		}
		return m
	}
	wfs := func(set sourcedSet) map[string]string {
		m := map[string]string{}
		for _, wf := range set.Workflows {
			m[wf.ID] = wf.Name
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
