package repository

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"gorm.io/gorm"
)

// migrateCompanyFolders moves teams/<id>/replicas/ to company/<id>/employee/.
// Each rename is safe to repeat, so an interrupted run finishes on the next start.
func migrateCompanyFolders(dataDir string, db *gorm.DB) error {
	oldRoot, newRoot := filepath.Join(dataDir, "teams"), filepath.Join(dataDir, "company")
	if info, err := os.Lstat(oldRoot); err == nil && info.IsDir() {
		if _, err := os.Lstat(newRoot); err == nil {
			return fmt.Errorf("both %s and %s exist; merge them by hand and remove teams", oldRoot, newRoot)
		}
		entries, err := os.ReadDir(oldRoot)
		if err != nil {
			return err
		}
		for _, entry := range entries {
			if !entry.IsDir() {
				continue
			}
			from, to := filepath.Join(oldRoot, entry.Name(), "replicas"), filepath.Join(oldRoot, entry.Name(), "employee")
			if _, err := os.Lstat(from); errors.Is(err, os.ErrNotExist) {
				continue
			}
			if _, err := os.Lstat(to); err == nil {
				return fmt.Errorf("both %s and %s exist; merge them by hand", from, to)
			}
			if err := os.Rename(from, to); err != nil {
				return err
			}
		}
		if err := os.Rename(oldRoot, newRoot); err != nil {
			return err
		}
	} else if err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return migrateJournalPaths(db)
}

// migrateJournalPaths renames the paths an unfinished settings batch refers to.
func migrateJournalPaths(db *gorm.DB) error {
	var rows []settingsJournal
	if err := db.Find(&rows).Error; err != nil {
		return err
	}
	for _, row := range rows {
		before, changedBefore, err := renameJournalPaths(row.Before)
		if err != nil {
			return err
		}
		after, changedAfter, err := renameJournalPaths(row.After)
		if err != nil {
			return err
		}
		if !changedBefore && !changedAfter {
			continue
		}
		if err := db.Save(&settingsJournal{ID: row.ID, Before: before, After: after}).Error; err != nil {
			return err
		}
	}
	return nil
}

func renameJournalPaths(raw []byte) ([]byte, bool, error) {
	var files map[string][]byte
	if err := json.Unmarshal(raw, &files); err != nil {
		return nil, false, err
	}
	out, changed := map[string][]byte{}, false
	for path, content := range files {
		if p := strings.Split(path, "/"); p[0] == "teams" {
			p[0], changed = "company", true
			if len(p) == 4 && p[2] == "replicas" {
				p[2] = "employee"
			}
			path = strings.Join(p, "/")
		}
		out[path] = content
	}
	if !changed {
		return raw, false, nil
	}
	raw, err := json.Marshal(out)
	return raw, true, err
}
