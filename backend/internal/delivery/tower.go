package delivery

import (
	"bytes"
	"context"
	"errors"
	"github.com/gorilla/websocket"
	"io"
	"log"
	"net"
	"net/http"
	"net/http/httputil"
	"strings"
	"sync"
	"time"

	"github.com/labstack/echo/v4"
	"github.com/yanun0323/Team-Work/internal/model"
	"github.com/yanun0323/Team-Work/internal/tower"
)

// EnableTowers is called before Serve; tower routes remain local even when viewing a remote island.
func (s *Server) EnableTowers(service *tower.Service) {
	api := s.echo.Group("/api/v1")
	api.GET("/towers", func(c echo.Context) error {
		c.Response().Header().Set("Cache-Control", "no-store")
		return c.JSON(200, service.View())
	})
	api.POST("/towers/pairing", func(c echo.Context) error {
		v, err := service.BeginPairing()
		if err != nil {
			return err
		}
		c.Response().Header().Set("Cache-Control", "no-store")
		return c.JSON(201, v)
	})
	api.DELETE("/towers/pairing", func(c echo.Context) error { service.StopPairing(); return c.NoContent(204) })
	for _, action := range []string{"approve", "reject"} {
		api.POST("/towers/pairing/"+action, func(c echo.Context) error {
			in, err := bind[struct {
				RequestID string `json:"requestId"`
			}](c)
			if err != nil {
				return err
			}
			v, err := service.Decide(in.RequestID, action == "approve")
			if err != nil {
				return err
			}
			if action == "reject" {
				return c.NoContent(204)
			}
			return c.JSON(201, v)
		})
	}
	api.POST("/towers/pair", func(c echo.Context) error {
		in, err := bind[struct {
			Address string `json:"address"`
		}](c)
		if err != nil {
			return err
		}
		v, err := service.Pair(in.Address)
		if err != nil {
			return err
		}
		return c.JSON(202, v)
	})
	api.DELETE("/towers/outgoing", func(c echo.Context) error { service.CancelOutgoing(); return c.NoContent(204) })
	api.PATCH("/towers/peers/:id", func(c echo.Context) error {
		in, err := bind[struct {
			Allow *bool `json:"allowInbound"`
		}](c)
		if err != nil {
			return err
		}
		if in.Allow == nil {
			return invalidRemote()
		}
		v, err := service.SetAllowed(c.Param("id"), *in.Allow)
		if err != nil {
			return err
		}
		return c.JSON(200, v)
	})
	api.POST("/towers/peers/:id/check", func(c echo.Context) error {
		v, err := service.Check(c.Request().Context(), c.Param("id"))
		if err != nil {
			return err
		}
		return c.JSON(200, v)
	})
	api.DELETE("/towers/peers/:id", func(c echo.Context) error {
		if err := service.Unpair(c.Request().Context(), c.Param("id")); err != nil {
			return err
		}
		return c.NoContent(204)
	})
	api.Any("/remote/:id/*", func(c echo.Context) error {
		address, token, revoked, err := service.Target(c.Param("id"))
		if err != nil {
			return err
		}
		ctx, cancel := context.WithCancel(c.Request().Context())
		defer cancel()
		stop := context.AfterFunc(revoked, cancel)
		defer stop()
		request := c.Request().Clone(ctx)
		request.URL.Path = "/api/v1/" + c.Param("*")
		request.URL.RawPath = ""
		if websocket.IsWebSocketUpgrade(request) {
			return proxyTowerSocket(c, service, request, address, token)
		}
		proxy := &httputil.ReverseProxy{
			Rewrite: func(p *httputil.ProxyRequest) {
				p.Out.URL.Scheme = "http"
				p.Out.URL.Host = "tower"
				p.Out.Host = "tower"
				p.Out.Header.Set("Authorization", "Bearer "+token)
				p.Out.Header.Del("Cookie")
				p.Out.Header.Del("Origin")
			},
			Transport: remoteTransport{service: service, address: address},
			ErrorLog:  log.New(io.Discard, "", 0),
			ModifyResponse: func(r *http.Response) error {
				if r.StatusCode == 401 {
					r.Body.Close()
					return model.Errorf("peer_unpaired", "對方已解除配對")
				}
				if r.StatusCode == 403 {
					raw, err := io.ReadAll(io.LimitReader(r.Body, 1<<20))
					r.Body.Close()
					if err != nil {
						return err
					}
					r.Body = io.NopCloser(bytes.NewReader(raw))
					if bytes.Contains(raw, []byte(`"peer_denied"`)) {
						return model.Errorf("peer_denied", "對方沒有允許這台操作它")
					}
				}
				return nil
			},
		}
		proxy.ErrorHandler = func(w http.ResponseWriter, r *http.Request, err error) { remoteError(w, err) }
		writer := &revocableWriter{ResponseWriter: c.Response(), ctx: ctx}
		defer writer.close()
		proxy.ServeHTTP(writer, request)
		return nil
	})
	service.Start(NewGateway(service, s.Handler()))
}

type remoteTransport struct {
	service *tower.Service
	address string
}

func (t remoteTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	// Buffer mutations before forwarding so every retry carries identical bytes and key.
	var body []byte
	if r.Body != nil {
		var err error
		body, err = io.ReadAll(io.LimitReader(r.Body, (32<<20)+1))
		r.Body.Close()
		if err != nil || len(body) > 32<<20 {
			return nil, invalidRemote()
		}
	}
	if r.Method != "GET" && r.Header.Get("Idempotency-Key") == "" {
		return nil, invalidRemote()
	}
	var err error
	for attempt := 0; attempt < 3; attempt++ {
		if r.Context().Err() != nil {
			return nil, r.Context().Err()
		}
		req := r.Clone(r.Context())
		if body != nil {
			req.Body = io.NopCloser(bytes.NewReader(body))
		}
		req.GetBody = nil
		// A failed connection gets a fresh Tailcat client, not the dead client's internal state.
		var response *http.Response
		response, err = t.service.RoundTrip(req, t.address)
		if err == nil {
			return response, nil
		}
		if strings.EqualFold(r.Header.Get("Upgrade"), "websocket") {
			break
		}
		select {
		case <-r.Context().Done():
			return nil, r.Context().Err()
		case <-time.After(100 * time.Millisecond):
		}
	}
	return nil, err
}

// Both ends receive ping/pong heartbeats: Tailcat does not report a vanished server's TCP close.
func proxyTowerSocket(c echo.Context, service *tower.Service, r *http.Request, address, token string) error {
	dialer := websocket.Dialer{HandshakeTimeout: 15 * time.Second, NetDialContext: func(ctx context.Context, _, _ string) (net.Conn, error) { return service.Dial(ctx, address) }}
	target := "ws://tower" + r.URL.RequestURI()
	remote, response, err := dialer.DialContext(r.Context(), target, http.Header{"Authorization": []string{"Bearer " + token}})
	if err != nil {
		if response != nil {
			defer response.Body.Close()
			if response.StatusCode == 401 {
				return model.Errorf("peer_unpaired", "對方已解除配對")
			}
			if response.StatusCode == 403 {
				return model.Errorf("peer_denied", "對方沒有允許這台操作它")
			}
			if response.StatusCode == 409 {
				return model.Errorf("incompatible", "這台的 Team Work 太舊，請更新這台")
			}
		}
		return model.Errorf(model.CodeUnavailable, "電塔暫時連不上，請確認對方仍在等待配對")
	}
	defer remote.Close()
	up := websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }}
	local, err := up.Upgrade(c.Response(), c.Request(), nil)
	if err != nil {
		return nil
	}
	defer local.Close()
	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()
	stop := context.AfterFunc(ctx, func() { local.Close(); remote.Close() })
	defer stop()
	var wg sync.WaitGroup
	for _, pair := range [][2]*websocket.Conn{{local, remote}, {remote, local}} {
		from, to := pair[0], pair[1]
		from.SetReadLimit(32 << 20)
		from.SetReadDeadline(time.Now().Add(45 * time.Second))
		from.SetPongHandler(func(string) error { return from.SetReadDeadline(time.Now().Add(45 * time.Second)) })
		wg.Add(1)
		go func() {
			defer wg.Done()
			defer cancel()
			for {
				kind, data, err := from.ReadMessage()
				if err != nil {
					return
				}
				to.SetWriteDeadline(time.Now().Add(10 * time.Second))
				if to.WriteMessage(kind, data) != nil {
					return
				}
			}
		}()
	}
	tick := time.NewTicker(15 * time.Second)
	defer tick.Stop()
	for {
		select {
		case <-ctx.Done():
			local.Close()
			remote.Close()
			wg.Wait()
			return nil
		case <-tick.C:
			deadline := time.Now().Add(10 * time.Second)
			if errors.Join(local.WriteControl(websocket.PingMessage, nil, deadline), remote.WriteControl(websocket.PingMessage, nil, deadline)) != nil {
				cancel()
			}
		}
	}
}
