package delivery

import (
	"encoding/json"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

// openTerminal starts a company in a new folder and a shell in it. The shell reads an empty zsh config, not
// the config of whoever runs the test, except for the marker that proves the config is loaded.
func openTerminal(t *testing.T, base string) (*websocket.Conn, string) {
	t.Helper()
	if _, err := exec.LookPath("zsh"); err != nil {
		t.Skip("no zsh")
	}
	dotdir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dotdir, ".zshrc"), []byte("PROMPT='$ '\nzshrc_loaded=yes\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("ZDOTDIR", dotdir)
	folder, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := json.Marshal(folder)
	code, team := send(t, "POST", base+"/api/v1/teams", `{"name":"公司","folder":`+string(raw)+`}`)
	if code != http.StatusCreated {
		t.Fatal(code, team)
	}
	url := "ws" + strings.TrimPrefix(base, "http") + "/api/v1/teams/" + team["id"].(string) + "/terminal?cols=91&rows=37"
	conn, _, err := websocket.DefaultDialer.Dial(url, http.Header{"Origin": {origin}})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { conn.Close() })
	return conn, folder
}

func typeIn(t *testing.T, conn *websocket.Conn, line string) {
	t.Helper()
	if err := conn.WriteMessage(websocket.BinaryMessage, []byte(line+"\n")); err != nil {
		t.Fatal(err)
	}
}

// readUntil collects the screen output until it holds want.
func readUntil(t *testing.T, conn *websocket.Conn, want string) string {
	t.Helper()
	conn.SetReadDeadline(time.Now().Add(10 * time.Second))
	var seen strings.Builder
	for !strings.Contains(seen.String(), want) {
		_, data, err := conn.ReadMessage()
		if err != nil {
			t.Fatalf("waiting for %q: %v, saw %q", want, err, seen.String())
		}
		seen.Write(data)
	}
	return seen.String()
}

// waitClosed reads until the server ends the connection.
func waitClosed(t *testing.T, conn *websocket.Conn) {
	t.Helper()
	conn.SetReadDeadline(time.Now().Add(10 * time.Second))
	for {
		if _, _, err := conn.ReadMessage(); err != nil {
			if ne, ok := err.(interface{ Timeout() bool }); ok && ne.Timeout() {
				t.Fatal("connection stayed open")
			}
			return
		}
	}
}

func TestTerminalRunsZshInTheCompanyFolder(t *testing.T) {
	conn, folder := openTerminal(t, setup(t).URL)
	// the printf keeps the typed line's echo from counting as the answer
	typeIn(t, conn, `printf '%s:%s:%s:%s\n' DIR "$PWD" "$zshrc_loaded" "$(stty size)" | sed s/DIR/ANSWER/`)
	readUntil(t, conn, "ANSWER:"+folder+":yes:37 91")

	if err := conn.WriteMessage(websocket.TextMessage, []byte(`{"cols":120,"rows":40}`)); err != nil {
		t.Fatal(err)
	}
	typeIn(t, conn, `stty size | sed 's/^/SI''ZE /'`)
	readUntil(t, conn, "SIZE 40 120")
}

func TestTerminalLeavesOutServerSettings(t *testing.T) {
	t.Setenv("TEAM_WORK_PORT", "18787")
	t.Setenv("TERM_PROGRAM", "Apple_Terminal")
	conn, _ := openTerminal(t, setup(t).URL)
	typeIn(t, conn, `echo "PO""RT=[$TEAM_WORK_PORT$TERM_PROGRAM]"`)
	readUntil(t, conn, "PORT=[]")
}

func TestTerminalEndsWithTheShell(t *testing.T) {
	conn, _ := openTerminal(t, setup(t).URL)
	typeIn(t, conn, "exit")
	waitClosed(t, conn)
}

func TestTerminalEndsWithAShellThatLeftAJobBehind(t *testing.T) {
	conn, _ := openTerminal(t, setup(t).URL)
	typeIn(t, conn, `sleep 5 &!`)
	typeIn(t, conn, "exit")
	waitClosed(t, conn)
}

func TestLeavingTheTerminalEndsTheShellAndItsJobs(t *testing.T) {
	conn, folder := openTerminal(t, setup(t).URL)
	typeIn(t, conn, `sleep 300 & echo $$ $! > pids; sh -c 'echo $$ >> pids; echo WRI""TTEN; exec sleep 300'`)
	readUntil(t, conn, "WRITTEN")
	raw, err := os.ReadFile(filepath.Join(folder, "pids"))
	if err != nil {
		t.Fatal(err)
	}
	conn.Close()
	for _, field := range strings.Fields(string(raw)) {
		pid, err := strconv.Atoi(field)
		if err != nil {
			t.Fatal(err)
		}
		deadline := time.Now().Add(5 * time.Second)
		for syscall.Kill(pid, 0) == nil {
			if time.Now().After(deadline) {
				_ = syscall.Kill(pid, syscall.SIGKILL)
				t.Fatalf("process %d still runs", pid)
			}
			time.Sleep(20 * time.Millisecond)
		}
	}
}

func TestTerminalRefusals(t *testing.T) {
	srv := setup(t)
	if code, _ := send(t, "GET", srv.URL+"/api/v1/teams/nobody/terminal?cols=80&rows=24", ""); code != http.StatusNotFound {
		t.Fatalf("unknown company: %d", code)
	}
	folder, _ := json.Marshal(t.TempDir())
	_, team := send(t, "POST", srv.URL+"/api/v1/teams", `{"name":"公司","folder":`+string(folder)+`}`)
	path := srv.URL + "/api/v1/teams/" + team["id"].(string) + "/terminal"
	for _, query := range []string{"", "?cols=0&rows=24", "?cols=80&rows=1001", "?cols=x&rows=24"} {
		if code, _ := send(t, "GET", path+query, ""); code != http.StatusBadRequest {
			t.Fatalf("size %q: %d", query, code)
		}
	}
	url := "ws" + strings.TrimPrefix(path, "http") + "?cols=80&rows=24"
	if _, res, err := websocket.DefaultDialer.Dial(url, http.Header{"Origin": {"https://evil.example"}}); err == nil || res.StatusCode != http.StatusForbidden {
		t.Fatalf("foreign websocket: %v %v", err, res)
	}
}

// The startup command preference is sent the moment the socket opens, before the shell has read its zshrc.
func TestTerminalRunsWhatIsSentBeforeTheShellIsReady(t *testing.T) {
	conn, _ := openTerminal(t, setup(t).URL)
	if err := conn.WriteMessage(websocket.BinaryMessage, []byte("echo loaded-$zshrc_loaded\r")); err != nil {
		t.Fatal(err)
	}
	readUntil(t, conn, "loaded-yes")
}
