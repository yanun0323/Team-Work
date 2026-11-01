// Package repository keeps the backend's data on disk and works with Git repos.
package repository

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sync"

	"github.com/glebarez/sqlite"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
	"gorm.io/gorm/logger"

	"github.com/yanun0323/mho-company/internal/model"
)

type docRow struct {
	Kind string `gorm:"primaryKey"`
	ID   string `gorm:"primaryKey"`
	Data []byte
}

func (docRow) TableName() string { return "documents" }

type secretRow struct {
	ID    string `gorm:"primaryKey"`
	Value string
}

func (secretRow) TableName() string { return "secrets" }

// Store is SQLite through gorm. The file holds API keys, so only its owner may read it.
type Store struct {
	db      *gorm.DB
	dataDir string
	mu      sync.Mutex
}

func NewStore(dataDir string) (*Store, error) {
	if err := os.MkdirAll(dataDir, 0o700); err != nil {
		return nil, fmt.Errorf("create data folder: %w", err)
	}
	path := filepath.Join(dataDir, "data.db")
	// created here, so the database never exists with wider permissions
	f, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, fmt.Errorf("create database: %w", err)
	}
	_ = f.Close()
	if err := os.Chmod(path, 0o600); err != nil {
		return nil, fmt.Errorf("protect database: %w", err)
	}
	db, err := gorm.Open(sqlite.Open(path+"?_pragma=journal_mode(WAL)&_pragma=busy_timeout(5000)"), &gorm.Config{Logger: logger.Discard})
	if err != nil {
		return nil, fmt.Errorf("open database: %w", err)
	}
	for _, table := range []any{&docRow{}, &secretRow{}, &settingsJournal{}} {
		if !db.Migrator().HasTable(table) {
			if err := db.Migrator().CreateTable(table); err != nil {
				return nil, fmt.Errorf("create database table: %w", err)
			}
		}
	}
	return &Store{db: db, dataDir: dataDir}, nil
}

func (s *Store) Close() error {
	raw, err := s.db.DB()
	if err != nil {
		return err
	}
	return raw.Close()
}

func (s *Store) LoadDocs(ctx context.Context) ([]model.Doc, error) {
	var rows []docRow
	if err := s.db.WithContext(ctx).Find(&rows).Error; err != nil {
		return nil, err
	}
	out := make([]model.Doc, len(rows))
	for i, r := range rows {
		out[i] = model.Doc{Kind: r.Kind, ID: r.ID, Data: r.Data}
	}
	return out, nil
}

func (s *Store) Apply(ctx context.Context, upserts, deletes []model.Doc, settings ...model.SettingsChange) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.recoverSettings(ctx); err != nil {
		return err
	}
	if len(settings) > 1 {
		return model.Errorf(model.CodeInvalid, "一次只能寫入一份設定")
	}
	if len(settings) > 0 {

		if err := s.CheckSettings(settings[0].Before); err != nil {
			return err
		}
	}
	if len(upserts)+len(deletes)+len(settings) == 0 {
		return nil
	}
	var written model.SettingsSnapshot
	err := s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		for _, d := range upserts {
			row := docRow{Kind: d.Kind, ID: d.ID, Data: d.Data}
			if err := tx.Clauses(clause.OnConflict{UpdateAll: true}).Create(&row).Error; err != nil {
				return err
			}
		}
		for _, d := range deletes {
			if err := tx.Delete(&docRow{}, "kind = ? AND id = ?", d.Kind, d.ID).Error; err != nil {
				return err
			}
		}
		if len(settings) > 0 {
			change := settings[0]
			journal, err := s.settingsWrite(change)
			if err != nil {
				return err
			}
			written.Data = change.After
			if err := json.Unmarshal(journal.After, &written.Files); err != nil {
				return err
			}
			if err := s.CheckSettings(change.Before); err != nil {
				return err
			}
			return tx.Clauses(clause.OnConflict{UpdateAll: true}).Create(journal).Error
		}
		return nil
	})
	if err != nil {
		return err
	}
	if err := s.recoverSettings(ctx); err != nil {
		return &model.SettingsPending{Err: err}
	}
	if len(settings) > 0 && settings[0].Written != nil {
		*settings[0].Written = written
	}
	return nil
}

func (s *Store) LoadSecrets(ctx context.Context) (map[string]string, error) {
	var rows []secretRow
	if err := s.db.WithContext(ctx).Find(&rows).Error; err != nil {
		return nil, err
	}
	out := make(map[string]string, len(rows))
	for _, r := range rows {
		out[r.ID] = r.Value
	}
	return out, nil
}

func (s *Store) Secret(ctx context.Context, id string) (string, error) {
	var rows []secretRow
	if err := s.db.WithContext(ctx).Find(&rows, "id = ?", id).Error; err != nil {
		return "", err
	}
	if len(rows) == 0 {
		return "", nil
	}
	return rows[0].Value, nil
}

func (s *Store) SetSecret(ctx context.Context, id, value string) error {
	return s.db.WithContext(ctx).Clauses(clause.OnConflict{UpdateAll: true}).Create(&secretRow{ID: id, Value: value}).Error
}

func (s *Store) DeleteSecret(ctx context.Context, id string) error {
	return s.db.WithContext(ctx).Delete(&secretRow{}, "id = ?", id).Error
}
