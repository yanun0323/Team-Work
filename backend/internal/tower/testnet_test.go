package tower

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"sync"
)

// No sockets or external network: only net.Pipe crosses the transport boundary.
type memoryNetwork struct {
	mu        sync.Mutex
	listeners map[string]*memoryListener
	dials     int
	fail      int
}

func (n *memoryNetwork) Validate(s string) error {
	if len(s) != 64 {
		return errors.New("invalid")
	}
	return nil
}
func (n *memoryNetwork) Listen(ctx context.Context, saved json.RawMessage) (net.Listener, string, json.RawMessage, error) {
	n.mu.Lock()
	defer n.mu.Unlock()
	if n.listeners == nil {
		n.listeners = map[string]*memoryListener{}
	}
	address := secret()
	if len(saved) > 0 {
		_ = json.Unmarshal(saved, &address)
	}
	l := &memoryListener{connections: make(chan net.Conn), closed: make(chan struct{})}
	n.listeners[address] = l
	raw, _ := json.Marshal(address)
	return l, address, raw, nil
}
func (n *memoryNetwork) Dial(ctx context.Context, address string) (net.Conn, error) {
	n.mu.Lock()
	n.dials++
	l := n.listeners[address]
	if n.fail > 0 {
		n.fail--
		n.mu.Unlock()
		return nil, errors.New("offline")
	}
	n.mu.Unlock()
	if l == nil {
		return nil, errors.New("offline")
	}
	a, b := net.Pipe()
	select {
	case l.connections <- b:
		return a, nil
	case <-ctx.Done():
	case <-l.closed:
	}
	a.Close()
	b.Close()
	return nil, errors.New("closed")
}

type memoryListener struct {
	connections chan net.Conn
	closed      chan struct{}
	once        sync.Once
}

func (l *memoryListener) Accept() (net.Conn, error) {
	select {
	case c := <-l.connections:
		return c, nil
	case <-l.closed:
		return nil, net.ErrClosed
	}
}
func (l *memoryListener) Close() error   { l.once.Do(func() { close(l.closed) }); return nil }
func (l *memoryListener) Addr() net.Addr { return memoryAddr{} }

type memoryAddr struct{}

func (memoryAddr) Network() string { return "memory" }
func (memoryAddr) String() string  { return "memory" }
