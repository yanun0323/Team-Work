package usecase

import (
	"crypto/sha256"
	"fmt"
	"reflect"
	"regexp"
	"slices"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/yanun0323/Team-Work/internal/model"
	"github.com/yanun0323/Team-Work/pkg/jsonx"
)

// ChatHistory is the bounded list/notification metadata sent instead of message bodies.
// Version identifies the history, not mutable UI metadata such as unread or title.
type ChatHistory struct {
	Version        string             `json:"version"`
	Previous       string             `json:"previous,omitempty"`
	ChangedFrom    int                `json:"changedFrom"`
	Count          int                `json:"count"`
	Preview        string             `json:"preview"`
	PreviewKind    string             `json:"previewKind,omitempty"`
	SortAt         float64            `json:"sortAt"`
	LastAgent      *model.ChatMessage `json:"lastAgent,omitempty"`
	Mentions       []string           `json:"mentions,omitempty"`
	HasFileMention bool               `json:"hasFileMention"`
	HasAttachment  bool               `json:"hasAttachment"`
}

type ChatSummary struct {
	*model.Chat
	History ChatHistory `json:"history"`
}

type PageHandoff struct {
	model.ChatHandoff
	To string `json:"to"`
}

type ChatPage struct {
	Version  string              `json:"version"`
	Start    int                 `json:"start"`
	Total    int                 `json:"total"`
	Messages []model.ChatMessage `json:"messages"`
	Handoffs []PageHandoff       `json:"handoffs"`
	Joins    []model.ChatJoin    `json:"joins"`
}

var fileMention = regexp.MustCompile(`(^|\s)#\S`)

func previewText(text string, limit int) string {
	// Keep only the prefix; trailing whitespace alone must not cause truncation.
	var out strings.Builder
	count, cut := 0, 0
	space := false
	for i, r := range text {
		if unicode.IsSpace(r) {
			space = count > 0
			continue
		}
		if space {
			if count == limit-1 {
				cut = out.Len()
			}
			out.WriteByte(' ')
			count++
			space = false
		}
		if count >= limit {
			// Match the old rune-based truncation, including malformed UTF-8.
			return string([]rune(out.String()[:cut])) + "…"
		}
		if count == limit-1 {
			cut = out.Len()
		}
		_, size := utf8.DecodeRuneInString(text[i:])
		out.WriteString(text[i : i+size])
		count++
	}
	return out.String()
}

func historyVersion(c *model.Chat) string {
	raw, _ := jsonx.Marshal(struct {
		Messages []model.ChatMessage
		Handoffs []model.ChatHandoff
		Joins    []model.ChatJoin
	}{c.Messages, c.Handoffs, c.Joins})
	return fmt.Sprintf("%x", sha256.Sum256(raw))
}

func summarizeChat(c, old *model.Chat, previous ChatHistory) ChatSummary {
	version := previous.Version
	if old == nil || version == "" || !reflect.DeepEqual(c.Messages, old.Messages) || !reflect.DeepEqual(c.Handoffs, old.Handoffs) || !reflect.DeepEqual(c.Joins, old.Joins) {
		version = historyVersion(c)
	}
	h := ChatHistory{Version: version, Count: len(c.Messages), SortAt: c.CreatedAt}
	if h.Version == previous.Version {
		h.Previous, h.ChangedFrom = previous.Previous, previous.ChangedFrom
	} else if old != nil {
		h.Previous = previous.Version
		if reflect.DeepEqual(c.Handoffs, old.Handoffs) && reflect.DeepEqual(c.Joins, old.Joins) {
			for h.ChangedFrom < min(len(old.Messages), len(c.Messages)) && reflect.DeepEqual(c.Messages[h.ChangedFrom], old.Messages[h.ChangedFrom]) {
				h.ChangedFrom++
			}
		}
	}
	lastAgent := -1
	var mentions []string
	for i, m := range c.Messages {
		if i == 0 {
			h.Preview = previewText(m.Text, 200)
			if h.Preview == "" {
				if len(m.Images) > 0 {
					h.PreviewKind = "image"
				} else if len(m.Files) > 0 {
					h.PreviewKind = "file"
				}
			}
		}
		if c.ReplyAt == nil || m.From == "user" {
			h.SortAt = max(h.SortAt, m.At)
		}
		if m.From == "agent" {
			lastAgent = i
		}
		if m.From == "user" {
			mentions = m.Mentions
			h.HasFileMention = h.HasFileMention || fileMention.MatchString(m.Text)
			h.HasAttachment = h.HasAttachment || len(m.Images)+len(m.Files) > 0
		}
	}
	h.Mentions = slices.Clone(mentions)
	if lastAgent >= 0 {
		m := c.Messages[lastAgent]
		h.LastAgent = &model.ChatMessage{From: m.From, At: m.At, By: m.By, Text: previewText(m.Text, 200)}
	}
	base := *c
	base.Messages = []model.ChatMessage{}
	base.Handoffs = nil
	base.Joins = nil
	base.Compact = nil
	return ChatSummary{Chat: copyChat(&base), History: h}
}

// Called under the engine lock. Successful saves alone replace these cached summaries.
func (e *Engine) chatSummary(c *model.Chat) ChatSummary {
	if e.chatSummaries == nil {
		e.chatSummaries = map[string]ChatSummary{}
	}
	if s, ok := e.chatSummaries[c.ID]; ok {
		return s
	}
	s := summarizeChat(c, nil, ChatHistory{})
	e.chatSummaries[c.ID] = s
	return s
}

func (e *Engine) pagedSnapshot() ([]byte, error) {
	chats := make(map[string]ChatSummary, len(e.w.Chats))
	for id, c := range e.w.Chats {
		chats[id] = e.chatSummary(c)
	}
	return jsonx.Marshal(struct {
		*model.World
		Chats map[string]ChatSummary `json:"chats"`
	}{e.w, chats})
}

func (e *Engine) PagedSnapshot() ([]byte, error) {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.pagedSnapshot()
}

// ChatMessages returns one immutable range from a specific history version. Empty version selects the latest.
func (e *Engine) ChatMessages(id, version string, before, limit int) (*ChatPage, error) {
	e.mu.Lock()
	defer e.mu.Unlock()
	c := e.w.Chats[id]
	if c == nil {
		return nil, model.Errorf(model.CodeNotFound, "找不到對話")
	}
	current := e.chatSummary(c).History.Version
	if version != "" && version != current {
		return nil, model.Errorf(model.CodeConflict, "版本不符，內容已經被改過，請重新讀取")
	}
	if before < 0 || before > len(c.Messages) || limit < 1 || limit > 100 {
		return nil, model.Errorf(model.CodeInvalid, "訊息範圍不正確")
	}
	start := max(0, before-limit)
	part := *c
	part.Messages = c.Messages[start:before]
	part.Handoffs = nil
	part.Joins = nil
	handoffs := []PageHandoff{}
	for i, h := range c.Handoffs {
		if h.Before >= start && (h.Before < before || before == len(c.Messages)) {
			to := c.Name
			if i+1 < len(c.Handoffs) {
				to = c.Handoffs[i+1].Name
			}
			handoffs = append(handoffs, PageHandoff{h, to})
		}
	}
	for _, j := range c.Joins {
		if j.Before >= start && (j.Before < before || before == len(c.Messages)) {
			part.Joins = append(part.Joins, j)
		}
	}
	detached := copyChat(&part)
	if detached.Messages == nil {
		detached.Messages = []model.ChatMessage{}
	}
	return &ChatPage{current, start, len(c.Messages), detached.Messages, handoffs, detached.Joins}, nil
}

// ChatSummaryJSON is a detached response for creation/fork endpoints in paged mode.
func (e *Engine) ChatSummaryJSON(id string) ([]byte, error) {
	e.mu.Lock()
	defer e.mu.Unlock()
	c := e.w.Chats[id]
	if c == nil {
		return nil, model.Errorf(model.CodeNotFound, "找不到對話")
	}
	return jsonx.Marshal(e.chatSummary(c))
}
