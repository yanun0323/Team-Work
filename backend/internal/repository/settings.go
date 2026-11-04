package repository

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"

	"github.com/yanun0323/Team-Work/internal/i18n"
	"github.com/yanun0323/Team-Work/internal/model"
	"go.yaml.in/yaml/v3"
)

// A batch is committed with runtime rows. Recovery accepts each file in either
// its before or after state, so interruption between two renames is recoverable.
type settingsJournal struct {
	ID     int `gorm:"primaryKey"`
	Before []byte
	After  []byte
}

func validID(id string) bool {
	if id == "" || id == "." || id == ".." {
		return false
	}
	for _, r := range id {
		if !(r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '-' || r == '_') {
			return false
		}
	}
	return true
}

func settingPath(path string) bool {
	p := strings.Split(filepath.ToSlash(path), "/")
	if path == "provider.json" || path == "preferences.yaml" || path == "tutorial.yaml" || path == "sources.yaml" {
		return true
	}
	if len(p) == 2 && (p[0] == "blueprints" || p[0] == "workflows") {
		return strings.HasSuffix(p[1], ".yaml") && validID(strings.TrimSuffix(p[1], ".yaml"))
	}
	if len(p) == 3 && p[0] == "company" && validID(p[1]) && p[2] == "config.yaml" {
		return true
	}
	return len(p) == 4 && p[0] == "company" && validID(p[1]) && p[2] == "employee" && strings.HasSuffix(p[3], ".json") && validID(strings.TrimSuffix(p[3], ".json"))
}

func fileError(path string, err error) error {
	return model.Errorf(model.CodeInvalid, "%s：%v", path, err)
}

// safePath refuses links in every managed path component, including directories.
func (s *Store) safePath(rel string) (string, error) {
	if !settingPath(rel) {
		return "", fileError(rel, i18n.Errorf("不正確的設定檔路徑"))
	}
	path := s.dataDir
	for _, part := range strings.Split(filepath.ToSlash(rel), "/") {
		path = filepath.Join(path, part)
		info, err := os.Lstat(path)
		if errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err != nil {
			return "", err
		}
		if info.Mode()&os.ModeSymlink != 0 {
			return "", fileError(rel, i18n.Errorf("不接受符號連結"))
		}
	}
	return path, nil
}

func (s *Store) readFile(rel string) ([]byte, error) {
	path, err := s.safePath(rel)
	if err != nil {
		return nil, err
	}
	f, err := os.Open(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() {
		return nil, fileError(rel, i18n.Errorf("必須是一般檔案"))
	}
	raw, err := io.ReadAll(io.LimitReader(f, (16<<20)+1))
	if err != nil {
		return nil, err
	}
	if len(raw) > 16<<20 {
		return nil, fileError(rel, i18n.Errorf("不能超過 16 MB"))
	}
	return raw, nil
}

func (s *Store) readFiles() (map[string][]byte, error) {
	files := map[string][]byte{}
	for _, path := range []string{"provider.json", "preferences.yaml", "tutorial.yaml", "sources.yaml"} {
		raw, err := s.readFile(path)
		if err != nil {
			return nil, err
		}
		if raw != nil {
			files[path] = raw
		}
	}
	for _, dir := range []string{"company", "blueprints", "workflows"} {
		root := filepath.Join(s.dataDir, dir)
		err := filepath.WalkDir(root, func(path string, entry os.DirEntry, err error) error {
			if errors.Is(err, os.ErrNotExist) && path == root {
				return nil
			}
			if err != nil {
				return err
			}
			rel, err := filepath.Rel(s.dataDir, path)
			if err != nil {
				return err
			}
			rel = filepath.ToSlash(rel)
			if entry.Type()&os.ModeSymlink != 0 {
				return fileError(rel, i18n.Errorf("不接受符號連結"))
			}
			if entry.IsDir() {
				return nil
			}
			if !settingPath(rel) {
				if strings.HasSuffix(rel, ".json") || strings.HasSuffix(rel, ".yaml") || strings.HasSuffix(rel, ".yml") {
					return fileError(rel, i18n.Errorf("設定檔名稱或位置不正確"))
				}
				return nil // editor temporary files are not configuration
			}
			raw, err := s.readFile(rel)
			if err != nil {
				return err
			}
			files[rel] = raw
			return nil
		})
		if err != nil {
			return nil, err
		}
	}
	return files, nil
}

// YAML uses the same camelCase fields as JSON. Decode to JSON before domain
// validation, avoiding a second set of struct tags and different field names.
func decodeFile(path string, raw []byte, into any) error {
	if bytes.HasSuffix([]byte(path), []byte(".yaml")) {
		var value any
		d := yaml.NewDecoder(bytes.NewReader(raw))
		if err := d.Decode(&value); err != nil {
			return fileError(path, err)
		}
		var extra any
		if err := d.Decode(&extra); err != io.EOF {
			return fileError(path, i18n.Errorf("只能有一份 YAML 文件"))
		}
		var err error
		raw, err = json.Marshal(value)
		if err != nil {
			return fileError(path, err)
		}
	}
	if bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return fileError(path, i18n.Errorf("不能為 null"))
	}
	d := json.NewDecoder(bytes.NewReader(raw))
	d.DisallowUnknownFields()
	if err := d.Decode(into); err != nil {
		return fileError(path, err)
	}
	var extra any
	if err := d.Decode(&extra); err != io.EOF {
		return fileError(path, i18n.Errorf("只能有一個 JSON 物件"))
	}
	return nil
}

func assemble(files map[string][]byte) ([]byte, error) {
	if len(files) == 0 {
		return nil, nil
	}
	c := model.Settings{Version: 1, Preferences: model.DefaultPreferences(), Tutorial: model.NewWorld().Tutorial, Teams: map[string]model.TeamConfig{}, Replicas: map[string]model.ReplicaConfig{}, Providers: map[string]model.ProviderConfig{}, Blueprints: map[string]*model.Blueprint{}, Sources: map[string]*model.Source{}, Workflows: map[string]*model.Workflow{}}
	if files["provider.json"] == nil {
		return nil, fileError("provider.json", i18n.Errorf("設定檔遺失"))
	}
	for path, raw := range files {
		p := strings.Split(path, "/")
		switch {
		case path == "preferences.yaml":
			if err := decodeFile(path, raw, &c.Preferences); err != nil {
				return nil, err
			}
		case path == "tutorial.yaml":
			if err := decodeFile(path, raw, &c.Tutorial); err != nil {
				return nil, err
			}
		case path == "provider.json":
			if err := decodeFile(path, raw, &c.Providers); err != nil {
				return nil, err
			}
			for id, provider := range c.Providers {
				if !validID(id) || id != provider.ID {
					return nil, fileError(path, i18n.Errorf("供應商 id 不正確"))
				}
			}
		case path == "sources.yaml":
			if err := decodeFile(path, raw, &c.Sources); err != nil {
				return nil, err
			}
			for id, src := range c.Sources {
				if src == nil {
					return nil, fileError(path, i18n.Errorf("不能為 null"))
				}
				src.ID = id // the key is the id
			}
		case p[0] == "blueprints":
			var v model.Blueprint
			if err := decodeFile(path, raw, &v); err != nil {
				return nil, err
			}
			id := strings.TrimSuffix(p[1], ".yaml")
			v.ID = id // the file name is the id
			c.Blueprints[id] = &v
		case p[0] == "workflows":
			var v model.Workflow
			if err := decodeFile(path, raw, &v); err != nil {
				return nil, err
			}
			id := strings.TrimSuffix(p[1], ".yaml")
			v.ID = id // the file name is the id
			c.Workflows[id] = &v
		case len(p) == 3:
			var v model.TeamConfig
			if err := decodeFile(path, raw, &v); err != nil {
				return nil, err
			}
			v.ID = p[1] // the folder name is the id
			c.Teams[v.ID] = v
		case len(p) == 4:
			var v model.ReplicaConfig
			if err := decodeFile(path, raw, &v); err != nil {
				return nil, err
			}
			v.TeamID, v.ID = p[1], strings.TrimSuffix(p[3], ".json") // the path names both
			if _, exists := c.Replicas[v.ID]; exists {
				return nil, fileError(path, i18n.Errorf("員工 id 重複"))
			}
			c.Replicas[v.ID] = v
		}
	}
	return json.Marshal(c)
}

func splitSettings(raw []byte) (map[string][]byte, error) {
	var c model.Settings
	if err := json.Unmarshal(raw, &c); err != nil {
		return nil, err
	}
	files := map[string][]byte{}
	put := func(path string, value any) error {
		if !settingPath(path) {
			return fileError(path, i18n.Errorf("id 只能包含英文字母、數字、底線與連字號"))
		}
		raw, err := json.MarshalIndent(value, "", "  ")
		if err != nil {
			return err
		}
		// The path names these ids, so the file does not repeat them.
		var implied []string
		switch p := strings.Split(path, "/"); {
		case p[0] == "blueprints" || p[0] == "workflows" || len(p) == 3:
			implied = []string{"id"}
		case len(p) == 4:
			implied = []string{"id", "teamId"}
		}
		if strings.HasSuffix(path, ".yaml") || implied != nil {
			var v any
			if err := json.Unmarshal(raw, &v); err != nil {
				return err
			}
			if named, ok := v.(map[string]any); ok {
				for _, key := range implied {
					delete(named, key)
				}
			}
			if strings.HasSuffix(path, ".yaml") {
				raw, err = yaml.Marshal(v)
			} else {
				raw, err = json.MarshalIndent(v, "", "  ")
				raw = append(raw, '\n')
			}
			if err != nil {
				return err
			}
		} else {
			raw = append(raw, '\n')
		}
		if len(raw) > 16<<20 {
			return fileError(path, i18n.Errorf("不能超過 16 MB"))
		}
		files[path] = raw
		return nil
	}
	if err := put("preferences.yaml", c.Preferences); err != nil {
		return nil, err
	}
	c.Tutorial.Normalize()
	if err := put("tutorial.yaml", c.Tutorial); err != nil {
		return nil, err
	}
	if err := put("provider.json", c.Providers); err != nil {
		return nil, err
	}
	if len(c.Sources) > 0 {
		sources := map[string]map[string]any{}
		for id, v := range c.Sources {
			raw, err := json.Marshal(v)
			if err != nil {
				return nil, err
			}
			var named map[string]any
			if err := json.Unmarshal(raw, &named); err != nil {
				return nil, err
			}
			delete(named, "id") // the key names it
			sources[id] = named
		}
		if err := put("sources.yaml", sources); err != nil {
			return nil, err
		}
	}
	for id, v := range c.Teams {
		if err := put("company/"+id+"/config.yaml", v); err != nil {
			return nil, err
		}
	}
	for id, v := range c.Replicas {
		if err := put("company/"+v.TeamID+"/employee/"+id+".json", v); err != nil {
			return nil, err
		}
	}
	for id, v := range c.Blueprints {
		if err := put("blueprints/"+id+".yaml", v); err != nil {
			return nil, err
		}
	}
	for id, v := range c.Workflows {
		if err := put("workflows/"+id+".yaml", v); err != nil {
			return nil, err
		}
	}
	return files, nil
}

func (s *Store) CheckSettings(expected model.SettingsSnapshot) error {
	files, err := s.readFiles()
	if err != nil {
		return err
	}
	if len(files) != len(expected.Files) {
		return model.Errorf(model.CodeConflict, "設定檔已被外部修改，請先重新載入設定")
	}
	for path, raw := range files {
		if !bytes.Equal(raw, expected.Files[path]) {
			return model.Errorf(model.CodeConflict, "%s 已被外部修改，請先重新載入設定", path)
		}
	}
	return nil
}

func (s *Store) LoadSettings(ctx context.Context) (model.SettingsSnapshot, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	var snapshot model.SettingsSnapshot
	if err := s.recoverSettings(ctx); err != nil {
		return snapshot, err
	}
	files, err := s.readFiles()
	if err != nil {
		return snapshot, err
	}
	data, err := assemble(files)
	if err != nil {
		return snapshot, err
	}
	return model.SettingsSnapshot{Data: data, Files: files}, nil
}

func (s *Store) settingsWrite(change model.SettingsChange) (*settingsJournal, error) {
	after, err := splitSettings(change.After)
	if err != nil {
		return nil, err
	}
	before := change.Before.Files
	// Leave untouched files byte-for-byte unchanged, including YAML comments.
	for path, raw := range after {
		if old := before[path]; old != nil {
			var a, b any
			if decodeFile(path, old, &a) == nil && decodeFile(path, raw, &b) == nil && reflect.DeepEqual(a, b) {
				after[path] = old
			}
		}
	}
	a, err := json.Marshal(before)
	if err != nil {
		return nil, err
	}
	b, err := json.Marshal(after)
	if err != nil {
		return nil, err
	}
	return &settingsJournal{ID: 1, Before: a, After: b}, nil
}

func (s *Store) recoverSettings(ctx context.Context) error {
	var rows []settingsJournal
	if err := s.db.WithContext(ctx).Find(&rows).Error; err != nil {
		return err
	}
	if len(rows) == 0 {
		return nil
	}
	var before, after map[string][]byte
	if err := json.Unmarshal(rows[0].Before, &before); err != nil {
		return err
	}
	if err := json.Unmarshal(rows[0].After, &after); err != nil {
		return err
	}
	paths := map[string]bool{}
	for p := range before {
		paths[p] = true
	}
	for p := range after {
		paths[p] = true
	}
	var sorted []string
	for path := range paths {
		raw, err := s.readFile(path)
		if err != nil {
			return err
		}
		if !bytes.Equal(raw, before[path]) && !bytes.Equal(raw, after[path]) {
			return model.Errorf(model.CodeConflict, "%s 在未完成儲存後被修改；請保留手改副本並還原檔案，再重啟", path)
		}
		sorted = append(sorted, path)
	}
	sort.Strings(sorted)
	for _, path := range sorted {
		raw, err := s.readFile(path)
		if err != nil {
			return err
		}
		if bytes.Equal(raw, after[path]) {
			continue
		}
		if err := s.replaceFile(path, raw, after[path]); err != nil {
			return err
		}
	}
	return s.db.WithContext(ctx).Delete(&settingsJournal{}, 1).Error
}

func (s *Store) replaceFile(rel string, before, after []byte) error {
	path, err := s.safePath(rel)
	if err != nil {
		return err
	}
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	if _, err := s.safePath(rel); err != nil {
		return err
	}
	if after != nil {
		f, err := os.CreateTemp(dir, ".settings-*")
		if err != nil {
			return err
		}
		defer os.Remove(f.Name())
		defer f.Close()
		if _, err := f.Write(after); err != nil {
			return err
		}
		if err := f.Sync(); err != nil {
			return err
		}
		if err := f.Close(); err != nil {
			return err
		}
		raw, err := s.readFile(rel)
		if err != nil {
			return err
		}
		if !bytes.Equal(raw, before) {
			return model.Errorf(model.CodeConflict, "%s 已被外部修改", rel)
		}
		if err := os.Rename(f.Name(), path); err != nil {
			return err
		}
	} else {
		raw, err := s.readFile(rel)
		if err != nil {
			return err
		}
		if !bytes.Equal(raw, before) {
			return model.Errorf(model.CodeConflict, "%s 已被外部修改", rel)
		}
		if err := os.Remove(path); err != nil {
			return err
		}
	}
	d, err := os.Open(dir)
	if err != nil {
		return err
	}
	defer d.Close()
	return d.Sync()
}
