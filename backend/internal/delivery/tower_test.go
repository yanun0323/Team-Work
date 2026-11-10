package delivery

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/rs/zerolog"
	"github.com/yanun0323/Team-Work/internal/tower"
)

const testToken = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"

type offlineTower struct{}

func (offlineTower) Validate(string) error { return nil }
func (offlineTower) Listen(context.Context, json.RawMessage) (net.Listener, string, json.RawMessage, error) {
	return nil, "", nil, errors.New("offline")
}
func (offlineTower) Dial(context.Context, string) (net.Conn, error) {
	return nil, errors.New("offline")
}
func pairedTower(t *testing.T, transport tower.Transport) *tower.Service {
	t.Helper()
	dir := t.TempDir()
	sum := sha256.Sum256([]byte(testToken))
	raw, _ := json.Marshal(map[string]any{"Me": map[string]any{"id": "me", "name": "Me", "protocol": 1}, "Peers": map[string]any{"peer": map[string]any{"id": "peer", "name": "Peer", "protocol": 1, "allowInbound": true, "status": "online", "Address": "test-address", "Token": testToken, "InboundHash": hex.EncodeToString(sum[:])}}})
	if err := os.WriteFile(filepath.Join(dir, "tower-private.json"), raw, 0600); err != nil {
		t.Fatal(err)
	}
	s, err := tower.New(context.Background(), dir, transport)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(s.Close)
	return s
}
func gatewayRequest(g http.Handler, method, path, token, key, body string) *httptest.ResponseRecorder {
	r := httptest.NewRequest(method, "http://tower"+path, strings.NewReader(body))
	if token != "" {
		r.Header.Set("Authorization", "Bearer "+token)
	}
	if key != "" {
		r.Header.Set("Idempotency-Key", key)
	}
	r.Header.Set("Origin", "https://evil.example")
	r.Header.Set("Cookie", "secret=cookie")
	w := httptest.NewRecorder()
	g.ServeHTTP(w, r)
	return w
}
func TestGatewayAuthenticationRevocationAndSanitizing(t *testing.T) {
	service := pairedTower(t, offlineTower{})
	var calls int
	api := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if r.Header.Get("Authorization") != "" || r.Header.Get("Origin") != "" || r.Header.Get("Cookie") != "" || isLocal(hostOnly(r.RemoteAddr)) || r.Host != "localhost" {
			t.Error("unsafe forwarded request")
		}
		w.WriteHeader(201)
	})
	g := NewGateway(service, api)
	for _, token := range []string{"", "wrong", testToken + "x"} {
		w := gatewayRequest(g, "GET", "/api/v1/world?token="+testToken, token, "", "")
		if w.Code != 401 {
			t.Fatal(w.Code, w.Body.String())
		}
	}
	if calls != 0 {
		t.Fatal("unauthorized reached api")
	}
	if w := gatewayRequest(g, "GET", "/api/v1/world", testToken, "", ""); w.Code != 201 {
		t.Fatal(w.Code, w.Body.String())
	}
	service.SetAllowed("peer", false)
	if w := gatewayRequest(g, "GET", "/api/v1/world", testToken, "", ""); w.Code != 403 {
		t.Fatal(w.Code)
	}
	service.SetAllowed("peer", true)
	service.Unpair(context.Background(), "peer")
	if w := gatewayRequest(g, "GET", "/api/v1/world", testToken, "", ""); w.Code != 401 {
		t.Fatal(w.Code)
	}
	if calls != 1 {
		t.Fatal(calls)
	}
}
func TestGatewayBlocksLocalOnlyPathsAndPreferences(t *testing.T) {
	service := pairedTower(t, offlineTower{})
	g := NewGateway(service, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(204) }))
	for _, test := range []struct {
		method, path, body string
		status             int
	}{
		{"GET", "/", "", 404}, {"GET", "/api/v1/towers", "", 403}, {"POST", "/api/v1/towers/pairing", "", 403}, {"GET", "/api/v1/remote/peer/world", "", 403},
		{"GET", "/api/v1/diagnostics/memory", "", 403}, {"POST", "/api/v1/folder-picker", "", 403}, {"POST", "/api/v1/settings/open-folder", "", 403}, {"POST", "/api/v1/teams/team/open-folder", "", 403}, {"POST", "/api/v1/airport/open-folder", "", 403}, {"POST", "/api/v1/claude-code/login", "", 403},
		{"POST", "/api/v1/providers/p/login", `{}`, 403}, {"POST", "/api/v1/providers/p/login", `{"method":"browser"}`, 403}, {"POST", "/api/v1/providers/p/login", `{"method":"device"}`, 204}, {"POST", "/api/v1/providers/p/login", "bad", 400},
		{"PUT", "/api/v1/settings/language", `{}`, 403}, {"PATCH", "/api/v1/tutorial", `{}`, 403}, {"PATCH", "/api/v1/settings/preferences", `{"language":"en","terminalCommand":"sh"}`, 400}, {"PATCH", "/api/v1/settings/preferences", `{"terminalCommand":"sh","compactSmall":0.5}`, 204}, {"PATCH", "/api/v1/settings/preferences", `null`, 400},
		{"POST", "/api/v1/%74owers/pairing", "", 403}, {"GET", "/api/v1/teams/../towers", "", 403},
	} {
		t.Run(test.method+test.path+test.body, func(t *testing.T) {
			w := gatewayRequest(g, test.method, test.path, testToken, test.path+test.body, test.body)
			if w.Code != test.status {
				t.Fatal(w.Code, w.Body.String())
			}
		})
	}
}
func TestGatewayIdempotencyConcurrentAndMismatch(t *testing.T) {
	service := pairedTower(t, offlineTower{})
	var calls atomic.Int32
	entered := make(chan struct{})
	release := make(chan struct{})
	g := NewGateway(service, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		close(entered)
		<-release
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(201)
		io.WriteString(w, `{"id":"one"}`)
	}))
	if w := gatewayRequest(g, "POST", "/api/v1/tasks", testToken, "", `{}`); w.Code != 400 {
		t.Fatal(w.Code)
	}
	results := make(chan *httptest.ResponseRecorder, 2)
	go func() { results <- gatewayRequest(g, "POST", "/api/v1/tasks", testToken, "same", `{}`) }()
	<-entered
	go func() { results <- gatewayRequest(g, "POST", "/api/v1/tasks", testToken, "same", `{}`) }()
	close(release)
	replayed := 0
	for i := 0; i < 2; i++ {
		w := <-results
		if w.Code != 201 || w.Body.String() != `{"id":"one"}` {
			t.Fatal(w.Code, w.Body.String())
		}
		if w.Header().Get("Idempotent-Replayed") == "true" {
			replayed++
		}
	}
	if calls.Load() != 1 || replayed != 1 {
		t.Fatal(calls.Load(), replayed)
	}
	if w := gatewayRequest(g, "POST", "/api/v1/tasks", testToken, "same", `{"different":true}`); w.Code != 409 {
		t.Fatal(w.Code)
	}
	service.SetAllowed("peer", false)
	if w := gatewayRequest(g, "POST", "/api/v1/tasks", testToken, "same", `{}`); w.Code != 403 {
		t.Fatal("replay bypassed authorization", w.Code)
	}
}
func TestGatewayClosesExistingWebSocket(t *testing.T) {
	for _, revoke := range []bool{false, true} {
		t.Run(map[bool]string{false: "disable", true: "unpair"}[revoke], func(t *testing.T) {
			service := pairedTower(t, offlineTower{})
			api := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				up := websocket.Upgrader{}
				conn, err := up.Upgrade(w, r, nil)
				if err != nil {
					return
				}
				defer conn.Close()
				conn.WriteMessage(websocket.TextMessage, []byte("snapshot"))
				for {
					if _, _, err := conn.ReadMessage(); err != nil {
						return
					}
				}
			})
			srv := httptest.NewServer(NewGateway(service, api))
			defer srv.Close()
			headers := http.Header{"Authorization": []string{"Bearer " + testToken}}
			conn, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(srv.URL, "http")+"/api/v1/events", headers)
			if err != nil {
				t.Fatal(err)
			}
			defer conn.Close()
			if _, _, err = conn.ReadMessage(); err != nil {
				t.Fatal(err)
			}
			if revoke {
				service.Unpair(context.Background(), "peer")
			} else {
				service.SetAllowed("peer", false)
			}
			conn.SetReadDeadline(time.Now().Add(time.Second))
			if _, _, err = conn.ReadMessage(); err == nil {
				t.Fatal("connection still open")
			}
			var timeout net.Error
			if errors.As(err, &timeout) && timeout.Timeout() {
				t.Fatal("revocation did not close connection")
			}
		})
	}
}

// This transport consumes the complete first response then loses it, as if a tunnel died after execution.
type lostResponseNetwork struct {
	handler http.Handler
	calls   atomic.Int32
	first   bool
	mu      sync.Mutex
}

func (n *lostResponseNetwork) Validate(string) error { return nil }
func (n *lostResponseNetwork) Listen(context.Context, json.RawMessage) (net.Listener, string, json.RawMessage, error) {
	return nil, "", nil, errors.New("offline")
}
func (n *lostResponseNetwork) Dial(ctx context.Context, _ string) (net.Conn, error) {
	n.calls.Add(1)
	client, server := net.Pipe()
	n.mu.Lock()
	lost := n.first
	n.first = false
	n.mu.Unlock()
	l := &oneListener{conn: server, closed: make(chan struct{})}
	go func() { srv := &http.Server{Handler: n.handler}; _ = srv.Serve(l) }()
	if lost {
		return &loseRead{Conn: client}, nil
	}
	return client, nil
}

type loseRead struct{ net.Conn }

func (c *loseRead) Read(p []byte) (int, error) {
	buf := make([]byte, 64<<10)
	for {
		_, err := c.Conn.Read(buf)
		if err != nil {
			return 0, io.ErrUnexpectedEOF
		}
	}
}

type oneListener struct {
	conn   net.Conn
	closed chan struct{}
	once   sync.Once
}

func (l *oneListener) Accept() (net.Conn, error) {
	if l.conn != nil {
		c := l.conn
		l.conn = nil
		return &closeListenerConn{Conn: c, listener: l}, nil
	}
	<-l.closed
	return nil, net.ErrClosed
}
func (l *oneListener) Close() error   { l.once.Do(func() { close(l.closed) }); return nil }
func (l *oneListener) Addr() net.Addr { return &net.TCPAddr{} }

type closeListenerConn struct {
	net.Conn
	listener *oneListener
}

func (c *closeListenerConn) Close() error { c.listener.Close(); return c.Conn.Close() }
func TestRemoteRetriesLostResponseWithSameKey(t *testing.T) {
	receiver := pairedTower(t, offlineTower{})
	var actions atomic.Int32
	g := NewGateway(receiver, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { actions.Add(1); io.WriteString(w, "created") }))
	network := &lostResponseNetwork{handler: g, first: true}
	sender := pairedTower(t, network)
	req, _ := http.NewRequest("POST", "http://tower/api/v1/tasks", strings.NewReader(`{}`))
	req.Header.Set("Idempotency-Key", "action")
	req.Header.Set("Authorization", "Bearer "+testToken)
	response, err := (remoteTransport{service: sender, address: "test"}).RoundTrip(req)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	raw, _ := io.ReadAll(response.Body)
	if string(raw) != "created" || response.Header.Get("Idempotent-Replayed") != "true" || actions.Load() != 1 || network.calls.Load() != 2 {
		t.Fatal(string(raw), actions.Load(), network.calls.Load())
	}
}
func TestTowerLocalAPIAndProxy(t *testing.T) {
	receiver := pairedTower(t, offlineTower{})
	network := &lostResponseNetwork{handler: NewGateway(receiver, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { io.WriteString(w, r.URL.RequestURI()) }))}
	sender := pairedTower(t, network)
	s := NewServer(nil, nil, nil, nil, []string{origin}, zerolog.Nop())
	s.EnableTowers(sender)
	srv := httptest.NewServer(s.Handler())
	defer srv.Close()
	for _, test := range []struct {
		method, path, body string
		status             int
	}{
		{"GET", "/towers", "", 200}, {"PATCH", "/towers/peers/peer", `{}`, 400}, {"PATCH", "/towers/peers/missing", `{"allowInbound":true}`, 404},
		{"POST", "/towers/pairing/approve", `{"requestId":"missing"}`, 404}, {"POST", "/towers/pairing/reject", `bad`, 400}, {"DELETE", "/towers/outgoing", "", 204},
		{"GET", "/remote/peer/world?test=yes", "", 200}, {"GET", "/remote/missing/world", "", 404},
	} {
		status, body := send(t, test.method, srv.URL+"/api/v1"+test.path, test.body)
		if status != test.status {
			t.Fatal(test, status, body)
		}
	}
	req, _ := http.NewRequest("GET", srv.URL+"/api/v1/towers", nil)
	req.Header.Set("Origin", "https://evil.example")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != 403 {
		t.Fatal("local guard bypassed")
	}
}
