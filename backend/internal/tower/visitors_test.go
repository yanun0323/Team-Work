package tower

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestNewPairsOnlyLook(t *testing.T) {
	n := &memoryNetwork{}
	a, b := testService(t, n), testService(t, n)
	pair(t, a, b)
	if p := b.View().Peers[0]; p.Access != AccessView || !p.AllowInbound {
		t.Fatal("a new pair must start looking only", p)
	}
	if p := a.View().Peers[0]; p.Access != AccessView {
		t.Fatal(p)
	}
}

// A pair saved before access modes existed has no access field: it keeps its identity but may only look,
// and control granted afterwards is saved, not reset on the next start.
func TestUpgradedPairStartsViewAndKeepsGrantedAccess(t *testing.T) {
	n := &memoryNetwork{}
	dir := t.TempDir()
	token := strings.Repeat("a", 64)
	raw := `{"Me":{"id":"me","name":"Me","protocol":1},"Peers":{"old":{"id":"old","name":"Old","allowInbound":true,"protocol":1,"pairedAt":1,"Token":"t","InboundHash":"` + hash(token) + `"}}}`
	if err := os.WriteFile(filepath.Join(dir, "tower-private.json"), []byte(raw), 0600); err != nil {
		t.Fatal(err)
	}
	open := func() *Service {
		s, err := New(context.Background(), dir, n)
		if err != nil {
			t.Fatal(err)
		}
		return s
	}
	s := open()
	if p := s.View().Peers[0]; p.Access != AccessView || p.Name != "Old" || p.ID != "old" || !p.AllowInbound {
		t.Fatal(p)
	}
	if p, _, err := s.Authorize(token, false); err != nil || p.ID != "old" || p.Access != AccessView {
		t.Fatal("the upgraded pair must still be recognised, looking only", p, err)
	}
	if _, err := s.SetAccess("old", AccessOperate); err != nil {
		t.Fatal(err)
	}
	s.Close()
	s = open()
	if p, _, err := s.Authorize(token, false); err != nil || p.Access != AccessOperate {
		t.Fatal("granted control was reset on restart", p, err)
	}
	if _, err := s.SetAccess("old", AccessView); err != nil {
		t.Fatal(err)
	}
	s.Close()
	s = open()
	defer s.Close()
	if p := s.View().Peers[0]; p.Access != AccessView {
		t.Fatal(p)
	}
}

func TestProfileNameReachesPairedTower(t *testing.T) {
	n := &memoryNetwork{}
	a, b := testService(t, n), testService(t, n)
	pair(t, a, b)
	for _, bad := range []string{"", "   ", "a\tb", strings.Repeat("x", 41)} {
		if _, err := b.SetProfile(bad); err == nil {
			t.Fatalf("%q accepted", bad)
		}
	}
	if _, err := b.SetProfile("  Studio  "); err != nil {
		t.Fatal(err)
	}
	if b.View().Me.Name != "Studio" {
		t.Fatal(b.View().Me)
	}
	p, err := a.Check(context.Background(), b.View().Me.ID)
	if err != nil || p.Name != "Studio" {
		t.Fatal(p, err)
	}
	// kept across a restart
	again, err := New(context.Background(), filepath.Dir(b.file), n)
	if err != nil {
		t.Fatal(err)
	}
	defer again.Close()
	if again.View().Me.Name != "Studio" {
		t.Fatal(again.View().Me)
	}
}

func TestBlockKickAndPresenceExpire(t *testing.T) {
	n := &memoryNetwork{}
	a, b := testService(t, n), testService(t, n)
	pair(t, a, b)
	id := a.View().Me.ID
	_, token, _, err := a.Target(b.View().Me.ID)
	if err != nil {
		t.Fatal(err)
	}
	clock := time.Now()
	b.mu.Lock()
	b.now = func() time.Time { return clock }
	b.mu.Unlock()
	refused := func() string {
		_, _, err := b.Authorize(token, false)
		if err == nil {
			return ""
		}
		return err.(interface{ Error() string }).Error()
	}
	if err := b.Visit(id, "p1", "airport", false); err != nil || len(b.View().Visitors) != 1 {
		t.Fatal(err, b.View().Visitors)
	}
	// a page that stops reporting falls off the list
	clock = clock.Add(presenceLifetime + time.Second)
	if len(b.View().Visitors) != 0 {
		t.Fatal("stale page still listed")
	}
	if err := b.Kick(id); err != nil || refused() == "" {
		t.Fatal("kick did not keep it out", err)
	}
	clock = clock.Add(kickCooldown + time.Second)
	if refused() != "" {
		t.Fatal("a kicked computer may come back")
	}
	if _, err := b.Block(id, time.Hour); err != nil || refused() == "" {
		t.Fatal("block did not keep it out", err)
	}
	// unpairing from the blocked side is still allowed
	if _, _, err := b.Authorize(token, true); err != nil {
		t.Fatal(err)
	}
	clock = clock.Add(time.Hour + time.Second)
	if refused() != "" {
		t.Fatal("an hour's block did not end")
	}
	if _, err := b.Block(id, 0); err != nil {
		t.Fatal(err)
	}
	// a block until lifted is kept across a restart
	again, err := New(context.Background(), filepath.Dir(b.file), n)
	if err != nil {
		t.Fatal(err)
	}
	defer again.Close()
	if p := again.View().Peers[0]; p.BlockedUntil != BlockedForever {
		t.Fatal(p)
	}
	if _, _, err := again.Authorize(token, false); err == nil {
		t.Fatal("block lost on restart")
	}
	if _, err := again.Unblock(id); err != nil {
		t.Fatal(err)
	}
	if _, _, err := again.Authorize(token, false); err != nil {
		t.Fatal(err)
	}
	// the check from the blocked side names why
	if _, err := b.Block(id, 0); err != nil {
		t.Fatal(err)
	}
	if p, _ := a.Check(context.Background(), b.View().Me.ID); p.Status != "denied" || !strings.Contains(p.Message, "封鎖") {
		t.Fatal(p)
	}
}
