package usecase

import (
	"maps"
	"reflect"
	"slices"

	"github.com/yanun0323/Team-Work/internal/model"
	"github.com/yanun0323/Team-Work/pkg/jsonx"
)

// copyChat owns mutable fields but shares immutable strings, including long
// message text. Keep this in step with model.Chat and model.ChatMessage.
func copyChat(c *model.Chat) *model.Chat {
	if c == nil {
		return nil
	}
	out := *c
	out.Look.Style = copyPointer(c.Look.Style)
	out.PinnedAt = copyPointer(c.PinnedAt)
	out.ReplyAt = copyPointer(c.ReplyAt)
	out.Compact = copyPointer(c.Compact)
	if c.Question != nil {
		out.Question = copyPointer(c.Question)
		out.Question.Options = slices.Clone(c.Question.Options)
	}
	if c.Change != nil {
		out.Change = clone(c.Change)
	}
	out.Messages = slices.Clone(c.Messages)
	for i, m := range c.Messages {
		out.Messages[i].Images = slices.Clone(m.Images)
		out.Messages[i].Files = slices.Clone(m.Files)
		out.Messages[i].Mentions = slices.Clone(m.Mentions)
		out.Messages[i].Tasks = slices.Clone(m.Tasks)
		out.Messages[i].Made = slices.Clone(m.Made)
	}
	out.Handoffs = slices.Clone(c.Handoffs)
	out.Guests = slices.Clone(c.Guests)
	for i, g := range c.Guests {
		out.Guests[i].Look.Style = copyPointer(g.Look.Style)
	}
	out.Joins = slices.Clone(c.Joins)
	out.Next = slices.Clone(c.Next)
	out.Queue = slices.Clone(c.Queue)
	for i, q := range c.Queue {
		out.Queue[i].Images = slices.Clone(q.Images)
		out.Queue[i].Files = slices.Clone(q.Files)
		out.Queue[i].Mentions = slices.Clone(q.Mentions)
	}
	return &out
}

func copyPointer[T any](p *T) *T {
	if p == nil {
		return nil
	}
	out := *p
	return &out
}

// Message slices contain only comparable values. Preserve nil versus empty,
// as DeepEqual does, without allocating a cycle-detection table for the history.
func sameChatSlice[T comparable](a, b []T) bool {
	return (a == nil) == (b == nil) && slices.Equal(a, b)
}

// Keep this comparison in step with ChatMessage (checked by its field test).
func sameChatMessage(a, b *model.ChatMessage) bool {
	return a.At == b.At && a.From == b.From && a.Text == b.Text && a.By == b.By &&
		a.Failed == b.Failed && a.SignedOut == b.SignedOut &&
		sameChatSlice(a.Images, b.Images) && sameChatSlice(a.Files, b.Files) &&
		sameChatSlice(a.Mentions, b.Mentions) && sameChatSlice(a.Tasks, b.Tasks) && sameChatSlice(a.Made, b.Made)
}

// Compare message contents without reflection; all other chat fields still use
// DeepEqual so new metadata cannot silently escape change detection.
func sameChat(a, b *model.Chat) bool {
	if a == b {
		return true
	}
	if a == nil || b == nil || len(a.Messages) != len(b.Messages) || (a.Messages == nil) != (b.Messages == nil) {
		return false
	}
	left, right := *a, *b
	left.Messages, right.Messages = nil, nil
	if !reflect.DeepEqual(&left, &right) {
		return false
	}
	for i := range a.Messages {
		if !sameChatMessage(&a.Messages[i], &b.Messages[i]) {
			return false
		}
	}
	return true
}

// rollbackWorld borrows immutable committed chats only when they match the live
// value. The caller must copy those chats before installing this world on undo.
func (e *Engine) rollbackWorld() *model.World {
	w := e.w
	// Other entities are still small; private model messages use copy-on-write.
	rest := *w
	rest.Chats = nil
	out := clone(&rest)
	out.Chats = make(map[string]*model.Chat, len(w.Chats))
	for id, c := range w.Chats {
		if saved, ok := e.savedChats[id]; ok && sameChat(saved, c) {
			out.Chats[id] = saved
		} else {
			// A failed background save can leave newer history than the committed copy.
			out.Chats[id] = copyChat(c)
		}
	}
	out.Conversations = maps.Clone(w.Conversations)
	return out
}

func (e *Engine) chatDocuments(docs map[string][]byte) {
	for id, c := range e.w.Chats {
		key := docKey("chat", id)
		// No mutation markers to forget: nested edits are compared with a detached
		// copy of the last successful save. Text strings are shared, not duplicated.
		// An unchanged chat contributes only its nil presence marker, not JSON.
		if old, ok := e.savedChats[id]; ok && sameChat(old, c) {
			if raw, ok := e.prev[key]; ok {
				docs[key] = raw
				continue
			}
		}
		if raw, err := jsonx.Marshal(c); err == nil {
			docs[key] = raw
		}
	}
}
