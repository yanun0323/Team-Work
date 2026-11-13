package semantic

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"sync"
	"syscall"
	"time"
)

const (
	// maxFrame bounds one line from the helper; a batch of vectors is far below it.
	maxFrame = 16 << 20
	// maxRestarts is how often a helper that died is started again before the vectors are given up on.
	maxRestarts = 3
	// queueWarn is how many waiting batches start a warning in the log.
	queueWarn = 64
)

var (
	errHelperGone = errors.New("semantic helper stopped")
	errClosed     = errors.New("semantic search is off")
)

// helperReply is one line on the helper's stdout.
type helperReply struct {
	ID          int     `json:"id"`
	OK          bool    `json:"ok"`
	Error       string  `json:"error"`
	LoadSeconds float64 `json:"loadSeconds"`
	Prewarm     float64 `json:"prewarmSeconds"`
	Seconds     float64 `json:"seconds"`
	MaxTokens   int     `json:"maxTokens"`
	Dim         int     `json:"dim"`
	Bytes       int64   `json:"bytes"`
	Results     []struct {
		Tokens  int       `json:"tokens"`
		TooLong bool      `json:"tooLong"`
		Vector  []float32 `json:"vector"`
	} `json:"results"`
	TokenizerSame  int     `json:"tokenizerSame"`
	TokenizerCases int     `json:"tokenizerCases"`
	SmokeCases     int     `json:"smokeCases"`
	MinCosine      float64 `json:"minCosine"`
	Threshold      float64 `json:"threshold"`
	DimensionsOK   bool    `json:"dimensionsOK"`
}

type job struct {
	ctx    context.Context
	req    map[string]any
	high   bool
	queued time.Time
	done   chan jobResult
}

type jobResult struct {
	reply helperReply
	queue time.Duration
	err   error
}

// helper owns the long-running semantic-helper process: one request at a time, as the Neural Engine runs one thing
// at a time, with searches ahead of indexing batches that have not started. It cannot stop a batch the Neural
// Engine is already running.
type helper struct {
	path    string
	bundle  string
	pidFile string
	log     *logger
	// loaded hears each load: its seconds, before the reply goes to whoever asked.
	timeout     time.Duration
	loadTimeout time.Duration

	mu       sync.Mutex
	high     []*job
	low      []*job
	wake     chan struct{}
	closed   bool
	warned   bool
	child    *child
	loading  *child
	restarts int
	failed   error
	nextID   int
	stop     chan struct{}
	stopped  chan struct{}
}

func newHelper(path, bundle, pidFile string, log *logger) *helper {
	h := &helper{path: path, bundle: bundle, pidFile: pidFile, log: log, timeout: 2 * time.Minute, loadTimeout: 20 * time.Minute,
		wake: make(chan struct{}, 1), stop: make(chan struct{}), stopped: make(chan struct{})}
	go h.loop()
	return h
}

// call queues a request and waits for its reply.
func (h *helper) call(ctx context.Context, req map[string]any, high bool) jobResult {
	j := &job{ctx: ctx, req: req, high: high, queued: time.Now(), done: make(chan jobResult, 1)}
	h.mu.Lock()
	if h.closed {
		h.mu.Unlock()
		return jobResult{err: errClosed}
	}
	if h.failed != nil {
		err := h.failed
		h.mu.Unlock()
		return jobResult{err: err}
	}
	if high {
		h.high = append(h.high, j)
	} else {
		h.low = append(h.low, j)
		if len(h.low) >= queueWarn && !h.warned {
			h.warned = true
			h.log.warn("semantic_queue_warning").Int("waiting", len(h.low)).Send()
		} else if len(h.low) < queueWarn/2 {
			h.warned = false
		}
	}
	h.mu.Unlock()
	select {
	case h.wake <- struct{}{}:
	default:
	}
	select {
	case r := <-j.done:
		return r
	case <-ctx.Done():
		return jobResult{err: ctx.Err()}
	}
}

func (h *helper) next() *job {
	h.mu.Lock()
	defer h.mu.Unlock()
	for len(h.high) > 0 || len(h.low) > 0 {
		var j *job
		if len(h.high) > 0 {
			j, h.high = h.high[0], h.high[1:]
		} else {
			j, h.low = h.low[0], h.low[1:]
		}
		if j.ctx.Err() == nil { // a search that gave up, or work for a removed folder, never reaches the model
			return j
		}
		j.done <- jobResult{err: j.ctx.Err()}
	}
	return nil
}

func (h *helper) loop() {
	defer close(h.stopped)
	for {
		select {
		case <-h.stop:
			return
		case <-h.wake:
		}
		for j := h.next(); j != nil; j = h.next() {
			j.done <- h.run(j)
			select {
			case <-h.stop:
				return
			default:
			}
		}
	}
}

// run sends one request, starting (and loading) the helper first if it is not running.
func (h *helper) run(j *job) jobResult {
	queue := time.Since(j.queued)
	c, err := h.ensure()
	if err != nil {
		return jobResult{queue: queue, err: err}
	}
	h.mu.Lock()
	h.nextID++
	id := h.nextID
	h.mu.Unlock()
	req := map[string]any{"id": id}
	for k, v := range j.req {
		req[k] = v
	}
	reply, err := c.roundTrip(req, h.timeout)
	if err == nil && j.ctx.Err() != nil {
		err = j.ctx.Err()
	} else if err != nil {
		h.log.error("semantic_error").Str("stage", "helper").Str("op", fmt.Sprint(j.req["op"])).Str("reason", err.Error()).Str("next", "restart").Send()
		h.drop(c)
	}
	if err == nil && !reply.OK {
		err = fmt.Errorf("helper: %s", reply.Error)
	}
	return jobResult{reply: reply, queue: queue, err: err}
}

// ensure starts the helper and loads the model, which Core AI compiles for this Mac the first time.
func (h *helper) ensure() (*child, error) {
	h.mu.Lock()
	if h.child != nil {
		c := h.child
		h.mu.Unlock()
		return c, nil
	}
	if h.failed != nil {
		err := h.failed
		h.mu.Unlock()
		return nil, err
	}
	h.mu.Unlock()
	c, err := startChild(h.path, h.log)
	if err != nil {
		h.giveUp(err)
		return nil, err
	}
	h.recordPid(c)
	h.mu.Lock()
	h.loading = c
	closed := h.closed
	h.mu.Unlock()
	if closed {
		c.close()
		return nil, errClosed
	}
	start := time.Now()
	h.log.info("semantic_compile").Str("phase", "start").Int("pid", c.pid).Send()
	reply, err := c.roundTrip(map[string]any{"id": 0, "op": "load", "bundle": h.bundle}, h.loadTimeout)
	h.mu.Lock()
	h.loading = nil
	h.mu.Unlock()
	if err == nil && !reply.OK {
		err = fmt.Errorf("load: %s", reply.Error)
	}
	if err != nil {
		h.log.error("semantic_compile").Str("phase", "failed").Int64("ms", time.Since(start).Milliseconds()).Str("reason", err.Error()).Send()
		c.close()
		h.mu.Lock()
		h.restarts++
		count := h.restarts
		h.mu.Unlock()
		if count > maxRestarts {
			h.giveUp(err)
		}
		return nil, &stageError{code: "compile_failed", stage: "compile", err: err}
	}
	// Core AI does not say whether it reused an earlier compilation, so the log says unknown, with the time it took.
	h.log.info("semantic_compile").Str("phase", "done").Int64("ms", time.Since(start).Milliseconds()).Float64("loadSeconds", reply.LoadSeconds).Float64("prewarmSeconds", reply.Prewarm).Str("cache", "unknown").Int("maxTokens", reply.MaxTokens).Int("dim", reply.Dim).Send()
	h.mu.Lock()
	if h.closed {
		h.mu.Unlock()
		c.close()
		return nil, errClosed
	}
	h.child = c
	h.mu.Unlock()
	go func() {
		<-c.done
		h.mu.Lock()
		gone := h.child == c
		if gone {
			h.child = nil
		}
		closed := h.closed
		h.mu.Unlock()
		if gone && !closed {
			h.restarted()
		}
	}()
	return c, nil
}

// drop stops a helper that failed a request; the next request starts it again, up to maxRestarts times.
func (h *helper) drop(c *child) {
	h.mu.Lock()
	mine := h.child == c // otherwise its exit was already counted
	if mine {
		h.child = nil
	}
	h.mu.Unlock()
	c.close()
	if mine {
		h.restarted()
	}
}

func (h *helper) restarted() {
	h.mu.Lock()
	h.restarts++
	count := h.restarts
	h.mu.Unlock()
	h.log.warn("semantic_helper_restart").Int("restarts", count).Int("max", maxRestarts).Send()
	if count > maxRestarts {
		h.giveUp(fmt.Errorf("helper stopped %d times", count))
	}
}

func (h *helper) giveUp(err error) {
	h.mu.Lock()
	if h.failed == nil {
		h.failed = &stageError{code: "helper_failed", stage: "helper", err: err}
	}
	h.mu.Unlock()
}

// broken is why the helper is given up on, or nil.
func (h *helper) broken() error {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.failed
}

// close fails every waiting request and stops the helper, waiting a bounded time.
func (h *helper) close() {
	h.mu.Lock()
	if h.closed {
		h.mu.Unlock()
		return
	}
	h.closed = true
	waiting := append(h.high, h.low...)
	h.high, h.low = nil, nil
	c, loading := h.child, h.loading
	h.child = nil
	h.mu.Unlock()
	close(h.stop)
	if loading != nil {
		loading.close()
	}
	for _, j := range waiting {
		j.done <- jobResult{err: errClosed}
	}
	if c != nil {
		c.close()
	}
	select {
	case <-h.stopped:
	case <-time.After(5 * time.Second):
		h.log.warn("semantic_error").Str("stage", "helper").Str("reason", "a request did not finish while stopping").Str("next", "skip").Send()
	}
}

// child is one running helper process.
type child struct {
	cmd    *exec.Cmd
	pid    int
	stdin  io.WriteCloser
	lines  chan []byte
	done   chan struct{}
	log    *logger
	once   sync.Once
	readMu sync.Mutex
}

func startChild(path string, log *logger) (*child, error) {
	cmd := exec.Command(path)
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.WaitDelay = time.Second
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return nil, err
	}
	if err := cmd.Start(); err != nil {
		log.error("semantic_error").Str("stage", "helper").Str("reason", "could not start the helper").Str("next", "keyword_fallback").Send()
		return nil, &stageError{code: "helper_failed", stage: "helper", err: err}
	}
	c := &child{cmd: cmd, pid: cmd.Process.Pid, stdin: stdin, lines: make(chan []byte, 4), done: make(chan struct{}), log: log}
	log.info("semantic_helper_start").Int("pid", c.pid).Send()
	var reading sync.WaitGroup
	reading.Add(2)
	go func() {
		defer reading.Done()
		defer close(c.lines)
		s := bufio.NewScanner(stdout)
		s.Buffer(make([]byte, 64<<10), maxFrame)
		for s.Scan() {
			line := append([]byte(nil), s.Bytes()...)
			if len(line) == 0 {
				continue
			}
			c.lines <- line
		}
		if s.Err() != nil {
			log.error("semantic_error").Str("stage", "helper").Int("pid", c.pid).Str("reason", "reading the helper failed: "+s.Err().Error()).Str("next", "restart").Send()
		}
	}()
	go func() {
		defer reading.Done()
		forwardStderr(stderr, c.pid, log)
	}()
	go func() {
		reading.Wait()
		err := cmd.Wait()
		code := cmd.ProcessState.ExitCode()
		ev := log.info("semantic_helper_exit")
		if code != 0 {
			ev = log.warn("semantic_helper_exit")
		}
		ev.Int("pid", c.pid).Int("exitCode", code).AnErr("wait", err).Send()
		close(c.done)
	}()
	return c, nil
}

// roundTrip writes one request and reads its reply. EOF, a broken line, a reply to another request or a timeout fail it.
// A request already sent is waited for even when its asker gave up: the Neural Engine cannot be interrupted, and
// stopping the helper would cost a reload.
func (c *child) roundTrip(req map[string]any, timeout time.Duration) (helperReply, error) {
	c.readMu.Lock()
	defer c.readMu.Unlock()
	raw, err := json.Marshal(req)
	if err != nil {
		return helperReply{}, err
	}
	if len(raw)+1 > maxFrame {
		return helperReply{}, errors.New("request too large")
	}
	if _, err := c.stdin.Write(append(raw, '\n')); err != nil {
		return helperReply{}, errHelperGone
	}
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	select {
	case line, ok := <-c.lines:
		if !ok {
			return helperReply{}, errHelperGone
		}
		var r helperReply
		if err := json.Unmarshal(line, &r); err != nil {
			return helperReply{}, fmt.Errorf("invalid reply (%d bytes)", len(line))
		}
		if r.ID != req["id"].(int) {
			return helperReply{}, fmt.Errorf("reply to request %d, expected %v", r.ID, req["id"])
		}
		return r, nil
	case <-timer.C:
		return helperReply{}, fmt.Errorf("no reply in %s", timeout)
	}
}

// close lets the helper see EOF and clean up after itself, then stops it if it does not.
func (c *child) close() {
	c.once.Do(func() {
		_ = c.stdin.Close()
		select {
		case <-c.done:
			return
		case <-time.After(3 * time.Second):
		}
		_ = syscall.Kill(-c.pid, syscall.SIGTERM)
		select {
		case <-c.done:
		case <-time.After(time.Second):
			_ = syscall.Kill(-c.pid, syscall.SIGKILL)
			<-c.done
		}
	})
}

// stderrKeys are the fields the helper's own diagnostics carry; anything else on stderr is not shown.
var stderrKeys = map[string]bool{"event": true, "pid": true, "seconds": true, "prewarmSeconds": true, "memory": true, "folders": true, "bytes": true, "op": true}

// forwardStderr copies every stderr line into the log. Lines that are not the helper's own diagnostics (a
// framework's message could quote input) are logged by size only, marked redacted.
func forwardStderr(r io.Reader, pid int, log *logger) {
	s := bufio.NewScanner(r)
	s.Buffer(make([]byte, 64<<10), 1<<20)
	for s.Scan() {
		line := s.Bytes()
		var fields map[string]any
		ev := log.info("semantic_helper_stderr").Int("pid", pid)
		safe := json.Unmarshal(line, &fields) == nil && fields != nil
		for k, v := range fields {
			if !stderrKeys[k] {
				safe = false
				break
			}
			if str, ok := v.(string); ok && len(str) > 40 {
				safe = false
				break
			}
		}
		if !safe {
			ev.Bool("redacted", true).Int("bytes", len(line)).Send()
			continue
		}
		ev.Interface("helper", fields).Send()
	}
	if err := s.Err(); err != nil {
		log.warn("semantic_helper_stderr").Int("pid", pid).Bool("truncated", true).Str("reason", err.Error()).Send()
	}
}

// recordPid notes the running helper, so leftovers of one that was killed can be found by the next start.
func (h *helper) recordPid(c *child) {
	if h.pidFile == "" {
		return
	}
	raw, _ := json.Marshal(map[string]any{"pid": c.pid, "started": time.Now().Unix()})
	_ = os.WriteFile(h.pidFile, raw, 0o644)
}

// stageError is a failure with where it happened, for the status page.
type stageError struct {
	code, stage string
	err         error
}

func (e *stageError) Error() string { return e.err.Error() }
func (e *stageError) Unwrap() error { return e.err }
