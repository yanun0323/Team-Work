// Package semantic is the experimental semantic search: EmbeddingGemma 2 on the Neural Engine, through the
// semantic-helper process, over the files of each folder employees work in. It is off unless the user turns it
// on, and runs only on macOS 27 or later on Apple silicon.
package semantic

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/rs/zerolog"
)

// States the settings page shows.
const (
	StateUnsupported     = "unsupported"
	StateDisabled        = "disabled"
	StateRestartRequired = "restart_required"
	StateDownloading     = "downloading"
	StateCompiling       = "compiling"
	StateIndexing        = "indexing"
	StateReady           = "ready"
	StateError           = "error"
)

// Status is GET /settings/semantic-search.
type Status struct {
	Supported       bool         `json:"supported"`
	Enabled         bool         `json:"enabled"`
	Active          bool         `json:"active"`
	RequiresRestart bool         `json:"requiresRestart"`
	State           string       `json:"state"`
	Reason          string       `json:"reason"`
	Progress        Progress     `json:"progress"`
	Error           *StatusError `json:"error"`
}

type Progress struct {
	DownloadedBytes int64  `json:"downloadedBytes"`
	TotalBytes      *int64 `json:"totalBytes"`
	CompletedFiles  int    `json:"completedFiles"`
	TotalFiles      int    `json:"totalFiles"`
	PendingFiles    int    `json:"pendingFiles"`
	Chunks          int    `json:"chunks"`
}

type StatusError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
	Stage   string `json:"stage"`
	Log     string `json:"log"`
}

// Options are what a Service needs; the zero values of the last ones are the real model download.
type Options struct {
	DataDir  string
	Log      zerolog.Logger
	Platform Platform
	// BaseURL and Pin replace the model's download address and CHECKSUMS.sha256 pin, for tests.
	BaseURL string
	Pin     string
	Client  *http.Client
	// Retry is how long to wait before downloading again after a failure; 10 seconds when zero.
	Retry time.Duration
	// MemoryEvery is how often memory is logged; five minutes when zero.
	MemoryEvery time.Duration
}

// Service runs semantic search for this backend. Its methods are safe on a nil Service, which is off.
type Service struct {
	o     Options
	log   *logger
	cache *vectors
	dir   string

	mu       sync.Mutex
	active   bool
	state    string
	reason   string
	err      *StatusError
	download Progress
	helper   *helper
	// ready: the model is loaded and checked, so vectors can be used.
	ready   bool
	roots   map[string]*root
	wake    chan struct{}
	ctx     context.Context
	cancel  context.CancelFunc
	wg      sync.WaitGroup
	started bool
}

func New(o Options) *Service {
	if o.BaseURL == "" {
		o.BaseURL = modelBase
	}
	if o.Pin == "" {
		o.Pin = manifestSHA256
	}
	if o.Client == nil {
		o.Client = &http.Client{Timeout: 0, Transport: &http.Transport{Proxy: http.ProxyFromEnvironment, ResponseHeaderTimeout: time.Minute}}
	}
	if o.Retry == 0 {
		o.Retry = 10 * time.Second
	}
	if o.MemoryEvery == 0 {
		o.MemoryEvery = 5 * time.Minute
	}
	dir := filepath.Join(o.DataDir, "cache", "semantic-search")
	ctx, cancel := context.WithCancel(context.Background())
	return &Service{o: o, log: &logger{z: o.Log}, dir: dir, cache: &vectors{dir: filepath.Join(dir, "vectors"), touched: map[string]bool{}},
		roots: map[string]*root{}, wake: make(chan struct{}, 1), ctx: ctx, cancel: cancel, state: StateDisabled}
}

// Start is called once at startup with the saved setting: it logs what this computer is and, when the setting is
// on here, begins downloading, compiling and indexing roots in the background. Nothing else starts the model.
func (s *Service) Start(enabled bool, roots []string) {
	if s == nil {
		return
	}
	p := s.o.Platform
	supported, why := p.Supported()
	s.log.info("semantic_startup").Bool("enabled", enabled).Str("os", p.OS).Str("build", p.Build).Str("chip", p.Chip).Str("arch", runtime.GOARCH).Bool("arm64", p.Arm64).Bool("supported", supported).Str("reason", why).Send()
	s.mu.Lock()
	s.started = true
	switch {
	case !supported:
		s.state = StateUnsupported
	case !enabled:
		s.state = StateDisabled
	default:
		s.active = true
		s.state = StateDownloading
		if (&fetcher{dir: filepath.Join(s.dir, "models")}).ready() != "" {
			s.state = StateCompiling
		}
		for _, dir := range roots {
			s.rootLocked(dir)
		}
	}
	active := s.active
	s.mu.Unlock()
	s.logState()
	if !active {
		return
	}
	s.wg.Add(2)
	go s.activate()
	go s.indexer()
}

// Active says whether employees get semantic_search: on at startup here, and not turned off since.
func (s *Service) Active() bool {
	if s == nil {
		return false
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.active
}

// Disable stops everything at once, when the user turns the setting off. Turning it on again needs a restart.
func (s *Service) Disable() {
	if s == nil {
		return
	}
	s.mu.Lock()
	if !s.active {
		s.mu.Unlock()
		return
	}
	s.active = false
	s.ready = false
	s.state = StateDisabled
	h := s.helper
	s.helper = nil
	for _, r := range s.roots {
		r.cancel()
	}
	s.roots = map[string]*root{}
	s.mu.Unlock()
	s.cancel()
	if h != nil {
		h.close()
	}
	s.wg.Wait()
	s.log.info("semantic_state").Str("state", StateDisabled).Str("reason", "turned off").Send()
}

// Close stops the service when the backend stops.
func (s *Service) Close() {
	if s == nil {
		return
	}
	s.mu.Lock()
	h := s.helper
	s.helper = nil
	s.mu.Unlock()
	s.cancel()
	if h != nil {
		h.close()
	}
	s.wg.Wait()
}

// Status is what the settings page shows; enabled is the saved setting. Reading it never starts anything.
func (s *Service) Status(enabled bool) Status {
	st := Status{Enabled: enabled, State: StateUnsupported}
	if s == nil {
		return st
	}
	supported, _ := s.o.Platform.Supported()
	st.Supported = supported
	if !supported {
		return st
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	st.Active = s.active
	switch {
	case !s.active && !enabled:
		st.State = StateDisabled
	case !s.active:
		st.State, st.RequiresRestart = StateRestartRequired, true
		st.Reason = "restart Team Work to start semantic search"
	default:
		st.State, st.Reason, st.Error = s.state, s.reason, s.err
		st.Progress = s.download
		for _, r := range s.roots {
			done, pending, chunks := r.counts()
			st.Progress.CompletedFiles += done
			st.Progress.PendingFiles += pending
			st.Progress.TotalFiles += done + pending
			st.Progress.Chunks += chunks
		}
		if !enabled { // turned off and saved, but this call came first
			st.State = StateDisabled
		}
	}
	return st
}

func (s *Service) setState(state, reason string, err *StatusError) {
	s.mu.Lock()
	changed := s.state != state || s.reason != reason
	s.state, s.reason = state, reason
	if err != nil || state != StateError {
		s.err = err
	}
	s.mu.Unlock()
	if changed {
		s.logState()
	}
}

func (s *Service) logState() {
	s.mu.Lock()
	state, reason, err := s.state, s.reason, s.err
	s.mu.Unlock()
	ev := s.log.info("semantic_state")
	if err != nil {
		ev = s.log.warn("semantic_state").Str("code", err.Code).Str("stage", err.Stage)
	}
	ev.Str("state", state).Str("reason", reason).Send()
}

func (s *Service) fail(code, stage, message string, cause error) {
	s.log.error("semantic_error").Str("stage", stage).Str("code", code).Str("reason", safeReason(cause)).Str("next", "keyword_fallback").Send()
	s.logMemory(nil)
	s.setState(StateError, message, &StatusError{Code: code, Message: message, Stage: stage, Log: "backend.log"})
}

// safeReason is an error for the log, cut short. The errors given to it never hold file content: the helper's
// replies, the only ones that could quote it, pass helperErrorText first.
func safeReason(err error) string {
	if err == nil {
		return ""
	}
	msg := err.Error()
	if len(msg) > 300 {
		msg = msg[:300] + "…"
	}
	return msg
}

// activate downloads and checks the model, starts the helper and has Core AI compile it, then indexes.
func (s *Service) activate() {
	defer s.wg.Done()
	ctx := s.ctx
	s.removeLeftovers()
	f := &fetcher{base: s.o.BaseURL, client: s.o.Client, dir: filepath.Join(s.dir, "models"), log: s.log, pin: s.o.Pin}
	var bundle string
	if dir := f.ready(); dir != "" {
		bundle = dir
		s.log.info("semantic_download").Str("result", "cached").Str("revision", Revision).Send()
	} else {
		s.setState(StateDownloading, "", nil)
		lastLogged := int64(0)
		for attempt := 1; ; attempt++ {
			dir, err := f.fetch(ctx, func(done, total int64, files, totalFiles int) {
				s.mu.Lock()
				s.download.DownloadedBytes = done
				if total >= 0 {
					s.download.TotalBytes = &total
				}
				s.mu.Unlock()
				if total > 0 && done-lastLogged >= total/10 {
					lastLogged = done
					s.log.info("semantic_download").Int64("doneBytes", done).Int64("totalBytes", total).Int("files", files).Int("totalFiles", totalFiles).Send()
				}
			})
			if err == nil {
				bundle = dir
				break
			}
			if ctx.Err() != nil {
				return
			}
			var de *downloadError
			code, stage := "download_failed", "download"
			if errors.As(err, &de) {
				code, stage = de.code, de.stage
			}
			if code == "checksum_mismatch" || attempt >= 3 {
				s.fail(code, stage, downloadMessage(code), err)
				return
			}
			s.log.warn("semantic_error").Str("stage", stage).Str("reason", safeReason(err)).Int("attempt", attempt).Str("next", "retry").Send()
			select {
			case <-ctx.Done():
				return
			case <-time.After(s.o.Retry * time.Duration(attempt)):
			}
		}
	}
	s.mu.Lock()
	if !s.active {
		s.mu.Unlock()
		return
	}
	h := newHelper(s.o.Platform.Helper, filepath.Join(bundle, "model"), filepath.Join(s.dir, "helper.json"), s.log)
	s.helper = h
	s.mu.Unlock()
	s.setState(StateCompiling, "Core AI is compiling the model for this Mac", nil)
	if err := s.validate(ctx, h, bundle); err != nil {
		if ctx.Err() != nil {
			return
		}
		var se *stageError
		if errors.As(err, &se) && se.code != "" {
			s.fail(se.code, se.stage, stageMessage(se.code), err)
		} else {
			s.fail("helper_failed", "helper", stageMessage("helper_failed"), err)
		}
		return
	}
	s.logMemory(h)
	s.mu.Lock()
	s.ready = true
	s.mu.Unlock()
	s.setState(StateIndexing, "", nil)
	s.poke()
	s.wg.Add(1)
	go s.housekeeping(h)
}

// validate checks the model on this Mac against the reference once per model and OS build: the tokenizer must match
// the reference ids exactly, and every reference text must reach cosine 0.999.
func (s *Service) validate(ctx context.Context, h *helper, bundle string) error {
	marker := filepath.Join(s.dir, "validated-"+Revision[:12]+"-"+s.o.Platform.Build+".json")
	if _, err := os.Stat(marker); err == nil {
		r := h.call(ctx, map[string]any{"op": "memory"}, true) // loads, and so compiles, the model
		if r.err == nil {
			s.log.info("semantic_validate").Str("result", "cached").Send()
		}
		return r.err
	}
	start := time.Now()
	r := h.call(ctx, map[string]any{"op": "validate", "reference": filepath.Join(bundle, "tests", "smoke-reference.json"), "tokenizerCases": filepath.Join(bundle, "tests", "tokenizer-cases.json")}, true)
	if r.err != nil {
		return r.err
	}
	v := r.reply
	ok := v.TokenizerSame == v.TokenizerCases && v.TokenizerCases > 0 && v.SmokeCases > 0 && v.DimensionsOK && v.MinCosine >= 0.999 && v.Threshold >= 0.999
	ev := s.log.info("semantic_validate")
	if !ok {
		ev = s.log.error("semantic_validate")
	}
	ev.Bool("ok", ok).Int("tokenizerSame", v.TokenizerSame).Int("tokenizerCases", v.TokenizerCases).Int("smokeCases", v.SmokeCases).Float64("minCosine", v.MinCosine).Float64("threshold", v.Threshold).Bool("dimensionsOK", v.DimensionsOK).Int64("ms", time.Since(start).Milliseconds()).Send()
	if !ok {
		return &stageError{code: "validation_failed", stage: "validate", err: errors.New("the model's output does not match the reference")}
	}
	raw, _ := json.Marshal(map[string]any{"minCosine": v.MinCosine, "tokenizer": v.TokenizerSame, "at": time.Now().Unix()})
	_ = os.MkdirAll(s.dir, 0o755)
	return os.WriteFile(marker, raw, 0o644)
}

func downloadMessage(code string) string {
	if code == "checksum_mismatch" {
		return "the downloaded model does not match its checksum"
	}
	return "the model could not be downloaded"
}

func stageMessage(code string) string {
	switch code {
	case "compile_failed":
		return "Core AI could not compile the model"
	case "validation_failed":
		return "the model failed its correctness check on this Mac"
	case "index_failed":
		return "indexing failed"
	}
	return "the semantic search helper stopped"
}

// removeLeftovers deletes the compiled-graph copies a helper killed earlier left in the temporary folder: only
// folders named for its pid and made after it started, and only when that process is gone.
func (s *Service) removeLeftovers() {
	raw, err := os.ReadFile(filepath.Join(s.dir, "helper.json"))
	if err != nil {
		return
	}
	var last struct {
		Pid     int   `json:"pid"`
		Started int64 `json:"started"`
	}
	if json.Unmarshal(raw, &last) != nil || last.Pid <= 0 {
		return
	}
	if err := syscall.Kill(last.Pid, 0); err == nil || !errors.Is(err, syscall.ESRCH) {
		return // still running, or not ours to judge
	}
	base := filepath.Join(os.TempDir(), "com.apple.MetalPerformanceShadersGraph")
	entries, _ := os.ReadDir(base)
	removed := 0
	for _, e := range entries {
		info, err := e.Info()
		if err != nil || !strings.HasPrefix(e.Name(), "mpsgraph-"+itoa(last.Pid)+"-") || info.ModTime().Unix() < last.Started-2 {
			continue
		}
		if os.RemoveAll(filepath.Join(base, e.Name())) == nil {
			removed++
		}
	}
	s.log.info("semantic_temp_cleanup").Int("pid", last.Pid).Int("folders", removed).Send()
}

func itoa(n int) string {
	raw, _ := json.Marshal(n)
	return string(raw)
}

// housekeeping logs memory every five minutes and removes vectors unused for 30 days, at most once a day.
func (s *Service) housekeeping(h *helper) {
	defer s.wg.Done()
	memory := time.NewTicker(s.o.MemoryEvery)
	defer memory.Stop()
	sweep := time.NewTimer(time.Minute)
	defer sweep.Stop()
	for {
		select {
		case <-s.ctx.Done():
			return
		case <-memory.C:
			s.logMemory(h)
		case <-sweep.C:
			s.sweep()
			sweep.Reset(24 * time.Hour)
		}
	}
}

func (s *Service) logMemory(h *helper) {
	var m runtime.MemStats
	runtime.ReadMemStats(&m)
	ev := s.log.info("semantic_memory").Uint64("backendHeapBytes", m.HeapAlloc)
	if h != nil {
		ctx, cancel := context.WithTimeout(s.ctx, 30*time.Second)
		r := h.call(ctx, map[string]any{"op": "memory"}, false)
		cancel()
		if r.err == nil {
			ev = ev.Int64("helperBytes", r.reply.Bytes)
		}
	}
	ev.Send()
}

func (s *Service) sweep() {
	stampFile := filepath.Join(s.dir, "last-sweep")
	if info, err := os.Stat(stampFile); err == nil && time.Since(info.ModTime()) < 24*time.Hour {
		return
	}
	inUse := map[string]bool{}
	s.mu.Lock()
	roots := make([]*root, 0, len(s.roots))
	for _, r := range s.roots {
		roots = append(roots, r)
	}
	s.mu.Unlock()
	for _, r := range roots {
		r.mu.Lock()
		for _, f := range r.files {
			for _, c := range f.chunks {
				inUse[c.key] = true
			}
		}
		r.mu.Unlock()
	}
	removed := s.cache.sweep(30*24*time.Hour, inUse)
	_ = os.MkdirAll(s.dir, 0o755)
	_ = os.WriteFile(stampFile, nil, 0o644)
	s.log.info("semantic_cache_sweep").Int("removed", removed).Int("inUse", len(inUse)).Send()
}

// canonical is the real path of a folder, so one folder reached two ways is indexed once.
func canonical(dir string) string {
	if dir == "" {
		return ""
	}
	if real, err := filepath.EvalSymlinks(dir); err == nil {
		return filepath.Clean(real)
	}
	return filepath.Clean(dir)
}

func (s *Service) rootLocked(dir string) *root {
	dir = canonical(dir)
	if dir == "" || !s.active {
		return nil
	}
	r := s.roots[dir]
	if r == nil {
		r = newRoot(dir)
		s.roots[dir] = r
	}
	return r
}

func (s *Service) poke() {
	select {
	case s.wake <- struct{}{}:
	default:
	}
}

// Forget drops a removed work tree's chunks and stops its indexing; the shared vectors stay.
func (s *Service) Forget(dir string) {
	if s == nil {
		return
	}
	dir = canonical(dir)
	s.mu.Lock()
	r := s.roots[dir]
	delete(s.roots, dir)
	s.mu.Unlock()
	if r == nil {
		return
	}
	r.cancel()
	_, _, chunks := r.counts()
	r.mu.Lock()
	files := len(r.files)
	r.files = map[string]*fileState{}
	r.mu.Unlock()
	s.log.info("semantic_worktree_removed").Str("root", dir).Int("files", files).Int("chunks", chunks).Send()
}

// Changed says a tool wrote path: its vectors stop being used at once and it is indexed again. source is
// write_file, edit_file or run_command; for run_command the path is the working directory, which is scanned.
func (s *Service) Changed(path, source string) {
	if s == nil || !s.Active() {
		return
	}
	path = canonical(path)
	s.mu.Lock()
	var hit *root
	rel := ""
	for dir, r := range s.roots {
		if path == dir || strings.HasPrefix(path, dir+string(filepath.Separator)) {
			if hit == nil || len(dir) > len(hit.dir) {
				hit = r
				rel, _ = filepath.Rel(dir, path)
			}
		}
	}
	s.mu.Unlock()
	if hit == nil {
		return
	}
	pending := 0
	if rel != "." && source != "run_command" {
		hit.touch(filepath.ToSlash(rel))
		hit.mu.Lock()
		pending = hit.pendingLocked()
		hit.mu.Unlock()
		s.log.info("semantic_file_change").Str("root", hit.dir).Str("source", source).Int("files", 1).Int("pending", pending).Send()
	} else {
		go func() {
			if _, err := hit.scan(hit.ctx, s.log, source); err != nil {
				s.log.warn("semantic_error").Str("stage", "scan").Str("root", hit.dir).Str("reason", safeReason(err)).Str("next", "skip").Send()
			}
		}()
	}
	s.poke()
}

// indexer indexes waiting files of every root, one file at a time, behind any search.
func (s *Service) indexer() {
	defer s.wg.Done()
	first := map[*root]bool{}
	for {
		select {
		case <-s.ctx.Done():
			return
		case <-s.wake:
		case <-time.After(30 * time.Second):
		}
		s.mu.Lock()
		ready := s.ready && s.active
		roots := make([]*root, 0, len(s.roots))
		for _, r := range s.roots {
			roots = append(roots, r)
		}
		s.mu.Unlock()
		if !ready {
			continue
		}
		s.mu.Lock()
		state := s.state
		s.mu.Unlock()
		if state == StateReady && !s.allIndexed() { // a new work tree, or files changed
			s.setState(StateIndexing, "", nil)
		}
		for _, r := range roots {
			if s.ctx.Err() != nil {
				return
			}
			if !s.indexRoot(r, !first[r]) {
				// a failed batch is tried again soon, not only on the next change
				time.AfterFunc(s.o.Retry, s.poke)
				continue
			}
			first[r] = true
		}
		s.mu.Lock()
		state = s.state
		s.mu.Unlock()
		if state == StateIndexing && s.allIndexed() {
			s.setState(StateReady, "", nil)
		}
	}
}

func (s *Service) allIndexed() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, r := range s.roots {
		if _, pending, _ := r.counts(); pending > 0 {
			return false
		}
	}
	return true
}

// indexRoot scans a root and indexes what waits, logging what it did. It says false when a batch failed.
func (s *Service) indexRoot(r *root, full bool) bool {
	start := time.Now()
	source := "scan"
	if _, err := r.scan(r.ctx, s.log, source); err != nil {
		if r.ctx.Err() == nil {
			s.log.warn("semantic_error").Str("stage", "index").Str("root", r.dir).Str("reason", safeReason(err)).Str("next", "skip").Send()
		}
		return true
	}
	var st indexStats
	emb := helperEmbedder{s}
	if rel, err := r.indexPending(r.ctx, emb, s.cache, s.log, &st); err != nil {
		if r.ctx.Err() != nil || errors.Is(err, errRemoved) || s.ctx.Err() != nil {
			return true
		}
		if h := s.currentHelper(); h == nil || h.broken() != nil {
			s.log.error("semantic_error").Str("stage", "index").Str("root", r.dir).Str("file", rel).Str("reason", safeReason(err)).Str("next", "keyword_fallback").Send()
			s.mu.Lock()
			s.ready = false
			s.mu.Unlock()
			s.fail("helper_failed", "helper", stageMessage("helper_failed"), err)
			return true
		}
		s.log.warn("semantic_error").Str("stage", "index").Str("root", r.dir).Str("file", rel).Str("reason", safeReason(err)).Str("next", "retry").Send()
		s.logMemory(nil)
		return false
	}
	if !full && st.files == 0 {
		return true
	}
	r.mu.Lock()
	r.indexed = true
	r.splits += st.splits
	l := r.listing
	r.mu.Unlock()
	done, pending, chunks := r.counts()
	skipped := map[string]int{}
	r.mu.Lock()
	for _, f := range r.files {
		if f.skipped != "" {
			skipped[f.skipped]++
		}
	}
	r.mu.Unlock()
	s.log.info("semantic_index").Str("root", r.dir).Int("listed", len(l.files)).Interface("excluded", l.excluded).Interface("skipped", skipped).
		Int("indexedFiles", done).Int("pendingFiles", pending).Int("chunks", chunks).Int("filesThisRun", st.files).Int("cacheHits", st.hits).
		Int("computed", st.computed).Int("splits", st.splits).Int64("ms", time.Since(start).Milliseconds()).Send()
	return true
}

func (s *Service) currentHelper() *helper {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.helper
}

// helperEmbedder sends texts to the helper and logs the batch.
type helperEmbedder struct{ s *Service }

func (e helperEmbedder) embed(ctx context.Context, texts []string, high bool) ([]embedded, time.Duration, error) {
	h := e.s.currentHelper()
	if h == nil {
		return nil, 0, errClosed
	}
	start := time.Now()
	r := h.call(ctx, map[string]any{"op": "embed", "texts": texts, "maxTokens": MaxTokens}, high)
	if r.err != nil {
		return nil, r.queue, r.err
	}
	if len(r.reply.Results) != len(texts) {
		return nil, r.queue, errors.New("the helper answered for a different number of texts")
	}
	out := make([]embedded, len(texts))
	for i, res := range r.reply.Results {
		out[i] = embedded{tokens: res.Tokens, tooLong: res.TooLong}
		if !res.TooLong {
			if len(res.Vector) != dim || !normalize(res.Vector) {
				return nil, r.queue, errors.New("the helper returned a bad vector")
			}
			out[i].vec = res.Vector
		}
	}
	e.s.log.info("semantic_batch").Int("texts", len(texts)).Bool("search", high).Int64("queueMs", r.queue.Milliseconds()).Int64("embedMs", (time.Since(start) - r.queue).Milliseconds()).Send()
	return out, r.queue, nil
}
