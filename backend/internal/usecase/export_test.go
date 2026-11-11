package usecase

import "time"

// SetStopWait shortens how long a stopped run may take to end before it is called uncertain, for a test.
func SetStopWait(d time.Duration) func() {
	old := stopWait
	stopWait = d
	return func() { stopWait = old }
}
