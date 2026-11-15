package tower

import (
	"context"

	"github.com/yanun0323/Team-Work/internal/model"
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
		if _, err := b.SetProfile(bad, nil); err == nil {
			t.Fatalf("%q accepted", bad)
		}
	}
	if _, err := b.SetProfile("  Studio  ", nil); err != nil {
		t.Fatal(err)
	}
	if b.View().Me.Name != "Studio" || b.View().Me.Look != nil {
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

func validLook() model.Look {
	return model.Look{Skin: "#f2d3b3", Hair: "#1f1a24", Shirt: "#3f6fb5", Pants: "#2c2c3a", Extra: "glasses", Wardrobe: 2,
		Parts: &model.LookParts{Hair: "bob", Top: "hoodie", Bottom: "skirt", Facial: "none", Accent: "#c23b3b", Shoes: "boots", ShoeColor: "#5b3a26"}}
}

func TestProfileLookReachesPairedTowerAndItsVisitorList(t *testing.T) {
	n := &memoryNetwork{}
	a, b := testService(t, n), testService(t, n)
	pair(t, a, b)
	broken := []func(*model.Look){
		func(l *model.Look) { l.Skin = "red" },
		func(l *model.Look) { l.Extra = "<script>" },
		func(l *model.Look) { l.Wardrobe = 99 },
		func(l *model.Look) { l.Parts.Hair = "" },
		func(l *model.Look) { l.Parts.Accent = "#12345" },
		func(l *model.Look) { l.Parts.Shoes = "Boots!" },
		func(l *model.Look) { l.Parts.ShoeColor = "brown" },
	}
	for i, change := range broken {
		l := validLook()
		change(&l)
		if _, err := b.SetProfile("Studio", &l); err == nil {
			t.Fatal("broken look accepted", i)
		}
	}
	if b.View().Me.Look != nil || b.View().Me.Name == "Studio" {
		t.Fatal("a refused look changed the profile", b.View().Me)
	}
	// parts picked before shoes could be have none, and still save
	older := validLook()
	older.Parts.Shoes, older.Parts.ShoeColor = "", ""
	if _, err := b.SetProfile("Studio", &older); err != nil {
		t.Fatal(err)
	}
	look := validLook()
	if _, err := b.SetProfile("Studio", &look); err != nil {
		t.Fatal(err)
	}
	// a later rename alone keeps the look
	if _, err := b.SetProfile("Studio 2", nil); err != nil {
		t.Fatal(err)
	}
	if l := b.View().Me.Look; l == nil || l.Parts == nil || l.Parts.Top != "hoodie" {
		t.Fatal(b.View().Me)
	}
	bID := b.View().Me.ID
	p, err := a.Check(context.Background(), bID)
	if err != nil || p.Look == nil || p.Look.Extra != "glasses" || p.Look.Parts.Bottom != "skirt" || p.Look.Parts.Shoes != "boots" || p.Look.Parts.ShoeColor != "#5b3a26" {
		t.Fatal(p, err)
	}
	if _, err := a.SetAllowed(bID, true); err != nil {
		t.Fatal(err)
	}
	if err := a.Visit(bID, "page1", "airport", false); err != nil {
		t.Fatal(err)
	}
	if v := a.View().Visitors; len(v) != 1 || v[0].Look == nil || v[0].Look.Parts.Hair != "bob" {
		t.Fatal(v)
	}
	// kept across a restart
	again, err := New(context.Background(), filepath.Dir(b.file), n)
	if err != nil {
		t.Fatal(err)
	}
	defer again.Close()
	if l := again.View().Me.Look; l == nil || l.Parts == nil || l.Parts.Accent != "#c23b3b" {
		t.Fatal(again.View().Me)
	}
}

func TestVisitorSinceOutlivesReloadButNotLeaving(t *testing.T) {
	n := &memoryNetwork{}
	a, b := testService(t, n), testService(t, n)
	pair(t, a, b)
	id := a.View().Me.ID
	start := time.Unix(1_800_000_000, 0)
	clock := start
	b.mu.Lock()
	b.now = func() time.Time { return clock }
	b.mu.Unlock()
	since := func() int64 {
		v := b.View().Visitors
		if len(v) != 1 {
			t.Fatal(v)
		}
		return v[0].Since
	}
	visit := func(page string, gone bool) {
		t.Helper()
		if err := b.Visit(id, page, "airport", gone); err != nil {
			t.Fatal(err)
		}
	}
	// a page says it is there every 10 seconds
	for range 60 {
		visit("p1", false)
		clock = clock.Add(10 * time.Second)
	}
	if since() != start.Unix() {
		t.Fatal("arrival moved while it stayed")
	}
	// a reload: the page says it has gone, and a new one comes at once
	visit("p1", true)
	clock = clock.Add(2 * time.Second)
	visit("p2", false)
	if since() != start.Unix() {
		t.Fatal("a reload started a new visit")
	}
	// gone for longer than a page may be silent: coming back is a new visit
	visit("p2", true)
	clock = clock.Add(presenceLifetime + time.Second)
	if len(b.View().Visitors) != 0 {
		t.Fatal("still listed after leaving")
	}
	visit("p3", false)
	if since() != clock.Unix() {
		t.Fatal("a new visit kept the old arrival")
	}
	// kicked, it starts again however soon it is back
	if err := b.Kick(id); err != nil {
		t.Fatal(err)
	}
	clock = clock.Add(time.Second)
	visit("p3", false)
	if since() != clock.Unix() {
		t.Fatal("a kick kept the old arrival")
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

func TestVisitHistoryKeepsLatestTenWithTheirEnds(t *testing.T) {
	n := &memoryNetwork{}
	a, b := testService(t, n), testService(t, n)
	pair(t, a, b)
	id := a.View().Me.ID
	clock := time.Unix(1_800_000_000, 0)
	b.mu.Lock()
	b.now = func() time.Time { return clock }
	b.mu.Unlock()
	visits := func() []VisitRecord {
		t.Helper()
		for _, p := range b.View().Peers {
			if p.ID == id {
				return p.Visits
			}
		}
		t.Fatal("peer missing")
		return nil
	}
	visit := func(page string, gone bool) {
		t.Helper()
		if err := b.Visit(id, page, "airport", gone); err != nil {
			t.Fatal(err)
		}
	}
	// a visit under way has no end yet
	first := clock.Unix()
	visit("p1", false)
	if v := visits(); len(v) != 1 || v[0] != (VisitRecord{Since: first}) {
		t.Fatal(v)
	}
	// it leaves after five minutes; the end is its last word, not when the list noticed
	clock = clock.Add(5 * time.Minute)
	visit("p1", true)
	clock = clock.Add(presenceLifetime + time.Second)
	if v := visits(); len(v) != 1 || v[0] != (VisitRecord{Since: first, Until: first + 300}) {
		t.Fatal(v)
	}
	// coming back after a silence ends the old visit at its last word and starts a new one
	second := clock.Unix()
	for range 4 {
		visit("p2", false)
		clock = clock.Add(20 * time.Second)
	}
	clock = clock.Add(presenceLifetime + time.Second)
	visit("p3", false)
	if v := visits(); len(v) != 3 || v[1] != (VisitRecord{Since: second, Until: second + 60}) || v[0].Until != 0 {
		t.Fatal(v)
	}
	// a kick ends it at once
	clock = clock.Add(time.Minute)
	if err := b.Kick(id); err != nil {
		t.Fatal(err)
	}
	if v := visits(); v[0].Until != clock.Unix() {
		t.Fatal(v)
	}
	// only the latest ten stay, newest first
	for range 12 {
		clock = clock.Add(kickCooldown + time.Second)
		visit("p4", false)
		if err := b.Kick(id); err != nil {
			t.Fatal(err)
		}
	}
	v := visits()
	if len(v) != maxVisits || v[0].Since != clock.Unix() || v[0].Since <= v[1].Since {
		t.Fatal(v)
	}
	// a check of the friend keeps the history
	if _, err := b.Check(context.Background(), id); err != nil {
		t.Fatal(err)
	}
	if len(visits()) != maxVisits {
		t.Fatal("check dropped the history")
	}
}

func TestVisitHistoryOutlivesRestart(t *testing.T) {
	n := &memoryNetwork{}
	a, b := testService(t, n), testService(t, n)
	pair(t, a, b)
	id := a.View().Me.ID
	if err := b.Visit(id, "p1", "airport", false); err != nil {
		t.Fatal(err)
	}
	// closing ends the visit under way
	b.Close()
	again, err := New(context.Background(), filepath.Dir(b.file), n)
	if err != nil {
		t.Fatal(err)
	}
	defer again.Close()
	for _, p := range again.View().Peers {
		if p.ID == id && (len(p.Visits) != 1 || p.Visits[0].Until == 0) {
			t.Fatal(p.Visits)
		}
	}
}
