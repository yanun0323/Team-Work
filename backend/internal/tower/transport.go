// Package tower owns private computer pairings, independently of World and settings reloads.
package tower

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"sync"
	"time"

	"github.com/tailscale/tailcat"
	"tailscale.com/tailcfg"
)

// Transport is the encrypted byte stream boundary. Tests use an in-memory network.
type Transport interface {
	Validate(string) error
	Listen(context.Context, json.RawMessage) (net.Listener, string, json.RawMessage, error)
	Dial(context.Context, string) (net.Conn, error)
}

type Tailcat struct{}

func (Tailcat) Validate(address string) error {
	if len(address) > 4096 {
		return errors.New("invalid address")
	}
	ci, err := tailcat.ParseAddr(tailcat.Addr(address))
	// Only the official relay is supported. Never fetch arbitrary relay URLs supplied by a peer.
	if err != nil || len(ci.Region) != 0 || ci.RegionID <= 0 || ci.PresharedKey.IsZero() {
		return errors.New("invalid address")
	}
	return nil
}

func (Tailcat) Listen(ctx context.Context, saved json.RawMessage) (net.Listener, string, json.RawMessage, error) {
	var identity struct {
		Key    *tailcat.PrivateKey
		Region tailcfg.DERPRegionID
	}
	if len(saved) != 0 {
		if err := json.Unmarshal(saved, &identity); err != nil {
			return nil, "", nil, err
		}
	}
	if identity.Key == nil {
		identity.Key = tailcat.NewPrivateKey()
	}
	srv := &tailcat.Server{Key: identity.Key.Private, PresharedKey: identity.Key.Public.PresharedKey, RegionID: identity.Region, Logf: func(string, ...any) {}}
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	l, err := srv.Listen(ctx, "tcp", ":80")
	if err != nil {
		srv.Close()
		return nil, "", nil, errors.New("tailcat listen failed")
	}
	address := string(srv.TailcatAddr())
	ci, err := tailcat.ParseAddr(tailcat.Addr(address))
	if err != nil {
		l.Close()
		srv.Close()
		return nil, "", nil, errors.New("tailcat address failed")
	}
	identity.Region = ci.RegionID
	raw, err := json.Marshal(identity)
	if err != nil {
		l.Close()
		srv.Close()
		return nil, "", nil, err
	}
	return &tailListener{Listener: l, closeServer: srv.Close}, address, raw, nil
}

type tailListener struct {
	net.Listener
	once        sync.Once
	closeServer func() error
}

func (l *tailListener) Close() error {
	var err error
	l.once.Do(func() { err = l.Listener.Close(); l.closeServer() })
	return err
}

// Each new TCP connection gets a fresh client: a client cannot recover after a server restart in v0.7.0.
func (Tailcat) Dial(ctx context.Context, address string) (net.Conn, error) {
	if err := (Tailcat{}).Validate(address); err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	client := &tailcat.Client{Server: tailcat.Addr(address), Logf: func(string, ...any) {}}
	conn, err := client.DialTCPPort(ctx, 80)
	if err != nil {
		client.Close()
		return nil, errors.New("tailcat dial failed")
	}
	return &tailConn{Conn: conn, closeClient: client.Close}, nil
}

type tailConn struct {
	net.Conn
	once        sync.Once
	closeClient func() error
}

func (c *tailConn) Close() error {
	var err error
	c.once.Do(func() { err = c.Conn.Close(); c.closeClient() })
	return err
}
