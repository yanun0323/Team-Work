package repository

import (
	"bytes"
	"context"
	"errors"
	"os/exec"
	"runtime"
	"strings"

	"github.com/yanun0323/mho-company/internal/model"
)

// FolderPicker asks the system's file browser for a folder. A web page is never told where a picked folder is, so
// the backend, on the same computer, asks instead.
type FolderPicker struct {
	// Command runs the dialog; empty means the one for this system.
	Command []string
}

var finderDialog = []string{"osascript", "-e", "activate", "-e", `POSIX path of (choose folder with prompt "選擇專案資料夾")`}

// PickFolder waits for the user and gives the folder's full path, or "" when they cancelled.
func (p FolderPicker) PickFolder(ctx context.Context) (string, error) {
	command := p.Command
	if len(command) == 0 {
		if runtime.GOOS != "darwin" {
			return "", model.Errorf(model.CodeInvalid, "這個系統還不能用視窗選資料夾，請直接輸入路徑")
		}
		command = finderDialog
	}
	var stdout, stderr bytes.Buffer
	cmd := exec.CommandContext(ctx, command[0], command[1:]...)
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	if err := cmd.Run(); err != nil {
		if ctx.Err() != nil {
			return "", ctx.Err()
		}
		// -128 is how macOS reports the user pressing Cancel
		var exit *exec.ExitError
		if errors.As(err, &exit) && strings.Contains(stderr.String(), "-128") {
			return "", nil
		}
		return "", model.Errorf(model.CodeUnavailable, "打不開選擇資料夾的視窗，請直接輸入路徑")
	}
	path := strings.TrimRight(stdout.String(), "\r\n")
	if len(path) > 1 {
		path = strings.TrimRight(path, "/")
	}
	return path, nil
}
