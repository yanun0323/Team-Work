// Package tower owns private computer pairings, independently of World and settings reloads.
package tower

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"github.com/fxamacker/cbor/v2"
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
	if err != nil || len(ci.Region) != 0 || ci.RegionID <= 0 || ci.PresharedKey.IsZero() || ci.ServerDiscoPublic.IsZero() || ci.ServerPublic.IsZero() {
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
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	region := identity.Region
	if region == 0 {
		region = -1
	}
	ci := tailcat.ConnInfo{RegionID: region}
	if err := ci.Expand(ctx, tailcat.ExpandForServer); err != nil {
		return nil, "", nil, errors.New("tailcat relay unavailable")
	}
	if len(ci.Region) != 1 {
		return nil, "", nil, errors.New("tailcat relay unavailable")
	}
	identity.Region = ci.Region[0].RegionID
	srv := &tailcat.Server{Key: identity.Key.Private, PresharedKey: identity.Key.Public.PresharedKey, Region: ci.Region[0], Logf: func(string, ...any) {}}
	l, err := srv.Listen(ctx, "tcp", ":80")
	if err != nil {
		srv.Close()
		return nil, "", nil, errors.New("tailcat listen failed")
	}
	// Advertise only the official region ID, never peer-supplied relay hosts. Avoid TailcatAddr,
	// and ConnInfo.Addr: their debug environment knob prints the preshared key.
	identity.Key.Public.RegionID = identity.Region
	identity.Key.Public.Region = nil
	address, err := privateAddress(identity.Key.Public)
	if err != nil {
		l.Close()
		srv.Close()
		return nil, "", nil, err
	}
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

// v0.7.0's public encoder logs secret CBOR bytes when TS_DEBUG_ADDR is inherited.
// Encode only its official-relay wire fields without invoking that logger.
func privateAddress(ci tailcat.ConnInfo) (string, error) {
	wire := struct {
		Public    tailcat.NodePublic    `cbor:"p"`
		Disco     *tailcat.DiscoPublic  `cbor:"k,omitempty"`
		Preshared *tailcat.PresharedKey `cbor:"q,omitempty"`
		Region    int64                 `cbor:"i,omitempty"`
	}{ci.ServerPublic, &ci.ServerDiscoPublic, &ci.PresharedKey, ci.RegionID.Int64()}
	raw, err := cbor.Marshal(wire)
	if err != nil {
		return "", err
	}
	return "tc" + base64.RawURLEncoding.EncodeToString(raw), nil
}
