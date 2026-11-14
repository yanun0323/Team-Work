package model

// ProfileStats is the user's milestones on this island, for their own profile.
type ProfileStats struct {
	// Since is when the island first saw use, in Unix seconds; 0 when it has seen none.
	Since     float64 `json:"since"`
	TasksDone int     `json:"tasksDone"`
	Chats     int     `json:"chats"`
	// Messages counts what the user said in chats.
	Messages int `json:"messages"`
	// Partner is the employee the user has worked with most; nil when there is none yet.
	Partner *ProfilePartner `json:"partner,omitempty"`
	Usage   UsageTotals     `json:"usage"`
}

// ProfilePartner is an employee and how many chats and finished steps the user had with them.
type ProfilePartner struct {
	ID    string `json:"id"`
	Name  string `json:"name"`
	Look  Look   `json:"look"`
	Count int    `json:"count"`
}
