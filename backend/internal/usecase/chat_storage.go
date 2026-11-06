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

func copyWorld(w *model.World) *model.World {
	// Other entities are still small. Do not serialize chat history just to undo
	// an operation; private model messages already use copy-on-write slices.
	rest := *w
	rest.Chats = nil
	out := clone(&rest)
	out.Chats = make(map[string]*model.Chat, len(w.Chats))
	for id, c := range w.Chats {
		out.Chats[id] = copyChat(c)
	}
	out.Conversations = maps.Clone(w.Conversations)
	return out
}

func (e *Engine) chatDocuments(docs map[string][]byte) {
	for id, c := range e.w.Chats {
		key := docKey("chat", id)
		// No mutation markers to forget: nested edits are compared with a detached
		// copy of the last successful save. Text strings are shared, not duplicated.
		if old, ok := e.savedChats[id]; ok && reflect.DeepEqual(old, c) {
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
