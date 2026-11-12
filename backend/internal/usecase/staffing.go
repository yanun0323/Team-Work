package usecase

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"io/fs"
	"net/url"
	"os"
	"path/filepath"
	"slices"
	"strings"

	"github.com/yanun0323/Team-Work/internal/i18n"
	"github.com/yanun0323/Team-Work/internal/model"
	"github.com/yanun0323/Team-Work/internal/model/enum"
)

// ---------- copying employees between islands ----------
//
// An employee is copied from a paired computer to this island's staffing agency: the other computer exports who they
// are and how they work (ExportReplica), and this one hires someone new from that (CopyReplica). Their memory, tasks,
// chats, company and credentials never leave, and the employee there stays as they were.

// Skill copy modes: SkillsSource keeps where the skills come from (a Git source is read again here; a folder on the
// other computer has to be picked again), SkillsFiles brings the files of the skills picked.
const (
	SkillsSource = "source"
	SkillsFiles  = "files"
)

// Bounds on the skill files one copy brings, so a folder full of something else is refused rather than carried.
const (
	copyFileMost  = 4 << 20
	copyTotalMost = 16 << 20
	copyFilesMost = 1000
)

// ReplicaExport is an employee as another island copies them.
type ReplicaExport struct {
	Name   string     `json:"name"`
	Look   model.Look `json:"look"`
	Model  string     `json:"model"`
	Effort string     `json:"effort"`
	// Blueprint is how they work: its name, prompt, tools and own repo. PresetID is set when that is a blueprint
	// built into the app, which every island has.
	Blueprint ExportBlueprint `json:"blueprint"`
	Packs     []ExportPack    `json:"packs"`
	// Files are the skills' files, only when asked for.
	Files []ExportSkill `json:"files,omitempty"`
}

type ExportBlueprint struct {
	PresetID string                `json:"presetId,omitempty"`
	Name     string                `json:"name"`
	Prompt   string                `json:"prompt"`
	Tools    []string              `json:"tools"`
	Source   model.BlueprintSource `json:"source"`
}

// ExportPack is one place the skills come from, written out whole. Skills are the names read there, nil when it could
// not be read on the computer exporting it.
type ExportPack struct {
	Kind    string   `json:"kind"` // git, local or missing
	Repo    string   `json:"repo,omitempty"`
	Ref     string   `json:"ref,omitempty"`
	Commit  string   `json:"commit,omitempty"`
	Path    string   `json:"path,omitempty"`
	Include []string `json:"include"`
	Exclude []string `json:"exclude"`
	Skills  []string `json:"skills"`
}

// ExportSkill is one skill's folder: each file by its path in it, with slashes.
type ExportSkill struct {
	Name  string       `json:"name"`
	Files []ExportFile `json:"files"`
}

type ExportFile struct {
	Path string `json:"path"`
	Data []byte `json:"data"`
}

// withoutCredentials drops a user name and password written into a repo's address, and its query and fragment, where a
// token can be too.
func withoutCredentials(repo string) string {
	u, err := url.Parse(repo)
	if err != nil || u.Scheme == "" {
		return repo
	}
	u.User, u.RawQuery, u.ForceQuery, u.Fragment, u.RawFragment = nil, "", false, "", ""
	return u.String()
}

// ExportReplica is employee id as another island copies them; with files, it brings the files of their skills.
func (e *Engine) ExportReplica(ctx context.Context, id string, files bool) (ReplicaExport, error) {
	e.mu.Lock()
	r := e.w.Replicas[id]
	var bp *model.Blueprint
	var packs []packRoot
	var refs []string
	if r != nil {
		bp = clone(e.w.Blueprints[r.BlueprintID])
	}
	if bp != nil {
		packs = e.packsOf(bp)
		for _, p := range bp.Skills {
			ref := ""
			switch {
			case p.SourceID != "" && e.w.Sources[p.SourceID] != nil:
				ref = e.w.Sources[p.SourceID].Ref
			case p.Source != nil:
				ref = p.Source.Ref
			default:
				ref = bp.Source.Ref
			}
			refs = append(refs, ref)
		}
	}
	var out ReplicaExport
	if r != nil {
		out = ReplicaExport{Name: r.Name, Look: r.Look, Model: r.Model, Effort: r.Effort, Packs: []ExportPack{}}
	}
	e.mu.Unlock()
	if r == nil {
		return out, model.Errorf(model.CodeNotFound, "找不到員工")
	}
	if bp == nil {
		return out, model.Errorf(model.CodeInvalid, "%s 的藍圖已不存在，請先選擇藍圖", r.Name)
	}
	out.Blueprint = ExportBlueprint{Name: bp.Name, Prompt: bp.Prompt, Tools: []string{}, Source: bp.Source}
	if model.IsPresetID(bp.ID) {
		out.Blueprint.PresetID = bp.ID
	}
	for _, t := range bp.Tools {
		out.Blueprint.Tools = append(out.Blueprint.Tools, string(t))
	}
	own := &out.Blueprint.Source
	own.Repo, own.Update, own.Private = withoutCredentials(own.Repo), nil, false
	if own.Kind == "local" { // a folder on this computer means nothing on another
		*own = model.BlueprintSource{Kind: "yaml"}
	}
	seen := map[string]bool{}
	total, count := 0, 0
	for i, p := range packs {
		found, roots, problems := e.loadSkills(ctx, []packRoot{p}) // reading them can take a while: not under the lock
		x := ExportPack{Kind: p.source.Kind, Repo: withoutCredentials(p.source.Repo), Commit: p.source.Commit, Path: p.source.Path,
			Include: p.include, Exclude: p.exclude}
		if i < len(refs) {
			x.Ref = refs[i]
		}
		if x.Kind != "git" && x.Kind != "local" {
			x = ExportPack{Kind: "missing"}
		}
		if x.Exclude == nil {
			x.Exclude = []string{}
		}
		if len(problems) == 0 && x.Kind != "missing" {
			x.Skills = []string{}
			for _, s := range found {
				x.Skills = append(x.Skills, s.name)
			}
		}
		out.Packs = append(out.Packs, x)
		if !files || x.Skills == nil {
			continue
		}
		for _, s := range found {
			if seen[s.name] {
				continue
			}
			seen[s.name] = true
			skill, size, err := skillFolder(s, roots[0])
			if err != nil {
				return out, err
			}
			total += size
			count += len(skill.Files)
			if total > copyTotalMost || count > copyFilesMost {
				return out, model.Errorf(model.CodeInvalid, "技能檔案太多或太大，請改用只複製技能來源設定")
			}
			out.Files = append(out.Files, skill)
		}
	}
	return out, nil
}

// skillFolder reads the files of a skill's folder in the source read at root: regular files only, never what a link
// leads to, and none hidden. A folder that a link in the source leads out of it to is refused: root itself may be a
// link, as the folder picked is whatever it leads to.
func skillFolder(s skill, root string) (ExportSkill, int, error) {
	out := ExportSkill{Name: s.name, Files: []ExportFile{}}
	dir, err := filepath.EvalSymlinks(filepath.Dir(s.path))
	if err != nil || !insideDir(root, dir) {
		return out, 0, model.Errorf(model.CodeInvalid, "技能 %s 的資料夾在技能來源之外，請改用只複製技能來源設定", s.name)
	}
	size := 0
	err = filepath.WalkDir(dir, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if path != dir && strings.HasPrefix(d.Name(), ".") {
			if d.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		if d.IsDir() || !d.Type().IsRegular() { // links and anything else are left behind
			return nil
		}
		info, err := d.Info()
		if err != nil {
			return err
		}
		if info.Size() > copyFileMost {
			return model.Errorf(model.CodeInvalid, "技能 %s 的檔案 %s 太大，請改用只複製技能來源設定", s.name, d.Name())
		}
		rel, err := filepath.Rel(dir, path)
		if err != nil || !filepath.IsLocal(rel) {
			return nil
		}
		raw, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		size += len(raw)
		if size > copyTotalMost {
			return model.Errorf(model.CodeInvalid, "技能檔案太多或太大，請改用只複製技能來源設定")
		}
		out.Files = append(out.Files, ExportFile{Path: filepath.ToSlash(rel), Data: raw})
		return nil
	})
	if err != nil {
		if _, known := err.(*model.Error); known {
			return out, 0, err
		}
		return out, 0, model.Errorf(model.CodeInvalid, "技能 %s 的檔案讀取失敗", s.name)
	}
	return out, size, nil
}

// CopyPreview is what copying an employee here would give, for the user to settle before it is done: the models this
// island offers, and whether theirs is one of them.
type CopyPreview struct {
	ReplicaExport
	Models   []string            `json:"models"`
	Thinking map[string][]string `json:"thinking"`
	// ModelOK and EffortOK say whether their model and thinking level can be kept here; when not, the user picks.
	ModelOK  bool `json:"modelOk"`
	EffortOK bool `json:"effortOk"`
	// PresetOK says whether the built-in blueprint they work by is here too.
	PresetOK bool `json:"presetOk"`
}

// PreviewCopy says what copying x here would give.
func (e *Engine) PreviewCopy(x ReplicaExport) CopyPreview {
	e.mu.Lock()
	defer e.mu.Unlock()
	out := CopyPreview{ReplicaExport: x, Models: []string{}, Thinking: map[string][]string{}}
	out.Files = nil
	for _, p := range e.w.Providers {
		for _, m := range p.Models {
			if !slices.Contains(out.Models, m) {
				out.Models = append(out.Models, m)
			}
		}
	}
	slices.Sort(out.Models)
	for _, m := range out.Models { // the levels takesEffort accepts, from whoever offers the model
		levels := []string{model.ThinkingDefault}
		for _, l := range []string{"none", "minimal", "low", "medium", "high", "xhigh", "max"} {
			if e.takesEffort(m, l) {
				levels = append(levels, l)
			}
		}
		if p := e.providerFor(m); p != nil {
			for _, l := range p.Thinking[m] {
				if !slices.Contains(levels, l) {
					levels = append(levels, l)
				}
			}
		}
		out.Thinking[m] = levels
	}
	out.ModelOK = e.providerFor(x.Model) != nil
	out.EffortOK = out.ModelOK && e.takesEffort(x.Model, cmpOr(x.Effort, model.ThinkingDefault))
	out.PresetOK = x.Blueprint.PresetID != "" && e.w.Blueprints[x.Blueprint.PresetID] != nil
	return out
}

func cmpOr(a, b string) string {
	if a != "" {
		return a
	}
	return b
}

// CopyOptions is how an employee is copied: Skills is SkillsSource or SkillsFiles; Model and Effort, when given,
// replace theirs, which this island may not offer. Key names the request, so one sent again hires nobody new.
type CopyOptions struct {
	Skills string `json:"skills"`
	Model  string `json:"model"`
	Effort string `json:"effort"`
	Key    string `json:"-"`
}

// CopyResult is who was hired, and the skill folders on the other computer to pick again here.
type CopyResult struct {
	Replica *model.Replica `json:"replica"`
	Missing []string       `json:"missing"`
}

// copyKey is what a copy's request key is kept as on the employee it hired: the key is the other computer's and the
// browser's, so only its hash is kept.
func copyKey(key string) string {
	if key == "" {
		return ""
	}
	sum := sha256.Sum256([]byte(key))
	return hex.EncodeToString(sum[:])
}

// copiedBy reports whether a copy with this key was made, and the employee it hired if they are still here. The key
// is saved with the world, apart from the employee, so a restart does not forget it, letting them go does not either,
// and a save that failed takes it back with everything else. Callers hold e.mu.
func (e *Engine) copiedBy(key string) (*model.Replica, bool) {
	id, ok := e.w.Copies[key]
	if key == "" || !ok {
		return nil, false
	}
	return e.w.Replicas[id], true
}

// copiedAgain answers a copy sent again: who it hired, or a refusal once they are gone, never someone new.
func copiedAgain(r *model.Replica, x ReplicaExport, mode string) (CopyResult, error) {
	if r == nil {
		return CopyResult{}, model.Errorf(model.CodeConflict, "這位員工已經複製過，複製來的員工已不在這座島上；要再複製請重新開始")
	}
	out := CopyResult{Replica: clone(r), Missing: []string{}}
	if !model.IsPresetID(r.BlueprintID) {
		out.Missing = copyMissing(x, mode)
	}
	return out, nil
}

// copyMissing is the skill sources of x that copying it this way leaves to be picked again.
func copyMissing(x ReplicaExport, mode string) []string {
	missing := []string{}
	for _, p := range x.Packs {
		switch {
		case p.Kind == "missing" || p.Skills == nil:
			missing = append(missing, packLabel(p))
		case mode == SkillsFiles:
			// the files came along, or there were none to bring
		case p.Kind == "git" && filepath.IsLocal(filepath.FromSlash(cmpOr(strings.Trim(p.Path, "/"), "."))):
		default:
			missing = append(missing, packLabel(p))
		}
	}
	return missing
}

// CopyReplica hires x into the staffing agency as someone new. With SkillsFiles, the skills' files are kept under
// this computer's data folder as a folder source of their own. Nothing is hired when anything is refused, and a
// request sent again with the same key hires nobody new: the key is kept apart from whoever it hired, who may
// be gone by then.
func (e *Engine) CopyReplica(x ReplicaExport, o CopyOptions) (CopyResult, error) {
	if o.Skills == "" {
		o.Skills = SkillsSource
	}
	if o.Skills != SkillsSource && o.Skills != SkillsFiles {
		return CopyResult{}, model.Errorf(model.CodeInvalid, "不認識的技能複製方式")
	}
	key := copyKey(o.Key)
	e.mu.Lock()
	done, made := e.copiedBy(key)
	e.mu.Unlock()
	if made {
		return copiedAgain(done, x, o.Skills)
	}
	var out CopyResult
	// their level is kept, or one picked with the model: none is put in its place
	modelID, effort := cmpOr(o.Model, x.Model), cmpOr(o.Effort, x.Effort)
	var folder string
	if o.Skills == SkillsFiles && len(x.Files) > 0 {
		var err error
		if folder, err = e.writeCopiedSkills(x.Files); err != nil {
			return CopyResult{}, err
		}
	}
	hired := false
	err := e.doSettings(func() error {
		if done, made := e.copiedBy(key); made { // the same request, waiting on the lock while this one was made
			var err error
			out, err = copiedAgain(done, x, o.Skills)
			return err
		}
		if strings.TrimSpace(x.Name) == "" {
			return model.Errorf(model.CodeInvalid, "員工要有名字")
		}
		if e.providerFor(modelID) == nil {
			return model.Errorf(model.CodeInvalid, "這座島沒有模型 %s，請重新選擇模型", modelID)
		}
		if !e.takesEffort(modelID, effort) {
			return model.Errorf(model.CodeInvalid, "%s 沒有思考等級 %s，請重新選擇思考等級", modelID, effort)
		}
		r := &model.Replica{ID: e.uid("rep"), TeamID: model.StaffingID, Name: strings.TrimSpace(x.Name), Look: x.Look,
			Model: modelID, Effort: effort, Memory: []model.MemoryEntry{}, HiredAt: e.w.Now}
		missing := []string{}
		if id := x.Blueprint.PresetID; id != "" && e.w.Blueprints[id] != nil {
			r.BlueprintID = id
		} else {
			bp := model.Blueprint{Name: r.Name, Prompt: x.Blueprint.Prompt, Source: x.Blueprint.Source, Skills: []model.SkillPack{}, Look: r.Look}
			if bp.Source.Kind != "git" {
				bp.Source = model.BlueprintSource{Kind: "yaml"}
			}
			for _, t := range x.Blueprint.Tools {
				bp.Tools = append(bp.Tools, enum.Tool(t))
			}
			if folder != "" {
				src := &model.Source{ID: e.uid("src"), Kind: "local", Path: folder}
				e.w.Sources[src.ID] = src
				bp.Skills = append(bp.Skills, model.SkillPack{SourceID: src.ID, Exclude: []string{}})
			}
			missing = copyMissing(x, o.Skills)
			if o.Skills == SkillsSource {
				for _, p := range x.Packs {
					sub := strings.Trim(p.Path, "/")
					if p.Kind != "git" || p.Skills == nil || !filepath.IsLocal(filepath.FromSlash(cmpOr(sub, "."))) {
						continue
					}
					bp.Skills = append(bp.Skills, model.SkillPack{Source: &model.BlueprintSource{Kind: "git", Repo: githubAddress(p.Repo), Ref: p.Ref, Commit: p.Commit, Path: sub},
						Include: p.Include, Exclude: cmpSlice(p.Exclude)})
				}
			}
			if err := e.ownBlueprint(r, bp); err != nil {
				return err
			}
		}
		e.w.Replicas[r.ID] = r
		if key != "" {
			if e.w.Copies == nil {
				e.w.Copies = map[string]string{}
			}
			e.w.Copies[key] = r.ID
		}
		out = CopyResult{Replica: clone(r), Missing: missing}
		hired = true
		return nil
	})
	if err != nil || !hired {
		os.RemoveAll(folder) // nothing hired with it, or the same copy was already made
	}
	return out, err
}

func cmpSlice(s []string) []string {
	if s == nil {
		return []string{}
	}
	return s
}

// packLabel names a pack for the user: its repo and folder, or the folder on the other computer.
func packLabel(p ExportPack) string {
	switch p.Kind {
	case "git":
		if p.Path != "" {
			return p.Repo + " / " + p.Path
		}
		return p.Repo
	case "local":
		return p.Path
	}
	return i18n.T("技能來源已不存在")
}

// writeCopiedSkills keeps the skills' files in a folder of their own under the data folder, as skills/<name>/...,
// refusing any name or path that would lead out of it. A refusal leaves nothing behind.
func (e *Engine) writeCopiedSkills(skills []ExportSkill) (string, error) {
	base := filepath.Join(e.dataDir, "copied-skills")
	if err := os.MkdirAll(base, 0o755); err != nil {
		return "", err
	}
	dir, err := os.MkdirTemp(base, "skills-")
	if err != nil {
		return "", err
	}
	fail := func(err error) (string, error) {
		os.RemoveAll(dir)
		return "", err
	}
	total, count := 0, 0
	names := map[string]bool{}
	for _, s := range skills {
		name := strings.TrimSpace(s.Name)
		if name == "" || name != filepath.Base(name) || name == "." || name == ".." || strings.ContainsAny(name, `/\`) || names[name] {
			return fail(model.Errorf(model.CodeInvalid, "技能名稱不正確：%s", s.Name))
		}
		names[name] = true
		root := filepath.Join(dir, "skills", name)
		for _, f := range s.Files {
			rel := filepath.FromSlash(f.Path)
			if !filepath.IsLocal(rel) || strings.Contains(f.Path, `\`) {
				return fail(model.Errorf(model.CodeInvalid, "技能 %s 的檔案路徑不正確：%s", name, f.Path))
			}
			total += len(f.Data)
			count++
			if len(f.Data) > copyFileMost || total > copyTotalMost || count > copyFilesMost {
				return fail(model.Errorf(model.CodeInvalid, "技能檔案太多或太大，請改用只複製技能來源設定"))
			}
			path := filepath.Join(root, rel)
			if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
				return fail(err)
			}
			// O_EXCL: a path given twice, or through a folder made a link, is never written over
			if err := writeNew(path, f.Data); err != nil {
				return fail(model.Errorf(model.CodeInvalid, "技能 %s 的檔案路徑不正確：%s", name, f.Path))
			}
		}
		if _, err := os.Lstat(filepath.Join(root, "SKILL.md")); err != nil {
			return fail(model.Errorf(model.CodeInvalid, "技能 %s 少了 SKILL.md", name))
		}
	}
	return dir, nil
}

func writeNew(path string, data []byte) error {
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o644)
	if err != nil {
		return err
	}
	if _, err := f.Write(data); err != nil {
		f.Close()
		return err
	}
	return f.Close()
}
