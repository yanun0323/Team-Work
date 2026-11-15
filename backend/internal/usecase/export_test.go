package usecase

import (
	"slices"
	"time"

	"github.com/yanun0323/Team-Work/internal/model"
)

// SetStopWait shortens how long a stopped run may take to end before it is called uncertain, for a test.
func SetStopWait(d time.Duration) func() {
	old := stopWait
	stopWait = d
	return func() { stopWait = old }
}

// SetReturnWait shortens how long a send-back waits for the runs built on it before the user is asked, for a test.
func SetReturnWait(d time.Duration) func() {
	old := returnWait
	returnWait = d
	return func() { returnWait = old }
}

// Remember gives an employee a note from outside any run, for a test.
func (e *Engine) Remember(replicaID, text string) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.remember(&replicaID, text, "test", "")
	e.settle()
}

// Conversation is what the model was told and said in a run, a chat or an owner's decisions, for a test.
func (e *Engine) Conversation(id string) []model.Message {
	e.mu.Lock()
	defer e.mu.Unlock()
	if err := e.loadConversation(id); err != nil {
		return nil
	}
	return slices.Clone(e.w.Conversations[id])
}

// OwnerConversation is the conversation of a task's owner, for a test.
func (e *Engine) OwnerConversation(taskID string) []model.Message {
	return e.Conversation(ownerKey(taskID))
}
