package usecase

import "time"

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
