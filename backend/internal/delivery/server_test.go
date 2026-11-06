package delivery

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/rs/zerolog"

	"github.com/yanun0323/Team-Work/internal/adapter"
	"github.com/yanun0323/Team-Work/internal/model"
	"github.com/yanun0323/Team-Work/internal/repository"
	"github.com/yanun0323/Team-Work/internal/usecase"
)

type noModels struct{}

func (noModels) Complete(context.Context, model.ModelRequest, func(string)) (model.ModelReply, error) {
	return model.ModelReply{}, model.Errorf(model.CodeInvalid, "no")
}
func (noModels) Models(context.Context) ([]model.ModelSpec, error) {
	return []model.ModelSpec{{ID: "m"}}, nil
}
func (n noModels) For(model.ModelProvider, string) (adapter.Provider, error) { return n, nil }
func (noModels) Login(context.Context, model.ModelProvider, string) (*adapter.LoginFlow, error) {
	return &adapter.LoginFlow{Prompt: model.LoginPrompt{Method: "browser", URL: "https://login"},
		Wait:  func(ctx context.Context) error { <-ctx.Done(); return ctx.Err() },
		Paste: func(string) error { return nil }}, nil
}
func (noModels) Logout(context.Context, model.ModelProvider) error { return nil }
func (noModels) Images(model.ModelProvider) (adapter.ImageMaker, error) {
	return nil, model.Errorf(model.CodeInvalid, "no images")
}

const origin = "http://localhost:5173"

// fakeClaude records what was asked of it; nothing is ever installed.
type fakeClaude struct {
	installs, logins int
	installed        bool
	loginErr         error
}

func (f *fakeClaude) Status(context.Context) (adapter.ClaudeStatus, error) {
	return adapter.ClaudeStatus{Installed: f.installed, SignedIn: f.logins > 0, Models: []string{}}, nil
}
func (f *fakeClaude) Install(context.Context) error { f.installs++; f.installed = true; return nil }
func (f *fakeClaude) Login(context.Context) error   { f.logins++; return f.loginErr }

var claude = &fakeClaude{}

type pickedFolder struct{}

func (pickedFolder) PickFolder(context.Context) (string, error) { return "/Users/me/shop", nil }
func (pickedFolder) OpenFolder(_ context.Context, path string) error {
	opened = path
	return nil
}

var opened string

func TestPickFolderGivesTheFullPath(t *testing.T) {
	srv := setup(t)
	code, body := send(t, "POST", srv.URL+"/api/v1/folder-picker", "")
	if code != http.StatusOK || body["path"] != "/Users/me/shop" {
		t.Fatalf("%d %s", code, body)
	}
}

func setup(t *testing.T) *httptest.Server {
	t.Helper()
	data := t.TempDir()
	store, err := repository.NewStore(data)
	if err != nil {
		t.Fatal(err)
	}
	e, err := usecase.NewEngine(context.Background(), usecase.Options{Store: store, Git: repository.NewGit(data), Providers: noModels{}, DataDir: data, Log: zerolog.Nop()})
	if err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(NewServer(e, claude, pickedFolder{}, repository.Terminals{}, []string{origin}, zerolog.Nop()).Handler())
	t.Cleanup(func() { srv.Close(); e.Close(); store.Close() })
	return srv
}

func send(t *testing.T, method, url, body string, headers ...string) (int, map[string]any) {
	t.Helper()
	req, err := http.NewRequest(method, url, strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i+1 < len(headers); i += 2 {
		req.Header.Set(headers[i], headers[i+1])
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	var out map[string]any
	_ = json.NewDecoder(res.Body).Decode(&out)
	return res.StatusCode, out
}

func TestAirportFilesEmptyResultsAreArrays(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	srv := setup(t)
	for _, query := range []string{"", ".", "。", "no-match", "missing/", "../", "/etc/"} {
		t.Run(query, func(t *testing.T) {
			res, err := http.Get(srv.URL + "/api/v1/airport/files?q=" + url.QueryEscape(query))
			if err != nil {
				t.Fatal(err)
			}
			defer res.Body.Close()
			body, err := io.ReadAll(res.Body)
			if err != nil {
				t.Fatal(err)
			}
			if res.StatusCode != http.StatusOK || strings.TrimSpace(string(body)) != "[]" {
				t.Fatalf("got HTTP %d %s, want HTTP 200 []", res.StatusCode, body)
			}
		})
	}
}

func TestCreateTeam(t *testing.T) {
	srv := setup(t)
	api := srv.URL + "/api/v1"
	folder, _ := json.Marshal(t.TempDir())

	code, team := send(t, "POST", api+"/teams", `{"name":"公司","folder":`+string(folder)+`}`)
	if code != http.StatusCreated || team["targetBranch"] != "master" || team["initializedGit"] != true {
		t.Fatalf("%d %v", code, team)
	}
	code, body := send(t, "POST", api+"/teams", `{"name":"","folder":"/x"}`)
	if code != http.StatusBadRequest || body["error"].(map[string]any)["code"] != model.CodeInvalid {
		t.Fatalf("%d %v", code, body)
	}
	if code, _ := send(t, "POST", api+"/teams", `{bad`); code != http.StatusBadRequest {
		t.Fatalf("broken JSON: %d", code)
	}
	if code, _ := send(t, "DELETE", api+"/teams/nope", ""); code != http.StatusNotFound {
		t.Fatalf("missing team: %d", code)
	}
}

func TestBranches(t *testing.T) {
	srv := setup(t)
	api := srv.URL + "/api/v1"
	folder := t.TempDir()
	_, got := send(t, "GET", api+"/branches?folder="+url.QueryEscape(folder), "")
	if got["repo"] != false {
		t.Fatalf("%v", got)
	}
	if entries, _ := os.ReadDir(folder); len(entries) != 0 {
		t.Fatal("looking changed the folder")
	}
	raw, _ := json.Marshal(folder)
	if code, _ := send(t, "POST", api+"/teams", `{"name":"c","folder":`+string(raw)+`}`); code != http.StatusCreated {
		t.Fatal(code)
	}
	_, got = send(t, "GET", api+"/branches?folder="+url.QueryEscape(folder), "")
	if got["repo"] != true || got["branches"].([]any)[0] != "master" {
		t.Fatalf("%v", got)
	}
	if _, got = send(t, "GET", api+"/branches?folder=relative/path", ""); got["repo"] != false {
		t.Fatalf("%v", got)
	}
}

func TestDuplicateAndEditing(t *testing.T) {
	srv := setup(t)
	api := srv.URL + "/api/v1"
	code, made := send(t, "POST", api+"/workflows", `{"name":"修 Bug"}`)
	if code != http.StatusCreated {
		t.Fatalf("%d %v", code, made)
	}
	wf := made["id"].(string)
	code, copied := send(t, "POST", api+"/workflows/"+wf+"/duplicate", "")
	if code != http.StatusCreated || copied["name"] != "修 Bug-1" {
		t.Fatalf("%d %v", code, copied)
	}
	_, copied = send(t, "POST", api+"/workflows/"+wf+"/duplicate", "")
	if copied["name"] != "修 Bug-2" {
		t.Fatalf("%v", copied)
	}
	if code, _ := send(t, "POST", api+"/workflows/nope/duplicate", ""); code != http.StatusNotFound {
		t.Fatal(code)
	}
	if code, _ := send(t, "PATCH", api+"/tasks/nope", `{"title":"x"}`); code != http.StatusNotFound {
		t.Fatal(code)
	}
}

func TestProviderKeyIsOnlyHinted(t *testing.T) {
	srv := setup(t)
	api := srv.URL + "/api/v1"
	code, p := send(t, "POST", api+"/providers", `{"name":"p","kind":"compatible","baseUrl":"http://x","login":{"kind":"apiKey","apiKey":"sk-abcd1234"}}`)
	if code != http.StatusCreated {
		t.Fatalf("%d %v", code, p)
	}
	if p["auth"].(map[string]any)["keyHint"] != "1234" {
		t.Fatalf("%v", p)
	}
	_, world := send(t, "GET", api+"/world", "")
	raw, _ := json.Marshal(world)
	if strings.Contains(string(raw), "sk-abcd") {
		t.Fatal("key sent to a client")
	}
	if code, _ := send(t, "POST", api+"/providers", `{"name":"p","kind":"compatible","login":{"kind":"apiKey","apiKey":" "}}`); code != http.StatusBadRequest {
		t.Fatalf("empty key: %d", code)
	}
}

func TestSubscriptionLoginEndpoints(t *testing.T) {
	srv := setup(t)
	api := srv.URL + "/api/v1"
	code, p := send(t, "POST", api+"/providers", `{"name":"訂閱","kind":"openai","login":{"kind":"subscription"}}`)
	if code != http.StatusCreated {
		t.Fatalf("%d %v", code, p)
	}
	id := p["id"].(string)
	code, prompt := send(t, "POST", api+"/providers/"+id+"/login", `{"method":"browser"}`)
	if code != http.StatusCreated || prompt["url"] != "https://login" {
		t.Fatalf("%d %v", code, prompt)
	}
	if code, _ := send(t, "POST", api+"/providers/"+id+"/login", `{"method":"carrier-pigeon"}`); code != http.StatusBadRequest {
		t.Fatalf("bad method: %d", code)
	}
	if code, _ := send(t, "POST", api+"/providers/"+id+"/login/paste", `{"value":"x"}`); code != http.StatusNoContent {
		t.Fatalf("paste: %d", code)
	}
	if code, _ := send(t, "DELETE", api+"/providers/"+id+"/login", ""); code != http.StatusNoContent {
		t.Fatalf("cancel: %d", code)
	}
	if code, _ := send(t, "POST", api+"/providers/"+id+"/login/paste", `{"value":"x"}`); code != http.StatusConflict {
		t.Fatalf("paste with no login: %d", code)
	}
	if code, _ := send(t, "POST", api+"/providers/"+id+"/logout", ""); code != http.StatusNoContent {
		t.Fatalf("logout: %d", code)
	}
	if code, _ := send(t, "POST", api+"/providers/nope/login", `{}`); code != http.StatusNotFound {
		t.Fatalf("missing: %d", code)
	}
	code, q := send(t, "POST", api+"/providers", `{"name":"k","kind":"compatible","baseUrl":"http://x","login":{"kind":"apiKey","apiKey":"k"}}`)
	if code != http.StatusCreated {
		t.Fatal(code)
	}
	if code, _ := send(t, "POST", api+"/providers/"+q["id"].(string)+"/login", `{}`); code != http.StatusConflict {
		t.Fatalf("a key provider: %d", code)
	}
	if code, _ := send(t, "POST", api+"/providers/"+q["id"].(string)+"/models", ""); code != http.StatusNoContent {
		t.Fatalf("refresh: %d", code)
	}
}

func TestClaudeCodeEndpoints(t *testing.T) {
	*claude = fakeClaude{}
	srv := setup(t)
	api := srv.URL + "/api/v1/claude-code"
	code, status := send(t, "GET", api, "")
	if code != http.StatusOK || status["installed"] != false {
		t.Fatalf("%d %v", code, status)
	}
	// installing needs the user's word
	for _, body := range []string{``, `{}`, `{"consent":false}`, `{"consent":"yes"}`} {
		if code, _ := send(t, "POST", api+"/install", body); code != http.StatusBadRequest {
			t.Fatalf("%q: %d", body, code)
		}
	}
	if claude.installs != 0 {
		t.Fatal("installed without consent")
	}
	// nor can another website ask, even with it
	if code, _ := send(t, "POST", api+"/install", `{"consent":true}`, "Origin", "https://evil.example"); code != http.StatusForbidden || claude.installs != 0 {
		t.Fatalf("foreign site: %d", code)
	}
	if code, _ := send(t, "POST", api+"/install", `{"consent":true}`, "Origin", origin); code != http.StatusNoContent || claude.installs != 1 {
		t.Fatalf("%d", code)
	}
	if code, _ := send(t, "POST", api+"/login", ""); code != http.StatusNoContent || claude.logins != 1 {
		t.Fatalf("%d", code)
	}
	claude.loginErr = model.Errorf(model.CodeInvalid, "登入沒有完成")
	if code, body := send(t, "POST", api+"/login", ""); code != http.StatusBadRequest || body["error"].(map[string]any)["message"] != "登入沒有完成" {
		t.Fatalf("%d %v", code, body)
	}
}

// waitingClaude blocks until its request ends, the way a long install or sign-in does.
type waitingClaude struct {
	fakeClaude
	started, stopped chan string
}

func (w *waitingClaude) wait(ctx context.Context, name string) error {
	w.started <- name
	<-ctx.Done()
	w.stopped <- name
	return ctx.Err()
}
func (w *waitingClaude) Install(ctx context.Context) error { return w.wait(ctx, "install") }
func (w *waitingClaude) Login(ctx context.Context) error   { return w.wait(ctx, "login") }

func TestClientLeavingStopsInstallAndLogin(t *testing.T) {
	data := t.TempDir()
	store, err := repository.NewStore(data)
	if err != nil {
		t.Fatal(err)
	}
	e, err := usecase.NewEngine(context.Background(), usecase.Options{Store: store, Git: repository.NewGit(data), Providers: noModels{}, DataDir: data, Log: zerolog.Nop()})
	if err != nil {
		t.Fatal(err)
	}
	w := &waitingClaude{started: make(chan string, 1), stopped: make(chan string, 1)}
	srv := httptest.NewServer(NewServer(e, w, pickedFolder{}, repository.Terminals{}, []string{origin}, zerolog.Nop()).Handler())
	defer func() { srv.Close(); e.Close(); store.Close() }()

	for _, tc := range []struct{ path, body, name string }{{"/install", `{"consent":true}`, "install"}, {"/login", `{}`, "login"}} {
		ctx, cancel := context.WithCancel(context.Background())
		req, _ := http.NewRequestWithContext(ctx, "POST", srv.URL+"/api/v1/claude-code"+tc.path, strings.NewReader(tc.body))
		gone := make(chan struct{})
		go func() {
			if res, err := http.DefaultClient.Do(req); err == nil {
				res.Body.Close()
			}
			close(gone)
		}()
		if got := <-w.started; got != tc.name {
			t.Fatal(got)
		}
		cancel()
		<-gone
		select {
		case <-w.stopped:
		case <-time.After(3 * time.Second):
			t.Fatalf("%s kept running after the client left", tc.name)
		}
	}
}

func TestConflictingActionsAreRefused(t *testing.T) {
	srv := setup(t)
	if code, _ := send(t, "POST", srv.URL+"/api/v1/tasks/nope/merge", ""); code != http.StatusNotFound {
		t.Fatalf("%d", code)
	}
	if code, _ := send(t, "POST", srv.URL+"/api/v1/subtasks/nope/talk", `{"text":"x"}`); code != http.StatusNotFound {
		t.Fatalf("%d", code)
	}
}

func TestOtherWebsitesAreKeptOut(t *testing.T) {
	srv := setup(t)
	world := srv.URL + "/api/v1/world"
	if code, _ := send(t, "GET", world, "", "Origin", "https://evil.example"); code != http.StatusForbidden {
		t.Fatalf("foreign origin: %d", code)
	}
	if code, _ := send(t, "GET", world, "", "Origin", origin); code != http.StatusOK {
		t.Fatalf("own origin: %d", code)
	}
	if code, _ := send(t, "OPTIONS", world, "", "Origin", origin); code != http.StatusNoContent {
		t.Fatalf("preflight: %d", code)
	}
	// DNS rebinding: a foreign name resolving to this computer
	req, _ := http.NewRequest("GET", world, nil)
	req.Host = "evil.example:8787"
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != http.StatusForbidden {
		t.Fatalf("foreign host: %d", res.StatusCode)
	}
	url := "ws" + strings.TrimPrefix(srv.URL, "http") + "/api/v1/events"
	if _, res, err := websocket.DefaultDialer.Dial(url, http.Header{"Origin": {"https://evil.example"}}); err == nil || res.StatusCode != http.StatusForbidden {
		t.Fatalf("foreign websocket: %v %v", err, res)
	}
}

func TestEventsSendSnapshotThenChanges(t *testing.T) {
	srv := setup(t)
	url := "ws" + strings.TrimPrefix(srv.URL, "http") + "/api/v1/events"
	conn, _, err := websocket.DefaultDialer.Dial(url, http.Header{"Origin": {origin}})
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	var first struct {
		Type  string `json:"type"`
		World struct {
			Teams map[string]any `json:"teams"`
		} `json:"world"`
	}
	if err := conn.ReadJSON(&first); err != nil || first.Type != "snapshot" || first.World.Teams == nil {
		t.Fatalf("%v %+v", err, first)
	}
	folder, _ := json.Marshal(t.TempDir())
	if code, _ := send(t, "POST", srv.URL+"/api/v1/teams", `{"name":"公司","folder":`+string(folder)+`}`); code != http.StatusCreated {
		t.Fatal(code)
	}
	var ev usecase.Event
	if err := conn.ReadJSON(&ev); err != nil || ev.Type != "patch" {
		t.Fatalf("%v %+v", err, ev)
	}
	kinds := map[string]bool{}
	for _, u := range ev.Upserts {
		kinds[u.Kind] = true
	}
	if !kinds["team"] {
		t.Fatalf("%v", kinds)
	}
}

func TestOpenSettingsFolderShowsTheDataDirectory(t *testing.T) {
	api := setup(t).URL + "/api/v1"
	opened = ""
	if code, body := send(t, "POST", api+"/settings/open-folder", ""); code != http.StatusNoContent {
		t.Fatalf("%d %v", code, body)
	}
	if _, err := os.Stat(filepath.Join(opened, "data.db")); err != nil {
		t.Fatalf("%q is not the data directory: %v", opened, err)
	}
}

func TestGlobalPromptEndpoints(t *testing.T) {
	api := setup(t).URL + "/api/v1"
	if code, body := send(t, "GET", api+"/settings/global-prompt", ""); code != http.StatusOK || body["prompt"] != "" {
		t.Fatalf("%d %v", code, body)
	}
	if code, body := send(t, "PUT", api+"/settings/global-prompt", `{"prompt":"規則"}`, "Content-Type", "application/json"); code != http.StatusNoContent {
		t.Fatalf("%d %v", code, body)
	}
	if code, body := send(t, "GET", api+"/settings/global-prompt", ""); code != http.StatusOK || body["prompt"] != "規則" {
		t.Fatalf("%d %v", code, body)
	}
}

func TestNotesEndpoints(t *testing.T) {
	api := setup(t).URL + "/api/v1"
	folder, _ := json.Marshal(t.TempDir())
	_, team := send(t, "POST", api+"/teams", `{"name":"c","folder":`+string(folder)+`}`)
	notes := api + "/teams/" + team["id"].(string) + "/notes"
	if code, body := send(t, "GET", notes, ""); code != http.StatusOK || body["text"] != "" {
		t.Fatalf("%d %v", code, body)
	}
	if code, body := send(t, "PUT", notes, `{"text":"筆記"}`, "Content-Type", "application/json"); code != http.StatusNoContent {
		t.Fatalf("%d %v", code, body)
	}
	if code, body := send(t, "GET", notes, ""); code != http.StatusOK || body["text"] != "筆記" {
		t.Fatalf("%d %v", code, body)
	}
	if code, _ := send(t, "GET", api+"/teams/nope/notes", ""); code != http.StatusNotFound {
		t.Fatal(code)
	}
}

func TestOpenFolderShowsTheCompanysFolder(t *testing.T) {
	api := setup(t).URL + "/api/v1"
	dir := t.TempDir()
	folder, _ := json.Marshal(dir)
	_, team := send(t, "POST", api+"/teams", `{"name":"c","folder":`+string(folder)+`}`)
	if code, body := send(t, "POST", api+"/teams/"+team["id"].(string)+"/open-folder", ""); code != http.StatusNoContent || opened != dir {
		t.Fatalf("%d %v %q", code, body, opened)
	}
	if code, _ := send(t, "POST", api+"/teams/nope/open-folder", ""); code != http.StatusNotFound {
		t.Fatal(code)
	}
}

func TestChatEndpoints(t *testing.T) {
	api := setup(t).URL + "/api/v1"
	for _, tt := range []struct{ method, path, body string }{
		{"GET", "/teams/nope/uncommitted", ""},
		{"GET", "/teams/nope/files", ""},
		{"GET", "/replicas/nope/skills", ""},
		{"POST", "/chats", `{"teamId":"nope","replicaId":"nope","text":"hi"}`},
		{"POST", "/chats/nope/say", `{"text":"hi"}`},
		{"POST", "/chats/nope/stop", ""},
		{"POST", "/chats/nope/rewind", `{"index":0}`},
		{"POST", "/chats/nope/task-draft", ""},
		{"DELETE", "/chats/nope", ""},
	} {
		if code, body := send(t, tt.method, api+tt.path, tt.body); code != http.StatusNotFound {
			t.Fatalf("%s %s: %d %v", tt.method, tt.path, code, body)
		}
	}
}

func TestReloadSettingsEndpoint(t *testing.T) {
	data := t.TempDir()
	store, err := repository.NewStore(data)
	if err != nil {
		t.Fatal(err)
	}
	e, err := usecase.NewEngine(context.Background(), usecase.Options{Store: store, Git: repository.NewGit(data), Providers: noModels{}, DataDir: data, Log: zerolog.Nop()})
	if err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(NewServer(e, claude, pickedFolder{}, repository.Terminals{}, []string{origin}, zerolog.Nop()).Handler())
	defer func() { srv.Close(); e.Close(); store.Close() }()
	if _, err := e.CreateWorkflow("mine"); err != nil {
		t.Fatal(err)
	}
	snapshot, err := store.LoadSettings(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	var settings model.Settings
	if err := json.Unmarshal(snapshot.Data, &settings); err != nil {
		t.Fatal(err)
	}
	var id string
	for key, wf := range settings.Workflows {
		id = key
		wf.Name = "JSON flow"
		break
	}
	path := filepath.Join(data, "workflows", id+".yaml")
	// JSON is a valid YAML document too.
	edited, _ := json.Marshal(settings.Workflows[id])
	if err := os.WriteFile(path, edited, 0o600); err != nil {
		t.Fatal(err)
	}
	api := srv.URL + "/api/v1"
	code, body := send(t, "POST", api+"/settings/reload", "")
	if code != http.StatusNoContent {
		t.Fatalf("%d %v", code, body)
	}
	_, world := send(t, "GET", api+"/world", "")
	if world["workflows"].(map[string]any)[id].(map[string]any)["name"] != "JSON flow" {
		t.Fatal("reload not visible")
	}
	if err := os.WriteFile(path, []byte(`{"version":1,"unknown":true}`), 0o600); err != nil {
		t.Fatal(err)
	}
	code, body = send(t, "POST", api+"/settings/reload", "")
	if code != http.StatusBadRequest || !strings.Contains(body["error"].(map[string]any)["message"].(string), "unknown") {
		t.Fatalf("%d %v", code, body)
	}
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	code, _ = send(t, "POST", api+"/settings/reload", "")
	if code != http.StatusBadRequest {
		t.Fatalf("missing settings: %d", code)
	}
	_, world = send(t, "GET", api+"/world", "")
	if world["workflows"].(map[string]any)[id].(map[string]any)["name"] != "JSON flow" {
		t.Fatal("invalid reload changed world")
	}
}

func TestTeamHealth(t *testing.T) {
	srv := setup(t)
	if code, _ := send(t, "GET", srv.URL+"/api/v1/teams/nobody/health", ""); code != http.StatusNotFound {
		t.Fatalf("unknown company: %d", code)
	}
	folder := t.TempDir()
	raw, _ := json.Marshal(folder)
	code, team := send(t, "POST", srv.URL+"/api/v1/teams", `{"name":"公司","folder":`+string(raw)+`}`)
	if code != http.StatusCreated {
		t.Fatal(code, team)
	}
	url := srv.URL + "/api/v1/teams/" + team["id"].(string) + "/health"
	expect := func(what string, want map[string]any) {
		t.Helper()
		code, got := send(t, "GET", url, "")
		if code != http.StatusOK {
			t.Fatalf("%s: %d", what, code)
		}
		for k, v := range want {
			if got[k] != v {
				t.Fatalf("%s: %v", what, got)
			}
		}
	}
	expect("a new company", map[string]any{"git": true, "folder": true, "repo": true, "targetBranch": true})
	if err := os.RemoveAll(filepath.Join(folder, ".git")); err != nil {
		t.Fatal(err)
	}
	expect("the repo removed", map[string]any{"folder": true, "repo": false, "targetBranch": false})
	if err := os.RemoveAll(folder); err != nil {
		t.Fatal(err)
	}
	expect("the folder removed", map[string]any{"folder": false, "repo": false, "targetBranch": false})
}

// countingGit counts the times the files of a commit were added up.
type countingGit struct {
	*repository.Git
	sums int
}

func (g *countingGit) TreeBytes(ctx context.Context, folder, commit string) (int64, error) {
	g.sums++
	return g.Git.TreeBytes(ctx, folder, commit)
}

// A project's size is what git records for the files on the target branch, added up once per commit.
func TestProjectSize(t *testing.T) {
	data := t.TempDir()
	store, err := repository.NewStore(data)
	if err != nil {
		t.Fatal(err)
	}
	git := &countingGit{Git: repository.NewGit(data)}
	e, err := usecase.NewEngine(context.Background(), usecase.Options{Store: store, Git: git, Providers: noModels{}, DataDir: data, Log: zerolog.Nop()})
	if err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(NewServer(e, claude, pickedFolder{}, repository.Terminals{}, []string{origin}, zerolog.Nop()).Handler())
	defer func() { srv.Close(); e.Close(); store.Close() }()
	api := srv.URL + "/api/v1"
	if code, _ := send(t, "GET", api+"/teams/nobody/size", ""); code != http.StatusNotFound {
		t.Fatalf("unknown company: %d", code)
	}
	folder := t.TempDir()
	raw, _ := json.Marshal(folder)
	code, team := send(t, "POST", api+"/teams", `{"name":"公司","folder":`+string(raw)+`}`)
	if code != http.StatusCreated {
		t.Fatal(code, team)
	}
	url := api + "/teams/" + team["id"].(string) + "/size"
	expect := func(what string, want float64) {
		t.Helper()
		code, got := send(t, "GET", url, "")
		if code != http.StatusOK || got["bytes"] != want {
			t.Fatalf("%s: %d %v, want %v bytes", what, code, got, want)
		}
	}
	gitIn := func(args ...string) {
		t.Helper()
		cmd := exec.Command("git", append([]string{"-c", "user.name=t", "-c", "user.email=t@t"}, args...)...)
		cmd.Dir = folder
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
	}
	write := func(name string, size int) {
		t.Helper()
		if err := os.MkdirAll(filepath.Dir(filepath.Join(folder, name)), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(folder, name), make([]byte, size), 0o644); err != nil {
			t.Fatal(err)
		}
	}

	expect("a new repo", 0)
	write("a.txt", 1000)
	write("sub/b.bin", 234)
	expect("files not committed", 0)
	gitIn("add", "-A")
	gitIn("commit", "-q", "-m", "files")
	expect("files committed", 1234)
	sums := git.sums
	expect("the same commit", 1234)
	if git.sums != sums {
		t.Fatal("the same commit was added up again")
	}

	// only the target branch counts, whichever is checked out
	gitIn("checkout", "-q", "-b", "side")
	write("c.txt", 66)
	gitIn("add", "-A")
	gitIn("commit", "-q", "-m", "side")
	expect("a commit on another branch", 1234)
	gitIn("checkout", "-q", "master")
	gitIn("merge", "-q", "side")
	expect("merged into the target", 1300)

	if err := os.RemoveAll(folder); err != nil {
		t.Fatal(err)
	}
	expect("the folder removed", 0)
}

// noGit is a computer whose git can be taken away, and which counts the times its installer was opened.
type noGit struct {
	*repository.Git
	missing  bool
	installs int
}

func (g *noGit) Tool(ctx context.Context) adapter.GitStatus {
	if g.missing {
		return adapter.GitStatus{Installable: true}
	}
	return g.Git.Tool(ctx)
}

func (g *noGit) InstallTool(context.Context) error { g.installs++; return nil }

func TestWithoutGit(t *testing.T) {
	data := t.TempDir()
	store, err := repository.NewStore(data)
	if err != nil {
		t.Fatal(err)
	}
	git := &noGit{Git: repository.NewGit(data)}
	e, err := usecase.NewEngine(context.Background(), usecase.Options{Store: store, Git: git, Providers: noModels{}, DataDir: data, Log: zerolog.Nop()})
	if err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(NewServer(e, claude, pickedFolder{}, repository.Terminals{}, []string{origin}, zerolog.Nop()).Handler())
	defer func() { srv.Close(); e.Close(); store.Close() }()
	api := srv.URL + "/api/v1"
	folder := t.TempDir()
	raw, _ := json.Marshal(folder)
	code, team := send(t, "POST", api+"/teams", `{"name":"公司","folder":`+string(raw)+`}`)
	if code != http.StatusCreated {
		t.Fatal(code, team)
	}

	git.missing = true
	if code, body := send(t, "GET", api+"/git", ""); code != http.StatusOK || body["installed"] != false || body["installable"] != true {
		t.Fatalf("status: %d %v", code, body)
	}
	// without git a folder cannot be told to be a repo, so it is not said to be none
	code, health := send(t, "GET", api+"/teams/"+team["id"].(string)+"/health", "")
	if code != http.StatusOK || health["git"] != false || health["folder"] != true {
		t.Fatalf("health: %d %v", code, health)
	}
	other, _ := json.Marshal(t.TempDir())
	code, body := send(t, "POST", api+"/teams", `{"name":"另一間","folder":`+string(other)+`}`)
	if code != http.StatusBadGateway || !strings.Contains(body["error"].(map[string]any)["message"].(string), "git") {
		t.Fatalf("create without git: %d %v", code, body)
	}

	if code, _ := send(t, "POST", api+"/git/install", `{}`); code != http.StatusBadRequest || git.installs != 0 {
		t.Fatalf("install without consent: %d, installs %d", code, git.installs)
	}
	if code, body := send(t, "POST", api+"/git/install", `{"consent":true}`); code != http.StatusNoContent || git.installs != 1 {
		t.Fatalf("install: %d %v, installs %d", code, body, git.installs)
	}
}

func TestUploadedAttachments(t *testing.T) {
	api := setup(t).URL + "/api/v1"
	content := strings.Repeat("x", 25<<20)
	code, body := send(t, "POST", api+"/attachments", content)
	if code != http.StatusCreated {
		t.Fatalf("upload: %d %v", code, body)
	}
	url := body["url"].(string)
	res, err := http.Get(strings.TrimSuffix(api, "/api/v1") + url)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	got, _ := io.ReadAll(res.Body)
	if res.StatusCode != http.StatusOK || string(got) != content || res.Header.Get("Content-Disposition") != "attachment" || res.Header.Get("Content-Type") != "application/octet-stream" {
		t.Fatalf("download: %d %d bytes %v", res.StatusCode, len(got), res.Header)
	}
	if code, body := send(t, "POST", api+"/attachments", content+"x"); code != http.StatusBadRequest {
		t.Fatalf("oversize: %d %v", code, body)
	}
	for _, hash := range []string{strings.Repeat("0", 64), "..%2F..%2Fsecrets"} {
		if code, _ := send(t, "GET", api+"/attachments/"+hash, ""); code != http.StatusNotFound {
			t.Fatalf("%s: %d", hash, code)
		}
	}
}

func TestFileAttachmentEndpoints(t *testing.T) {
	api := setup(t).URL + "/api/v1"
	post := func(path string, input any, status int) map[string]any {
		t.Helper()
		raw, _ := json.Marshal(input)
		code, body := send(t, "POST", api+path, string(raw))
		if code != status {
			t.Fatalf("%s: %d %v", path, code, body)
		}
		return body
	}
	team := post("/teams", map[string]any{"name": "files", "folder": t.TempDir()}, http.StatusCreated)
	post("/providers", map[string]any{"name": "fake", "kind": "compatible", "login": map[string]any{"kind": "apiKey", "apiKey": "test"}}, http.StatusCreated)
	bp := post("/blueprints", map[string]any{"name": "reader", "prompt": "read", "tools": []string{"readFile"}}, http.StatusCreated)
	employee := post("/replicas", map[string]any{"teamId": team["id"], "blueprintId": bp["id"], "name": "reader", "model": "m"}, http.StatusCreated)
	flow := post("/workflows", map[string]any{"name": "files"}, http.StatusCreated)
	files := []map[string]string{{"name": "empty.txt", "url": "data:text/plain;base64,"}}
	chat := post("/chats", map[string]any{"teamId": team["id"], "replicaId": employee["id"], "files": files}, http.StatusCreated)
	if len(chat["messages"].([]any)[0].(map[string]any)["files"].([]any)) != 1 {
		t.Fatal(chat)
	}
	id := chat["id"].(string)
	post("/chats/"+id+"/stop", nil, http.StatusNoContent)
	post("/chats/"+id+"/say", map[string]any{"files": files}, http.StatusNoContent)
	task := post("/tasks", map[string]any{"teamId": team["id"], "title": "files", "workflowId": flow["id"], "ownerId": employee["id"], "files": files,
		"staff": map[string]any{flow["nodes"].([]any)[0].(map[string]any)["id"].(string): []any{employee["id"]}}}, http.StatusCreated)
	if len(task["files"].([]any)) != 1 {
		t.Fatal(task)
	}
	bad := []map[string]string{{"name": "bad.txt", "url": "data:text/plain;base64,***"}}
	post("/chats", map[string]any{"teamId": team["id"], "replicaId": employee["id"], "files": bad}, http.StatusBadRequest)
	post("/chats/"+id+"/say", map[string]any{"files": bad}, http.StatusBadRequest)
	post("/tasks", map[string]any{"teamId": team["id"], "title": "bad", "workflowId": flow["id"], "ownerId": employee["id"], "files": bad}, http.StatusBadRequest)
}

func TestHireKeepsTheWardrobe(t *testing.T) {
	api := setup(t).URL + "/api/v1"
	post := func(path string, input any) map[string]any {
		t.Helper()
		raw, _ := json.Marshal(input)
		code, body := send(t, "POST", api+path, string(raw))
		if code != http.StatusCreated {
			t.Fatalf("%s: %d %v", path, code, body)
		}
		return body
	}
	team := post("/teams", map[string]any{"name": "looks", "folder": t.TempDir()})
	post("/providers", map[string]any{"name": "fake", "kind": "compatible", "login": map[string]any{"kind": "apiKey", "apiKey": "test"}})
	bp := post("/blueprints", map[string]any{"name": "dresser", "prompt": "dress"})
	look := map[string]any{"skin": "#f1c7a5", "hair": "#5a3a24", "shirt": "#3f7fd0", "pants": "#34405a", "extra": "flower", "style": 7, "wardrobe": 2}
	hired := post("/replicas", map[string]any{"teamId": team["id"], "blueprintId": bp["id"], "name": "Ada", "model": "m", "look": look})
	_, w := send(t, "GET", api+"/world", "")
	got := w["replicas"].(map[string]any)[hired["id"].(string)].(map[string]any)["look"].(map[string]any)
	if got["wardrobe"] != float64(2) || got["extra"] != "flower" {
		t.Fatalf("%v", got)
	}
}
