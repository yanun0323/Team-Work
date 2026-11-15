package usecase

import "time"

// SetStopWait shortens how long a stopped run may take to end before it is called uncertain, for a test.
func SetStopWait(d time.Duration) func() {
	old := stopWait
	stopWait = d
	return func() { stopWait = old }
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
	e.remember("", &replicaID, scopeMine, text, "test", "")
	e.settle()
}

// RememberFor gives company teamID a note written by replicaID from outside any run, for a test.
func (e *Engine) RememberFor(teamID, replicaID, text string) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.remember(teamID, &replicaID, scopeCompany, text, "test", "")
	e.settle()
}
