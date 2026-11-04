package usecase

import "testing"

// A typical step finishes in about 14 model calls, and long ones run past 100,
// so the bar must not reach 90% after a few dozen calls.
func TestStepProgressPacing(t *testing.T) {
	if p := stepProgress(14); p < 0.45 || p > 0.55 {
		t.Errorf("stepProgress(14) = %.2f, want about half", p)
	}
	if p := stepProgress(36); p > 0.75 {
		t.Errorf("stepProgress(36) = %.2f, want at most 0.75", p)
	}
	if p := stepProgress(10000); p != 0.95 {
		t.Errorf("stepProgress(10000) = %.2f, want capped at 0.95", p)
	}
	for c := 1; c < 200; c++ {
		if stepProgress(c+1) < stepProgress(c) {
			t.Fatalf("stepProgress went down at %d calls", c+1)
		}
	}
}
