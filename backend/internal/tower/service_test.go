package tower

import (
	"context"
	"encoding/json"
	"fmt"
	"github.com/yanun0323/Team-Work/internal/model"
	"io"
	"net"
	"net/http"
	"os"
	"strings"
	"sync"
	"testing"
	"time"
)

func await(t *testing.T, f func() bool) {
	t.Helper()
	until := time.Now().Add(3 * time.Second)
	for time.Now().Before(until) {
		if f() {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatal("condition timed out")
}
func testService(t *testing.T, n *memoryNetwork) *Service {
	t.Helper()
	s, err := New(context.Background(), t.TempDir(), n)
	if err != nil {
		t.Fatal(err)
	}
	s.Start(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _, err := s.Authorize(bearer(r), false)
		if err != nil {
			w.WriteHeader(403)
			if known, ok := err.(*model.Error); ok {
				json.NewEncoder(w).Encode(map[string]any{"error": map[string]string{"code": known.Code, "message": known.Message}})
			}
			return
		}
		json.NewEncoder(w).Encode(s.View().Me)
	}))
	t.Cleanup(s.Close)
	return s
}
func pair(t *testing.T, a, b *Service) {
	t.Helper()
	waiting, err := b.BeginPairing()
	if err != nil {
		t.Fatal(err)
	}
	if _, err = a.Pair(waiting.Address); err != nil {
		t.Fatal(err)
	}
	await(t, func() bool { v := b.View(); return v.Pairing != nil && v.Pairing.Request != nil })
	if _, err = b.Decide(a.View().Me.ID, true); err != nil {
		t.Fatal(err)
	}
	await(t, func() bool { return a.View().Outgoing.State == "paired" })
}
func TestPairPersistAndRevoke(t *testing.T) {
	n := &memoryNetwork{}
	a, b := testService(t, n), testService(t, n)
	pair(t, a, b)
	av, bv := a.View(), b.View()
	if len(av.Peers) != 1 || av.Peers[0].AllowInbound || !bv.Peers[0].AllowInbound {
		t.Fatal(av, bv)
	}
	_, token, _, err := a.Target(bv.Me.ID)
	if err != nil {
		t.Fatal(err)
	}
	_, revoked, err := b.Authorize(token, false)
	if err != nil {
		t.Fatal(err)
	}
	for _, bad := range []string{"", strings.Repeat("x", 64), token + "x"} {
		if _, _, err := b.Authorize(bad, false); err == nil {
			t.Fatal("accepted invalid token")
		}
	}
	p, err := a.Check(context.Background(), bv.Me.ID)
	if err != nil || p.Status != "online" {
		t.Fatal(p, err)
	}
	info, err := os.Stat(b.file)
	if err != nil || info.Mode().Perm() != 0600 {
		t.Fatal(info, err)
	}
	raw, _ := os.ReadFile(b.file)
	if strings.Contains(string(raw), token) {
		t.Fatal("inbound token stored in plaintext")
	}
	public, _ := json.Marshal(b.View())
	for _, secret := range []string{token, b.address, b.disk.Peers[av.Me.ID].Token, b.disk.Peers[av.Me.ID].InboundHash} {
		if strings.Contains(string(public), secret) {
			t.Fatal("secret in view")
		}
	}
	if _, err = b.SetAllowed(av.Me.ID, false); err != nil {
		t.Fatal(err)
	}
	select {
	case <-revoked.Done():
	default:
		t.Fatal("existing stream not revoked")
	}
	if _, _, err = b.Authorize(token, false); err == nil {
		t.Fatal("disabled peer allowed")
	}
	if _, err = b.SetAllowed(av.Me.ID, true); err != nil {
		t.Fatal(err)
	}
	dir := strings.TrimSuffix(b.file, "/tower-private.json")
	address := b.address
	b.Close()
	restored, err := New(context.Background(), dir, n)
	if err != nil {
		t.Fatal(err)
	}
	restored.gateway = http.NotFoundHandler()
	defer restored.Close()
	if err = restored.ensureEndpoint(); err != nil {
		t.Fatal(err)
	}
	if restored.address != address {
		t.Fatal("address changed")
	}
	if _, _, err = restored.Authorize(token, false); err != nil {
		t.Fatal(err)
	}
	if err = restored.Unpair(context.Background(), av.Me.ID); err != nil {
		t.Fatal(err)
	}
	if _, _, err = restored.Authorize(token, false); err == nil {
		t.Fatal("revoked token accepted")
	}
}
func TestPairFailuresAndReplacement(t *testing.T) {
	n := &memoryNetwork{}
	a, b, c := testService(t, n), testService(t, n), testService(t, n)
	if _, err := a.Pair("bad"); err == nil {
		t.Fatal("bad address accepted")
	}
	w, _ := b.BeginPairing()
	if _, err := b.Pair(w.Address); err == nil {
		t.Fatal("self pair accepted")
	}
	if _, err := a.Pair(w.Address); err != nil {
		t.Fatal(err)
	}
	await(t, func() bool { return b.View().Pairing.Request != nil })
	if _, err := a.Pair(w.Address); err == nil {
		t.Fatal("parallel outgoing accepted")
	}
	if _, err := c.Pair(w.Address); err != nil {
		t.Fatal(err)
	}
	await(t, func() bool { return c.View().Outgoing.State == "failed" })
	if c.View().Outgoing.Code != "pair_busy" {
		t.Fatal(c.View())
	}
	if _, err := b.Decide(a.View().Me.ID, false); err != nil {
		t.Fatal(err)
	}
	await(t, func() bool { return a.View().Outgoing.State == "failed" })
	if a.View().Outgoing.Code != "pair_rejected" {
		t.Fatal(a.View())
	}
	if _, err := b.Decide(a.View().Me.ID, true); err == nil {
		t.Fatal("approved missing request")
	}
	pair(t, a, b)
	_, old, _, _ := a.Target(b.View().Me.ID)
	pair(t, a, b)
	if len(b.View().Peers) != 1 {
		t.Fatal("duplicate pair")
	}
	if _, _, err := b.Authorize(old, false); err == nil {
		t.Fatal("old token accepted")
	}
}
func TestCancelExpiryIncompatibleAndOffline(t *testing.T) {
	n := &memoryNetwork{}
	a, b := testService(t, n), testService(t, n)
	w, _ := b.BeginPairing()
	a.Pair(w.Address)
	await(t, func() bool { return b.View().Pairing.Request != nil })
	a.CancelOutgoing()
	await(t, func() bool { return b.View().Pairing.Request == nil })
	a.Pair(w.Address)
	await(t, func() bool { return b.View().Pairing.Request != nil })
	b.StopPairing()
	await(t, func() bool { return a.View().Outgoing.State == "failed" })
	if a.View().Outgoing.Code != "pair_expired" {
		t.Fatal(a.View())
	}
	a.mu.Lock()
	a.disk.Me.Protocol = Protocol + 1
	a.mu.Unlock()
	w, _ = b.BeginPairing()
	a.Pair(w.Address)
	await(t, func() bool { return a.View().Outgoing.State == "failed" })
	if a.View().Outgoing.Code != "incompatible" || b.View().Pairing.Request.Compatible {
		t.Fatal(a.View(), b.View())
	}
	a.mu.Lock()
	a.disk.Me.Protocol = Protocol
	a.mu.Unlock()
	b.StopPairing()
	pair(t, a, b)
	n.mu.Lock()
	n.fail = 1
	n.mu.Unlock()
	p, err := a.Check(context.Background(), b.View().Me.ID)
	if err != nil || p.Status != "offline" || len(a.View().Peers) != 1 {
		t.Fatal(p, err)
	}
	p, err = a.Check(context.Background(), b.View().Me.ID)
	if err != nil || p.Status != "online" {
		t.Fatal(p, err)
	}
	a.CancelOutgoing()
	a.Pair(secret())
	await(t, func() bool { return a.View().Outgoing.State == "failed" })
	if a.View().Outgoing.Message != "連不上這個位址，請確認位址正確、對方還在等待配對" {
		t.Fatal("wrong offline pairing message")
	}
	if a.View().Outgoing.Code != "unavailable" {
		t.Fatal(a.View())
	}
}
func TestSaveFailureKeepsAuthorization(t *testing.T) {
	n := &memoryNetwork{}
	a, b := testService(t, n), testService(t, n)
	pair(t, a, b)
	_, token, _, _ := a.Target(b.View().Me.ID)
	b.mu.Lock()
	b.file = b.file + "/missing"
	b.mu.Unlock()
	if _, err := b.SetAllowed(a.View().Me.ID, false); err == nil {
		t.Fatal("save failure ignored")
	}
	if _, _, err := b.Authorize(token, false); err != nil {
		t.Fatal("failed write changed access", err)
	}
}

func TestVersionCheckBeforeForwardingAndDisabledDirection(t *testing.T) {
	n := &memoryNetwork{}
	a, b := testService(t, n), testService(t, n)
	pair(t, a, b)
	p, err := b.Check(context.Background(), a.View().Me.ID)
	if err != nil || p.Status != "denied" {
		t.Fatal(p, err)
	}
	b.mu.Lock()
	b.disk.Me.Protocol = Protocol + 1
	b.mu.Unlock()
	p, err = a.Check(context.Background(), b.View().Me.ID)
	if err != nil || p.Status != "incompatible" || p.Message == "" {
		t.Fatal(p, err)
	}
	if _, _, _, err := a.Target(b.View().Me.ID); err == nil {
		t.Fatal("forwarded incompatible peer")
	}
}
func TestIncompatiblePairRequestCanBeDismissed(t *testing.T) {
	n := &memoryNetwork{}
	a, b := testService(t, n), testService(t, n)
	a.mu.Lock()
	a.disk.Me.Protocol = Protocol + 1
	a.mu.Unlock()
	w, _ := b.BeginPairing()
	a.Pair(w.Address)
	await(t, func() bool { return a.View().Outgoing.State == "failed" })
	if _, err := b.Decide(a.View().Me.ID, true); err == nil {
		t.Fatal("incompatible approved")
	}
	if _, err := b.Decide(a.View().Me.ID, false); err != nil {
		t.Fatal(err)
	}
	if b.View().Pairing.Request != nil {
		t.Fatal("incompatible request not dismissed")
	}
}

// A vanished Tailcat client need not send EOF. Keep its server-side connection
// alive and discard writes, so HTTP cannot infer liveness from a successful write.
type silentNetwork struct {
	memoryNetwork
	muConn sync.Mutex
	client net.Conn
}

func (n *silentNetwork) Dial(ctx context.Context, address string) (net.Conn, error) {
	c, err := n.memoryNetwork.Dial(ctx, address)
	if err != nil {
		return nil, err
	}
	n.muConn.Lock()
	n.client = c
	n.muConn.Unlock()
	return &silentClose{Conn: c}, nil
}

type silentClose struct{ net.Conn }

func (c *silentClose) Close() error { go io.Copy(io.Discard, c.Conn); return nil }

func TestPairDisappearsWithoutTransportEOF(t *testing.T) {
	for _, approve := range []bool{false, true} {
		t.Run(fmt.Sprint(approve), func(t *testing.T) {
			n := &silentNetwork{}
			a, err := New(context.Background(), t.TempDir(), n)
			if err != nil {
				t.Fatal(err)
			}
			a.gateway = http.NotFoundHandler()
			defer a.Close()
			b := testService(t, &n.memoryNetwork)
			w, err := b.BeginPairing()
			if err != nil {
				t.Fatal(err)
			}
			a.Pair(w.Address)
			await(t, func() bool { return b.View().Pairing.Request != nil })
			a.CancelOutgoing()
			defer func() { n.muConn.Lock(); defer n.muConn.Unlock(); n.client.Close() }()
			if approve {
				if _, err := b.Decide(a.View().Me.ID, true); err == nil {
					t.Fatal("approved vanished client before heartbeat expiry")
				}
			}
			until := time.Now().Add(20 * time.Second)
			for b.View().Pairing.Request != nil && time.Now().Before(until) {
				time.Sleep(10 * time.Millisecond)
			}
			if b.View().Pairing.Request != nil {
				t.Fatal("vanished client still has an approvable request")
			}
			if _, err := b.Decide(a.View().Me.ID, true); err == nil {
				t.Fatal("approved vanished client")
			}
			if len(b.View().Peers) != 0 {
				t.Fatal("persisted unfinished pairing")
			}

		})
	}
}

func TestTailcatLivePairCancellation(t *testing.T) {
	if os.Getenv("TEAM_WORK_TEST_TAILCAT") != "1" {
		t.Skip("live relay test is opt-in")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	makeService := func() *Service {
		s, err := New(ctx, t.TempDir(), Tailcat{})
		if err != nil {
			t.Fatal("cannot create tower")
		}
		s.gateway = http.NotFoundHandler()
		t.Cleanup(s.Close)
		return s
	}
	a, b := makeService(), makeService()
	wait := func(f func() bool) {
		until := time.Now().Add(20 * time.Second)
		for !f() {
			if time.Now().After(until) {
				t.Fatal("live pairing condition timed out")
			}
			time.Sleep(50 * time.Millisecond)
		}
	}
	for _, stopReceiver := range []bool{true, false} {
		w, err := b.BeginPairing()
		if err != nil {
			t.Fatal("cannot listen on relay")
		}
		if _, err := a.Pair(w.Address); err != nil {
			t.Fatal("cannot begin pairing")
		}
		wait(func() bool { return b.View().Pairing.Request != nil })
		if stopReceiver {
			b.StopPairing()
			wait(func() bool { return a.View().Outgoing.State == "failed" })
			if a.View().Outgoing.Code != "pair_expired" {
				t.Fatal("wrong cancellation result")
			}
		} else {
			a.CancelOutgoing()
			// Even before heartbeat expiry, approval must require a fresh reply.
			if _, err := b.Decide(a.View().Me.ID, true); err == nil {
				t.Fatal("approved disconnected client")
			}
			wait(func() bool { return b.View().Pairing.Request == nil })
			if len(b.View().Peers) != 0 {
				t.Fatal("persisted unfinished pairing")
			}
		}
	}
}
