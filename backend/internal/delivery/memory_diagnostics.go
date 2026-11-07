package delivery

import (
	"net"
	"net/http"
	"net/url"
	"os"
	"runtime"
	"runtime/pprof"

	"github.com/labstack/echo/v4"

	"github.com/yanun0323/Team-Work/internal/model"
)

// EnableMemoryDiagnostics registers only memory stats and a binary heap profile.
// Call before Serve, only when explicitly enabled in startup configuration. Do not
// import net/http/pprof: its init registers unrelated diagnostics on DefaultServeMux.
func (s *Server) EnableMemoryDiagnostics() {
	g := s.echo.Group("/api/v1/diagnostics", func(next echo.HandlerFunc) echo.HandlerFunc {
		return func(c echo.Context) error {
			// Use the socket peer, never forwarded headers or a supplied hostname.
			host, _, err := net.SplitHostPort(c.Request().RemoteAddr)
			if ip := net.ParseIP(host); err != nil || ip == nil || !ip.IsLoopback() {
				return model.Errorf(codeForbidden, "這個位址不能連到 API")
			}
			c.Response().Header().Set("Cache-Control", "no-store")
			c.Response().Header().Set("X-Content-Type-Options", "nosniff")
			return next(c)
		}
	})
	for _, path := range []string{"/memory", "/heap"} {
		g.Any(path, func(c echo.Context) error {
			c.Response().Header().Set("Allow", http.MethodGet)
			return echo.NewHTTPError(http.StatusMethodNotAllowed)
		})
	}
	g.GET("/memory", func(c echo.Context) error {
		if c.Request().URL.RawQuery != "" {
			return echo.NewHTTPError(http.StatusBadRequest)
		}
		var memory runtime.MemStats
		runtime.ReadMemStats(&memory)
		return c.JSON(http.StatusOK, struct {
			PID            int              `json:"pid"`
			GoVersion      string           `json:"goVersion"`
			Goroutines     int              `json:"goroutines"`
			MemProfileRate int              `json:"memProfileRate"`
			Memory         runtime.MemStats `json:"memory"`
		}{os.Getpid(), runtime.Version(), runtime.NumGoroutine(), runtime.MemProfileRate, memory})
	})
	g.GET("/heap", func(c echo.Context) error {
		q, err := url.ParseQuery(c.Request().URL.RawQuery)
		if err != nil {
			return echo.NewHTTPError(http.StatusBadRequest)
		}
		for key, values := range q {
			if key != "gc" || len(values) != 1 || (values[0] != "0" && values[0] != "1") {
				return echo.NewHTTPError(http.StatusBadRequest)
			}
		}
		// Never collect or release memory merely to observe it. Explicit gc=1
		// collects first; it does not call debug.FreeOSMemory or alter GC tuning.
		if q.Get("gc") == "1" {
			runtime.GC()
		}
		c.Response().Header().Set("Content-Type", "application/octet-stream")
		c.Response().Header().Set("Content-Disposition", `attachment; filename="heap.pprof"`)
		return pprof.WriteHeapProfile(c.Response())
	})
}
