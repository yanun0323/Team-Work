//go:build !darwin

package tools

import (
	"fmt"
	"os"
	"strconv"
)

// groupBusy says whether process group pgid has a live process other than except, from /proc. A process that went
// away while it was read is not in the group; anything else that cannot be read is an error, as it may be.
func groupBusy(pgid, except int) (bool, error) {
	entries, err := os.ReadDir("/proc")
	if err != nil {
		return false, err
	}
	group := strconv.Itoa(pgid)
	for _, e := range entries {
		pid, err := strconv.Atoi(e.Name())
		if err != nil || pid == except {
			continue
		}
		b, err := os.ReadFile("/proc/" + e.Name() + "/stat")
		if procGone(err) {
			continue
		}
		if err != nil {
			return false, err
		}
		state, pgrp, err := procStat(b)
		if err != nil {
			return false, fmt.Errorf("process %d: %w", pid, err)
		}
		if pgrp == group && state != "Z" && state != "X" {
			return true, nil
		}
	}
	return false, nil
}
