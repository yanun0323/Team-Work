package delivery

import (
	"encoding/json"
	"net/http"
	"strconv"
	"time"

	"github.com/gorilla/websocket"
	"github.com/labstack/echo/v4"

	"github.com/yanun0323/Team-Work/internal/model"
)

const (
	// terminalReadLimit is the most text one paste can send.
	terminalReadLimit = 32 << 20
	maxTerminalSide   = 1000
	// terminalFlush lets the last output of a shell that ended arrive, if a job it left behind keeps the
	// terminal from ever reporting its end.
	terminalFlush = 200 * time.Millisecond
)

// terminal connects a WebSocket to a new shell in the company's folder until either of them ends. Binary
// messages carry the bytes typed and the bytes shown; a text message from the client is a resize.
func (s *Server) terminal(c echo.Context) error {
	folder, err := s.engine.TeamFolder(c.Param("id"))
	if err != nil {
		return err
	}
	cols, err := terminalSide(c.QueryParam("cols"))
	if err != nil {
		return err
	}
	rows, err := terminalSide(c.QueryParam("rows"))
	if err != nil {
		return err
	}
	shell, err := s.terminals.Start(folder, cols, rows)
	if err != nil {
		return err
	}
	defer shell.Close()
	up := websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }} // guard has checked it
	conn, err := up.Upgrade(c.Response(), c.Request(), nil)
	if err != nil {
		return nil // the upgrader has answered
	}
	defer conn.Close()
	conn.SetReadLimit(terminalReadLimit)
	_ = s.engine.Learn("terminal") // only the tutorial's record; the terminal works without it

	// Closing the connection ends the read loop below.
	output := make(chan struct{})
	go func() { // ends when the shell's output does; shell.Close sees to that
		defer close(output)
		defer conn.Close()
		buf := make([]byte, 32<<10)
		connected := true
		for {
			n, err := shell.Read(buf)
			// keeps reading once the client has gone: on macOS a shell cannot finish exiting, not even when
			// killed, while output it wrote is waiting to be read
			if n > 0 && connected {
				_ = conn.SetWriteDeadline(time.Now().Add(writeTimeout))
				if conn.WriteMessage(websocket.BinaryMessage, buf[:n]) != nil {
					connected = false
					conn.Close()
				}
			}
			if err != nil {
				return
			}
		}
	}()
	stop := make(chan struct{})
	defer close(stop)
	go func() { // ends with the handler
		select {
		case <-stop:
		case <-shell.Exited():
			select {
			case <-stop:
			case <-output:
			case <-time.After(terminalFlush):
				conn.Close()
			}
		}
	}()

	for {
		kind, data, err := conn.ReadMessage()
		if err != nil {
			return nil
		}
		if kind == websocket.BinaryMessage {
			if _, err := shell.Write(data); err != nil {
				return nil
			}
			continue
		}
		var size struct {
			Cols uint16 `json:"cols"`
			Rows uint16 `json:"rows"`
		}
		if json.Unmarshal(data, &size) == nil && validTerminalSide(size.Cols) && validTerminalSide(size.Rows) {
			_ = shell.Resize(size.Cols, size.Rows)
		}
	}
}

func terminalSide(raw string) (uint16, error) {
	n, err := strconv.ParseUint(raw, 10, 16)
	if err != nil || !validTerminalSide(uint16(n)) {
		return 0, model.Errorf(model.CodeInvalid, "終端機大小不正確")
	}
	return uint16(n), nil
}

func validTerminalSide(n uint16) bool { return n >= 1 && n <= maxTerminalSide }
