package usecase

import (
	"context"
	"errors"
	"fmt"
	"reflect"
	"strings"
	"testing"

	"github.com/yanun0323/Team-Work/internal/adapter"
	"github.com/yanun0323/Team-Work/internal/model"
	"github.com/yanun0323/Team-Work/pkg/jsonx"
)

type chatDisk struct {
	adapter.Store
	fail bool
}

func (s *chatDisk) Apply(context.Context, []model.Doc, []model.Doc, []model.SecretChange, ...model.SettingsChange) error {
	if s.fail {
		return errors.New("disk full")
	}
	return nil
}

func storageEngine(t testing.TB) (*Engine, *chatDisk) {
	t.Helper()
	disk := &chatDisk{}
	e := &Engine{w: model.NewWorld(), store: disk, prev: map[string][]byte{}, dirty: map[string]bool{}, clock: func() float64 { return 1 }}
	return e, disk
}

func TestUnchangedChatsReusePersistedEncoding(t *testing.T) {
	e, _ := storageEngine(t)
	e.w.Chats["c"] = &model.Chat{ID: "c", Messages: []model.ChatMessage{{Text: strings.Repeat("history ", 10000)}}}
	if err := e.sync(); err != nil {
		t.Fatal(err)
	}
	key := docKey("chat", "c")
	saved := e.prev[key]
	e.w.Preferences.MusicVolume = 12
	got := e.documents()[key]
	if &got[0] != &saved[0] {
		t.Fatal("unchanged chat was encoded again")
	}
}

func TestChangedChatEncodingIsKeptOnlyAfterSuccessfulSave(t *testing.T) {
	e, disk := storageEngine(t)
	c := &model.Chat{ID: "c", Messages: []model.ChatMessage{{Text: "old", Images: []model.Attachment{{URL: "old.png"}}}}}
	e.w.Chats[c.ID] = c
	if err := e.sync(); err != nil {
		t.Fatal(err)
	}
	old := string(e.prev[docKey("chat", c.ID)])
	c.Messages[0].Images[0].URL = "new.png"
	disk.fail = true
	if err := e.sync(); err == nil {
		t.Fatal("missing save failure")
	}
	if string(e.prev[docKey("chat", c.ID)]) != old {
		t.Fatal("failed write replaced saved bytes")
	}
	disk.fail = false
	if err := e.sync(); err != nil {
		t.Fatal(err)
	}
	var saved model.Chat
	if err := jsonx.Unmarshal(e.prev[docKey("chat", c.ID)], &saved); err != nil {
		t.Fatal(err)
	}
	if saved.Messages[0].Images[0].URL != "new.png" {
		t.Fatal("retry lost nested change")
	}
	delete(e.w.Chats, c.ID)
	if err := e.sync(); err != nil {
		t.Fatal(err)
	}
	if _, ok := e.prev[docKey("chat", c.ID)]; ok {
		t.Fatal("deleted chat still cached")
	}
	e.w.Chats[c.ID] = &model.Chat{ID: c.ID, Title: "replacement"}
	if err := e.sync(); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(e.prev[docKey("chat", c.ID)]), "replacement") {
		t.Fatal("recreated chat reused stale bytes")
	}
}

func TestChatChangesAreDetectedWithoutDirtyMarkers(t *testing.T) {
	e, _ := storageEngine(t)
	style := 2
	c := &model.Chat{ID: "c", Look: model.Look{Style: &style}, Messages: []model.ChatMessage{{Text: "old", Images: []model.Attachment{{URL: "image"}}, Files: []model.Attachment{{URL: "file"}}, Mentions: []string{"a"}, Tasks: []string{"t"}, Made: []model.Made{{ID: "b"}}}}, Queue: []model.QueuedMessage{{Text: "queued", Images: []model.Attachment{{URL: "queued image"}}}}, Question: &model.ChatQuestion{Options: []string{"yes"}}, Compact: &model.ChatCompact{Summary: "summary"}}
	e.w.Chats[c.ID] = c
	changes := []func(){
		func() { c.Title = "renamed" }, func() { c.Unread = true }, func() { *c.Look.Style = 3 },
		func() { c.Messages[0].Text = "edited" }, func() { c.Messages[0].Images[0].URL = "other" },
		func() { c.Messages[0].Files[0].URL = "other" }, func() { c.Messages[0].Mentions[0] = "b" },
		func() { c.Messages[0].Tasks[0] = "t2" }, func() { c.Messages[0].Made[0].ID = "b2" },
		func() { c.Queue[0].Images[0].URL = "other" }, func() { c.Question.Options[0] = "no" },
		func() { c.Compact.Summary = "new summary" }, func() { c.Messages = c.Messages[:0] },
	}
	for i, change := range changes {
		if err := e.sync(); err != nil {
			t.Fatal(err)
		}
		before := string(e.prev[docKey("chat", c.ID)])
		change()
		got := e.documents()[docKey("chat", c.ID)]
		expected, err := jsonx.Marshal(c)
		if err != nil {
			t.Fatal(err)
		}
		if string(got) == before || string(got) != string(expected) {
			t.Fatalf("mutation %d was lost", i)
		}
	}
}

func TestFailedChatChangeRestoresNestedHistory(t *testing.T) {
	e, disk := storageEngine(t)
	e.w.Chats["c"] = &model.Chat{ID: "c", Messages: []model.ChatMessage{{Text: "original", Images: []model.Attachment{{URL: "before"}}, Tasks: []string{"old"}}}, Queue: []model.QueuedMessage{{Mentions: []string{"a"}}}}
	if err := e.sync(); err != nil {
		t.Fatal(err)
	}
	before := clone(e.w.Chats["c"])
	disk.fail = true
	err := e.do(func() error {
		c := e.w.Chats["c"]
		c.Messages[0].Text = "lost"
		c.Messages[0].Images[0].URL = "lost"
		c.Messages[0].Tasks[0] = "lost"
		c.Queue[0].Mentions[0] = "lost"
		return nil
	})
	if err == nil {
		t.Fatal("missing save error")
	}
	if !reflect.DeepEqual(before, e.w.Chats["c"]) {
		t.Fatal("rollback aliased changed history")
	}
	disk.fail = false
	if err := e.sync(); err != nil {
		t.Fatal(err)
	}
	var saved model.Chat
	if err := jsonx.Unmarshal(e.prev[docKey("chat", "c")], &saved); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(before, &saved) {
		t.Fatal("rollback saved mutated history")
	}
}

func historyEngine(b testing.TB) *Engine {
	e, _ := storageEngine(b)
	for i := range 277 {
		c := &model.Chat{ID: fmt.Sprint(i)}
		for range 60 {
			c.Messages = append(c.Messages, model.ChatMessage{Text: strings.Repeat("history ", 100)})
		}
		e.w.Chats[c.ID] = c
	}
	if err := e.sync(); err != nil {
		b.Fatal(err)
	}
	return e
}

func BenchmarkHistoryDocuments(b *testing.B) {
	e := historyEngine(b)
	b.ReportAllocs()
	b.ResetTimer()
	for b.Loop() {
		e.documents()
	}
}
func BenchmarkHistoryUndo(b *testing.B) {
	e := historyEngine(b)
	stop := errors.New("validation stopped")
	b.ReportAllocs()
	b.ResetTimer()
	for b.Loop() {
		_ = e.do(func() error { return stop })
	}
}

func TestCopyChatOwnsAllMutableFields(t *testing.T) {
	// Fill every exported field recursively, including future fields, so a newly
	// added pointer or slice cannot silently alias a rollback or saved snapshot.
	var fill func(reflect.Value)
	fill = func(v reflect.Value) {
		switch v.Kind() {
		case reflect.Pointer:
			v.Set(reflect.New(v.Type().Elem()))
			fill(v.Elem())
		case reflect.Struct:
			for i := 0; i < v.NumField(); i++ {
				fill(v.Field(i))
			}
		case reflect.Slice:
			if v.Type() == reflect.TypeOf([]byte(nil)) {
				v.SetBytes([]byte("{}"))
				return
			}
			if v.Type().Elem().Kind() == reflect.Uint8 {
				v.SetBytes([]byte("{}"))
				return
			}
			v.Set(reflect.MakeSlice(v.Type(), 1, 1))
			fill(v.Index(0))
		case reflect.Map:
			v.Set(reflect.MakeMap(v.Type()))
			key := reflect.New(v.Type().Key()).Elem()
			fill(key)
			value := reflect.New(v.Type().Elem()).Elem()
			fill(value)
			v.SetMapIndex(key, value)
		case reflect.String:
			v.SetString("value")
		case reflect.Bool:
			v.SetBool(true)
		case reflect.Int, reflect.Int64:
			v.SetInt(1)
		case reflect.Float64:
			v.SetFloat(1)
		}
	}
	c := new(model.Chat)
	fill(reflect.ValueOf(c).Elem())
	copied := copyChat(c)
	if !reflect.DeepEqual(c, copied) {
		t.Fatal("copy changed values")
	}
	var separate func(reflect.Value, reflect.Value, string)
	separate = func(a, b reflect.Value, path string) {
		switch a.Kind() {
		case reflect.Pointer:
			if !a.IsNil() {
				if a.Pointer() == b.Pointer() {
					t.Errorf("shared pointer %s", path)
				}
				separate(a.Elem(), b.Elem(), path)
			}
		case reflect.Slice:
			if a.Len() > 0 {
				if a.Pointer() == b.Pointer() {
					t.Errorf("shared slice %s", path)
				}
				for i := 0; i < a.Len(); i++ {
					separate(a.Index(i), b.Index(i), path)
				}
			}
		case reflect.Map:
			if !a.IsNil() && a.Pointer() == b.Pointer() {
				t.Errorf("shared map %s", path)
			}
		case reflect.Struct:
			for i := 0; i < a.NumField(); i++ {
				separate(a.Field(i), b.Field(i), path+"."+a.Type().Field(i).Name)
			}
		}
	}
	separate(reflect.ValueOf(c), reflect.ValueOf(copied), "chat")
}

func TestChatSyncPublishesOnlyChangesAndNotFailedWrites(t *testing.T) {
	e, disk := storageEngine(t)
	ch := make(chan Event, 10)
	e.subs = map[chan Event]struct{}{ch: {}}
	e.w.Chats["a"] = &model.Chat{ID: "a"}
	e.w.Chats["b"] = &model.Chat{ID: "b"}
	if err := e.sync(); err != nil {
		t.Fatal(err)
	}
	<-ch
	if err := e.sync(); err != nil {
		t.Fatal(err)
	}
	if len(ch) != 0 {
		t.Fatal("unchanged chats were published")
	}
	e.w.Chats["a"].Title = "new"
	disk.fail = true
	if err := e.sync(); err == nil {
		t.Fatal("missing failure")
	}
	if len(ch) != 0 {
		t.Fatal("failed save was published")
	}
	disk.fail = false
	if err := e.sync(); err != nil {
		t.Fatal(err)
	}
	event := <-ch
	if len(event.Upserts) != 1 || event.Upserts[0].ID != "a" {
		t.Fatalf("patch: %+v", event)
	}
	delete(e.w.Chats, "a")
	if err := e.sync(); err != nil {
		t.Fatal(err)
	}
	event = <-ch
	if len(event.Deletes) != 1 || event.Deletes[0].ID != "a" {
		t.Fatalf("delete: %+v", event)
	}
	if _, ok := e.savedChats["a"]; ok {
		t.Fatal("deleted snapshot retained")
	}
}
