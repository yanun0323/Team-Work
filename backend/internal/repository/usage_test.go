package repository

import (
	"context"
	"testing"

	"github.com/yanun0323/Team-Work/internal/model"
)

func TestFirstUsageIsTheEarliestCall(t *testing.T) {
	ctx := context.Background()
	s, err := NewStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if first, err := s.FirstUsage(ctx); err != nil || first != 0 {
		t.Fatalf("no calls: %v, %v", first, err)
	}
	for _, at := range []float64{300, 100.5, 200} {
		if err := s.AddUsage(ctx, model.Usage{At: at, Model: "m"}); err != nil {
			t.Fatal(err)
		}
	}
	if first, err := s.FirstUsage(ctx); err != nil || first != 100.5 {
		t.Fatalf("first call %v, %v; want 100.5", first, err)
	}
}
