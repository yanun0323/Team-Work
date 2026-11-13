package codex

import (
	"io"
	"sync/atomic"
	"time"

	"github.com/yanun0323/Team-Work/internal/model"
)

// DefaultIdle is how long a reply may send nothing before it is given up on, Codex's default.
const DefaultIdle = 5 * time.Minute

// WatchIdle closes body once it has sent nothing for d, so a reply the server stopped sending ends instead of
// waiting forever; reads then fail as a reply that can be tried again.
func WatchIdle(body io.ReadCloser, d time.Duration) io.ReadCloser {
	w := &idleBody{ReadCloser: body, d: d}
	w.timer = time.AfterFunc(d, func() {
		w.idle.Store(true)
		body.Close()
	})
	return w
}

type idleBody struct {
	io.ReadCloser
	d     time.Duration
	timer *time.Timer
	idle  atomic.Bool
}

func (w *idleBody) Read(p []byte) (int, error) {
	n, err := w.ReadCloser.Read(p)
	if w.idle.Load() {
		return n, model.Errorf(model.CodeUnavailable, "模型太久沒有回應，已中斷")
	}
	if n > 0 {
		w.timer.Reset(w.d)
	}
	return n, err
}

func (w *idleBody) Close() error {
	w.timer.Stop()
	return w.ReadCloser.Close()
}
