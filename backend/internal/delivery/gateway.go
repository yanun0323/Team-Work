package delivery

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"path"
	"strings"
	"sync"
	"time"

	"github.com/yanun0323/Team-Work/internal/model"
	"github.com/yanun0323/Team-Work/internal/tower"
)

// Gateway is deliberately not a listener on config.Host/Port. Only Tailcat serves it.
// Authorization runs before routing, cache lookups, or upgrades, including replayed requests.
type Gateway struct {
	service   *tower.Service
	api       http.Handler
	mu        sync.Mutex
	responses map[string]*remoteResponse
	reserved  int
}
type remoteResponse struct {
	done        chan struct{}
	expires     time.Time
	fingerprint [32]byte
	header      http.Header
	status      int
	body        []byte
	size        int
}

func NewGateway(service *tower.Service, api http.Handler) *Gateway {
	return &Gateway{service: service, api: api, responses: map[string]*remoteResponse{}}
}
func remoteError(w http.ResponseWriter, err error) {
	var known *model.Error
	if !errors.As(err, &known) {
		known = model.Errorf(model.CodeUnavailable, "電塔暫時連不上，請確認對方仍在等待配對")
	}
	status := http.StatusBadRequest
	switch known.Code {
	case "unauthorized":
		status = 401
	case "peer_denied", "peer_unpaired", "remote_unavailable":
		status = 403
	case model.CodeNotFound:
		status = 404
	case "incompatible", model.CodeConflict:
		status = 409
	case model.CodeUnavailable:
		status = 502
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]any{"error": map[string]string{"code": known.Code, "message": known.Message}})
}
func deniedRemote() error {
	return model.Errorf("remote_unavailable", "這個功能不能從遠端使用，請回到那台電腦操作")
}
func invalidRemote() error { return model.Errorf(model.CodeInvalid, "遠端請求格式不正確") }
func (g *Gateway) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	token := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
	if !strings.HasPrefix(r.Header.Get("Authorization"), "Bearer ") {
		token = ""
	}
	peer, revoked, err := g.service.Authorize(token, r.URL.Path == "/tower/v1/unpair")
	if err != nil {
		remoteError(w, err)
		return
	}
	if r.URL.Path == "/tower/v1/hello" && r.Method == "GET" {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(g.service.View().Me)
		return
	}
	if r.URL.Path == "/tower/v1/unpair" && r.Method == "POST" {
		if err := g.service.RemoteUnpair(peer.ID); err != nil {
			remoteError(w, err)
		} else {
			w.WriteHeader(204)
		}
		return
	}
	if peer.Protocol != tower.Protocol {
		remoteError(w, model.Errorf("incompatible", "這台的 Team Work 太舊，請更新這台"))
		return
	}
	// Reject ambiguous paths rather than allowing normalization to bypass a protected route.
	p := r.URL.Path
	if !strings.HasPrefix(p, "/api/v1/") {
		http.NotFound(w, r)
		return
	}
	if p != path.Clean(p) || strings.Contains(p, "\\") || r.URL.RawPath != "" {
		remoteError(w, deniedRemote())
		return
	}
	if blockedRemote(p, r.Method) {
		remoteError(w, deniedRemote())
		return
	}
	var body []byte
	if r.Method != "GET" {
		if k := r.Header.Get("Idempotency-Key"); k == "" || len(k) > 128 {
			remoteError(w, invalidRemote())
			return
		}
		body, err = io.ReadAll(io.LimitReader(r.Body, (32<<20)+1))
		if err != nil || len(body) > 32<<20 {
			remoteError(w, invalidRemote())
			return
		}
		if p == "/api/v1/settings/preferences" && r.Method == "PATCH" {
			var fields map[string]json.RawMessage
			if json.Unmarshal(body, &fields) != nil || fields == nil {
				remoteError(w, invalidRemote())
				return
			}
			for field := range fields {
				if !remoteWorkPreference(field) {
					remoteError(w, invalidRemote())
					return
				}
			}
		}
		if r.Method == "POST" && strings.HasPrefix(p, "/api/v1/providers/") && strings.HasSuffix(p, "/login") {
			var in struct {
				Method string `json:"method"`
			}
			if json.Unmarshal(body, &in) != nil {
				remoteError(w, invalidRemote())
				return
			}
			if in.Method != "device" {
				remoteError(w, deniedRemote())
				return
			}
		}
	}
	// Revoke HTTP handlers through context cancellation and upgraded streams through Hijack.
	// Mutations run independently of the requesting socket, so a retry can wait for the same result.
	base := r.Context()
	if r.Method != "GET" {
		base = context.Background()
	}
	ctx, cancel := context.WithCancel(base)
	stop := context.AfterFunc(revoked, cancel)
	defer stop()
	defer cancel()
	req := r.Clone(ctx)
	req.Host = "localhost"
	req.RemoteAddr = "192.0.2.1:1"
	for _, h := range []string{"Authorization", "Origin", "Cookie", "Forwarded", "X-Forwarded-For", "X-Real-IP"} {
		req.Header.Del(h)
	}
	req.Body = io.NopCloser(bytes.NewReader(body))
	if r.Method == "GET" {
		req.Body = r.Body
		stream := &revocableWriter{ResponseWriter: w, ctx: ctx}
		defer stream.close()
		g.api.ServeHTTP(stream, req)
		return
	}
	key := peer.ID + ":" + fmt.Sprintf("%x", sha256.Sum256([]byte(token))) + ":" + r.Header.Get("Idempotency-Key")
	fingerprint := sha256.Sum256(append([]byte(r.Method+"\x00"+r.URL.RequestURI()+"\x00"+r.Header.Get("Content-Type")+"\x00"), body...))
	g.mu.Lock()
	now := time.Now()
	for k, v := range g.responses {
		if !v.expires.IsZero() && now.After(v.expires) {
			delete(g.responses, k)
			g.reserved -= v.size
		}
	}
	if saved, ok := g.responses[key]; ok {
		g.mu.Unlock()
		if saved.fingerprint != fingerprint {
			remoteError(w, model.Errorf(model.CodeConflict, "這個操作識別碼已用於不同的請求"))
			return
		}
		select {
		case <-saved.done:
		case <-ctx.Done():
			return
		}
		w.Header().Set("Idempotent-Replayed", "true")
		writeRemoteResponse(w, saved)
		return
	}
	// Do not evict successful actions inside their promised ten-minute replay window.
	const maxResponse = 32 << 20
	if len(g.responses) >= 1024 || g.reserved+maxResponse > 128<<20 {
		g.mu.Unlock()
		remoteError(w, model.Errorf(model.CodeUnavailable, "遠端操作暫存已滿，請稍後重試"))
		return
	}
	saved := &remoteResponse{done: make(chan struct{}), fingerprint: fingerprint, size: maxResponse}
	g.responses[key] = saved
	g.reserved += maxResponse
	g.mu.Unlock()
	recorder := &boundedResponse{header: make(http.Header)}
	func() {
		defer func() {
			if recover() != nil {
				recorder = &boundedResponse{header: make(http.Header)}
				remoteError(recorder, invalidRemote())
			}
		}()
		g.api.ServeHTTP(recorder, req)
	}()
	if recorder.overflow {
		recorder = &boundedResponse{header: make(http.Header)}
		remoteError(recorder, model.Errorf(model.CodeUnavailable, "遠端回應過大，請重新讀取目前狀態"))
	}
	saved.header = recorder.header.Clone()
	saved.status = recorder.status
	if saved.status == 0 {
		saved.status = 200
	}
	saved.body = recorder.body.Bytes()
	g.mu.Lock()
	g.reserved -= saved.size - len(saved.body)
	saved.size = len(saved.body)
	saved.expires = time.Now().Add(10 * time.Minute)
	close(saved.done)
	g.mu.Unlock()
	writeRemoteResponse(w, saved)
}
func blockedRemote(p, method string) bool {
	for _, prefix := range []string{"/api/v1/towers", "/api/v1/remote", "/api/v1/diagnostics"} {
		if p == prefix || strings.HasPrefix(p, prefix+"/") {
			return true
		}
	}
	if method == "PUT" && p == "/api/v1/settings/language" || method == "PATCH" && p == "/api/v1/tutorial" {
		return true
	}
	if method != "POST" {
		return false
	}
	switch p {
	case "/api/v1/git/install", "/api/v1/folder-picker", "/api/v1/settings/open-folder", "/api/v1/airport/open-folder", "/api/v1/claude-code/login":
		return true
	}
	return strings.HasPrefix(p, "/api/v1/teams/") && strings.HasSuffix(p, "/open-folder")
}
func remoteWorkPreference(key string) bool {
	switch key {
	case "terminalCommand", "chatTitleModel", "chatTitleEffort", "imageProvider", "codexSkills", "claudeSkills", "hiddenBlueprints", "hiddenWorkflows", "compact1M", "compact256K", "compact128K", "compactSmall":
		return true
	}
	return false
}
func writeRemoteResponse(w http.ResponseWriter, r *remoteResponse) {
	for key, values := range r.header {
		w.Header()[key] = append([]string(nil), values...)
	}
	w.WriteHeader(r.status)
	_, _ = w.Write(r.body)
}

type boundedResponse struct {
	header   http.Header
	status   int
	body     bytes.Buffer
	overflow bool
}

func (w *boundedResponse) Header() http.Header { return w.header }
func (w *boundedResponse) WriteHeader(status int) {
	if w.status == 0 {
		w.status = status
	}
}
func (w *boundedResponse) Write(b []byte) (int, error) {
	if w.body.Len()+len(b) > 32<<20 {
		w.overflow = true
		return 0, errors.New("response limit")
	}
	if w.status == 0 {
		w.status = 200
	}
	return w.body.Write(b)
}

type revocableWriter struct {
	http.ResponseWriter
	ctx  context.Context
	mu   sync.Mutex
	conn net.Conn
	stop func() bool
}

func (w *revocableWriter) Unwrap() http.ResponseWriter { return w.ResponseWriter }
func (w *revocableWriter) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	c, b, err := http.NewResponseController(w.ResponseWriter).Hijack()
	if err != nil {
		return nil, nil, err
	}
	w.mu.Lock()
	w.conn = c
	w.stop = context.AfterFunc(w.ctx, func() { _ = c.Close() })
	w.mu.Unlock()
	return c, b, nil
}
func (w *revocableWriter) close() {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.stop != nil {
		w.stop()
	}
	if w.conn != nil {
		_ = w.conn.Close()
	}
}
