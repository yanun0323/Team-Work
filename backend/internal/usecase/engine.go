// Package usecase runs companies: tasks move through their workflow, employees work on them for real.
// The flow rules follow the frontend's simulator (frontend/src/core/domain/sim.ts).
package usecase

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/rs/zerolog"

	"github.com/yanun0323/Team-Work/internal/adapter"
	"github.com/yanun0323/Team-Work/internal/i18n"
	"github.com/yanun0323/Team-Work/internal/model"
	"github.com/yanun0323/Team-Work/internal/model/enum"
	"github.com/yanun0323/Team-Work/internal/usecase/tools"
	"github.com/yanun0323/Team-Work/pkg/jsonx"
)

const subscriberBuffer = 1024

// Options is what an Engine works with.
type Options struct {
	Store     adapter.Store
	Git       adapter.Git
	Providers adapter.Providers
	DataDir   string
	Log       zerolog.Logger
}

// Patch is one change to the world as clients see it.
type Patch struct {
	Kind string          `json:"kind"`
	ID   string          `json:"id"`
	Data json.RawMessage `json:"data,omitempty"`
}

// Event is what subscribers receive.
type Event struct {
	Type string `json:"type"` // patch, delta or notice
	// patch
	Upserts []Patch `json:"upserts,omitempty"`
	Deletes []Patch `json:"deletes,omitempty"`
	// delta: text an employee is writing now in a chat or discussion, whose id SubID then is; it is not kept.
	// deltaReset: start that text over.
	// toolOutput: the last lines of a command running now in a chat, in place of the ones before; "" when it ends.
	SubID string `json:"subId,omitempty"`
	Text  string `json:"text,omitempty"`
	// language: the language picked, for clients already connected
	Language string `json:"language,omitempty"`
	// notice: review or awaitMerge
	Kind   string `json:"kind,omitempty"`
	TaskID string `json:"taskId,omitempty"`
}

// Engine owns the world: everything is read and changed under mu. Agent runs work outside it, and each
// run's goroutine is owned by the engine: Close cancels them and waits.
type Engine struct {
	mu      sync.Mutex
	w       *model.World
	secrets map[string]string
	runs    map[string]*run
	live    map[string]string // what is being written now in chats and discussions, by their id
	// output is the last lines of a command running now in a chat, by its id, with the run it belongs to
	output  map[string]liveOutput
	prev    map[string][]byte
	dirty   map[string]bool // conversations changed since the last save
	subs    map[chan Event]struct{}
	pending []Event
	logins  map[string]*loginRun
	// pendingKeys are API keys waiting on the user's answer to a change, by its KeyRef. They go with a restart.
	pendingKeys map[string]string
	// terms is what each company's terminal has shown, by the company's id; under its own lock, as output
	// comes all the time
	termMu sync.Mutex
	terms  map[string]*TerminalLog

	store     adapter.Store
	git       adapter.Git
	providers adapter.Providers
	dataDir   string
	log       zerolog.Logger
	clock     func() float64
	// search is the one web search everyone shares, so its queue and cooldown hold across them all.
	search *tools.Search

	ctx             context.Context
	cancel          context.CancelFunc
	wg              sync.WaitGroup
	closed          bool
	settingsRaw     model.SettingsSnapshot
	settingsEncoded []byte
	saveFailed      bool
}

// run is an agent working. Its callbacks count only while it is still the one registered in Engine.runs,
// so a stopped run can never change a sub-task that moved on.
type run struct {
	cancel    context.CancelFunc
	replicaID string
}

const (
	kindMeta = "meta"
	kindConv = "conv"
)

// NewEngine loads the world and picks up what was under way when the server last stopped.
func NewEngine(ctx context.Context, o Options) (*Engine, error) {
	e := &Engine{
		w: model.NewWorld(), runs: map[string]*run{}, live: map[string]string{}, output: map[string]liveOutput{}, prev: map[string][]byte{}, dirty: map[string]bool{},
		subs: map[chan Event]struct{}{}, logins: map[string]*loginRun{}, pendingKeys: map[string]string{}, terms: map[string]*TerminalLog{}, store: o.Store, git: o.Git, providers: o.Providers, dataDir: o.DataDir, log: o.Log,
		clock:  func() float64 { return float64(time.Now().UnixMilli()) / 1000 },
		search: &tools.Search{Endpoint: tools.ExaEndpoint, Log: o.Log, State: filepath.Join(o.DataDir, "cache", "search-cooldown.json")},
	}
	e.ctx, e.cancel = context.WithCancel(context.Background())
	if err := e.load(ctx); err != nil {
		e.cancel()
		return nil, err
	}
	secrets, err := o.Store.LoadSecrets(ctx)
	if err != nil {
		e.cancel()
		return nil, fmt.Errorf("load secrets: %w", err)
	}
	e.secrets = secrets

	e.mu.Lock()
	defer e.mu.Unlock()
	e.w.Now = e.clock()
	i18n.Set(e.w.Language)
	e.installPresets()
	for _, t := range e.w.Teams {
		e.readPrompt(t)
	}
	// the global AGENTS.md can be written outside the app
	if prompt, err := e.readGlobalPrompt(); err == nil && strings.TrimSpace(prompt) != "" {
		e.w.Tutorial.Learn("globalAgents")
	}
	if err := e.prepareSettings(ctx); err != nil {
		e.cancel()
		return nil, err
	}
	for _, s := range e.w.SubTasks {
		// nobody works across a restart: back in the queue, keeping the conversation so far
		if s.Status == enum.StatusProgressing {
			s.Status = enum.StatusTodo
			e.logLine(s, enum.LogSystem, i18n.T("伺服器重新啟動，重新排入佇列"), "", nil)
		}
	}
	for _, p := range e.w.Providers {
		p.Auth.Login = nil // a sign-in does not outlive the server
	}
	for _, t := range e.w.Tasks {
		if t.Stage == enum.StageMerging && t.Merge != nil {
			t.Merge.StartedAt = nil
		}
	}
	for _, s := range e.w.SubTasks {
		if s.Talk != nil && s.Talk.ReplyAt != nil {
			s.Talk.ReplyAt = nil
			if talking(s) {
				e.startTalkReply(e.w.Tasks[s.TaskID], s)
			}
		}
	}
	e.interruptChats()
	e.settle()
	return e, nil
}

// Close stops every run and waits for them, then ends the subscriptions.
func (e *Engine) Close() {
	e.mu.Lock()
	e.closed = true
	e.mu.Unlock()
	e.cancel()
	e.wg.Wait()
	e.mu.Lock()
	defer e.mu.Unlock()
	for ch := range e.subs {
		close(ch)
		delete(e.subs, ch)
	}
}

// do changes the world under the lock: when fn accepts, the flow moves on and the change is saved and sent.
func (e *Engine) do(fn func() error) error { return e.change(false, fn) }

func (e *Engine) doSettings(fn func() error) error { return e.change(true, fn) }

func (e *Engine) change(config bool, fn func() error) error {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.closed {
		return model.Errorf(model.CodeUnavailable, "伺服器已停止，請重新啟動")
	}
	var before *model.World
	if config {
		if err := e.store.CheckSettings(e.settingsRaw); err != nil {
			return err
		}
		before = clone(e.w)
		before.Conversations = e.w.Conversations
	}
	e.w.Now = e.clock()
	if err := fn(); err != nil {
		return err
	}
	if config {
		if err := e.sync(); err != nil {
			if !e.closed {
				e.w = before
			}
			return err
		}
	}
	e.settle()
	return nil
}

// settle advances the flow, then saves and publishes what changed. Call it holding the lock.
func (e *Engine) settle() {
	if !e.closed {
		e.step()
	}
	if err := e.sync(); err != nil {
		e.log.Error().Err(err).Msg("save world")
	}
}

func docKey(kind, id string) string { return kind + "\x00" + id }

func (e *Engine) load(ctx context.Context) error {
	rawSettings, err := e.store.LoadSettings(ctx)
	if err != nil {
		return err
	}
	docs, err := e.store.LoadDocs(ctx)
	if err != nil {
		return fmt.Errorf("load world: %w", err)
	}
	for _, d := range docs {
		var err error
		switch d.Kind {
		case kindMeta:
			var meta struct {
				Seq      int    `json:"seq"`
				Language string `json:"language"`
			}
			err = jsonx.Unmarshal(d.Data, &meta)
			e.w.Seq = meta.Seq
			if meta.Language != "" {
				e.w.Language = meta.Language
			}

		case kindConv:
			var conv []model.Message
			err = jsonx.Unmarshal(d.Data, &conv)
			e.w.Conversations[d.ID] = conv
		case "team":
			err = loadInto(d, e.w.Teams)
		case "provider":
			err = loadInto(d, e.w.Providers)
		case "blueprint":
			err = loadInto(d, e.w.Blueprints)
		case "replica":
			err = loadInto(d, e.w.Replicas)
		case "workflow":
			err = loadInto(d, e.w.Workflows)
		case "task":
			err = loadInto(d, e.w.Tasks)
		case "subTask":
			err = loadInto(d, e.w.SubTasks)
		case "chat":
			err = loadInto(d, e.w.Chats)
		}
		if err != nil {
			return fmt.Errorf("read %s %s: %w", d.Kind, d.ID, err)
		}
		e.prev[docKey(d.Kind, d.ID)] = d.Data
	}
	if len(docs) > 0 && rawSettings.Data == nil {
		return model.Errorf(model.CodeInvalid, "設定檔遺失；請還原設定檔，不能從執行資料重建設定")
	}
	if rawSettings.Data != nil {
		settings, err := e.parseSettings(rawSettings.Data)
		if err != nil {
			return err
		}
		settings.Install(e.w)
		e.settingsRaw, e.settingsEncoded = rawSettings, settingsBytes(e.w)
	}
	e.initializePlots()
	return nil
}

func loadInto[T any](d model.Doc, into map[string]*T) error {
	v := new(T)
	if err := jsonx.Unmarshal(d.Data, v); err != nil {
		return err
	}
	into[d.ID] = v
	return nil
}

func encodeAll[T any](docs map[string][]byte, kind string, all map[string]*T) {
	for id, v := range all {
		if raw, err := jsonx.Marshal(v); err == nil {
			docs[docKey(kind, id)] = raw
		}
	}
}

// documents captures the public entities plus private runtime records for change detection.
func (e *Engine) documents() map[string][]byte {
	now := map[string][]byte{}
	meta, _ := jsonx.Marshal(map[string]any{"seq": e.w.Seq, "language": e.w.Language})
	now[docKey(kindMeta, "world")] = meta
	prefs, _ := jsonx.Marshal(e.w.Preferences)
	now[docKey("preferences", "world")] = prefs
	tutorial, _ := jsonx.Marshal(e.w.Tutorial)
	now[docKey("tutorial", "world")] = tutorial
	encodeAll(now, "team", e.w.Teams)
	encodeAll(now, "provider", e.w.Providers)
	encodeAll(now, "blueprint", e.w.Blueprints)
	encodeAll(now, "replica", e.w.Replicas)
	encodeAll(now, "workflow", e.w.Workflows)
	encodeAll(now, "task", e.w.Tasks)
	encodeAll(now, "subTask", e.w.SubTasks)
	encodeAll(now, "chat", e.w.Chats)
	// conversations grow large, and only the ones marked have changed
	for id := range e.w.Conversations {
		key := docKey(kindConv, id)
		if e.dirty[id] {
			if raw, err := jsonx.Marshal(e.w.Conversations[id]); err == nil {
				now[key] = raw
			}
		} else if old, ok := e.prev[key]; ok {
			now[key] = old
		}
	}
	return now
}

// sync persists runtime records and changed settings before publishing their public entities.
func (e *Engine) sync() error {
	if e.saveFailed {
		return model.Errorf(model.CodeUnavailable, "設定儲存尚未完成，請重新啟動伺服器")
	}
	now := e.documents()
	encoded := settingsBytes(e.w)
	var changes []model.SettingsChange
	var written model.SettingsSnapshot
	if !bytes.Equal(encoded, e.settingsEncoded) {
		changes = append(changes, model.SettingsChange{Before: e.settingsRaw, After: encoded, Written: &written})
	}
	var upserts, deletes []model.Doc
	for key, raw := range now {
		if !bytes.Equal(e.prev[key], raw) {
			upserts = append(upserts, docOf(key, raw))
		}
	}
	for key := range e.prev {
		if _, ok := now[key]; !ok {
			deletes = append(deletes, docOf(key, nil))
		}
	}
	if len(upserts)+len(deletes)+len(changes) == 0 {
		e.flushPending()
		return nil
	}
	runtime := make([]model.Doc, 0, len(upserts))
	for _, d := range upserts {
		if d.Kind == "preferences" || d.Kind == "tutorial" {
			continue // Published to clients; persisted only in YAML.
		}
		row, err := model.RuntimeDoc(d)
		if err != nil {
			return err
		}
		runtime = append(runtime, row)
	}
	if err := e.store.Apply(context.Background(), runtime, deletes, changes...); err != nil {
		var pending *model.SettingsPending
		if errors.As(err, &pending) {
			e.closed, e.saveFailed = true, true
			e.cancel()
			return model.Errorf(model.CodeUnavailable, "%s", pending.Error())
		}
		return err
	}
	if len(changes) > 0 {
		e.settingsRaw, e.settingsEncoded = written, encoded
	}
	for _, d := range upserts {
		e.prev[docKey(d.Kind, d.ID)] = d.Data
	}
	for _, d := range deletes {
		delete(e.prev, docKey(d.Kind, d.ID))
	}
	e.dirty = map[string]bool{}
	ev := Event{Type: "patch"}
	for _, d := range upserts {
		if d.Kind != kindConv && d.Kind != kindMeta {
			ev.Upserts = append(ev.Upserts, Patch{Kind: d.Kind, ID: d.ID, Data: d.Data})
		}
	}
	for _, d := range deletes {
		if d.Kind != kindConv && d.Kind != kindMeta {
			ev.Deletes = append(ev.Deletes, Patch{Kind: d.Kind, ID: d.ID})
		}
	}
	if len(ev.Upserts)+len(ev.Deletes) > 0 {
		e.publish(ev)
	}
	e.flushPending()
	return nil
}

func docOf(key string, data []byte) model.Doc {
	i := bytes.IndexByte([]byte(key), 0)
	return model.Doc{Kind: key[:i], ID: key[i+1:], Data: data}
}

// DataDir is where the settings files and the database live: TEAM_WORK_HOME.
func (e *Engine) DataDir() string { return e.dataDir }

// notice sends after the changes it is about.
func (e *Engine) notice(ev Event) { e.pending = append(e.pending, ev) }

func (e *Engine) flushPending() {
	for _, ev := range e.pending {
		e.publish(ev)
	}
	e.pending = nil
}

// publish never blocks: a subscriber that cannot keep up is dropped and has to connect again for a snapshot.
func (e *Engine) publish(ev Event) {
	for ch := range e.subs {
		select {
		case ch <- ev:
		default:
			close(ch)
			delete(e.subs, ch)
		}
	}
}

// Subscribe returns the world as JSON and the changes after it. The channel closes when the
// subscription ends; cancel ends it early.
func (e *Engine) Subscribe() (snapshot []byte, events <-chan Event, cancel func(), err error) {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.closed {
		return nil, nil, nil, model.Errorf(model.CodeUnavailable, "伺服器正在關閉")
	}
	e.w.Now = e.clock()
	snapshot, err = jsonx.Marshal(e.w)
	if err != nil {
		return nil, nil, nil, fmt.Errorf("encode world: %w", err)
	}
	ch := make(chan Event, subscriberBuffer)
	e.subs[ch] = struct{}{}
	for id, text := range e.live { // what is being written is in no snapshot
		ch <- Event{Type: "delta", SubID: id, Text: text}
	}
	for id, o := range e.output {
		ch <- Event{Type: "toolOutput", SubID: id, Text: o.text}
	}
	return snapshot, ch, func() {
		e.mu.Lock()
		defer e.mu.Unlock()
		if _, ok := e.subs[ch]; ok {
			close(ch)
			delete(e.subs, ch)
		}
	}, nil
}

// Snapshot returns the world as JSON.
func (e *Engine) Snapshot() ([]byte, error) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.w.Now = e.clock()
	return jsonx.Marshal(e.w)
}

func (e *Engine) uid(prefix string) string {
	for {
		e.w.Seq++
		id := fmt.Sprintf("%s-%d", prefix, e.w.Seq)
		if e.w.Blueprints[id] == nil && e.w.Workflows[id] == nil {
			return id
		}
	}
}

func (e *Engine) worktreeOf(t *model.Task) string {
	return filepath.Join(e.dataDir, "cache", "worktrees", t.TeamID, t.ID)
}

func clone[T any](v T) T {
	var out T
	raw, err := json.Marshal(v)
	if err == nil {
		err = json.Unmarshal(raw, &out)
	}
	if err != nil {
		panic(fmt.Sprintf("clone %T: %v", v, err)) // the domain types always encode
	}
	return out
}

func ptr[T any](v T) *T { return &v }

// sortedSubs lists sub-tasks oldest first; ids break ties, shorter first because they end in a counter.
func sortedSubs(all []*model.SubTask) []*model.SubTask {
	sort.Slice(all, func(i, j int) bool {
		a, b := all[i], all[j]
		if a.CreatedAt != b.CreatedAt {
			return a.CreatedAt < b.CreatedAt
		}
		if len(a.ID) != len(b.ID) {
			return len(a.ID) < len(b.ID)
		}
		return a.ID < b.ID
	})
	return all
}
