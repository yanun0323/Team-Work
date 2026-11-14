package tower

import (
	"context"
	"net"
	"net/http"
	"strings"
	"time"

	"github.com/gorilla/websocket"
	"github.com/yanun0323/Team-Work/internal/model"
)

type exchange struct {
	Identity
	Address string `json:"address"`
	Token   string `json:"token"`
}
type pairResult struct {
	Challenge string       `json:"challenge,omitempty"`
	State     string       `json:"state"`
	Peer      *exchange    `json:"peer,omitempty"`
	Error     *model.Error `json:"error,omitempty"`
}

func (s *Service) BeginPairing() (*Pairing, error) {
	s.pairStartMu.Lock()
	defer s.pairStartMu.Unlock()
	s.mu.Lock()
	if s.pairing != nil {
		p := s.pairing.view
		s.mu.Unlock()
		return &p, nil
	}
	s.mu.Unlock()
	if err := s.ensureEndpoint(); err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(s.ctx, pairLifetime)
	l, address, _, err := s.transport.Listen(ctx, nil)
	if err != nil {
		cancel()
		return nil, unavailable()
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if ctx.Err() != nil {
		cancel()
		l.Close()
		return nil, unavailable()
	}
	w := &waiting{done: make(chan struct{}), view: Pairing{Address: address, ExpiresAt: time.Now().Add(pairLifetime).Unix()}, cancel: cancel}
	s.pairing = w
	srv := &http.Server{Handler: http.HandlerFunc(func(rw http.ResponseWriter, r *http.Request) { s.receivePair(ctx, w, rw, r) }), ReadHeaderTimeout: 10 * time.Second, IdleTimeout: 15 * time.Second, MaxHeaderBytes: 32 << 10}
	e := &endpoint{srv, l}
	s.wg.Add(1)
	go func() {
		defer s.wg.Done()
		go func() { _ = srv.Serve(l) }()
		<-ctx.Done()
		s.mu.Lock()
		if s.pairing == w {
			s.pairing = nil
		}
		active := w.pending != nil
		s.mu.Unlock()
		// Closing Tailcat's listener also destroys its established streams. Let the
		// result be acknowledged before tearing it down, but never wait forever.
		if active {
			select {
			case <-w.done:
			case <-time.After(pairTimeout):
			}
		}
		e.close()
	}()
	p := w.view
	return &p, nil
}
func (s *Service) StopPairing() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.pairing != nil {
		s.pairing.cancel()
		s.pairing = nil
	}
}
func (s *Service) validExchange(x exchange) bool {
	return x.ID != "" && len(x.ID) <= 128 && strings.TrimSpace(x.Name) != "" && len(x.Name) <= 256 && len(x.Token) == 64 && s.transport.Validate(x.Address) == nil
}

const pairTimeout = 10 * time.Second

func pairFailure(conn *websocket.Conn, code, msg string) {
	_ = conn.SetWriteDeadline(time.Now().Add(pairTimeout))
	_ = conn.WriteJSON(pairResult{State: "failed", Error: &model.Error{Code: code, Message: msg}})
}
func (s *Service) receivePair(ctx context.Context, w *waiting, rw http.ResponseWriter, r *http.Request) {
	if r.Method != "GET" || r.URL.Path != "/tower/v1/pair" {
		http.NotFound(rw, r)
		return
	}
	up := websocket.Upgrader{}
	conn, err := up.Upgrade(rw, r, nil)
	if err != nil {
		return
	}
	defer conn.Close()
	conn.SetReadLimit(8192)
	conn.SetReadDeadline(time.Now().Add(pairTimeout))
	var x exchange
	if conn.ReadJSON(&x) != nil || !s.validExchange(x) {
		err := model.Errorf(model.CodeInvalid, "配對位址格式不正確")
		pairFailure(conn, err.Code, err.Message)
		return
	}
	s.mu.Lock()
	if s.pairing != w || ctx.Err() != nil {
		s.mu.Unlock()
		pairFailure(conn, "pair_expired", model.Errorf("pair_expired", "配對等待已結束").Message)
		return
	}
	if x.ID == s.disk.Me.ID {
		s.mu.Unlock()
		err := model.Errorf("pair_self", "不能和自己配對")
		pairFailure(conn, err.Code, err.Message)
		return
	}
	if w.pending != nil {
		s.mu.Unlock()
		err := model.Errorf("pair_busy", "對方正在處理另一個配對請求")
		pairFailure(conn, err.Code, err.Message)
		return
	}
	w.view.Request = &Request{Identity: x.Identity, Compatible: x.Protocol == Protocol}
	if x.Protocol != Protocol {
		me := s.disk.Me
		s.mu.Unlock()
		var err *model.Error
		if x.Protocol < Protocol {
			err = model.Errorf("incompatible", "這台的 Team Work 太舊，請更新這台")
		} else {
			err = model.Errorf("incompatible", "%s 的 Team Work 太舊，請更新那台", me.Name)
		}
		pairFailure(conn, err.Code, err.Message)
		return
	}
	p := &pending{wire: x, result: make(chan pairResult, 1), confirmed: make(chan struct{}), challenge: secret(), done: make(chan struct{})}
	w.pending = p
	s.mu.Unlock()
	defer func() {
		s.mu.Lock()
		if w.pending == p {
			w.pending = nil
			w.view.Request = nil
		}
		close(p.done)
		s.mu.Unlock()
	}()
	// One reader owns deadlines; only a response from the client extends its lease.
	messages := make(chan pairResult)
	readerStop := make(chan struct{})
	readDone := make(chan struct{})
	go func() {
		defer close(readDone)
		defer conn.Close()
		for {
			conn.SetReadDeadline(time.Now().Add(pairTimeout))
			var reply pairResult
			if conn.ReadJSON(&reply) != nil {
				return
			}
			select {
			case messages <- reply:
			case <-readerStop:
				return
			}
		}
	}()
	defer func() { close(readerStop); conn.Close(); <-readDone }()
	send := func(result pairResult) bool {
		conn.SetWriteDeadline(time.Now().Add(pairTimeout))
		return conn.WriteJSON(result) == nil
	}
	if !send(pairResult{State: "waiting"}) {
		return
	}
	tick := time.NewTicker(2 * time.Second)
	defer tick.Stop()
	terminal := false
	paired := false
	defer func() {
		if paired {
			w.cancel()
		}
	}()
	for {
		select {
		case result := <-p.result:
			paired = result.State == "paired"
			if !send(result) {
				return
			}
			terminal = result.State == "paired" || result.State == "failed"
		case reply := <-messages:
			if reply.State == "confirm" && reply.Challenge == p.challenge {
				select {
				case <-p.confirmed:
				default:
					close(p.confirmed)
				}
			}
			if terminal && reply.State == "received" {
				if ctx.Err() != nil || paired {
					close(w.done)
					w.cancel()
				}
				return
			}
		case <-readDone:
			return
		case <-ctx.Done():
			if !terminal {
				err := model.Errorf("pair_expired", "配對等待已結束")
				if !send(pairResult{State: "failed", Error: err}) {
					return
				}
				terminal = true
			}
			// The listener stays alive until the client acknowledges the final result.
			select {
			case reply := <-messages:
				if reply.State == "received" {
					close(w.done)
					return
				}
			case <-readDone:
				return
			case <-time.After(pairTimeout):
				return
			}
		case <-tick.C:
			if !terminal && !send(pairResult{State: "waiting"}) {
				return
			}
		}
	}
}
func (s *Service) Decide(requestID string, approve bool) (Peer, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	w := s.pairing
	if w == nil || w.view.Request == nil || w.view.Request.ID != requestID {
		return Peer{}, missing()
	}
	if !w.view.Request.Compatible {
		if !approve {
			w.view.Request = nil
			return Peer{}, nil
		}
		return Peer{}, incompatible(w.view.Request.Identity)
	}
	if w.pending == nil {
		return Peer{}, missing()
	}
	p := w.pending
	if p.deciding {
		return Peer{}, model.Errorf(model.CodeConflict, "已經有一筆配對正在進行")
	}
	p.deciding = true
	if !approve {
		err := model.Errorf("pair_rejected", "對方拒絕了配對")
		p.result <- pairResult{State: "failed", Error: err}
		w.pending = nil
		w.view.Request = nil
		return Peer{}, nil
	}
	// Require a fresh round trip at approval, not merely a recently alive socket.
	p.result <- pairResult{State: "confirm", Challenge: p.challenge}
	s.mu.Unlock()
	select {
	case <-p.confirmed:
	case <-p.done:
	case <-time.After(pairTimeout):
	}
	s.mu.Lock()
	select {
	case <-p.confirmed:
	default:
		if w.pending == p {
			w.pending = nil
			w.view.Request = nil
		}
		return Peer{}, missing()
	}
	if s.pairing != w || w.pending != p {
		return Peer{}, missing()
	}
	token := secret()
	peer := savedPeer{Peer: Peer{ID: p.wire.ID, Name: p.wire.Name, Protocol: p.wire.Protocol, Status: "checking", AllowInbound: true, Access: AccessView, PairedAt: time.Now().Unix(), Look: remoteLook(p.wire.Look)}, Address: p.wire.Address, Token: p.wire.Token, InboundHash: hash(token)}
	old, exists := s.disk.Peers[peer.ID]
	s.disk.Peers[peer.ID] = peer
	if err := s.saveLocked(); err != nil {
		if exists {
			s.disk.Peers[peer.ID] = old
		} else {
			delete(s.disk.Peers, peer.ID)
		}
		return Peer{}, unavailable()
	}
	s.newLeaseLocked(peer.ID)
	p.result <- pairResult{State: "paired", Peer: &exchange{Identity: s.disk.Me, Address: s.address, Token: token}}
	w.pending = nil
	w.view.Request = nil
	s.pairing = nil
	return peer.Peer, nil
}
func (s *Service) Pair(address string) (*Outgoing, error) {
	address = strings.TrimSpace(address)
	if s.transport.Validate(address) != nil {
		return nil, model.Errorf(model.CodeInvalid, "配對位址格式不正確")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.pairing != nil && s.pairing.view.Address == address {
		return nil, model.Errorf("pair_self", "不能和自己配對")
	}
	if s.outgoing != nil && (s.outgoing.State == "connecting" || s.outgoing.State == "waiting") {
		return nil, model.Errorf(model.CodeConflict, "已經有一筆配對正在進行")
	}
	ctx, cancel := context.WithTimeout(s.ctx, pairLifetime)
	s.outgoingCancel = cancel
	o := &Outgoing{State: "connecting"}
	s.outgoing = o
	s.wg.Add(1)
	go func() { defer s.wg.Done(); defer cancel(); s.runPair(ctx, address, o) }()
	copy := *o
	return &copy, nil
}
func (s *Service) CancelOutgoing() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.outgoingCancel != nil {
		s.outgoingCancel()
		s.outgoingCancel = nil
	}
	s.outgoing = nil
}
func (s *Service) pairFailed(o *Outgoing, err *model.Error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.outgoing == o {
		o.State = "failed"
		o.Code = err.Code
		o.Message = err.Message
	}
}
func (s *Service) runPair(ctx context.Context, address string, o *Outgoing) {
	fail := func() {
		s.pairFailed(o, model.Errorf(model.CodeUnavailable, "連不上這個位址，請確認位址正確、對方還在等待配對"))
	}
	if s.ensureEndpoint() != nil {
		fail()
		return
	}
	token := secret()
	s.mu.Lock()
	x := exchange{Identity: s.disk.Me, Address: s.address, Token: token}
	s.mu.Unlock()
	dialer := websocket.Dialer{HandshakeTimeout: 30 * time.Second, NetDialContext: func(ctx context.Context, _, _ string) (net.Conn, error) { return s.Dial(ctx, address) }}
	conn, resp, err := dialer.DialContext(ctx, "ws://tower/tower/v1/pair", nil)
	if err != nil {
		if resp != nil {
			resp.Body.Close()
		}
		fail()
		return
	}
	defer conn.Close()
	stop := context.AfterFunc(ctx, func() { conn.Close() })
	defer stop()
	send := func(state string) error {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		conn.SetWriteDeadline(time.Now().Add(pairTimeout))
		return conn.WriteJSON(pairResult{State: state})
	}
	conn.SetWriteDeadline(time.Now().Add(pairTimeout))
	if conn.WriteJSON(x) != nil {
		fail()
		return
	}
	for {
		conn.SetReadDeadline(time.Now().Add(pairTimeout))
		var result pairResult
		if conn.ReadJSON(&result) != nil {
			s.pairFailed(o, model.Errorf("pair_expired", "配對等待已結束"))
			return
		}
		if result.State == "confirm" {
			conn.SetWriteDeadline(time.Now().Add(pairTimeout))
			if ctx.Err() != nil || conn.WriteJSON(pairResult{State: "confirm", Challenge: result.Challenge}) != nil {
				fail()
				return
			}
			continue
		}
		if result.Error != nil {
			_ = send("received")
			s.pairFailed(o, result.Error)
			return
		}
		if result.State == "waiting" {
			if send("waiting") != nil {
				fail()
				return
			}
			s.mu.Lock()
			if s.outgoing == o {
				o.State = "waiting"
			}
			s.mu.Unlock()
			continue
		}
		if result.State != "paired" || result.Peer == nil || !s.validExchange(*result.Peer) {
			fail()
			return
		}
		remote := result.Peer
		if remote.Protocol != Protocol {
			s.pairFailed(o, incompatible(remote.Identity))
			return
		}
		s.mu.Lock()
		if s.outgoing != o || ctx.Err() != nil {
			s.mu.Unlock()
			return
		}
		if remote.ID == s.disk.Me.ID {
			s.mu.Unlock()
			s.pairFailed(o, model.Errorf("pair_self", "不能和自己配對"))
			return
		}
		peer := savedPeer{Peer: Peer{ID: remote.ID, Name: remote.Name, Protocol: remote.Protocol, Status: "online", AllowInbound: false, Access: AccessView, PairedAt: time.Now().Unix(), LastSeenAt: time.Now().Unix(), Look: remoteLook(remote.Look)}, Address: remote.Address, Token: remote.Token, InboundHash: hash(token)}
		old, exists := s.disk.Peers[peer.ID]
		s.disk.Peers[peer.ID] = peer
		if s.saveLocked() != nil {
			if exists {
				s.disk.Peers[peer.ID] = old
			} else {
				delete(s.disk.Peers, peer.ID)
			}
			s.mu.Unlock()
			fail()
			return
		}
		s.newLeaseLocked(peer.ID)
		_ = send("received")
		o.State = "paired"
		o.Name = peer.Name
		o.PeerID = peer.ID
		s.mu.Unlock()
		return
	}
}
