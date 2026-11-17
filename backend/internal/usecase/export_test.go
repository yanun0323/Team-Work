package usecase

import (
	"context"
	"encoding/json"
	"slices"
	"sync/atomic"
	"time"

	"github.com/yanun0323/Team-Work/internal/model"
	"github.com/yanun0323/Team-Work/internal/model/enum"
	"github.com/yanun0323/Team-Work/internal/semantic"
)

// SetStopWait shortens how long a stopped run may take to end before it is called uncertain, for a test.
func SetStopWait(d time.Duration) func() {
	old := stopWait
	stopWait = d
	return func() { stopWait = old }
}

// SetJobsCleaned has f hear each step run's background commands stopped, before the run is said to have ended; f
// may hold it there. Set it before any run starts.
func (e *Engine) SetJobsCleaned(f func(scope string)) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.jobsCleaned = f
}

// FailJobLookups has no background command's process group be looked up while failing is set, and End and Close
// wait endWait for what they stop, for a test. Call it before any command starts.
func (e *Engine) FailJobLookups(failing *atomic.Bool, endWait time.Duration) {
	e.jobs.FailLookups(failing, endWait)
}

// JobsRunning is the ids of the background commands still known to run, in every scope starting with prefix.
func (e *Engine) JobsRunning(prefix string) []string { return e.jobs.RunningUnder(prefix) }

// OutputRoot is where the command output of a run or chat is kept.
func (e *Engine) OutputRoot(id string) string { return e.outputRoot(id) }

// ForgetModelsAsked has every provider be taken as asked for its models long ago, for a test.
func (e *Engine) ForgetModelsAsked() {
	e.mu.Lock()
	defer e.mu.Unlock()
	clear(e.modelsAt)
}

// SetRetryDelay shortens the wait before a passing model failure is tried again, for all the tests at once: call it
// from TestMain, before any test runs.
func SetRetryDelay(d time.Duration) { retryDelay = d }

// SetReturnWait shortens how long a send-back waits for the runs built on it before the user is asked, for a test.
func SetReturnWait(d time.Duration) func() {
	old := returnWait
	returnWait = d
	return func() { returnWait = old }
}

// Remember gives an employee a note of their own from outside any run, for a test.
func (e *Engine) Remember(replicaID, text string) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.remember("", &replicaID, scopeMine, text, "test", "", "")
	e.settle()
}

// RememberFor gives company teamID a note written by replicaID from outside any run, for a test.
func (e *Engine) RememberFor(teamID, replicaID, text string) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.remember(teamID, &replicaID, scopeCompany, text, "test", "", "")
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

// SetRankNotes puts a stand-in for the model's ranking of memory notes, for a test.
func (e *Engine) SetRankNotes(f func(ctx context.Context, query string, notes []semantic.Note) ([]string, bool)) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.rankNotes = f
}

// SearchMemory is search_memory as replicaID calls it in company teamID, for a test.
func (e *Engine) SearchMemory(teamID, replicaID, query string) model.ToolResult {
	raw, _ := json.Marshal(map[string]string{"query": query})
	return e.searchMemoryTool(func() (string, *string) { return teamID, &replicaID }).Run(context.Background(), "", raw)
}

// RenameWaitingCall renames the tool call a chat's conversation last made, as a conversation saved before the tool
// was renamed has it.
func (e *Engine) RenameWaitingCall(chatID, name string) {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.loadConversation(chatID) != nil {
		return
	}
	conv := e.w.Conversations[chatID]
	for i := len(conv) - 1; i >= 0; i-- {
		for j, b := range conv[i].Content {
			if b.Type == enum.BlockToolCall {
				conv[i].Content[j].Name = name
				e.dirty[chatID] = true
				return
			}
		}
	}
}
