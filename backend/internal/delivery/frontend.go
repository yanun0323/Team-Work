package delivery

import (
	"io/fs"
	"net/http"
	"strings"

	"github.com/labstack/echo/v4"
)

// Frontend serves only the packaged UI, never a directory listing or an API fallback.
func (s *Server) Frontend(files fs.FS) {
	handler := http.FileServer(http.FS(files))
	s.echo.GET("/*", func(c echo.Context) error {
		path := strings.TrimPrefix(c.Request().URL.Path, "/")
		if path == "" {
			path = "index.html"
		}
		if path == "api" || strings.HasPrefix(path, "api/") || !fs.ValidPath(path) {
			return echo.NewHTTPError(http.StatusNotFound)
		}
		info, err := fs.Stat(files, path)
		if err != nil || info.IsDir() {
			return echo.NewHTTPError(http.StatusNotFound)
		}
		c.Response().Header().Set("X-Content-Type-Options", "nosniff")
		c.Response().Header().Set("Cache-Control", "no-cache")
		handler.ServeHTTP(c.Response(), c.Request())
		return nil
	})
}
