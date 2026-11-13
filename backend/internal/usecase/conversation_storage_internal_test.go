package usecase

import (
	"context"
	"errors"
	"reflect"
	"testing"

	"github.com/yanun0323/Team-Work/internal/adapter"
	"github.com/yanun0323/Team-Work/internal/model"
	"github.com/yanun0323/Team-Work/internal/repository"
	"github.com/yanun0323/Team-Work/pkg/jsonx"
)

type conversationDisk struct {
	adapter.Store
	rows               map[string][]byte
	reads              int
	failRead, failSave bool
}

func (s *conversationDisk) LoadConversation(_ context.Context, id string) ([]byte, error) {
	s.reads++
	if s.failRead {
		return nil, errors.New("read failed")
	}
	raw, ok := s.rows[id]
	if !ok {
		return nil, errors.New("missing history")
	}
	return raw, nil
}
func (s *conversationDisk) Apply(_ context.Context, up, del []model.Doc, _ []model.SecretChange, _ ...model.SettingsChange) error {
	if s.failSave {
		return errors.New("disk full")
	}
	for _, d := range up {
		if d.Kind == kindConv {
			s.rows[d.ID] = d.Data
		}
	}
	for _, d := range del {
		if d.Kind == kindConv {
			delete(s.rows, d.ID)
		}
	}
	return nil
}
func TestIdleConversationsReleaseAndReloadOnlyWhenNeeded(t *testing.T) {
	t.Parallel()
	e, _ := storageEngine(t)
	disk := &conversationDisk{rows: map[string][]byte{}}
	e.store = disk
	e.w.Conversations["c"] = []model.Message{userText("original")}
	e.dirty["c"] = true
	if err := e.sync(); err != nil {
		t.Fatal(err)
	}
	if e.w.Conversations["c"] != nil || len(e.prev[docKey(kindConv, "c")]) != 0 {
		t.Fatal("idle history remains resident")
	}
	if err := e.sync(); err != nil {
		t.Fatal(err)
	}
	if disk.reads != 0 || len(disk.rows) != 1 {
		t.Fatal("unrelated save read or deleted history")
	}
	if err := e.loadConversation("c"); err != nil {
		t.Fatal(err)
	}
	if disk.reads != 1 || e.w.Conversations["c"][0].Content[0].Text != "original" {
		t.Fatal("history not restored")
	}
	e.runs = map[string]*run{"c": {}}
	if err := e.sync(); err != nil {
		t.Fatal(err)
	}
	if e.w.Conversations["c"] == nil {
		t.Fatal("active history evicted")
	}
	delete(e.runs, "c")
	if err := e.sync(); err != nil {
		t.Fatal(err)
	}
	disk.failRead = true
	if err := e.loadConversation("c"); err == nil {
		t.Fatal("read failure became empty history")
	}
	if e.w.Conversations["c"] != nil {
		t.Fatal("failed read cached")
	}
	disk.failRead = false
	disk.rows["c"] = []byte("broken")
	if err := e.loadConversation("c"); err == nil {
		t.Fatal("invalid history accepted")
	}
	disk.rows["c"], _ = jsonx.Marshal([]model.Message{userText("original")})
	if err := e.loadConversation("c"); err != nil {
		t.Fatal(err)
	}
	e.w.Conversations["c"] = append(e.w.Conversations["c"], userText("unsaved"))
	e.dirty["c"] = true
	disk.failSave = true
	if err := e.sync(); err == nil {
		t.Fatal("save succeeded")
	}
	if len(e.w.Conversations["c"]) != 2 || !e.dirty["c"] {
		t.Fatal("unsaved history evicted")
	}
	disk.failSave = false
	if err := e.sync(); err != nil {
		t.Fatal(err)
	}
	if err := e.loadConversation("c"); err != nil {
		t.Fatal(err)
	}
	if len(e.w.Conversations["c"]) != 2 {
		t.Fatal("retry lost history")
	}
	delete(e.w.Conversations, "c")
	if err := e.sync(); err != nil {
		t.Fatal(err)
	}
	if len(disk.rows) != 0 {
		t.Fatal("explicit deletion not persisted")
	}
}

func TestFailedColdRewindDoesNotSaveNullOnNextUnrelatedChange(t *testing.T) {
	t.Parallel()
	e, _ := storageEngine(t)
	disk := &conversationDisk{rows: map[string][]byte{}}
	e.store = disk
	e.w.Chats["c"] = &model.Chat{ID: "c", Messages: []model.ChatMessage{{From: "user", Text: "original"}}}
	e.w.Conversations["c"] = []model.Message{userText("original")}
	e.dirty["c"] = true
	if err := e.sync(); err != nil {
		t.Fatal(err)
	}
	original := string(disk.rows["c"])
	disk.failSave = true
	if err := e.RewindChat("c", 0); err == nil {
		t.Fatal("rewind succeeded")
	}
	if e.dirty["c"] || e.w.Conversations["c"] != nil || len(e.w.Chats["c"].Messages) != 1 {
		t.Fatal("rollback left dirty unloaded history")
	}
	disk.failSave = false
	if err := e.sync(); err != nil {
		t.Fatal(err)
	}
	if string(disk.rows["c"]) != original {
		t.Fatal("unrelated save destroyed restored history")
	}
	if err := e.RewindChat("c", 0); err != nil {
		t.Fatal(err)
	}
	if err := e.loadConversation("c"); err != nil {
		t.Fatal(err)
	}
	if len(e.w.Conversations["c"]) != 0 {
		t.Fatal("empty rewind not saved")
	}
}

func TestColdHistoryReadFailureLeavesMutationsAndQueueUntouched(t *testing.T) {
	t.Parallel()
	e, _ := storageEngine(t)
	disk := &conversationDisk{rows: map[string][]byte{}, failRead: true}
	e.store = disk
	c := &model.Chat{ID: "c", Messages: []model.ChatMessage{{From: "user", Text: "original"}}, Queue: []model.QueuedMessage{{ID: "q", Text: "queued"}}}
	e.w.Chats["c"] = c
	e.w.Conversations["c"] = nil
	e.prev[docKey(kindConv, "c")] = nil
	before := copyChat(c)
	for _, op := range []func() error{
		func() error { return e.SayInChat("c", "new", nil) },
		func() error { return e.RewindChat("c", 0) },
		func() error { _, err := e.HandOffChat("c", 0, ""); return err },
		func() error { return e.SteerChat("c", "q") },
	} {
		if err := op(); err == nil {
			t.Fatal("read failure ignored")
		}
		if !reflect.DeepEqual(c, before) || len(e.runs) > 0 || e.dirty["c"] {
			t.Fatal("failed read changed chat")
		}
	}
	if disk.reads != 4 {
		t.Fatalf("did not exercise reads: %d", disk.reads)
	}
}

func TestStartupLoadsOnlyConversationIndex(t *testing.T) {
	t.Parallel()
	e, _ := storageEngine(t)
	e.dataDir = t.TempDir()
	store, err := repository.NewStore(e.dataDir)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	e.store = store
	settings, _ := jsonx.Marshal(model.SettingsOf(e.w))
	raw, _ := jsonx.Marshal([]model.Message{userText("kept on disk")})
	if err = store.Apply(context.Background(), []model.Doc{{Kind: kindConv, ID: "c", Data: raw}}, nil, nil, model.SettingsChange{After: settings}); err != nil {
		t.Fatal(err)
	}
	if err = e.load(context.Background()); err != nil {
		t.Fatal(err)
	}
	conv, ok := e.w.Conversations["c"]
	if !ok || conv != nil || e.prev[docKey(kindConv, "c")] != nil {
		t.Fatal("startup retained history")
	}
	if err = e.sync(); err != nil {
		t.Fatal(err)
	}
	if err = e.loadConversation("c"); err != nil {
		t.Fatal(err)
	}
	if e.w.Conversations["c"][0].Content[0].Text != "kept on disk" {
		t.Fatal("startup deleted history")
	}
}

func (s *conversationDisk) InlineConversations(context.Context) ([]string, error) {
	return []string{"c"}, nil
}

func TestInlineConversationMigrationFailureKeepsOriginal(t *testing.T) {
	t.Parallel()
	e, _ := storageEngine(t)
	e.dataDir = t.TempDir()
	original := []byte(`[{"role":"user","content":[{"type":"image","mimeType":"image/png","data":"aGVsbG8="}]}]`)
	disk := &conversationDisk{rows: map[string][]byte{"c": original}, failSave: true}
	e.store = disk
	if err := e.migrateConversationImages(context.Background()); err == nil {
		t.Fatal("migration ignored failed write")
	}
	if string(disk.rows["c"]) != string(original) {
		t.Fatal("migration lost original")
	}
	disk.failSave = false
	if err := e.migrateConversationImages(context.Background()); err != nil {
		t.Fatal(err)
	}
	var stored []model.Message
	if err := jsonx.Unmarshal(disk.rows["c"], &stored); err != nil {
		t.Fatal(err)
	}
	if stored[0].Content[0].Data != "" || stored[0].Content[0].ImageRef == "" {
		t.Fatal("inline image not migrated")
	}
	restored, err := e.resolveImages(context.Background(), stored)
	if err != nil || restored[0].Content[0].Data != "aGVsbG8=" {
		t.Fatal("original image not recoverable", err)
	}
	if len(e.w.Conversations) > 0 {
		t.Fatal("migration retained decoded histories")
	}
}
