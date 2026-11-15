//go:build !darwin

package tools

import (
	"os"
	"strconv"
	"strings"
)

// groupBusy says whether process group pgid has a live process other than except, from /proc.
func groupBusy(pgid, except int) (bool, error) {
	entries, err := os.ReadDir("/proc")
	if err != nil {
		return false, err
	}
	for _, e := range entries {
		pid, err := strconv.Atoi(e.Name())
		if err != nil || pid == except {
			continue
		}
		b, err := os.ReadFile("/proc/" + e.Name() + "/stat")
		if err != nil {
			continue
		}
		// after the name in parentheses: state, ppid, pgrp
		s := string(b)
		fields := strings.Fields(s[strings.LastIndexByte(s, ')')+1:])
		if len(fields) > 2 && fields[2] == strconv.Itoa(pgid) && fields[0] != "Z" && fields[0] != "X" {
			return true, nil
		}
	}
	return false, nil
}
