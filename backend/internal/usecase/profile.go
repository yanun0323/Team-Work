package usecase

import (
	"context"

	"github.com/yanun0323/Team-Work/internal/model"
	"github.com/yanun0323/Team-Work/internal/model/enum"
)

// ProfileStats sums the user's milestones on this island: since when it was used, tasks finished, chats and what
// the user said in them, the employee worked with most, and every model call's usage.
func (e *Engine) ProfileStats(ctx context.Context) (model.ProfileStats, error) {
	records, err := e.store.LoadUsage(ctx, 0)
	if err != nil {
		return model.ProfileStats{}, err
	}
	var out model.ProfileStats
	seen := func(at float64) {
		if at > 0 && (out.Since == 0 || at < out.Since) {
			out.Since = at
		}
	}
	for _, u := range records {
		out.Usage.Add(u)
	}
	if len(records) > 0 {
		seen(records[0].At)
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	together := map[string]int{}
	for _, t := range e.w.Tasks {
		seen(t.CreatedAt)
		if t.Stage == enum.StageDone {
			out.TasksDone++
		}
	}
	for _, s := range e.w.SubTasks {
		if s.ReplicaID != nil && s.Status == enum.StatusComplete && !s.Skipped && !s.Cancelled {
			together[*s.ReplicaID]++
		}
	}
	for _, c := range e.w.Chats {
		out.Chats++
		together[c.ReplicaID]++
		for _, m := range c.Messages {
			seen(m.At)
			if m.From == "user" {
				out.Messages++
			}
		}
	}
	for id, n := range together {
		r := e.w.Replicas[id]
		if r == nil {
			continue
		}
		if p := out.Partner; p == nil || n > p.Count || n == p.Count && (r.Name < p.Name || r.Name == p.Name && id < p.ID) {
			out.Partner = &model.ProfilePartner{ID: id, Name: r.Name, Look: r.Look, Count: n}
		}
	}
	return out, nil
}
