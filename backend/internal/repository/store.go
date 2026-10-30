// Package repository keeps the backend's data on disk and works with Git repos.
package repository

import (
	"context"
	"fmt"
	"os"
	"path/filepath"

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
type Store struct{ db *gorm.DB }

func NewStore(dataDir string) (*Store, error) {
	if err := os.MkdirAll(dataDir, 0o700); err != nil {
		return nil, fmt.Errorf("create data folder: %w", err)
	}
	path := filepath.Join(dataDir, "company.db")
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
	if err := db.AutoMigrate(&docRow{}, &secretRow{}); err != nil {
		return nil, fmt.Errorf("migrate database: %w", err)
	}
	return &Store{db: db}, nil
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

func (s *Store) Apply(ctx context.Context, upserts, deletes []model.Doc) error {
	if len(upserts)+len(deletes) == 0 {
		return nil
	}
	return s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
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
		return nil
	})
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
