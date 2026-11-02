package model

import (
	"fmt"
	"regexp"
	"slices"
)

// Tutorial is how far the user has come through the tutorial, kept in tutorial.yaml. Which steps there are and
// when each is met is the client's business; the backend only keeps the lists. Every list only grows, so two
// windows adding to it at once cannot undo each other.
type Tutorial struct {
	// Seeded is set once the steps already met when the tutorial first ran have been put down as done, quietly.
	Seeded bool `json:"seeded"`
	Hidden bool `json:"hidden"`
	// Done are the steps met; Shown, the steps the user has seen appear; Played, the done steps whose tick has played.
	Done   []string `json:"done"`
	Shown  []string `json:"shown"`
	Played []string `json:"played"`
	// Actions are things the user did that leave nothing behind in the world to show for them.
	Actions []string `json:"actions"`
	// Copies are flows copied and not saved since, so that saving one counts as changing a copy.
	Copies []string `json:"copies"`
}

// TutorialPatch adds to a tutorial's lists and, when given, sets its flags. Reset first empties it, to start over.
type TutorialPatch struct {
	Reset   bool     `json:"reset"`
	Seeded  *bool    `json:"seeded"`
	Hidden  *bool    `json:"hidden"`
	Done    []string `json:"done"`
	Shown   []string `json:"shown"`
	Played  []string `json:"played"`
	Actions []string `json:"actions"`
}

var tutorialID = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9]{0,39}$`)

// maxTutorialItems bounds each list; the client has a few dozen steps.
const maxTutorialItems = 200

// CheckTutorial refuses names the client could not have meant and lists that keep growing.
func CheckTutorial(t Tutorial) error {
	for name, list := range map[string][]string{"done": t.Done, "shown": t.Shown, "played": t.Played, "actions": t.Actions} {
		if len(list) > maxTutorialItems {
			return fmt.Errorf("%s: too many items", name)
		}
		for _, id := range list {
			if !tutorialID.MatchString(id) {
				return fmt.Errorf("%s: invalid item %q", name, id)
			}
		}
	}
	if len(t.Copies) > maxTutorialItems {
		return fmt.Errorf("copies: too many items")
	}
	return nil
}

func addNew(list []string, items ...string) []string {
	for _, id := range items {
		if !slices.Contains(list, id) {
			list = append(list, id)
		}
	}
	return list
}

// Apply adds the patch; the result is checked before anything changes.
func (t *Tutorial) Apply(p TutorialPatch) error {
	next := *t
	if p.Reset {
		next = Tutorial{Copies: t.Copies}
	}
	next.Done = addNew(slices.Clone(next.Done), p.Done...)
	next.Shown = addNew(slices.Clone(next.Shown), p.Shown...)
	next.Played = addNew(slices.Clone(next.Played), p.Played...)
	next.Actions = addNew(slices.Clone(next.Actions), p.Actions...)
	if p.Seeded != nil {
		next.Seeded = *p.Seeded
	}
	if p.Hidden != nil {
		next.Hidden = *p.Hidden
	}
	if err := CheckTutorial(next); err != nil {
		return err
	}
	next.Normalize()
	*t = next
	return nil
}

// Learn records an action; it says whether it is new.
func (t *Tutorial) Learn(action string) bool {
	if slices.Contains(t.Actions, action) {
		return false
	}
	t.Actions = append(t.Actions, action)
	return true
}

// Copied remembers a copied flow until it is saved; ChangedCopy says whether a saved flow was one, and forgets it.
func (t *Tutorial) Copied(id string) {
	t.Copies = addNew(t.Copies, id)
	if len(t.Copies) > maxTutorialItems {
		t.Copies = t.Copies[len(t.Copies)-maxTutorialItems:]
	}
}

func (t *Tutorial) ChangedCopy(id string) bool {
	i := slices.Index(t.Copies, id)
	if i < 0 {
		return false
	}
	t.Copies = slices.Delete(t.Copies, i, i+1)
	return true
}

// Lists are never null on the wire or in the file.
func (t *Tutorial) Normalize() {
	for _, list := range []*[]string{&t.Done, &t.Shown, &t.Played, &t.Actions, &t.Copies} {
		if *list == nil {
			*list = []string{}
		}
	}
}
