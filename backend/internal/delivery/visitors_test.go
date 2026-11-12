package delivery

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/rs/zerolog"
)

func errorCode(t *testing.T, w *httptest.ResponseRecorder) string {
	t.Helper()
	var out struct {
		Error struct{ Code string } `json:"error"`
	}
	_ = json.Unmarshal(w.Body.Bytes(), &out)
	return out.Error.Code
}

// A visitor opening a chat or a source must not clear the unread marks this computer's own user sees.
func TestGatewayVisitorKeepsUnreadMarks(t *testing.T) {
	service := pairedTower(t, offlineTower{})
	var reached []string
	g := NewGateway(service, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		reached = append(reached, r.Method+" "+r.URL.Path)
		w.WriteHeader(204)
	}))
	for _, path := range []string{"/api/v1/chats/c1/read", "/api/v1/sources/s1/seen"} {
		if w := gatewayRequest(g, "POST", path, testToken, path, ""); w.Code != 204 {
			t.Fatal(path, w.Code, w.Body.String())
		}
	}
	if len(reached) != 0 {
		t.Fatal("a visitor cleared unread marks:", reached)
	}
	if w := gatewayRequest(g, "POST", "/api/v1/chats/c1/say", testToken, "say", `{}`); w.Code != 204 || len(reached) != 1 {
		t.Fatal("other chat actions must still reach the island", w.Code, reached)
	}
}

func TestGatewayViewAccessOnlyReads(t *testing.T) {
	service := pairedTower(t, offlineTower{})
	var reached int
	g := NewGateway(service, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { reached++; w.WriteHeader(200) }))
	if _, err := service.SetAccess("peer", "view"); err != nil {
		t.Fatal(err)
	}
	for _, test := range []struct {
		method, path string
		status       int
	}{
		{"GET", "/api/v1/world", 200}, {"GET", "/api/v1/chats/c/messages", 200},
		{"POST", "/api/v1/tasks", 403}, {"PATCH", "/api/v1/teams/t", 403}, {"DELETE", "/api/v1/chats/c", 403}, {"PUT", "/api/v1/teams/t/notes", 403},
		{"GET", "/api/v1/teams/t/terminal", 403}, {"GET", "/api/v1/airport/terminal", 403}, {"GET", "/api/v1/folders", 403},
	} {
		w := gatewayRequest(g, test.method, test.path, testToken, test.method+test.path, `{}`)
		if w.Code != test.status {
			t.Fatal(test, w.Code, w.Body.String())
		}
		if w.Code == 403 && errorCode(t, w) != "peer_readonly" {
			t.Fatal(test, w.Body.String())
		}
	}
	if reached != 2 {
		t.Fatal("refused requests reached the island", reached)
	}
	// reporting where it is still works while it can only look
	if w := gatewayRequest(g, "POST", "/api/v1/presence", testToken, "", `{"page":"p1","place":"airport"}`); w.Code != 204 {
		t.Fatal(w.Code, w.Body.String())
	}
	if _, err := service.SetAccess("peer", "operate"); err != nil {
		t.Fatal(err)
	}
	if w := gatewayRequest(g, "POST", "/api/v1/tasks", testToken, "again", `{}`); w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
}

// Taking control away, kicking or blocking closes what the visitor already has open.
func TestGatewayAccessChangesCloseOpenSockets(t *testing.T) {
	for _, change := range []string{"view", "kick", "block"} {
		t.Run(change, func(t *testing.T) {
			service := pairedTower(t, offlineTower{})
			api := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				conn, err := (&websocket.Upgrader{}).Upgrade(w, r, nil)
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
			url := "ws" + strings.TrimPrefix(srv.URL, "http") + "/api/v1/events"
			headers := http.Header{"Authorization": []string{"Bearer " + testToken}}
			conn, _, err := websocket.DefaultDialer.Dial(url, headers)
			if err != nil {
				t.Fatal(err)
			}
			defer conn.Close()
			if _, _, err = conn.ReadMessage(); err != nil {
				t.Fatal(err)
			}
			switch change {
			case "view":
				_, err = service.SetAccess("peer", "view")
			case "kick":
				err = service.Kick("peer")
			case "block":
				_, err = service.Block("peer", time.Hour)
			}
			if err != nil {
				t.Fatal(err)
			}
			conn.SetReadDeadline(time.Now().Add(time.Second))
			if _, _, err = conn.ReadMessage(); err == nil {
				t.Fatal("connection still open")
			}
			_, resp, err := websocket.DefaultDialer.Dial(url, headers)
			if change == "view" {
				if err != nil {
					t.Fatal("looking may go on", err)
				}
				return
			}
			if err == nil || resp == nil || resp.StatusCode != 403 {
				t.Fatal("a new connection got in", err)
			}
		})
	}
}

func TestGatewayKickBlockAndPresence(t *testing.T) {
	service := pairedTower(t, offlineTower{})
	g := NewGateway(service, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(200) }))
	visit := func(body string) int {
		return gatewayRequest(g, "POST", "/api/v1/presence", testToken, "", body).Code
	}
	for _, bad := range []string{`{"page":"","place":"airport"}`, `{"page":"p 1","place":"airport"}`, `{"page":"p1","place":"towers"}`, `nope`} {
		if visit(bad) != 400 {
			t.Fatal(bad)
		}
	}
	// two pages of the same computer are one visitor; the page's own claims never name who it is
	if visit(`{"page":"p1","place":"team:a","id":"someone-else"}`) != 204 || visit(`{"page":"p2","place":"team:a"}`) != 204 || visit(`{"page":"p3","place":"airport"}`) != 204 {
		t.Fatal("visit refused")
	}
	v := service.View().Visitors
	if len(v) != 1 || v[0].ID != "peer" || v[0].Name != "Peer" || strings.Join(v[0].Places, ",") != "airport,team:a" {
		t.Fatal(v)
	}
	if visit(`{"page":"p3","gone":true}`) != 204 || strings.Join(service.View().Visitors[0].Places, ",") != "team:a" {
		t.Fatal(service.View().Visitors)
	}
	if err := service.Kick("peer"); err != nil {
		t.Fatal(err)
	}
	if len(service.View().Visitors) != 0 {
		t.Fatal("a kicked computer stays on the list")
	}
	if w := gatewayRequest(g, "GET", "/api/v1/world", testToken, "", ""); w.Code != 403 || errorCode(t, w) != "peer_kicked" {
		t.Fatal(w.Code, w.Body.String())
	}
	if w := gatewayRequest(g, "POST", "/api/v1/presence", testToken, "", `{"page":"p1","place":"airport"}`); w.Code != 403 {
		t.Fatal("a kicked page reported itself back", w.Code)
	}
	// unpairing stays possible while kicked or blocked
	if _, err := service.Block("peer", 0); err != nil {
		t.Fatal(err)
	}
	if w := gatewayRequest(g, "GET", "/api/v1/world", testToken, "", ""); w.Code != 403 || errorCode(t, w) != "peer_blocked" {
		t.Fatal(w.Code, w.Body.String())
	}
	if w := gatewayRequest(g, "POST", "/tower/v1/unpair", testToken, "", ""); w.Code != 204 {
		t.Fatal(w.Code, w.Body.String())
	}
}

func TestTowerProfileAccessAndBlockRoutes(t *testing.T) {
	service := pairedTower(t, offlineTower{})
	s := NewServer(nil, nil, nil, nil, []string{origin}, zerolog.Nop())
	s.EnableTowers(service)
	srv := httptest.NewServer(s.Handler())
	defer srv.Close()
	for _, test := range []struct {
		method, path, body string
		status             int
	}{
		{"PUT", "/towers/profile", `{"name":"  "}`, 400}, {"PUT", "/towers/profile", `{"name":"a\nb"}`, 400}, {"PUT", "/towers/profile", `{"name":"` + strings.Repeat("名", 41) + `"}`, 400},
		{"PUT", "/towers/profile", `{"name":" Desk "}`, 200},
		{"PATCH", "/towers/peers/peer", `{"access":"admin"}`, 400}, {"PATCH", "/towers/peers/peer", `{"access":"view"}`, 200}, {"PATCH", "/towers/peers/missing", `{"access":"view"}`, 404},
		{"POST", "/towers/peers/peer/block", `{"for":"day"}`, 400}, {"POST", "/towers/peers/peer/block", `{"for":"hour"}`, 200}, {"DELETE", "/towers/peers/peer/block", "", 200},
		{"POST", "/towers/peers/peer/kick", "", 204}, {"POST", "/towers/peers/missing/kick", "", 404},
	} {
		if status, body := send(t, test.method, srv.URL+"/api/v1"+test.path, test.body); status != test.status {
			t.Fatal(test, status, body)
		}
	}
	v := service.View()
	if v.Me.Name != "Desk" || v.Peers[0].Access != "view" || v.Peers[0].BlockedUntil != 0 {
		t.Fatal(v)
	}
}
