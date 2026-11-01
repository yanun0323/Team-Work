package repository

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"runtime"
	"slices"
	"strings"

	"github.com/yanun0323/mho-company/internal/i18n"
	"github.com/yanun0323/mho-company/internal/model"
)

// FolderPicker asks the system's file browser for a folder. A web page is never told where a picked folder is, so
// the backend, on the same computer, asks instead.
type FolderPicker struct {
	// Command runs the dialog; empty means the one for this system.
	Command []string
	// Opener shows a folder, given as its last argument; empty means the one for this system.
	Opener []string
}

func finderDialog() []string {
	return []string{"osascript", "-e", "activate", "-e", fmt.Sprintf(`POSIX path of (choose folder with prompt %q)`, i18n.T("選擇專案資料夾"))}
}

// OpenFolder shows a folder in Finder.
func (p FolderPicker) OpenFolder(ctx context.Context, path string) error {
	if info, err := os.Stat(path); err != nil || !info.IsDir() {
		return model.Errorf(model.CodeInvalid, "找不到資料夾 %s", path)
	}
	command := p.Opener
	if len(command) == 0 {
		if runtime.GOOS != "darwin" {
			return model.Errorf(model.CodeInvalid, "這個系統還不能打開資料夾")
		}
		command = []string{"open"}
	}
	if err := exec.CommandContext(ctx, command[0], append(slices.Clone(command[1:]), path)...).Run(); err != nil {
		return model.Errorf(model.CodeUnavailable, "打不開資料夾")
	}
	return nil
}

// PickFolder waits for the user and gives the folder's full path, or "" when they cancelled.
func (p FolderPicker) PickFolder(ctx context.Context) (string, error) {
	command := p.Command
	if len(command) == 0 {
		if runtime.GOOS != "darwin" {
			return "", model.Errorf(model.CodeInvalid, "這個系統還不能用視窗選資料夾，請直接輸入路徑")
		}
		command = finderDialog()
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
