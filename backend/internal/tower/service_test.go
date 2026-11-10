package tower

import (
	"context"
	"encoding/json"
	"net/http"
	"os"
	"strings"
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
