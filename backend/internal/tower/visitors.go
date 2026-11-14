package tower

import (
	"regexp"
	"sort"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/yanun0323/Team-Work/internal/model"
)

const maxNameRunes = 40

// CleanName is a computer's profile name as shown on other towers: trimmed, one line, not empty, not too long.
func CleanName(name string) (string, error) {
	name = strings.TrimSpace(name)
	if name == "" || !utf8.ValidString(name) || utf8.RuneCountInString(name) > maxNameRunes || strings.IndexFunc(name, unicode.IsControl) >= 0 {
		return "", model.Errorf(model.CodeInvalid, "名稱需為 1 到 %d 個字，且不能換行", maxNameRunes)
	}
	return name, nil
}

var (
	hexColour = regexp.MustCompile(`^#[0-9a-fA-F]{6}$`)
	partName  = regexp.MustCompile(`^[a-z]{1,16}$`)
)

// maxWardrobe bounds the wardrobe number a look may name; the frontend has three so far.
const maxWardrobe = 9

// CleanLook checks the look of the person at a computer: colours as #rrggbb and every part a short lowercase word.
// Which words there are is the frontend's to know; one it does not know draws as the style seed picks.
func CleanLook(l model.Look) (model.Look, error) {
	bad := model.Errorf(model.CodeInvalid, "角色外觀格式不正確")
	for _, c := range []string{l.Skin, l.Hair, l.Shirt, l.Pants} {
		if !hexColour.MatchString(c) {
			return model.Look{}, bad
		}
	}
	if !partName.MatchString(l.Extra) || l.Wardrobe < 0 || l.Wardrobe > maxWardrobe || l.Style != nil && *l.Style < 0 {
		return model.Look{}, bad
	}
	if p := l.Parts; p != nil {
		for _, n := range []string{p.Hair, p.Top, p.Bottom, p.Facial} {
			if !partName.MatchString(n) {
				return model.Look{}, bad
			}
		}
		if !hexColour.MatchString(p.Accent) || p.Shoes != "" && !partName.MatchString(p.Shoes) || p.ShoeColor != "" && !hexColour.MatchString(p.ShoeColor) {
			return model.Look{}, bad
		}
		parts := *p
		l.Parts = &parts
	}
	if l.Style != nil {
		style := *l.Style
		l.Style = &style
	}
	return l, nil
}

// remoteLook is a paired computer's look as it said, or nil when it said none or one that is not well formed.
func remoteLook(l *model.Look) *model.Look {
	if l == nil {
		return nil
	}
	clean, err := CleanLook(*l)
	if err != nil {
		return nil
	}
	return &clean
}

// SetProfile renames this computer and, when look is not nil, sets how the person at it looks; paired computers
// see both the next time they check it.
func (s *Service) SetProfile(name string, look *model.Look) (Identity, error) {
	name, err := CleanName(name)
	if err != nil {
		return Identity{}, err
	}
	if look != nil {
		clean, err := CleanLook(*look)
		if err != nil {
			return Identity{}, err
		}
		look = &clean
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	old := s.disk.Me
	s.disk.Me.Name = name
	if look != nil {
		s.disk.Me.Look = look
	}
	if err := s.saveLocked(); err != nil {
		s.disk.Me = old
		return Identity{}, unavailable()
	}
	return s.disk.Me, nil
}

// updatePeerLocked saves a change to one paired computer and, when it takes anything away, ends its open
// connections and its place on the visitor list, so the change holds for what is already open.
func (s *Service) updatePeerLocked(id string, change func(*savedPeer), revoke bool) (Peer, error) {
	p, ok := s.disk.Peers[id]
	if !ok {
		return Peer{}, missing()
	}
	old := p
	change(&p)
	s.disk.Peers[id] = p
	if err := s.saveLocked(); err != nil {
		s.disk.Peers[id] = old
		return Peer{}, unavailable()
	}
	if revoke {
		s.newLeaseLocked(id)
		delete(s.presence, id)
	}
	return p.Peer, nil
}

// SetAccess switches what a paired computer may do here. Taking control away ends what it has open.
func (s *Service) SetAccess(id, access string) (Peer, error) {
	if access != AccessView && access != AccessOperate {
		return Peer{}, model.Errorf(model.CodeInvalid, "權限只能是檢視或操作")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	p, ok := s.disk.Peers[id]
	if !ok {
		return Peer{}, missing()
	}
	return s.updatePeerLocked(id, func(p *savedPeer) { p.Access = access }, p.Access == AccessOperate && access == AccessView)
}

// Kick sends a computer off this island now; it may come back once its pages have gone home.
func (s *Service) Kick(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.disk.Peers[id]; !ok {
		return missing()
	}
	s.kicked[id] = s.now().Add(kickCooldown)
	s.newLeaseLocked(id)
	delete(s.presence, id)
	return nil
}

// Block keeps a computer out for d, or until unblocked when d is zero.
func (s *Service) Block(id string, d time.Duration) (Peer, error) {
	until := int64(BlockedForever)
	if d > 0 {
		until = s.now().Add(d).Unix()
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.updatePeerLocked(id, func(p *savedPeer) { p.BlockedUntil = until }, true)
}

// Unblock lets a blocked computer come again at once.
func (s *Service) Unblock(id string) (Peer, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.updatePeerLocked(id, func(p *savedPeer) { p.BlockedUntil = 0 }, false)
}

func (s *Service) blockedLocked(p Peer) bool {
	return p.BlockedUntil == BlockedForever || p.BlockedUntil > 0 && s.now().Unix() < p.BlockedUntil
}

// ValidPlace is what a visitor's page may report having open: nothing, the airport, or a company.
func ValidPlace(place string) bool {
	if place == "" || place == "airport" {
		return true
	}
	id, ok := strings.CutPrefix(place, "team:")
	return ok && id != "" && len(id) <= 128 && strings.IndexFunc(id, unicode.IsControl) < 0
}

func validPage(page string) bool {
	if page == "" || len(page) > 64 {
		return false
	}
	return strings.IndexFunc(page, func(r rune) bool {
		return !(r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '-' || r == '_')
	}) < 0
}

// Visit records what one page of paired computer id has open on this island; gone takes the page off the list.
// The computer is the one its token proves, never anything the page says about itself.
func (s *Service) Visit(id, page, place string, gone bool) error {
	if !validPage(page) || !ValidPlace(place) {
		return model.Errorf(model.CodeInvalid, "遠端請求格式不正確")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.disk.Peers[id]; !ok {
		return missing()
	}
	pages := s.presence[id]
	if gone {
		delete(pages, page)
		if len(pages) == 0 {
			delete(s.presence, id)
		}
		return nil
	}
	if pages == nil {
		pages = map[string]presence{}
		s.presence[id] = pages
	}
	if _, ok := pages[page]; !ok && len(pages) >= maxPresencePages {
		s.prunePresenceLocked()
		if len(pages) >= maxPresencePages {
			return model.Errorf(model.CodeInvalid, "同時開啟的頁面太多")
		}
	}
	pages[page] = presence{place: place, at: s.now()}
	return nil
}

func (s *Service) prunePresenceLocked() {
	now := s.now()
	for id, pages := range s.presence {
		for page, p := range pages {
			if now.Sub(p.at) > presenceLifetime {
				delete(pages, page)
			}
		}
		if len(pages) == 0 {
			delete(s.presence, id)
		}
	}
}

// visitorsLocked lists each computer on this island once, however many pages it has open.
func (s *Service) visitorsLocked() []Visitor {
	s.prunePresenceLocked()
	out := []Visitor{}
	for id, pages := range s.presence {
		p, ok := s.disk.Peers[id]
		if !ok || p.Revoked || !p.AllowInbound || s.blockedLocked(p.Peer) {
			continue
		}
		v := Visitor{ID: id, Name: p.Name, Look: p.Look, Places: []string{}}
		seen := map[string]bool{}
		for _, page := range pages {
			if page.place != "" && !seen[page.place] {
				seen[page.place] = true
				v.Places = append(v.Places, page.place)
			}
		}
		sort.Strings(v.Places)
		out = append(out, v)
	}
	sort.Slice(out, func(i, j int) bool {
		return out[i].Name < out[j].Name || out[i].Name == out[j].Name && out[i].ID < out[j].ID
	})
	return out
}
