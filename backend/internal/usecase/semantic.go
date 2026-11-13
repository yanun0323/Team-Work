package usecase

import (
	"github.com/yanun0323/Team-Work/internal/semantic"
)

// StartSemantic starts the experimental semantic search when the saved setting has it on and this Mac can run it,
// indexing every company's folder; otherwise it only logs why not. Call it once, after the engine is up.
func (e *Engine) StartSemantic() {
	e.mu.Lock()
	enabled := e.w.Preferences.SemanticSearch
	var roots []string
	for _, t := range e.w.Teams {
		if t.Folder != "" {
			roots = append(roots, t.Folder)
		}
	}
	e.mu.Unlock()
	e.semantic.Start(enabled, roots)
}

// SemanticStatus is what the settings page shows about semantic search; reading it starts nothing.
func (e *Engine) SemanticStatus() semantic.Status {
	e.mu.Lock()
	enabled := e.w.Preferences.SemanticSearch
	e.mu.Unlock()
	return e.semantic.Status(enabled)
}

// replicaOf is who a run is, for logs; "" when unknown.
func replicaOf(r *run) string {
	if r == nil {
		return ""
	}
	return r.replicaID
}
