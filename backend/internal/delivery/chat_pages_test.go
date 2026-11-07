package delivery

import (
	"context"
	"fmt"
	"github.com/gorilla/websocket"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/rs/zerolog"
	"github.com/yanun0323/Team-Work/internal/model"
	"github.com/yanun0323/Team-Work/internal/repository"
	"github.com/yanun0323/Team-Work/internal/usecase"
	"github.com/yanun0323/Team-Work/pkg/jsonx"
)

func TestChatMessagePagesHTTP(t *testing.T) {
	data := t.TempDir()
	store, err := repository.NewStore(data)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	initial, err := usecase.NewEngine(context.Background(), usecase.Options{Store: store, Git: repository.NewGit(data), Providers: noModels{}, DataDir: data, Log: zerolog.Nop()})
	if err != nil {
		t.Fatal(err)
	}
	initial.Close()
	c := model.Chat{ID: "c", Messages: []model.ChatMessage{}}
	for i := 0; i < 201; i++ {
		c.Messages = append(c.Messages, model.ChatMessage{From: "user", Text: fmt.Sprint(i)})
	}
	raw, _ := jsonx.Marshal(c)
	if err = store.Apply(context.Background(), []model.Doc{{Kind: "chat", ID: "c", Data: raw}}, nil, nil); err != nil {
		t.Fatal(err)
	}
	e, err := usecase.NewEngine(context.Background(), usecase.Options{Store: store, Git: repository.NewGit(data), Providers: noModels{}, DataDir: data, Log: zerolog.Nop()})
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	srv := httptest.NewServer(NewServer(e, claude, pickedFolder{}, repository.Terminals{}, []string{origin}, zerolog.Nop()).Handler())
	defer srv.Close()
	status, w := send(t, "GET", srv.URL+"/api/v1/world?chats=paged", "")
	if status != 200 {
		t.Fatalf("snapshot %d %v", status, w)
	}
	chat := w["chats"].(map[string]any)["c"].(map[string]any)
	if len(chat["messages"].([]any)) != 0 {
		t.Fatal("summary has messages")
	}
	version := chat["history"].(map[string]any)["version"].(string)
	conn, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(srv.URL, "http")+"/api/v1/events?chats=paged", http.Header{"Origin": []string{origin}})
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	_ = conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	var snapshot struct {
		Type  string `json:"type"`
		World struct {
			Chats map[string]usecase.ChatSummary `json:"chats"`
		} `json:"world"`
	}
	if err = conn.ReadJSON(&snapshot); err != nil {
		t.Fatal(err)
	}
	if snapshot.Type != "snapshot" || len(snapshot.World.Chats["c"].Messages) != 0 {
		t.Fatal("websocket sent full history")
	}
	status, _ = send(t, "PATCH", srv.URL+"/api/v1/chats/c/title", `{"title":"renamed"}`, "Content-Type", "application/json", "Origin", origin)
	if status != 204 {
		t.Fatalf("rename: %d", status)
	}
	var event usecase.Event
	if err = conn.ReadJSON(&event); err != nil {
		t.Fatal(err)
	}
	var renamed usecase.ChatSummary
	if len(event.Upserts) != 1 {
		t.Fatalf("unexpected event %+v", event)
	}
	if err = jsonx.Unmarshal(event.Upserts[0].Data, &renamed); err != nil {
		t.Fatal(err)
	}
	if len(renamed.Messages) != 0 || renamed.History.Version != version || renamed.Title != "renamed" {
		t.Fatal("bad summary patch")
	}

	for _, tc := range []struct {
		query  string
		status int
	}{
		{"before=201&limit=100&version=" + version, 200},
		{"before=101&version=" + version, 200},
		{"before=0", 200}, {"before=-1", 400}, {"before=999", 400}, {"before=1&limit=101", 400},
		{"before=x", 400}, {"before=1&limit=x", 400}, {"before=1&version=old", 409},
	} {
		status, page := send(t, "GET", srv.URL+"/api/v1/chats/c/messages?"+tc.query, "")
		if status != tc.status {
			t.Fatalf("%s: %d %v", tc.query, status, page)
		}
		if status == 200 && len(page["messages"].([]any)) > 100 {
			t.Fatal("unbounded page")
		}
	}
	status, _ = send(t, "GET", srv.URL+"/api/v1/chats/missing/messages?before=0", "")
	if status != 404 {
		t.Fatalf("missing: %d", status)
	}
	status, w = send(t, "GET", srv.URL+"/api/v1/world", "")
	if status != 200 || len(w["chats"].(map[string]any)["c"].(map[string]any)["messages"].([]any)) != 201 {
		t.Fatal("legacy snapshot changed")
	}
}
