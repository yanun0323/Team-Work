package tower

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/yanun0323/Team-Work/internal/model"
)

type exchange struct {
	Identity
	Address string `json:"address"`
	Token   string `json:"token"`
}
type pairResult struct {
	State string       `json:"state"`
	Peer  *exchange    `json:"peer,omitempty"`
	Error *model.Error `json:"error,omitempty"`
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
	w := &waiting{view: Pairing{Address: address, ExpiresAt: time.Now().Add(pairLifetime).Unix()}, cancel: cancel}
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
		s.mu.Unlock()
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
func pairFailure(w http.ResponseWriter, code, msg string) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(pairResult{State: "failed", Error: &model.Error{Code: code, Message: msg}})
}
func (s *Service) receivePair(ctx context.Context, w *waiting, rw http.ResponseWriter, r *http.Request) {
	if r.Method != "POST" || r.URL.Path != "/tower/v1/pair" {
		http.NotFound(rw, r)
		return
	}
	var x exchange
	if json.NewDecoder(io.LimitReader(r.Body, 8192)).Decode(&x) != nil || !s.validExchange(x) {
		err := model.Errorf(model.CodeInvalid, "配對位址格式不正確")
		pairFailure(rw, err.Code, err.Message)
		return
	}
	s.mu.Lock()
	if s.pairing != w || ctx.Err() != nil {
		s.mu.Unlock()
		err := model.Errorf("pair_expired", "配對等待已結束")
		pairFailure(rw, err.Code, err.Message)
		return
	}
	if x.ID == s.disk.Me.ID {
		s.mu.Unlock()
		err := model.Errorf("pair_self", "不能和自己配對")
		pairFailure(rw, err.Code, err.Message)
		return
	}
	if w.pending != nil {
		s.mu.Unlock()
		err := model.Errorf("pair_busy", "對方正在處理另一個配對請求")
		pairFailure(rw, err.Code, err.Message)
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
		pairFailure(rw, err.Code, err.Message)
		return
	}
	p := &pending{wire: x, result: make(chan pairResult, 1)}
	w.pending = p
	s.mu.Unlock()
	defer func() {
		s.mu.Lock()
		if w.pending == p {
			w.pending = nil
			w.view.Request = nil
		}
		s.mu.Unlock()
	}()
	rw.Header().Set("Content-Type", "application/json")
	enc := json.NewEncoder(rw)
	if enc.Encode(pairResult{State: "waiting"}) != nil {
		return
	}
	http.NewResponseController(rw).Flush()
	tick := time.NewTicker(5 * time.Second)
	defer tick.Stop()
	for {
		select {
		case result := <-p.result:
			_ = enc.Encode(result)
			_ = http.NewResponseController(rw).Flush()
			if result.State == "paired" {
				w.cancel()
			}
			return
		case <-ctx.Done():
			err := model.Errorf("pair_expired", "配對等待已結束")
			pairFailure(rw, err.Code, err.Message)
			return
		case <-r.Context().Done():
			return
		case <-tick.C:
			if enc.Encode(pairResult{State: "waiting"}) != nil {
				return
			}
			if http.NewResponseController(rw).Flush() != nil {
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
	if !approve {
		err := model.Errorf("pair_rejected", "對方拒絕了配對")
		p.result <- pairResult{State: "failed", Error: err}
		w.pending = nil
		w.view.Request = nil
		return Peer{}, nil
	}
	token := secret()
	peer := savedPeer{Peer: Peer{ID: p.wire.ID, Name: p.wire.Name, Protocol: p.wire.Protocol, Status: "checking", AllowInbound: true, PairedAt: time.Now().Unix()}, Address: p.wire.Address, Token: p.wire.Token, InboundHash: hash(token)}
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
		s.pairFailed(o, model.Errorf(model.CodeUnavailable, "電塔暫時連不上，請確認對方仍在等待配對"))
	}
	if s.ensureEndpoint() != nil {
		fail()
		return
	}
	token := secret()
	s.mu.Lock()
	x := exchange{Identity: s.disk.Me, Address: s.address, Token: token}
	s.mu.Unlock()
	raw, _ := json.Marshal(x)
	req, _ := http.NewRequestWithContext(ctx, "POST", "http://tower/tower/v1/pair", bytes.NewReader(raw))
	req.Header.Set("Content-Type", "application/json")
	resp, err := s.RoundTrip(req, address)
	if err != nil {
		fail()
		return
	}
	defer resp.Body.Close()
	dec := json.NewDecoder(resp.Body)
	for {
		var result pairResult
		if dec.Decode(&result) != nil {
			fail()
			return
		}
		if result.Error != nil {
			s.pairFailed(o, result.Error)
			return
		}
		if result.State == "waiting" {
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
		peer := savedPeer{Peer: Peer{ID: remote.ID, Name: remote.Name, Protocol: remote.Protocol, Status: "online", AllowInbound: false, PairedAt: time.Now().Unix(), LastSeenAt: time.Now().Unix()}, Address: remote.Address, Token: remote.Token, InboundHash: hash(token)}
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
		o.State = "paired"
		o.Name = peer.Name
		o.PeerID = peer.ID
		s.mu.Unlock()
		return
	}
}
