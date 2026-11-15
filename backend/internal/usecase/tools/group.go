package tools

import (
	"errors"
	"io/fs"
	"strings"
	"syscall"
)

// procStat reads a process's state and process group from what /proc/<pid>/stat holds. Its name, in parentheses,
// may hold anything, parentheses and spaces too, so the fields are read after the last ")".
func procStat(b []byte) (state, pgrp string, err error) {
	s := string(b)
	i := strings.LastIndexByte(s, ')')
	if i < 0 || !strings.Contains(s[:i], "(") {
		return "", "", errors.New("no process name in /proc stat")
	}
	// after the name: state, ppid, pgrp
	fields := strings.Fields(s[i+1:])
	if len(fields) < 3 {
		return "", "", errors.New("too few fields in /proc stat")
	}
	return fields[0], fields[2], nil
}

// procGone says a failure to read a process's /proc entry means the process is gone; any other failure says
// nothing about it.
func procGone(err error) bool {
	return errors.Is(err, fs.ErrNotExist) || errors.Is(err, syscall.ESRCH)
}
