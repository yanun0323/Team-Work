package model

// Meeting states. A meeting of an owner-led task is held in its conversation, chaired by the task's owner.
const (
	MeetingOpen          = "open"
	MeetingPaused        = "paused"
	MeetingClosing       = "closing"
	MeetingSummaryFailed = "summaryFailed"
	MeetingEnded         = "ended"
	MeetingCancelled     = "cancelled"
)

// Meeting is a meeting held in an owner-led task's conversation (Version 2). Batch and CallsInBatch count its model
// calls in batches the user allows one at a time; Revision goes up with every saved change.
type Meeting struct {
	Version          int                  `json:"version"`
	ID               string               `json:"id"`
	Topic            string               `json:"topic"`
	ChairID          string               `json:"chairId"`
	Participants     []MeetingParticipant `json:"participants"`
	State            string               `json:"state"`
	Revision         int                  `json:"revision"`
	Batch            int                  `json:"batch"`
	CallsInBatch     int                  `json:"callsInBatch"`
	CallsTotal       int                  `json:"callsTotal"`
	StartedAt        float64              `json:"startedAt"`
	EndedAt          *float64             `json:"endedAt,omitempty"`
	SpeakerID        string               `json:"speakerId,omitempty"`
	PauseReason      string               `json:"pauseReason,omitempty"`
	ClosingRequested bool                 `json:"closingRequested,omitempty"`
	Summary          string               `json:"summary,omitempty"`
	SummaryActivity  string               `json:"summaryActivityId,omitempty"`
	Error            *OperationError      `json:"error,omitempty"`
}

// MeetingParticipant is who is in a meeting as they were when it opened: the chair first.
type MeetingParticipant struct {
	ReplicaID string `json:"replicaId"`
	Name      string `json:"name"`
	Look      Look   `json:"look"`
	Model     string `json:"model"`
	Effort    string `json:"effort,omitempty"`
}

// Has says whether an employee is in the meeting.
func (m *Meeting) Has(id string) bool {
	for _, p := range m.Participants {
		if p.ReplicaID == id {
			return true
		}
	}
	return false
}

// Over says whether the meeting can no longer go on.
func (m *Meeting) Over() bool { return m.State == MeetingEnded || m.State == MeetingCancelled }
