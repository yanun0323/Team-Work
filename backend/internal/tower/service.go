package tower

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/yanun0323/Team-Work/internal/i18n"
	"github.com/yanun0323/Team-Work/internal/model"
)

// Protocol must increase when World or API formats change incompatibly.
const Protocol = 1
const pairLifetime = 10 * time.Minute

type Identity struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Protocol int    `json:"protocol"`
}
type Peer struct {
	ID           string `json:"id"`
	Name         string `json:"name"`
	Status       string `json:"status"`
	AllowInbound bool   `json:"allowInbound"`
	Protocol     int    `json:"protocol,omitempty"`
	LastSeenAt   int64  `json:"lastSeenAt,omitempty"`
	PairedAt     int64  `json:"pairedAt"`
	Message      string `json:"message,omitempty"`
}
type Request struct {
	Identity
	Compatible bool `json:"compatible"`
}
type Pairing struct {
	Address   string   `json:"address"`
	ExpiresAt int64    `json:"expiresAt"`
	Request   *Request `json:"request"`
}
type Outgoing struct {
	State   string `json:"state"`
	Name    string `json:"name,omitempty"`
	Code    string `json:"code,omitempty"`
	Message string `json:"message,omitempty"`
	PeerID  string `json:"peerId,omitempty"`
}
type View struct {
	Me       Identity  `json:"me"`
	Pairing  *Pairing  `json:"pairing"`
	Outgoing *Outgoing `json:"outgoing"`
	Peers    []Peer    `json:"peers"`
}

type savedPeer struct {
	Peer
	Address     string
	Token       string
	InboundHash string
	Revoked     bool
}
type diskState struct {
	Me       Identity
	Identity json.RawMessage
	Peers    map[string]savedPeer
}
type lease struct {
	ctx    context.Context
	cancel context.CancelFunc
}
type pending struct {
	confirmed chan struct{}
	challenge string
	done      chan struct{}
	deciding  bool
	wire      exchange
	result    chan pairResult
}
type waiting struct {
	done    chan struct{}
	view    Pairing
	cancel  context.CancelFunc
	pending *pending
}
type endpoint struct {
	server   *http.Server
	listener net.Listener
}

func (e *endpoint) close() {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = e.server.Shutdown(ctx)
	_ = e.server.Close()
	_ = e.listener.Close()
}

type Service struct {
	mu             sync.Mutex
	startMu        sync.Mutex
	pairStartMu    sync.Mutex
	ctx            context.Context
	cancel         context.CancelFunc
	wg             sync.WaitGroup
	transport      Transport
	file           string
	disk           diskState
	leases         map[string]lease
	gateway        http.Handler
	endpoint       *endpoint
	address        string
	pairing        *waiting
	outgoing       *Outgoing
	outgoingCancel context.CancelFunc
}

func New(ctx context.Context, dir string, transport Transport) (*Service, error) {
	ctx, cancel := context.WithCancel(ctx)
	s := &Service{ctx: ctx, cancel: cancel, transport: transport, file: filepath.Join(dir, "tower-private.json"), leases: map[string]lease{}}
	raw, err := os.ReadFile(s.file)
	if err == nil {
		err = json.Unmarshal(raw, &s.disk)
	} else if errors.Is(err, os.ErrNotExist) {
		name, _ := os.Hostname()
		if name == "" {
			name = "Team Work"
		}
		s.disk = diskState{Me: Identity{ID: secret(), Name: name, Protocol: Protocol}, Peers: map[string]savedPeer{}}
		err = s.saveLocked()
	}
	if err != nil {
		cancel()
		return nil, errors.New("cannot load private tower state")
	}
	if s.disk.Me.ID == "" || s.disk.Peers == nil {
		cancel()
		return nil, errors.New("invalid private tower state")
	}
	if err := os.Chmod(s.file, 0600); err != nil {
		cancel()
		return nil, err
	}
	s.disk.Me.Protocol = Protocol
	for id := range s.disk.Peers {
		s.newLeaseLocked(id)
	}
	return s, nil
}
func secret() string {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return hex.EncodeToString(b)
}
func hash(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}
func (s *Service) saveLocked() error {
	raw, err := json.Marshal(s.disk)
	if err != nil {
		return err
	}
	f, err := os.CreateTemp(filepath.Dir(s.file), ".tower-*")
	if err != nil {
		return err
	}
	name := f.Name()
	defer os.Remove(name)
	if err = f.Chmod(0600); err == nil {
		_, err = f.Write(raw)
	}
	if err == nil {
		err = f.Sync()
	}
	closeErr := f.Close()
	if err == nil {
		err = closeErr
	}
	if err == nil {
		err = os.Rename(name, s.file)
	}
	return err
}
func (s *Service) newLeaseLocked(id string) {
	if l, ok := s.leases[id]; ok {
		l.cancel()
	}
	ctx, cancel := context.WithCancel(s.ctx)
	s.leases[id] = lease{ctx, cancel}
}

// Start wires the API only once. Network availability never prevents the local app starting.
func (s *Service) Start(gateway http.Handler) {
	s.gateway = gateway
	s.wg.Add(1)
	go func() {
		defer s.wg.Done()
		tick := time.NewTicker(30 * time.Second)
		defer tick.Stop()
		for {
			s.mu.Lock()
			ids := make([]string, 0, len(s.disk.Peers))
			for id := range s.disk.Peers {
				ids = append(ids, id)
			}
			s.mu.Unlock()
			if len(ids) > 0 {
				_ = s.ensureEndpoint()
				for _, id := range ids {
					_, _ = s.Check(s.ctx, id)
				}
			}
			select {
			case <-s.ctx.Done():
				return
			case <-tick.C:
			}
		}
	}()
}
func (s *Service) Close() {
	s.cancel()
	s.mu.Lock()
	if s.pairing != nil {
		s.pairing.cancel()
	}
	if s.outgoingCancel != nil {
		s.outgoingCancel()
	}
	s.mu.Unlock()
	s.wg.Wait()
	s.startMu.Lock()
	if s.endpoint != nil {
		s.endpoint.close()
	}
	s.startMu.Unlock()
}
func (s *Service) ensureEndpoint() error {
	s.startMu.Lock()
	defer s.startMu.Unlock()
	if s.ctx.Err() != nil {
		return s.ctx.Err()
	}
	if s.endpoint != nil {
		return nil
	}
	s.mu.Lock()
	saved := append(json.RawMessage(nil), s.disk.Identity...)
	s.mu.Unlock()
	l, address, state, err := s.transport.Listen(s.ctx, saved)
	if err != nil {
		return unavailable()
	}
	s.mu.Lock()
	old := s.disk.Identity
	s.disk.Identity = state
	err = s.saveLocked()
	if err != nil {
		s.disk.Identity = old
	}
	s.mu.Unlock()
	if err != nil {
		l.Close()
		return unavailable()
	}
	srv := &http.Server{Handler: s.gateway, ReadHeaderTimeout: 10 * time.Second, IdleTimeout: 60 * time.Second, MaxHeaderBytes: 32 << 10}
	s.endpoint = &endpoint{srv, l}
	s.address = address
	go func() { _ = srv.Serve(l) }()
	return nil
}
func unavailable() error {
	return model.Errorf(model.CodeUnavailable, "基地台暫時連不上，請確認對方仍在等待配對")
}
func (s *Service) View() View {
	s.mu.Lock()
	defer s.mu.Unlock()
	v := View{Me: s.disk.Me, Peers: []Peer{}}
	if s.pairing != nil {
		p := s.pairing.view
		if p.Request != nil {
			r := *p.Request
			p.Request = &r
		}
		v.Pairing = &p
	}
	if s.outgoing != nil {
		o := *s.outgoing
		v.Outgoing = &o
	}
	for _, p := range s.disk.Peers {
		v.Peers = append(v.Peers, p.Peer)
	}
	sort.Slice(v.Peers, func(i, j int) bool {
		if v.Peers[i].PairedAt == v.Peers[j].PairedAt {
			return v.Peers[i].ID < v.Peers[j].ID
		}
		return v.Peers[i].PairedAt < v.Peers[j].PairedAt
	})
	return v
}
func (s *Service) SetAllowed(id string, allow bool) (Peer, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	p, ok := s.disk.Peers[id]
	if !ok {
		return Peer{}, missing()
	}
	old := p
	p.AllowInbound = allow
	s.disk.Peers[id] = p
	if err := s.saveLocked(); err != nil {
		s.disk.Peers[id] = old
		return Peer{}, unavailable()
	}
	if old.AllowInbound != allow {
		s.newLeaseLocked(id)
	}
	return p.Peer, nil
}
func missing() error { return model.Errorf(model.CodeNotFound, "找不到配對電腦或配對請求") }
func (s *Service) Unpair(ctx context.Context, id string) error {
	s.mu.Lock()
	p, ok := s.disk.Peers[id]
	if !ok {
		s.mu.Unlock()
		return missing()
	}
	delete(s.disk.Peers, id)
	if err := s.saveLocked(); err != nil {
		s.disk.Peers[id] = p
		s.mu.Unlock()
		return unavailable()
	}
	s.newLeaseLocked(id)
	s.leases[id].cancel()
	delete(s.leases, id)
	s.mu.Unlock()
	ctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, http.MethodPost, "http://tower/tower/v1/unpair", nil)
	req.Header.Set("Authorization", "Bearer "+p.Token)
	resp, err := s.RoundTrip(req, p.Address)
	if err == nil {
		resp.Body.Close()
	}
	return nil
}

// Authorize also returns a revocation context for already-open streams. Tokens never leave this boundary.
func (s *Service) Authorize(token string, allowDisabled bool) (Peer, context.Context, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	digest := hash(token)
	if len(token) == 64 {
		for id, p := range s.disk.Peers {
			if !p.Revoked && subtle.ConstantTimeCompare([]byte(digest), []byte(p.InboundHash)) == 1 {
				if !allowDisabled && !p.AllowInbound {
					return Peer{}, nil, model.Errorf("peer_denied", "對方沒有允許這台操作它")
				}
				return p.Peer, s.leases[id].ctx, nil
			}
		}
	}
	return Peer{}, nil, model.Errorf("unauthorized", "通行證無效或配對已解除")
}
func (s *Service) RemoteUnpair(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	p, ok := s.disk.Peers[id]
	if !ok {
		return missing()
	}
	old := p
	p.Revoked = true
	p.InboundHash = ""
	p.Token = ""
	p.Status = "unpaired"
	p.Message = i18n.T("對方已解除配對")
	s.disk.Peers[id] = p
	if err := s.saveLocked(); err != nil {
		s.disk.Peers[id] = old
		return unavailable()
	}
	s.newLeaseLocked(id)
	return nil
}
func incompatible(remote Identity) *model.Error {
	if remote.Protocol > Protocol {
		return model.Errorf("incompatible", "這台的 Team Work 太舊，請更新這台")
	}
	return model.Errorf("incompatible", "%s 的 Team Work 太舊，請更新那台", remote.Name)
}
func (s *Service) Target(id string) (string, string, context.Context, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	p, ok := s.disk.Peers[id]
	if !ok {
		return "", "", nil, missing()
	}
	if p.Revoked {
		return "", "", nil, model.Errorf("peer_unpaired", "對方已解除配對")
	}
	if p.Protocol != Protocol {
		return "", "", nil, incompatible(Identity{ID: p.ID, Name: p.Name, Protocol: p.Protocol})
	}
	return p.Address, p.Token, s.leases[id].ctx, nil
}
func (s *Service) Check(ctx context.Context, id string) (Peer, error) {
	s.mu.Lock()
	p, ok := s.disk.Peers[id]
	s.mu.Unlock()
	if !ok {
		return Peer{}, missing()
	}
	if p.Revoked {
		return p.Peer, nil
	}
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, "GET", "http://tower/tower/v1/hello", nil)
	req.Header.Set("Authorization", "Bearer "+p.Token)
	resp, err := s.RoundTrip(req, p.Address)
	p.Status = "offline"
	p.Message = i18n.T("連不上 %s", p.Name)
	if err == nil {
		defer resp.Body.Close()
		switch resp.StatusCode {
		case 200:
			var identity Identity
			if json.NewDecoder(resp.Body).Decode(&identity) == nil && identity.ID == id {
				p.Protocol = identity.Protocol
				p.LastSeenAt = time.Now().Unix()
				p.Status = "online"
				p.Message = ""
				if identity.Protocol != Protocol {
					p.Status = "incompatible"
					p.Message = incompatible(identity).Message
				}
			}
		case 401:
			p.Status = "unpaired"
			p.Message = i18n.T("對方已解除配對")
		case 403:
			p.Status = "denied"
			p.Message = i18n.T("對方沒有允許這台操作它")
		}
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	current, ok := s.disk.Peers[id]
	if !ok {
		return Peer{}, missing()
	}
	if current.Token != p.Token {
		return current.Peer, nil
	}
	p.AllowInbound = current.AllowInbound
	if p.Status == "unpaired" {
		p.Revoked = true
		p.InboundHash = ""
		p.Token = ""
		s.disk.Peers[id] = p
		if err := s.saveLocked(); err != nil {
			s.disk.Peers[id] = current
			return Peer{}, unavailable()
		}
		s.newLeaseLocked(id)
	} else {
		s.disk.Peers[id] = p
	}
	return p.Peer, nil
}
func bearer(r *http.Request) string {
	h := r.Header.Get("Authorization")
	if !strings.HasPrefix(h, "Bearer ") {
		return ""
	}
	return strings.TrimPrefix(h, "Bearer ")
}

// Dial opens a fresh encrypted stream with bounded connection establishment.
func (s *Service) Dial(ctx context.Context, address string) (net.Conn, error) {
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	return s.transport.Dial(ctx, address)
}

// RoundTrip never uses environment proxies or follows redirects. Closing the body closes its client.
func (s *Service) RoundTrip(req *http.Request, address string) (*http.Response, error) {
	tr := &http.Transport{DisableKeepAlives: true, ResponseHeaderTimeout: 30 * time.Second, DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) { return s.Dial(ctx, address) }}
	return tr.RoundTrip(req)
}

// Unreachable names the already-paired computer, not the one-time pairing address.
func (s *Service) Unreachable(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	p, ok := s.disk.Peers[id]
	if !ok {
		return missing()
	}
	return model.Errorf(model.CodeUnavailable, "連不上 %s", p.Name)
}
