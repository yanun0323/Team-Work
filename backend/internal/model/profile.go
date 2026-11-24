package model

// ProfileStats is the user's milestones on this island, for their own profile.
type ProfileStats struct {
	// Since is when the island first saw use, in Unix seconds; 0 when it has seen none.
	Since     float64 `json:"since"`
	TasksDone int     `json:"tasksDone"`
	Chats     int     `json:"chats"`
	// Messages counts what the user said in chats.
	Messages int `json:"messages"`
	// Partners are the employees the user has worked with most, most first, at most MaxProfilePartners.
	Partners []ProfilePartner `json:"partners"`
	Usage    UsageTotals      `json:"usage"`
	// Landmarks are how far each of the island's landmarks has got along its road, one per kind.
	Landmarks []LandmarkRoad `json:"landmarks"`
}

// LandmarkRoad is a landmark's road: the milestones that grow it, and how far the user has got along them.
type LandmarkRoad struct {
	Kind string `json:"kind"`
	// Stage is the stage the landmark has reached, 0 before it appears.
	Stage int `json:"stage"`
	// Value is the count its milestones go by now, such as tasks finished.
	Value int `json:"value"`
	// Steps are the counts that grow each stage, in order.
	Steps []int `json:"steps"`
}

// MaxProfilePartners is how many employees the profile lists as worked with most.
const MaxProfilePartners = 5

// ProfilePartner is an employee and how many chats and finished steps the user had with them.
type ProfilePartner struct {
	ID    string `json:"id"`
	Name  string `json:"name"`
	Look  Look   `json:"look"`
	Count int    `json:"count"`
}
