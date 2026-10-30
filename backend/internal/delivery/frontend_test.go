package delivery

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"

	"github.com/labstack/echo/v4"
	"github.com/rs/zerolog"
)

func TestPackagedFrontend(t *testing.T) {
	s := &Server{echo: echo.New(), log: zerolog.Nop(), origins: []string{"http://127.0.0.1:18787"}}
	s.echo.HTTPErrorHandler = s.handleError
	s.echo.Use(s.guard)
	s.echo.GET("/api/v1/world", func(c echo.Context) error { return c.String(200, "world") })
	s.Frontend(fstest.MapFS{
		"index.html":    {Data: []byte("<html>app</html>")},
		"assets/app.js": {Data: []byte("app()")},
	})
	for _, tt := range []struct {
		path, origin, body string
		status             int
	}{
		{"/", "", "<html>app</html>", 200},
		{"/assets/app.js", "http://127.0.0.1:18787", "app()", 200},
		{"/api/v1/world", "", "world", 200},
		{"/missing.js", "", "", 404},
		{"/api/v1/missing", "", "", 404},
		{"/assets/", "", "", 404},
		{"/../index.html", "", "", 404},
		{"/", "https://attacker.example", "", 403},
	} {
		t.Run(tt.path+tt.origin, func(t *testing.T) {
			r := httptest.NewRequest(http.MethodGet, "http://127.0.0.1:18787"+tt.path, nil)
			r.Header.Set("Origin", tt.origin)
			w := httptest.NewRecorder()
			s.Handler().ServeHTTP(w, r)
			if w.Code != tt.status || (tt.body != "" && w.Body.String() != tt.body) {
				t.Fatalf("status %d, body %s", w.Code, w.Body.String())
			}
			if tt.status != 200 && strings.Contains(w.Body.String(), "<html>") {
				t.Fatal("error served the UI")
			}
		})
	}
}
