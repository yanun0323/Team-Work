package tools

import "golang.org/x/sys/unix"

// szomb is a process that ended and waits to be reaped.
const szomb = 5

// groupBusy says whether process group pgid has a live process other than except.
func groupBusy(pgid, except int) (bool, error) {
	procs, err := unix.SysctlKinfoProcSlice("kern.proc.pgrp", pgid)
	if err != nil {
		return false, err
	}
	for _, p := range procs {
		if int(p.Eproc.Pgid) == pgid && int(p.Proc.P_pid) != except && p.Proc.P_stat != szomb {
			return true, nil
		}
	}
	return false, nil
}
