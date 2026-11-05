package usecase

import (
	"context"
	"path/filepath"
	"slices"
	"strings"
	"time"

	"github.com/yanun0323/Team-Work/internal/i18n"
	"github.com/yanun0323/Team-Work/internal/model"
)

// sourceCheckEvery is how often every Git source is asked for its newest version.
const sourceCheckEvery = 6 * time.Hour

// NewSource is a place to read from: a Git repo at a branch (Ref empty: its default branch), or a folder.
type NewSource struct {
	Kind string `json:"kind"`
	Repo string `json:"repo"`
	Ref  string `json:"ref"`
	Path string `json:"path"`
	// Commit is the version a repo was previewed at, to keep using; empty reads the newest.
	Commit string `json:"commit,omitempty"`
}

// SourcePreview is what a source would bring before it is kept: the version read, the skills there, the names of
// the blueprints and flows there, and the files of those that could not be read.
type SourcePreview struct {
	Commit     string       `json:"commit"`
	Items      []SourceItem `json:"items"`
	Blueprints []string     `json:"blueprints"`
	Workflows  []string     `json:"workflows"`
	Problems   []string     `json:"problems"`
}

// empty says whether a source brings nothing at all.
func (p SourcePreview) empty() bool { return len(p.Items)+len(p.Blueprints)+len(p.Workflows) == 0 }

// SourceItem is a skill a source has. Path is its folder in the source and Category the folder holding it, as a pack
// names them; both use slashes, and the source's top is "".
type SourceItem struct {
	Name        string `json:"name"`
	Description string `json:"description"`
	Path        string `json:"path"`
	Category    string `json:"category"`
}

// SourceChanges is what moving a source to its newest version would change: the skills that come and go, and the
// blueprints and employees whose skills change with them.
type SourceChanges struct {
	From       string       `json:"from"`
	To         string       `json:"to"`
	Added      []SourceItem `json:"added"`
	Removed    []SourceItem `json:"removed"`
	Blueprints []string     `json:"blueprints"`
	Replicas   []string     `json:"replicas"`
	// The names of the blueprints and flows the source brings that come and go, and the employees working by one
	// that goes, who keep it as their own settings.
	AddedBlueprints   []string `json:"addedBlueprints"`
	RemovedBlueprints []string `json:"removedBlueprints"`
	AddedWorkflows    []string `json:"addedWorkflows"`
	RemovedWorkflows  []string `json:"removedWorkflows"`
	Kept              []string `json:"kept"`
}

// sameSource says whether s is the place n names.
func sameSource(s *model.Source, n NewSource) bool {
	if s.Kind != n.Kind {
		return false
	}
	if n.Kind == "local" {
		return filepath.Clean(expandHome(s.Path)) == filepath.Clean(expandHome(n.Path))
	}
	return s.Repo == n.Repo && s.Ref == n.Ref
}

func cleanSource(n NewSource) (NewSource, error) {
	switch n.Kind {
	case "git":
		n.Repo, n.Ref, n.Path, n.Commit = githubAddress(n.Repo), strings.TrimSpace(n.Ref), "", strings.TrimSpace(n.Commit)
		if n.Repo == "" || strings.HasPrefix(n.Repo, "-") {
			return n, model.Errorf(model.CodeInvalid, "Git 位址不正確")
		}
	case "local":
		n.Repo, n.Ref, n.Path, n.Commit = "", "", strings.TrimSpace(n.Path), ""
		if n.Path == "" {
			return n, model.Errorf(model.CodeInvalid, "技能要有來源")
		}
	default:
		return n, model.Errorf(model.CodeInvalid, "技能要有來源")
	}
	return n, nil
}

// sourceFor finds the source n names, or keeps a new one. Call it holding the lock, inside a change.
func (e *Engine) sourceFor(n NewSource) *model.Source {
	for _, s := range e.w.Sources {
		if sameSource(s, n) {
			return s
		}
	}
	s := &model.Source{ID: e.uid("src"), Kind: n.Kind, Repo: n.Repo, Ref: n.Ref, Path: n.Path}
	e.w.Sources[s.ID] = s
	return s
}

// adoptPacks moves each place written into a blueprint's packs to the sources kept apart: a repo at a branch is one
// source, and the folder in it becomes the pack's. Call it holding the lock. When merge is set, sources made by this
// adoption take the version of whichever pack last updated successfully, and fresh tells which those are.
func (e *Engine) adoptPacks(b *model.Blueprint, fresh map[string]bool) {
	if model.IsLockedID(b.ID) {
		return
	}
	for i := range b.Skills {
		p := &b.Skills[i]
		if p.Source == nil || p.SourceID != "" {
			continue
		}
		in := NewSource{Kind: p.Source.Kind, Repo: p.Source.Repo, Ref: p.Source.Ref, Path: p.Source.Path}
		if in.Kind == "git" {
			in.Path = ""
		}
		in, err := cleanSource(in)
		if err != nil {
			continue
		}
		before := len(e.w.Sources)
		s := e.sourceFor(in)
		if len(e.w.Sources) > before && fresh != nil {
			fresh[s.ID] = true
			s.Commit, s.Latest, s.Upstream, s.Update = p.Source.Commit, p.Source.Latest, p.Source.Upstream, p.Source.Update
		} else if fresh[s.ID] && newerUpdate(p.Source.Update, s.Update) {
			s.Commit, s.Latest, s.Upstream, s.Update = p.Source.Commit, p.Source.Latest, p.Source.Upstream, p.Source.Update
		}
		p.SourceID = s.ID
		if in.Kind == "git" {
			p.Path = strings.Trim(p.Source.Path, "/")
		}
		p.Source = nil
	}
}

// newerUpdate says whether a is a successful update made after b, or b failed or never was.
func newerUpdate(a, b *model.SourceUpdate) bool {
	if a == nil || !a.OK {
		return false
	}
	return b == nil || !b.OK || a.At > b.At
}

// adoptSources moves every blueprint, an employee's own settings too, to the sources kept apart. Settings from before
// there were sources wrote each place into each pack; the same repo used by several blueprints becomes one source.
func (e *Engine) adoptSources() {
	if e.w.Sources == nil {
		e.w.Sources = map[string]*model.Source{}
	}
	ids := make([]string, 0, len(e.w.Blueprints))
	for id := range e.w.Blueprints {
		ids = append(ids, id)
	}
	slices.Sort(ids)                            // the same ids each time
	for _, path := range presets.SkillFolders { // the agents' own folders are there to pick from
		e.sourceFor(NewSource{Kind: "local", Path: path})
	}
	fresh := map[string]bool{}
	for _, id := range ids {
		e.adoptPacks(e.w.Blueprints[id], fresh)
	}
}

// packsOf is a blueprint's packs as read at run time. Call it holding the lock.
func (e *Engine) packsOf(bp *model.Blueprint) []packRoot {
	var packs []packRoot
	for _, pack := range bp.Skills {
		var source model.BlueprintSource
		switch {
		case pack.SourceID != "":
			s := e.w.Sources[pack.SourceID]
			if s == nil {
				source = model.BlueprintSource{Kind: "missing"}
				break
			}
			source = model.BlueprintSource{Kind: s.Kind, Repo: s.Repo, Commit: s.Commit, Path: pack.Path}
			if s.Kind == "local" {
				source.Path = filepath.Join(s.Path, pack.Path)
			}
		case pack.Source != nil:
			source = *pack.Source
		default:
			source = bp.Source
		}
		packs = append(packs, packRoot{source: source, include: pack.Include, exclude: pack.Exclude})
	}
	return packs
}

// writtenPacks are packs with each source written into them, as the model reads and writes them. Call it holding
// the lock.
func (e *Engine) writtenPacks(packs []model.SkillPack) []model.SkillPack {
	out := make([]model.SkillPack, len(packs))
	for i, p := range packs {
		out[i] = p
		if s := e.w.Sources[p.SourceID]; p.SourceID != "" && s != nil {
			src := model.BlueprintSource{Kind: s.Kind, Repo: s.Repo, Ref: s.Ref, Path: p.Path}
			if s.Kind == "local" {
				src.Path = filepath.ToSlash(filepath.Join(s.Path, p.Path))
			}
			out[i] = model.SkillPack{Source: &src, Include: p.Include, Exclude: p.Exclude}
		}
	}
	return out
}

// checkPacks says whether every source a blueprint's packs name is kept.
func checkPacks(b *model.Blueprint, sources map[string]*model.Source) error {
	for _, p := range b.Skills {
		if p.SourceID != "" && sources[p.SourceID] == nil {
			return model.Errorf(model.CodeInvalid, "技能來源已不存在")
		}
		if strings.HasPrefix(p.Path, "/") || slices.Contains(strings.Split(p.Path, "/"), "..") {
			return model.Errorf(model.CodeInvalid, "技能來源的資料夾不正確")
		}
	}
	return nil
}

// AddSource keeps a place to read skills from, or finds the one already kept, and reads a new repo's newest version.
func (e *Engine) AddSource(ctx context.Context, in NewSource) (*model.Source, error) {
	in, err := cleanSource(in)
	if err != nil {
		return nil, err
	}
	e.mu.Lock()
	var kept *model.Source
	for _, s := range e.w.Sources {
		if sameSource(s, in) {
			kept = clone(s)
		}
	}
	e.mu.Unlock()
	if kept != nil {
		return kept, nil
	}
	// a repo is kept only once its skills were read, at the version they were read at
	var read SourcePreview
	if in.Kind == "git" {
		if read, err = e.PreviewSource(ctx, in); err != nil {
			return nil, err
		}
		if read.empty() {
			return nil, model.Errorf(model.CodeInvalid, "這個來源沒有技能、員工藍圖或任務藍圖")
		}
	}
	var id string
	err = e.doSettings(func() error {
		s := e.sourceFor(in)
		id = s.ID
		if s.Kind == "git" && s.Commit == "" {
			s.Commit, s.Latest, s.Upstream = read.Commit, read.Commit, true
			s.Update = &model.SourceUpdate{At: e.clock(), OK: true}
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	if err := e.refreshSourced(ctx, id); err != nil {
		e.log.Warn().Err(err).Str("source", id).Msg("read blueprints and flows of a source")
	}
	if err := e.PinSources(ctx); err != nil { // repos its blueprints name
		return nil, err
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	if s := e.w.Sources[id]; s != nil {
		return clone(s), nil
	}
	return nil, model.Errorf(model.CodeNotFound, "找不到來源")
}

// PreviewSource reads what a source would bring without keeping it: a repo at in.Commit, or at its newest version, and
// its skills there. The repo is fetched into the cache, so keeping it afterwards needs no second download.
func (e *Engine) PreviewSource(ctx context.Context, in NewSource) (SourcePreview, error) {
	in, err := cleanSource(in)
	if err != nil {
		return SourcePreview{}, err
	}
	src := model.Source{Kind: in.Kind, Repo: in.Repo, Ref: in.Ref, Path: in.Path}
	commit := in.Commit
	if src.Kind == "git" && commit == "" {
		if commit, err = e.git.Latest(ctx, src.Repo, src.Ref); err != nil {
			return SourcePreview{}, model.Errorf(model.CodeInvalid, "%s", sourceProblem(err))
		}
	}
	root, err := e.sourceRoot(ctx, src, commit)
	if err != nil {
		return SourcePreview{}, model.Errorf(model.CodeInvalid, "%s", sourceProblem(err))
	}
	out := SourcePreview{Commit: commit, Items: itemsAt(src, root), Blueprints: []string{}, Workflows: []string{}, Problems: []string{}}
	if set, err := e.readSourced(ctx, src, commit); err == nil {
		for _, b := range set.Blueprints {
			out.Blueprints = append(out.Blueprints, b.bp.Name)
		}
		for _, wf := range set.Workflows {
			out.Workflows = append(out.Workflows, wf.Name)
		}
		out.Problems = append(out.Problems, set.Problems...)
	}
	return out, nil
}

// pinSource reads the newest version of a repo source that has none yet; it is the version used from then on.
func (e *Engine) pinSource(ctx context.Context, id string) error {
	e.mu.Lock()
	s := e.w.Sources[id]
	unpinned := s != nil && s.Kind == "git" && s.Commit == ""
	e.mu.Unlock()
	if !unpinned {
		return nil
	}
	return e.checkSource(ctx, id)
}

// PinSources reads the newest version of every repo source that has none yet, as one an employee named would. The
// blueprints a source brings can name repos of their own, which are read too; each source is tried once.
func (e *Engine) PinSources(ctx context.Context) error {
	tried := map[string]bool{}
	for {
		e.mu.Lock()
		var ids []string
		for id, s := range e.w.Sources {
			if s.Kind == "git" && s.Commit == "" && !tried[id] {
				ids = append(ids, id)
			}
		}
		e.mu.Unlock()
		if len(ids) == 0 {
			return nil
		}
		slices.Sort(ids)
		for _, id := range ids {
			tried[id] = true
			if err := e.pinSource(ctx, id); err != nil {
				return err
			}
		}
	}
}

// SetSourceAutoApply sets whether a source moves to its newest version by itself once it is found.
func (e *Engine) SetSourceAutoApply(id string, on bool) error {
	return e.doSettings(func() error {
		s := e.w.Sources[id]
		if s == nil {
			return model.Errorf(model.CodeNotFound, "找不到來源")
		}
		s.AutoApply = on
		return nil
	})
}

// SeeSource records that the user has seen a source, so an update it applied by itself is no longer news.
func (e *Engine) SeeSource(id string) error {
	return e.doSettings(func() error {
		s := e.w.Sources[id]
		if s == nil {
			return model.Errorf(model.CodeNotFound, "找不到來源")
		}
		s.Unseen = false
		return nil
	})
}

// DeleteSource forgets a source nothing uses.
func (e *Engine) DeleteSource(id string) error {
	return e.doSettings(func() error {
		if e.w.Sources[id] == nil {
			return model.Errorf(model.CodeNotFound, "找不到來源")
		}
		for _, b := range e.w.Blueprints {
			if model.SourceOfID(b.ID) == id {
				continue // goes with it
			}
			for _, p := range b.Skills {
				if p.SourceID == id {
					return model.Errorf(model.CodeConflict, "還有藍圖或員工使用這個來源")
				}
			}
		}
		for _, r := range e.w.Replicas {
			if model.SourceOfID(r.BlueprintID) == id {
				return model.Errorf(model.CodeConflict, "還有藍圖或員工使用這個來源")
			}
		}
		delete(e.w.Sources, id)
		e.installSourced()
		return nil
	})
}

// CheckSource checks a source as checkSource does, then finds a version for the repos its blueprints name.
func (e *Engine) CheckSource(ctx context.Context, id string) error {
	count := func() int { e.mu.Lock(); defer e.mu.Unlock(); return len(e.w.Sources) }
	before := count()
	if err := e.checkSource(ctx, id); err != nil {
		return err
	}
	if count() == before {
		return nil
	}
	return e.PinSources(ctx)
}

// checkSource asks a repo source's upstream for its newest version. A source with no version yet, or one that applies
// updates itself, moves to it; others keep theirs until the user applies it. Each attempt is recorded on the source.
func (e *Engine) checkSource(ctx context.Context, id string) error {
	e.mu.Lock()
	s := e.w.Sources[id]
	if s == nil {
		e.mu.Unlock()
		return model.Errorf(model.CodeNotFound, "找不到來源")
	}
	src := *s
	repo, ref, kind := s.Repo, s.Ref, s.Kind
	e.mu.Unlock()
	if kind != "git" {
		// a folder has no versions: what it brings is read again
		return e.refreshSourced(ctx, id)
	}
	latest, err := e.git.Latest(ctx, repo, ref)
	if err != nil {
		e.log.Warn().Err(err).Str("repo", repo).Msg("check source")
	}
	// what it would bring there, read before the version moves to it by itself
	var set *sourcedSet
	if err == nil && latest != src.Commit && (src.Commit == "" || src.AutoApply) {
		if read, rerr := e.readSourced(ctx, src, latest); rerr == nil {
			set = &read
		} else {
			e.log.Warn().Err(rerr).Str("source", id).Msg("read blueprints and flows of a source")
		}
	}
	return e.doSettings(func() error {
		s := e.w.Sources[id]
		if s == nil {
			return model.Errorf(model.CodeNotFound, "找不到來源")
		}
		s.Upstream = err == nil || !upstreamGone(err)
		s.Update = &model.SourceUpdate{At: e.clock(), OK: err == nil}
		if err != nil {
			s.Update.Error = sourceProblem(err)
			return nil
		}
		s.Latest = latest
		if s.Commit != "" && s.Commit != latest && s.AutoApply {
			s.Unseen = true
		}
		if s.Commit == "" || s.AutoApply {
			s.Commit = latest
			if set != nil {
				e.putSourced(id, *set)
			}
		}
		return nil
	})
}

// ApplySource moves a source to the newest version found, with the blueprints and flows it brings there. Work under
// way keeps reading the version it started with; employees whose blueprint goes keep it as their own settings.
func (e *Engine) ApplySource(ctx context.Context, id string) error {
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
	if src.Latest == "" || src.Latest == src.Commit {
		return nil
	}
	set, err := e.readSourced(ctx, src, src.Latest)
	if err != nil {
		return model.Errorf(model.CodeInvalid, "%s", sourceProblem(err))
	}
	err = e.doSettings(func() error {
		s := e.w.Sources[id]
		if s == nil {
			return model.Errorf(model.CodeNotFound, "找不到來源")
		}
		if s.Latest != src.Latest {
			return model.Errorf(model.CodeConflict, "來源又有新版本，請重新查看更新內容")
		}
		s.Commit = s.Latest
		e.putSourced(id, set)
		return nil
	})
	if err != nil {
		return err
	}
	return e.PinSources(ctx) // repos its blueprints name
}

// checkSources asks every repo source for its newest version now and then, until the engine stops.
func (e *Engine) checkSources() {
	e.wg.Add(1)
	go func() {
		defer e.wg.Done()
		tick := time.NewTicker(sourceCheckEvery)
		defer tick.Stop()
		for {
			select {
			case <-e.ctx.Done():
				return
			case <-tick.C:
			}
			e.mu.Lock()
			var ids []string
			for id, s := range e.w.Sources {
				if s.Kind == "git" {
					ids = append(ids, id)
				}
			}
			e.mu.Unlock()
			for _, id := range ids {
				_ = e.CheckSource(e.ctx, id)
			}
		}
	}()
}

// sourceRoot is the folder a source is read from, at commit for a repo.
func (e *Engine) sourceRoot(ctx context.Context, s model.Source, commit string) (string, error) {
	if s.Kind == "local" {
		return expandHome(s.Path), nil
	}
	return e.git.Fetch(ctx, s.Repo, commit)
}

// itemsAt lists the skills in a source's folder root, as a pack of the whole source finds them; a repo's are only those
// that stay inside it.
func itemsAt(s model.Source, root string) []SourceItem {
	inside := ""
	if s.Kind != "local" {
		inside = root
	}
	out := []SourceItem{}
	for _, sk := range skillsIn(root, inside, nil, nil) {
		rel, err := filepath.Rel(root, filepath.Dir(sk.path))
		if err != nil {
			continue
		}
		rel = filepath.ToSlash(rel)
		category := filepath.ToSlash(filepath.Dir(rel))
		if category == "." {
			category = ""
		}
		out = append(out, SourceItem{Name: sk.name, Description: sk.description, Path: rel, Category: category})
	}
	slices.SortFunc(out, func(a, b SourceItem) int { return strings.Compare(a.Path, b.Path) })
	return out
}

// SourceItems lists the skills a source has at the version in use.
func (e *Engine) SourceItems(ctx context.Context, id string) ([]SourceItem, error) {
	e.mu.Lock()
	s := e.w.Sources[id]
	var src model.Source
	if s != nil {
		src = *s
	}
	e.mu.Unlock()
	if s == nil {
		return nil, model.Errorf(model.CodeNotFound, "找不到來源")
	}
	root, err := e.sourceRoot(ctx, src, src.Commit)
	if err != nil {
		return nil, model.Errorf(model.CodeInvalid, "%s", sourceProblem(err))
	}
	return itemsAt(src, root), nil
}

// covers says whether a pack takes the skill it at path; the pack's folder holds it and its picks keep it.
func covers(p model.SkillPack, it SourceItem) bool {
	if p.Path != "" && it.Path != p.Path && !strings.HasPrefix(it.Path, p.Path+"/") {
		return false
	}
	return (p.Include == nil || slices.Contains(p.Include, it.Name)) && !slices.Contains(p.Exclude, it.Name)
}

// SourceUpdateChanges compares a source's version in use with the newest found: the skills that come and go, and who
// gets or loses them.
func (e *Engine) SourceUpdateChanges(ctx context.Context, id string) (SourceChanges, error) {
	e.mu.Lock()
	s := e.w.Sources[id]
	var src model.Source
	if s != nil {
		src = *s
	}
	e.mu.Unlock()
	if s == nil {
		return SourceChanges{}, model.Errorf(model.CodeNotFound, "找不到來源")
	}
	out := SourceChanges{
		From: src.Commit, To: src.Latest, Added: []SourceItem{}, Removed: []SourceItem{}, Blueprints: []string{}, Replicas: []string{},
		AddedBlueprints: []string{}, RemovedBlueprints: []string{}, AddedWorkflows: []string{}, RemovedWorkflows: []string{}, Kept: []string{},
	}
	if src.Kind != "git" || src.Latest == "" || src.Latest == src.Commit {
		return out, nil
	}
	was, err := e.sourceRoot(ctx, src, src.Commit)
	if err != nil {
		return out, model.Errorf(model.CodeInvalid, "%s", sourceProblem(err))
	}
	is, err := e.sourceRoot(ctx, src, src.Latest)
	if err != nil {
		return out, model.Errorf(model.CodeInvalid, "%s", sourceProblem(err))
	}
	before, after := itemsAt(src, was), itemsAt(src, is)
	if err := e.sourcedChanges(ctx, src, &out); err != nil {
		return out, model.Errorf(model.CodeInvalid, "%s", sourceProblem(err))
	}
	has := func(list []SourceItem, it SourceItem) bool {
		return slices.ContainsFunc(list, func(x SourceItem) bool { return x.Path == it.Path && x.Name == it.Name })
	}
	for _, it := range after {
		if !has(before, it) {
			out.Added = append(out.Added, it)
		}
	}
	for _, it := range before {
		if !has(after, it) {
			out.Removed = append(out.Removed, it)
		}
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	changed := append(slices.Clone(out.Added), out.Removed...)
	for _, b := range e.w.Blueprints {
		hit := false
		for _, p := range b.Skills {
			hit = hit || p.SourceID == id && slices.ContainsFunc(changed, func(it SourceItem) bool { return covers(p, it) })
		}
		if !hit {
			continue
		}
		out.Blueprints = append(out.Blueprints, b.ID)
		for _, r := range e.w.Replicas {
			if r.BlueprintID == b.ID {
				out.Replicas = append(out.Replicas, r.ID)
			}
		}
	}
	slices.Sort(out.Blueprints)
	slices.Sort(out.Replicas)
	return out, nil
}

// missingSource is what an employee is told of a pack whose source is gone.
func missingSource() string { return i18n.T("技能來源已不存在") }
