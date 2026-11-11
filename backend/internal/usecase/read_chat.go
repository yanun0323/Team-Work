package usecase

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/yanun0323/Team-Work/internal/model"
)

const (
	toolReadChat = "read_chat"
	// readChatBytes caps one read, as read_file does; offset and limit read the rest.
	readChatBytes = 50 << 10
)

var readChatSpec = model.ToolSpec{Name: toolReadChat,
	Description: "Read a chat by its ID, such as chat-805, which the user can copy from under a chat: who said what, oldest first, with the tools the employees ran. Returns at most 50KB; use offset and limit to continue. Only chats you can reach.",
	Parameters: json.RawMessage(`{"type":"object","properties":{` +
		`"id":{"type":"string","description":"The chat's ID, such as chat-805"},` +
		`"offset":{"type":"integer","minimum":1,"description":"Message to start from, 1-indexed"},` +
		`"limit":{"type":"integer","minimum":1,"description":"Maximum number of messages"}},"required":["id"]}`)}

// readChatTool reads a chat the manager can reach, by its ID.
func (e *Engine) readChatTool(m manager) funcTool {
	return funcTool{readChatSpec, func(_ context.Context, _ string, raw json.RawMessage) model.ToolResult {
		var a struct {
			ID     string `json:"id"`
			Offset int    `json:"offset"`
			Limit  int    `json:"limit"`
		}
		if err := json.Unmarshal(raw, &a); err != nil {
			return toolError("bad arguments: %v", err)
		}
		id := strings.TrimPrefix(strings.TrimSpace(a.ID), "#")
		if id == "" {
			return toolError("id is required, such as chat-805")
		}
		if a.Offset < 0 || a.Limit < 0 {
			return toolError("offset and limit must be positive")
		}
		e.mu.Lock()
		defer e.mu.Unlock()
		c := e.w.Chats[id]
		if c == nil || !m.reaches(c.TeamID) {
			return toolError("no chat %s that you can reach", id)
		}
		return model.ToolResult{Text: e.chatText(c, a.Offset, a.Limit)}
	}}
}

// chatText writes a chat's messages from offset (1-indexed), at most limit of them (0: all) and readChatBytes.
// Call it holding the lock.
func (e *Engine) chatText(c *model.Chat, offset, limit int) string {
	total := len(c.Messages)
	from := max(offset, 1) - 1
	var b strings.Builder
	fmt.Fprintf(&b, "Chat %s", c.ID)
	if c.Title != "" {
		fmt.Fprintf(&b, " %q", c.Title)
	}
	if c.AtAirport() {
		b.WriteString(", at the airport")
	} else if t := e.w.Teams[c.TeamID]; t != nil {
		fmt.Fprintf(&b, ", in company %s", t.Name)
	}
	people := []string{e.chatSpeaker(c, c.ReplicaID)}
	for _, g := range c.Guests {
		people = append(people, g.Name)
	}
	fmt.Fprintf(&b, ", with %s.\n", strings.Join(people, ", "))
	if total == 0 {
		b.WriteString("It has no messages yet.\n")
		return b.String()
	}
	if from >= total {
		fmt.Fprintf(&b, "It has %d messages; offset %d is past the end.\n", total, offset)
		return b.String()
	}
	end := total
	if limit > 0 {
		end = min(total, from+limit)
	}
	var body strings.Builder
	shown := from
	for i := from; i < end; i++ {
		line := e.chatLine(c, i)
		if body.Len()+len(line) > readChatBytes {
			if i == from {
				// one message larger than a whole read: show its start
				line = strings.ToValidUTF8(line[:readChatBytes], "") + "…[message cut]\n"
			} else {
				break
			}
		}
		body.WriteString(line)
		shown = i + 1
	}
	fmt.Fprintf(&b, "Messages %d-%d of %d.\n\n", from+1, shown, total)
	b.WriteString(body.String())
	if shown < total {
		fmt.Fprintf(&b, "\n[%d more; continue with offset %d]\n", total-shown, shown+1)
	}
	return b.String()
}

// chatLine is message i as the model reads it. Call it holding the lock.
func (e *Engine) chatLine(c *model.Chat, i int) string {
	msg := c.Messages[i]
	at := time.UnixMilli(int64(msg.At * 1000)).Local().Format("2006-01-02 15:04")
	var who string
	switch msg.From {
	case "user":
		who = "user"
		if len(msg.Mentions) > 0 {
			names := make([]string, len(msg.Mentions))
			for j, id := range msg.Mentions {
				names[j] = e.chatSpeaker(c, id)
			}
			who += " to " + strings.Join(names, ", ")
		}
	case "tool":
		// the app's own lines, such as auto_compact, have no one
		if msg.By == "" {
			who = "tool"
		} else {
			who = e.chatSpeaker(c, msg.By) + " ran"
		}
	default:
		who = e.chatSpeaker(c, msg.By)
	}
	var b strings.Builder
	fmt.Fprintf(&b, "[%d] %s %s: %s\n", i+1, at, who, msg.Text)
	for _, list := range []struct {
		kind  string
		files []model.Attachment
	}{{"images", msg.Images}, {"files", msg.Files}} {
		if len(list.files) == 0 {
			continue
		}
		names := make([]string, len(list.files))
		for j, f := range list.files {
			names[j] = f.Name
		}
		fmt.Fprintf(&b, "    (%s attached: %s)\n", list.kind, strings.Join(names, ", "))
	}
	return b.String()
}

// chatSpeaker names an employee in a chat; empty is the one the chat is with. Call it holding the lock.
func (e *Engine) chatSpeaker(c *model.Chat, id string) string {
	if id == "" {
		id = c.ReplicaID
	}
	if r := e.w.Replicas[id]; r != nil && r.Name != "" {
		return r.Name
	}
	for _, g := range c.Guests {
		if g.ReplicaID == id && g.Name != "" {
			return g.Name
		}
	}
	if id == c.ReplicaID && c.Name != "" {
		return c.Name
	}
	if id == "" {
		return "employee"
	}
	return id
}
