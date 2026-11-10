package delivery

import (
	"encoding/json"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"testing"

	"github.com/rs/zerolog"
)

func TestBrowseFolders(t *testing.T) {
	root := t.TempDir()
	for _, name := range []string{"z", "a", ".hidden", "empty"} {
		if err := os.Mkdir(filepath.Join(root, name), 0700); err != nil {
			t.Fatal(err)
		}
	}
	os.WriteFile(filepath.Join(root, "file"), []byte("x"), 0600)
	os.Symlink(filepath.Join(root, "a"), filepath.Join(root, "link"))
	os.Symlink(filepath.Join(root, "file"), filepath.Join(root, "file-link"))
	os.Symlink(filepath.Join(root, "missing"), filepath.Join(root, "broken"))
	s := NewServer(nil, nil, nil, nil, nil, zerolog.Nop())
	for _, test := range []struct {
		path   string
		status int
	}{{root, 200}, {filepath.Join(root, "empty"), 200}, {filepath.Join(root, "missing"), 404}, {filepath.Join(root, "file"), 400}, {"relative", 400}, {"", 200}, {"/", 200}} {
		w := httptest.NewRecorder()
		r := httptest.NewRequest("GET", "http://localhost/api/v1/folders?path="+url.QueryEscape(test.path), nil)
		s.Handler().ServeHTTP(w, r)
		if w.Code != test.status {
			t.Fatal(test, w.Code, w.Body.String())
		}
		if test.path == root {
			var got folderListing
			if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
				t.Fatal(err)
			}
			if len(got.Folders) != 4 || got.Folders[0].Name != "a" || got.Folders[2].Name != "link" {
				t.Fatal(got)
			}
		}
		if test.path == "/" {
			var got folderListing
			json.Unmarshal(w.Body.Bytes(), &got)
			if got.Parent != nil {
				t.Fatal("root has parent")
			}
		}
	}
	denied := filepath.Join(root, "denied")
	os.Mkdir(denied, 0000)
	defer os.Chmod(denied, 0700)
	if _, err := os.ReadDir(denied); err == nil {
		t.Skip("runtime can read mode-000 directory")
	}
	w := httptest.NewRecorder()
	s.Handler().ServeHTTP(w, httptest.NewRequest("GET", "http://localhost/api/v1/folders?path="+url.QueryEscape(denied), nil))
	if w.Code != 400 {
		t.Fatal(w.Code, w.Body.String())
	}
}
