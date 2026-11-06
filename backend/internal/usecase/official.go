package usecase

import "github.com/yanun0323/Team-Work/internal/model"

// The official source: the employee and task blueprints the app offers, kept in a repo of their own so they can
// change between versions of the app. Every world has it, by the same id, so the blueprints it brings have the same
// ids everywhere. The app has no copy of it: it is downloaded like any other source, at the first check after start.
const (
	OfficialSourceID = "team-work"
	officialRepo     = "https://github.com/yanun0323/Team-Work-Source"
)

// ensureOfficial keeps the official source among sources, with no version yet and applying its updates by itself,
// unless it is there already.
func ensureOfficial(sources map[string]*model.Source) {
	if sources[OfficialSourceID] != nil {
		return
	}
	sources[OfficialSourceID] = &model.Source{ID: OfficialSourceID, Kind: "git", Repo: officialRepo, Upstream: true, AutoApply: true}
}
