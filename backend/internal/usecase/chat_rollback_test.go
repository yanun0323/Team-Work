package usecase

import (
	"errors"
	"reflect"
	"testing"

	"github.com/yanun0323/Team-Work/internal/model"
	"github.com/yanun0323/Team-Work/pkg/jsonx"
)

func TestRollbackPreparationDoesNotCopySavedMessageAttachments(t *testing.T) {
	allocations := func(n int) float64 {
		e, _ := storageEngine(t)
		c := &model.Chat{ID: "c"}
		for i := 0; i < n; i++ {
			c.Messages = append(c.Messages, model.ChatMessage{Text: "history", Files: []model.Attachment{{URL: "file"}}, Mentions: []string{"employee"}})
		}
		e.w.Chats[c.ID] = c
		if err := e.sync(); err != nil {
			t.Fatal(err)
		}
		stop := errors.New("validation stopped")
		// Average enough runs to avoid codec pool/race-instrumentation noise.
		return testing.AllocsPerRun(1000, func() {
			if err := e.do(func() error { return stop }); err != stop {
				t.Fatal(err)
			}
		})
	}
	small, large := allocations(1), allocations(200)
	if large > small+4 {
		t.Fatalf("rollback preparation copies every message: small %.0f large %.0f", small, large)
	}
}

func TestRollbackDoesNotExposeCommittedChatToLaterMutations(t *testing.T) {
	t.Parallel()
	e, disk := storageEngine(t)
	e.w.Chats["c"] = &model.Chat{ID: "c", Messages: []model.ChatMessage{{Text: "original", Files: []model.Attachment{{URL: "original"}}}}}
	if err := e.sync(); err != nil {
		t.Fatal(err)
	}
	before := copyChat(e.w.Chats["c"])
	disk.fail = true
	for i := 0; i < 2; i++ {
		if err := e.do(func() error { e.w.Chats["c"].Messages[0].Files[0].URL = "failed"; return nil }); err == nil {
			t.Fatal("write succeeded")
		}
		if !reflect.DeepEqual(before, e.w.Chats["c"]) || !reflect.DeepEqual(before, e.savedChats["c"]) {
			t.Fatal("rollback or committed history polluted")
		}
	}
	disk.fail = false
	if err := e.do(func() error { e.w.Chats["c"].Messages[0].Files[0].URL = "saved"; return nil }); err != nil {
		t.Fatal(err)
	}
	var persisted model.Chat
	if err := jsonx.Unmarshal(disk.rows[docKey("chat", "c")], &persisted); err != nil {
		t.Fatal(err)
	}
	if persisted.Messages[0].Files[0].URL != "saved" {
		t.Fatal("later mutation was not detected")
	}
}

func TestRollbackPreservesUnsavedHistoryInsteadOfCommittedSnapshot(t *testing.T) {
	t.Parallel()
	e, disk := storageEngine(t)
	e.w.Chats["c"] = &model.Chat{ID: "c", Messages: []model.ChatMessage{{Text: "committed"}}}
	if err := e.sync(); err != nil {
		t.Fatal(err)
	}
	// A running reply may have changed public history when its last save failed.
	e.w.Chats["c"].Messages[0].Text = "pending reply"
	e.w.Chats["new"] = &model.Chat{ID: "new", Messages: []model.ChatMessage{{Text: "not saved yet"}}}
	disk.fail = true
	if err := e.do(func() error {
		e.w.Chats["c"].Messages[0].Text = "failed edit"
		delete(e.w.Chats, "new")
		return nil
	}); err == nil {
		t.Fatal("write succeeded")
	}
	if e.w.Chats["c"].Messages[0].Text != "pending reply" || e.w.Chats["new"].Messages[0].Text != "not saved yet" {
		t.Fatal("rollback discarded unsaved history")
	}
	if e.savedChats["c"].Messages[0].Text != "committed" {
		t.Fatal("committed snapshot changed")
	}
	disk.fail = false
	if err := e.sync(); err != nil {
		t.Fatal(err)
	}
	if e.savedChats["c"].Messages[0].Text != "pending reply" || e.savedChats["new"] == nil {
		t.Fatal("retry lost unsaved history")
	}
}

func TestChatMessageComparisonCoversEveryField(t *testing.T) {
	t.Parallel()
	zero := model.ChatMessage{}
	typ := reflect.TypeOf(zero)
	for i := 0; i < typ.NumField(); i++ {
		t.Run(typ.Field(i).Name, func(t *testing.T) {
			changed := model.ChatMessage{}
			field := reflect.ValueOf(&changed).Elem().Field(i)
			switch field.Kind() {
			case reflect.String:
				field.SetString("changed")
			case reflect.Bool:
				field.SetBool(true)
			case reflect.Float64:
				field.SetFloat(1)
			case reflect.Slice:
				field.Set(reflect.MakeSlice(field.Type(), 1, 1))
			default:
				t.Fatalf("add comparison coverage for %s", field.Type())
			}
			if sameChatMessage(&zero, &changed) {
				t.Fatal("field omitted from comparison")
			}
			if !sameChatMessage(&changed, &changed) {
				t.Fatal("equal value not recognized")
			}
			if field.Kind() != reflect.Slice {
				return
			}
			original := changed
			field.Set(reflect.MakeSlice(field.Type(), 1, 1))
			value := field.Index(0)
			if value.Kind() == reflect.String {
				value.SetString("nested change")
			} else {
				for j := 0; j < value.NumField(); j++ {
					nested := value.Field(j)
					if nested.Kind() != reflect.String {
						t.Fatalf("add nested coverage for %s", nested.Type())
					}
					nested.SetString("nested change")
					if sameChatMessage(&original, &changed) {
						t.Fatalf("nested field %s ignored", value.Type().Field(j).Name)
					}
					nested.SetString("")
				}
				value.Field(0).SetString("nested change")
			}
			if sameChatMessage(&original, &changed) {
				t.Fatal("slice contents ignored")
			}
			field.Set(reflect.MakeSlice(field.Type(), 0, 0))
			if sameChatMessage(&zero, &changed) {
				t.Fatal("nil and empty conflated")
			}
		})
	}
}

func TestSameChatMatchesDeepEqualForNilAndMetadata(t *testing.T) {
	t.Parallel()
	cases := []*model.Chat{nil, {}, {Messages: []model.ChatMessage{}}, {Title: "title"},
		{Messages: []model.ChatMessage{{Text: "one"}}}, {Messages: []model.ChatMessage{{Text: "two"}}},
		{Question: &model.ChatQuestion{Options: []string{"yes"}}},
	}
	for _, a := range cases {
		for _, b := range cases {
			if sameChat(a, b) != reflect.DeepEqual(a, b) {
				t.Fatalf("comparison differs: %+v %+v", a, b)
			}
		}
	}
}
