package delivery

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
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
	"github.com/labstack/echo/v4"
	"github.com/rs/zerolog"
	"github.com/yanun0323/Team-Work/internal/repository"
	"github.com/yanun0323/Team-Work/internal/tower"
	"github.com/yanun0323/Team-Work/internal/usecase"
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

// pairedTower is a tower whose one peer has been allowed to operate it.
func pairedTower(t *testing.T, transport tower.Transport) *tower.Service {
	t.Helper()
	dir := t.TempDir()
	writePeer(t, dir, map[string]any{"access": "operate"})
	return openTower(t, dir, transport)
}

// writePeer saves the test peer as tower-private.json, with extra fields on top of the ones every pair has.
func writePeer(t *testing.T, dir string, extra map[string]any) {
	t.Helper()
	sum := sha256.Sum256([]byte(testToken))
	peer := map[string]any{"id": "peer", "name": "Peer", "protocol": 1, "allowInbound": true, "status": "online", "Address": "test-address", "Token": testToken, "InboundHash": hex.EncodeToString(sum[:])}
	for k, v := range extra {
		peer[k] = v
	}
	raw, _ := json.Marshal(map[string]any{"Me": map[string]any{"id": "me", "name": "Me", "protocol": 1}, "Peers": map[string]any{"peer": peer}})
	if err := os.WriteFile(filepath.Join(dir, "tower-private.json"), raw, 0600); err != nil {
		t.Fatal(err)
	}
}

func openTower(t *testing.T, dir string, transport tower.Transport) *tower.Service {
	t.Helper()
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
		{"GET", "/api/v1/diagnostics/memory", "", 403}, {"POST", "/api/v1/git/install", `{"consent":true}`, 403}, {"POST", "/api/v1/folder-picker", "", 403}, {"POST", "/api/v1/settings/open-folder", "", 403}, {"POST", "/api/v1/teams/team/open-folder", "", 403}, {"POST", "/api/v1/airport/open-folder", "", 403}, {"POST", "/api/v1/claude-code/login", "", 403},
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

func TestRemoteSocketProxyAndRevocation(t *testing.T) {
	receiver := pairedTower(t, offlineTower{})
	network := &lostResponseNetwork{handler: NewGateway(receiver, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		up := websocket.Upgrader{}
		conn, err := up.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer conn.Close()
		conn.WriteMessage(websocket.TextMessage, []byte("remote snapshot"))
		for {
			kind, data, err := conn.ReadMessage()
			if err != nil {
				return
			}
			if conn.WriteMessage(kind, data) != nil {
				return
			}
		}
	}))}
	sender := pairedTower(t, network)
	s := NewServer(nil, nil, nil, nil, []string{origin}, zerolog.Nop())
	s.EnableTowers(sender)
	srv := httptest.NewServer(s.Handler())
	defer srv.Close()
	conn, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(srv.URL, "http")+"/api/v1/remote/peer/events", http.Header{"Origin": []string{origin}})
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	_, data, err := conn.ReadMessage()
	if err != nil || string(data) != "remote snapshot" {
		t.Fatal(string(data), err)
	}
	if err := conn.WriteMessage(websocket.BinaryMessage, []byte("terminal bytes")); err != nil {
		t.Fatal(err)
	}
	kind, data, err := conn.ReadMessage()
	if err != nil || kind != websocket.BinaryMessage || string(data) != "terminal bytes" {
		t.Fatal(kind, string(data), err)
	}
	receiver.SetAllowed("peer", false)
	conn.SetReadDeadline(time.Now().Add(time.Second))
	if _, _, err := conn.ReadMessage(); err == nil {
		t.Fatal("proxy remained open")
	}
}

func TestRemoteUnpairAllowedEvenWhenControlDenied(t *testing.T) {
	service := pairedTower(t, offlineTower{})
	service.SetAllowed("peer", false)
	g := NewGateway(service, http.NotFoundHandler())
	w := gatewayRequest(g, "POST", "/tower/v1/unpair", testToken, "", "")
	if w.Code != 204 || service.View().Peers[0].Status != "unpaired" {
		t.Fatal(w.Code, service.View())
	}
	if _, _, err := service.Authorize(testToken, true); err == nil {
		t.Fatal("unpair did not invalidate token")
	}
}

// Explicit opt-in only: default go test never contacts Tailcat's relay.
func TestTailcatLivePairHTTPAndWebSocket(t *testing.T) {
	if os.Getenv("TEAM_WORK_TEST_TAILCAT") != "1" {
		t.Skip("live relay test is opt-in")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	makeServer := func() (*tower.Service, *httptest.Server) {
		service, err := tower.New(ctx, t.TempDir(), tower.Tailcat{})
		if err != nil {
			t.Fatal(err)
		}
		s := NewServer(nil, nil, nil, nil, []string{origin}, zerolog.Nop())
		s.echo.GET("/api/v1/live-socket", func(c echo.Context) error {
			up := websocket.Upgrader{}
			conn, err := up.Upgrade(c.Response(), c.Request(), nil)
			if err != nil {
				return err
			}
			defer conn.Close()
			for {
				kind, data, err := conn.ReadMessage()
				if err != nil {
					return nil
				}
				if conn.WriteMessage(kind, data) != nil {
					return nil
				}
			}
		})
		s.EnableTowers(service)
		srv := httptest.NewServer(s.Handler())
		t.Cleanup(func() { srv.Close(); service.Close() })
		return service, srv
	}
	a, local := makeServer()
	b, _ := makeServer()
	waiting, err := b.BeginPairing()
	if err != nil {
		t.Fatal("cannot listen on relay")
	}
	if _, err = a.Pair(waiting.Address); err != nil {
		t.Fatal("cannot start pairing")
	}
	wait := func(f func() bool) {
		for !f() {
			select {
			case <-ctx.Done():
				t.Fatal("live pairing timed out")
			case <-time.After(100 * time.Millisecond):
			}
		}
	}
	wait(func() bool { return b.View().Pairing != nil && b.View().Pairing.Request != nil })
	if _, err = b.Decide(a.View().Me.ID, true); err != nil {
		t.Fatal("cannot approve")
	}
	wait(func() bool { v := a.View().Outgoing; return v != nil && v.State == "paired" })
	id := b.View().Me.ID
	peer, err := a.Check(ctx, id)
	if err != nil || peer.Status != "online" {
		t.Fatal("paired peer not online")
	}
	response, err := http.Get(local.URL + "/api/v1/remote/" + id + "/folders")
	if err != nil {
		t.Fatal("live HTTP failed")
	}
	response.Body.Close()
	if response.StatusCode != 200 {
		t.Fatal(response.StatusCode)
	}
	conn, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(local.URL, "http")+"/api/v1/remote/"+id+"/live-socket", nil)
	if err != nil {
		t.Fatal("live websocket failed")
	}
	defer conn.Close()
	conn.SetReadDeadline(time.Now().Add(15 * time.Second))
	conn.WriteMessage(websocket.BinaryMessage, []byte("hello"))
	_, data, err := conn.ReadMessage()
	if err != nil || string(data) != "hello" {
		t.Fatal("live websocket roundtrip failed")
	}
	b.SetAllowed(a.View().Me.ID, false)
	conn.SetReadDeadline(time.Now().Add(15 * time.Second))
	if _, _, err := conn.ReadMessage(); err == nil {
		t.Fatal("live revocation failed")
	}
}

func TestTowerSecretsStayOutOfWorldEventsAndLogs(t *testing.T) {
	data := t.TempDir()
	store, err := repository.NewStore(data)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	var logs bytes.Buffer
	engine, err := usecase.NewEngine(context.Background(), usecase.Options{Store: store, Git: offline{repository.NewGit(data)}, Providers: noModels{}, DataDir: data, Log: zerolog.New(&logs)})
	if err != nil {
		t.Fatal(err)
	}
	defer engine.Close()
	service := pairedTower(t, offlineTower{})
	s := NewServer(engine, claude, pickedFolder{}, repository.Terminals{}, []string{origin}, zerolog.New(&logs))
	s.EnableTowers(service)
	srv := httptest.NewServer(s.Handler())
	defer srv.Close()
	outputs := []string{}
	for _, path := range []string{"/api/v1/world", "/api/v1/towers"} {
		resp, err := http.Get(srv.URL + path)
		if err != nil {
			t.Fatal(err)
		}
		raw, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		outputs = append(outputs, string(raw))
	}
	conn, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(srv.URL, "http")+"/api/v1/events", nil)
	if err != nil {
		t.Fatal(err)
	}
	_, event, err := conn.ReadMessage()
	conn.Close()
	if err != nil {
		t.Fatal(err)
	}
	outputs = append(outputs, string(event), logs.String())
	sum := sha256.Sum256([]byte(testToken))
	for _, output := range outputs {
		for _, secret := range []string{testToken, "test-address", hex.EncodeToString(sum[:])} {
			if strings.Contains(output, secret) {
				t.Fatal("secret leaked into public output")
			}
		}
	}
}

type partialResponseNetwork struct {
	lostResponseNetwork
	cut atomic.Bool
}

func (n *partialResponseNetwork) Dial(ctx context.Context, address string) (net.Conn, error) {
	conn, err := n.lostResponseNetwork.Dial(ctx, address)
	if err != nil {
		return nil, err
	}
	if !n.cut.Swap(true) {
		return &partialRead{Conn: conn}, nil
	}
	return conn, nil
}

type partialRead struct {
	net.Conn
	sent bool
}

func (c *partialRead) Read(p []byte) (int, error) {
	if c.sent {
		return 0, io.ErrUnexpectedEOF
	}
	buf := make([]byte, 4096)
	n, err := c.Conn.Read(buf)
	if err != nil {
		return n, err
	}
	cut := bytes.Index(buf[:n], []byte("\r\n\r\n"))
	if cut < 0 {
		return copy(p, buf[:n]), nil
	}
	c.sent = true
	return copy(p, buf[:cut+4]), nil
}
func TestRemoteRetriesPartialMutationResponse(t *testing.T) {
	receiver := pairedTower(t, offlineTower{})
	var actions atomic.Int32
	network := &partialResponseNetwork{lostResponseNetwork: lostResponseNetwork{handler: NewGateway(receiver, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { actions.Add(1); io.WriteString(w, "created") }))}}
	sender := pairedTower(t, network)
	req, _ := http.NewRequest("POST", "http://tower/api/v1/tasks", strings.NewReader(`{}`))
	req.Header.Set("Idempotency-Key", "partial")
	req.Header.Set("Authorization", "Bearer "+testToken)
	response, err := (remoteTransport{service: sender, address: "test"}).RoundTrip(req)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	raw, _ := io.ReadAll(response.Body)
	if string(raw) != "created" || actions.Load() != 1 || response.Header.Get("Idempotent-Replayed") != "true" {
		t.Fatal(string(raw), actions.Load())
	}
}

func TestOfflineProxyNamesThePairedComputer(t *testing.T) {
	service := pairedTower(t, offlineTower{})
	s := NewServer(nil, nil, nil, nil, []string{origin}, zerolog.Nop())
	s.EnableTowers(service)
	srv := httptest.NewServer(s.Handler())
	defer srv.Close()
	for _, socket := range []bool{false, true} {
		req, _ := http.NewRequest("GET", srv.URL+"/api/v1/remote/peer/events", nil)
		if socket {
			req.Header.Set("Connection", "Upgrade")
			req.Header.Set("Upgrade", "websocket")
		}
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		raw, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		if resp.StatusCode != 502 || !strings.Contains(string(raw), "連不上 Peer") {
			t.Fatal(resp.StatusCode, string(raw))
		}
	}
	status, body := send(t, "PATCH", srv.URL+"/api/v1/towers/peers/peer", `{}`)
	if status != 400 || strings.Contains(fmt.Sprint(body), "遠端") {
		t.Fatal(status, body)
	}
}
