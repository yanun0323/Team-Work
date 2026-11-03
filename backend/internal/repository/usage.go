package repository

import (
	"context"

	"github.com/yanun0323/Team-Work/internal/model"
)

// usageRow is one model call. Rows are only ever added, so they live apart from the documents.
type usageRow struct {
	ID           uint64  `gorm:"primaryKey;autoIncrement"`
	At           float64 `gorm:"index"`
	ProviderID   string
	ProviderName string
	Model        string
	Input        int
	Output       int
	CacheRead    int
	CostUSD      float64
	Priced       bool
}

func (usageRow) TableName() string { return "usage" }

func (s *Store) AddUsage(ctx context.Context, u model.Usage) error {
	return s.db.WithContext(ctx).Create(&usageRow{At: u.At, ProviderID: u.ProviderID, ProviderName: u.ProviderName, Model: u.Model,
		Input: u.Input, Output: u.Output, CacheRead: u.CacheRead, CostUSD: u.CostUSD, Priced: u.Priced}).Error
}

func (s *Store) LoadUsage(ctx context.Context, since float64) ([]model.Usage, error) {
	var rows []usageRow
	if err := s.db.WithContext(ctx).Where("at >= ?", since).Order("at").Find(&rows).Error; err != nil {
		return nil, err
	}
	out := make([]model.Usage, len(rows))
	for i, r := range rows {
		out[i] = model.Usage{At: r.At, ProviderID: r.ProviderID, ProviderName: r.ProviderName, Model: r.Model,
			Input: r.Input, Output: r.Output, CacheRead: r.CacheRead, CostUSD: r.CostUSD, Priced: r.Priced}
	}
	return out, nil
}
