package delivery

import (
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/labstack/echo/v4"
	"github.com/yanun0323/Team-Work/internal/model"
)

type folderEntry struct {
	Name string `json:"name"`
	Path string `json:"path"`
}
type folderListing struct {
	Path    string        `json:"path"`
	Parent  *string       `json:"parent"`
	Home    string        `json:"home"`
	Folders []folderEntry `json:"folders"`
}

func (s *Server) browseFolders(c echo.Context) error {
	home, err := os.UserHomeDir()
	if err != nil {
		return model.Errorf(model.CodeInvalid, "讀不到家目錄")
	}
	path := c.QueryParam("path")
	if path == "" {
		path = home
	}
	if !filepath.IsAbs(path) {
		return model.Errorf(model.CodeInvalid, "資料夾路徑必須是絕對路徑")
	}
	path = filepath.Clean(path)
	entries, err := os.ReadDir(path)
	if err != nil {
		switch {
		case errors.Is(err, os.ErrNotExist):
			return model.Errorf(model.CodeNotFound, "找不到資料夾 %s", path)
		case errors.Is(err, os.ErrPermission):
			return model.Errorf(model.CodeInvalid, "沒有權限讀取這個資料夾")
		default:
			return model.Errorf(model.CodeInvalid, "讀不到資料夾 %s", path)
		}
	}
	listing := folderListing{Path: path, Home: home, Folders: []folderEntry{}}
	if parent := filepath.Dir(path); parent != path {
		listing.Parent = &parent
	}
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), ".") {
			continue
		}
		full := filepath.Join(path, entry.Name())
		isDir := entry.IsDir()
		if entry.Type()&os.ModeSymlink != 0 {
			info, err := os.Stat(full)
			isDir = err == nil && info.IsDir()
		}
		if isDir {
			listing.Folders = append(listing.Folders, folderEntry{Name: entry.Name(), Path: full})
		}
	}
	sort.Slice(listing.Folders, func(i, j int) bool { return listing.Folders[i].Name < listing.Folders[j].Name })
	return c.JSON(http.StatusOK, listing)
}
