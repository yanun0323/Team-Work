package model

// OrchestrationOwner marks a task its owner leads: the flow is the starting plan, and the owner dispatches each step,
// reviews each handoff and reports in the task's conversation. A task without it is an older one, run by the flow alone.
const OrchestrationOwner = "owner"

// Owner states: idle waits for an event; queued has events waiting for a decision; responding is deciding now;
// blocked stops for the user (BlockedReason says why); failed is a decision that failed after retries.
const (
	OwnerIdle       = "idle"
	OwnerQueued     = "queued"
	OwnerResponding = "responding"
	OwnerBlocked    = "blocked"
	OwnerFailed     = "failed"
)

// Coordination is an owner-led task's formal state, the part every client sees. The full conversation, every operation
// and the owner's pending events are kept apart and read by page.
type Coordination struct {
	// PlanVersion goes up with each change to the plan, instructions or staff; ControlVersion with each input from the
	// user that makes earlier decisions stale: a message, pause, resume, an answer or a new owner.
	PlanVersion    int               `json:"planVersion"`
	ControlVersion int               `json:"controlVersion"`
	StartedAt      *float64          `json:"startedAt,omitempty"`
	OwnerState     string            `json:"ownerState"`
	OwnerCostUSD   float64           `json:"ownerCostUsd"`
	OwnerTokens    int               `json:"ownerTokens"`
	History        ActivityHistory   `json:"history"`
	Authorization  TaskAuthorization `json:"authorization"`
	Facts          []TaskFact        `json:"facts"`
	Questions      []TaskQuestion    `json:"questions"`
	Operations     []TaskOperation   `json:"operations"`
	BlockedReason  string            `json:"blockedReason,omitempty"`
}

// ActivityHistory says what the task's conversation holds: Version changes whenever it does.
type ActivityHistory struct {
	Version string `json:"version"`
	Count   int    `json:"count"`
}

// TaskAuthorization is what the user allowed: who may work on the task, and whether its owner may change the plan.
type TaskAuthorization struct {
	ReplicaIDs  []string `json:"replicaIds"`
	PlanChanges bool     `json:"planChanges"`
}

// TaskFact is a constraint or decision that stays in force however long the conversation grows. A newer fact
// supersedes an older one instead of removing it.
type TaskFact struct {
	ID                string   `json:"id"`
	Kind              string   `json:"kind"` // constraint or decision
	Text              string   `json:"text"`
	SourceActivityIDs []string `json:"sourceActivityIds"`
	Supersedes        string   `json:"supersedes,omitempty"`
	At                float64  `json:"at"`
}

// TaskQuestion is a question waiting for an answer: the user's (audience user) or the owner's (an employee asking
// the owner). Only the user answers the user's.
type TaskQuestion struct {
	ID          string         `json:"id"`
	ActivityID  string         `json:"activityId"`
	Prompt      string         `json:"prompt"`
	Options     []ReviewOption `json:"options"`
	Kind        string         `json:"kind"`     // question, approval, budget or recovery
	Audience    string         `json:"audience"` // owner or user
	SubID       string         `json:"subId,omitempty"`
	PlanVersion int            `json:"planVersion"`
	CreatedAt   float64        `json:"createdAt"`
	Change      *PendingChange `json:"change,omitempty"`
	// ReplicaIDs is who an approval would add to the task's staff.
	ReplicaIDs []string `json:"replicaIds,omitempty"`
}

// Operation statuses. Received is saved; applied only once it took effect; uncertain when that cannot be known.
const (
	OpReceived   = "received"
	OpProcessing = "processing"
	OpApplied    = "applied"
	OpFailed     = "failed"
	OpUncertain  = "uncertain"
)

// TaskOperation is something asked of an owner-led task and how far it got.
type TaskOperation struct {
	ID             string          `json:"id"`
	RequestID      string          `json:"requestId,omitempty"`
	Kind           string          `json:"kind"` // message, pause, resume, return, answer, retry, dispatch, stop, plan or complete
	Status         string          `json:"status"`
	At             float64         `json:"at"`
	UpdatedAt      float64         `json:"updatedAt"`
	MessageID      string          `json:"messageId,omitempty"`
	SubID          string          `json:"subId,omitempty"`
	AffectedSubIDs []string        `json:"affectedSubIds,omitempty"`
	Error          *OperationError `json:"error,omitempty"`
}

type OperationError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

// TaskActivity is one entry of an owner-led task's conversation: a message, a handoff, a question, a short event or a
// meeting's words. Name keeps who said it, for when they have left.
type TaskActivity struct {
	ID          string         `json:"id"`
	Seq         int            `json:"seq"`
	At          float64        `json:"at"`
	Kind        string         `json:"kind"` // message, handoff, question, event or meeting
	From        string         `json:"from"` // user, agent or system
	Text        string         `json:"text"`
	By          string         `json:"by,omitempty"`
	Name        string         `json:"name,omitempty"`
	SubID       string         `json:"subId,omitempty"`
	NodeID      string         `json:"nodeId,omitempty"`
	MeetingID   string         `json:"meetingId,omitempty"`
	OperationID string         `json:"operationId,omitempty"`
	QuestionID  string         `json:"questionId,omitempty"`
	PlanVersion int            `json:"planVersion"`
	Key         string         `json:"key,omitempty"`
	Args        map[string]any `json:"args,omitempty"`
	Images      []Attachment   `json:"images,omitempty"`
	Files       []Attachment   `json:"files,omitempty"`
}

// What an owner-led step's run is doing, and whether its result still counts.
const (
	ExecQueued    = "queued"
	ExecRunning   = "running"
	ExecStopping  = "stopping"
	ExecStopped   = "stopped"
	ExecUncertain = "uncertain"

	ReviewPending  = "pending"
	ReviewAccepted = "accepted"
	ReviewRejected = "rejected"

	ValidCurrent           = "current"
	ValidNeedsRevalidation = "needsRevalidation"
	ValidSuperseded        = "superseded"
)

// OwnerLed says whether the task is one its owner leads.
func (t *Task) OwnerLed() bool { return t.Orchestration == OrchestrationOwner && t.Coordination != nil }
