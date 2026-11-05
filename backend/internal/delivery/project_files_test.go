package delivery

import (
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/yanun0323/Team-Work/internal/model"
)

func TestProjectBrowserHTTPContract(t *testing.T) {
	folder := t.TempDir()
	t.Setenv("HOME", folder)
	srv := setup(t)
	api := srv.URL + "/api/v1"
	encoded, _ := json.Marshal(map[string]string{"name": "files", "folder": folder})
	status, team := send(t, "POST", api+"/teams", string(encoded))
	if status != 201 {
		t.Fatalf("%d %+v", status, team)
	}
	base := api + "/teams/" + team["id"].(string)
	call := func(method, endpoint string, payload any, status int, code string) map[string]any {
		t.Helper()
		raw := ""
		if payload != nil {
			b, err := json.Marshal(payload)
			if err != nil {
				t.Fatal(err)
			}
			raw = string(b)
		}
		got, body := send(t, method, endpoint, raw)
		if got != status {
			t.Fatalf("%s %s: %d %+v; want %d", method, endpoint, got, body, status)
		}
		if code != "" {
			failure, ok := body["error"].(map[string]any)
			if !ok || failure["code"] != code || failure["message"] == "" {
				t.Fatalf("error envelope: %+v", body)
			}
		}
		return body
	}
	create := func(parent, name, kind string) map[string]string {
		return map[string]string{"parent": parent, "name": name, "kind": kind}
	}
	save := func(path, text, hash string) map[string]string {
		return map[string]string{"path": path, "text": text, "hash": hash}
	}
	dir := call("POST", base+"/tree", create("", "empty", "dir"), 201, "")
	if dir["path"] != "empty" || dir["kind"] != "dir" || dir["name"] != "empty" {
		t.Fatalf("%+v", dir)
	}
	tree := call("GET", base+"/tree?path=empty", nil, 200, "")
	entries, ok := tree["entries"].([]any)
	if !ok || len(entries) != 0 || tree["truncated"] != false {
		t.Fatalf("%+v", tree)
	}
	entry := call("POST", base+"/tree", create("empty", "note.txt", "file"), 201, "")
	if entry["path"] != "empty/note.txt" {
		t.Fatalf("%+v", entry)
	}
	read := call("GET", base+"/file?path=empty/note.txt", nil, 200, "")
	emptyHash := fmt.Sprintf("%x", sha256.Sum256(nil))
	if read["text"] != "" || read["hash"] != emptyHash {
		t.Fatalf("%+v", read)
	}
	body := "原文\r\n"
	saved := call("PUT", base+"/file", save("empty/note.txt", body, emptyHash), 200, "")
	hash := fmt.Sprintf("%x", sha256.Sum256([]byte(body)))
	if saved["hash"] != hash {
		t.Fatalf("%+v", saved)
	}
	airport := call("GET", api+"/airport/file?path=empty/note.txt", nil, 200, "")
	if airport["hash"] != hash || airport["text"] != body {
		t.Fatalf("%+v", airport)
	}
	call("PUT", base+"/file", save("empty/note.txt", "stale", emptyHash), 409, model.CodeConflict)
	call("PUT", base+"/file", save("absent", "stale", hash), 409, model.CodeConflict)
	call("PUT", base+"/file", save("empty", "dir", hash), 400, model.CodeInvalid)
	call("PUT", base+"/file", save("empty/note.txt", "no hash", ""), 400, model.CodeInvalid)
	call("PUT", base+"/file", map[string]string{"path": "empty/note.txt", "hash": hash}, 400, model.CodeInvalid)
	call("PUT", base+"/file", map[string]any{"path": "empty/note.txt", "hash": hash, "text": nil}, 400, model.CodeInvalid)
	call("PUT", base+"/file", save("empty/note.txt", strings.Repeat("x", 1<<20+1), hash), 400, model.CodeInvalid)
	call("POST", base+"/tree", create("", "empty", "dir"), 409, model.CodeConflict)
	call("POST", base+"/tree", create("", "../bad", "file"), 400, model.CodeInvalid)
	call("POST", base+"/tree", create("absent", "new", "file"), 404, model.CodeNotFound)
	call("POST", base+"/tree", create("empty/note.txt", "new", "file"), 400, model.CodeInvalid)
	call("GET", base+"/tree?path=absent", nil, 404, model.CodeNotFound)
	call("GET", base+"/tree?path=empty/note.txt", nil, 400, model.CodeInvalid)
	call("GET", api+"/teams/absent/tree", nil, 404, model.CodeNotFound)
	call("POST", api+"/teams/absent/tree", create("", "new", "file"), 404, model.CodeNotFound)
	call("PUT", api+"/teams/absent/file", save("note", "new", hash), 404, model.CodeNotFound)
	for _, methodPath := range [][2]string{{"POST", "/tree"}, {"PUT", "/file"}} {
		status, body := send(t, methodPath[0], base+methodPath[1], "{broken")
		if status != 400 || body["error"].(map[string]any)["code"] != model.CodeInvalid {
			t.Fatalf("%d %+v", status, body)
		}
	}
	for name, raw := range map[string][]byte{"binary": {0, 1}, "nonutf8": {0xff}, "large": []byte(strings.Repeat("x", 1<<20+1))} {
		if err := os.WriteFile(filepath.Join(folder, name), raw, 0644); err != nil {
			t.Fatal(err)
		}
		call("GET", base+"/file?path="+name, nil, 415, model.CodeUnsupported)
		call("GET", api+"/airport/file?path="+name, nil, 415, model.CodeUnsupported)
		call("PUT", base+"/file", save(name, "new", fmt.Sprintf("%x", sha256.Sum256(raw))), 415, model.CodeUnsupported)
	}
	outside := t.TempDir()
	if err := os.Symlink(outside, filepath.Join(folder, "away")); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(outside, "note"), []byte(body), 0644); err != nil {
		t.Fatal(err)
	}
	for _, rel := range []string{"../", outside, "away"} {
		call("GET", base+"/tree?path="+url.QueryEscape(rel), nil, 400, model.CodeInvalid)
		call("POST", base+"/tree", create(rel, "new", "file"), 400, model.CodeInvalid)
		call("PUT", base+"/file", save(rel+"/note", "escape", hash), 400, model.CodeInvalid)
	}
	// No browser mutations are exposed for the airport.
	call("PUT", api+"/airport/file", save("note", "new", hash), 405, model.CodeInvalid)
	// A missing project root is an error, not an empty tree.
	if err := os.Rename(folder, folder+"-moved"); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := os.Rename(folder+"-moved", folder); err != nil {
			t.Error(err)
		}
	})
	call("GET", base+"/tree", nil, 400, model.CodeInvalid)
}

func TestProjectBrowserWriteFailureLeavesOriginalIntact(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("root bypasses directory permissions")
	}
	folder := t.TempDir()
	srv := setup(t)
	encoded, _ := json.Marshal(map[string]string{"name": "readonly", "folder": folder})
	status, team := send(t, "POST", srv.URL+"/api/v1/teams", string(encoded))
	if status != 201 {
		t.Fatalf("%d %+v", status, team)
	}
	base := srv.URL + "/api/v1/teams/" + team["id"].(string)
	at := filepath.Join(folder, "original")
	if err := os.WriteFile(at, []byte("original"), 0644); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(folder, 0555); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := os.Chmod(folder, 0755); err != nil {
			t.Error(err)
		}
	})
	payload, _ := json.Marshal(map[string]string{"path": "original", "text": "replacement", "hash": fmt.Sprintf("%x", sha256.Sum256([]byte("original")))})
	for _, request := range []struct{ method, route, body string }{
		{"PUT", "/file", string(payload)},
		{"POST", "/tree", `{"name":"new","kind":"file"}`},
		{"POST", "/tree", `{"name":"new","kind":"dir"}`},
	} {
		status, body := send(t, request.method, base+request.route, request.body)
		if status != 502 || body["error"].(map[string]any)["code"] != model.CodeUnavailable {
			t.Fatalf("%d %+v", status, body)
		}
	}
	raw, err := os.ReadFile(at)
	if err != nil || string(raw) != "original" {
		t.Fatalf("%q %v", raw, err)
	}
	entries, err := os.ReadDir(folder)
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), ".team-work-save-") || entry.Name() == "new" {
			t.Fatalf("leftover: %s", entry.Name())
		}
	}
	if err := os.Chmod(folder, 0000); err != nil {
		t.Fatal(err)
	}
	status, body := send(t, "GET", base+"/tree", "")
	if status != 502 || body["error"].(map[string]any)["code"] != model.CodeUnavailable {
		t.Fatalf("%d %+v", status, body)
	}
}
