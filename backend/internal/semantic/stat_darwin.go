package semantic

import "syscall"

func statOf(path string) (stamp, bool) {
	var st syscall.Stat_t
	if err := syscall.Lstat(path, &st); err != nil {
		return stamp{}, false
	}
	return stamp{size: st.Size, mtime: st.Mtimespec.Nano(), ctime: st.Ctimespec.Nano(), ino: int64(st.Ino)}, true
}
