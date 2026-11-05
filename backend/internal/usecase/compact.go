package usecase

import (
	"context"
	"fmt"
	"slices"
	"strings"
	"unicode/utf8"

	"github.com/yanun0323/Team-Work/internal/model"
	"github.com/yanun0323/Team-Work/internal/model/enum"
)

const (
	// compactReserve is the room a chat always keeps for its next call: a tool's output and a reply. A model with
	// less than four times it keeps a quarter of what it reads instead.
	compactReserve = 20_000
	// chatCompactKeep is about how many tokens of the latest messages stay word for word, at most a tenth of the room.
	chatCompactKeep = 20_000
	// chatCompactLeast is the fewest tokens worth a summary, so a chat stuck on one huge message does not pay for one
	// on every call; at most a fiftieth of the room.
	chatCompactLeast  = 4_000
	compactBlockRunes = 4_000
	// compactRulesTokens is about what the summing up's own instructions take.
	compactRulesTokens = 2_000
	imageTokens        = 1_500
)

const chatCompactRules = "Summarize the earlier part of the conversation below so an employee can go on from it without seeing it. Keep the user's requests, decisions and preferences, what was done and which files changed, unfinished work and open questions. Keep exact paths, names and commands. Output only the summary."

// reserveOf is the room kept for the next call by a model that reads window tokens.
func reserveOf(window int) int {
	return min(compactReserve, window/4)
}

// compactAt is how many tokens a model that reads window tokens may be sent before its chat is summed up: the share
// the preferences set for its size, but never past the room kept for the next call.
func compactAt(window int, prefs model.Preferences) int {
	return min(window-reserveOf(window), window*prefs.CompactShare(window)/100)
}

// summaryWords is about how long a summary may be, so the one with the least room can still read it and go on.
func summaryWords(room int) int {
	return min(max(room/40, 500), 4_000)
}

// windowOf is how many tokens a model can read: its provider's size, or a guess when no provider offers it.
func (e *Engine) windowOf(modelID string) int {
	if p := e.providerFor(modelID); p != nil {
		return model.ContextWindow(*p)
	}
	return model.ContextUnknown
}

// chatModels are the models of everyone in a chat, the one it is with first.
func chatModels(c *model.Chat) []string {
	out := []string{c.Model}
	for _, g := range c.Guests {
		out = append(out, g.Model)
	}
	return out
}

// chatRoom is the least any of a chat's people can read, and the least they may be sent before it is summed up. Each
// works out their own threshold: the one who reads least is not always the first to reach it.
func (e *Engine) chatRoom(c *model.Chat) (room, at int) {
	for i, m := range chatModels(c) {
		window := e.windowOf(m)
		mine := compactAt(window, e.w.Preferences)
		if i == 0 || window < room {
			room = window
		}
		if i == 0 || mine < at {
			at = mine
		}
	}
	return room, at
}

// chairSpec is the model the chat is with, at the level its employee is on, which sums the chat up for everyone.
func (e *Engine) chairSpec(c *model.Chat) (agentSpec, error) {
	effort := c.Effort
	if !c.AtAirport() {
		effort = model.ThinkingDefault
		if r := e.w.Replicas[c.ReplicaID]; r != nil && r.Model == c.Model {
			effort = r.Effort
		}
	}
	return e.modelSpec(c.Model, effort)
}

// chatView is what the model reads: the summary in place of what it covers, then the rest word for word.
func chatView(conv []model.Message, compact *model.ChatCompact) []model.Message {
	if compact == nil {
		return conv
	}
	said := userText("Summary of the earlier conversation, which you can no longer see:\n\n" + compact.Summary)
	return append([]model.Message{said}, conv[compact.Upto:]...)
}

func tokensAbout(m model.Message) int {
	n := 0
	for _, b := range m.Content {
		n += (len(b.Text) + len(b.Args)) / 4
		if b.Type == enum.BlockImage || b.Data != "" {
			n += imageTokens
		}
	}
	return n
}

func tokensOf(conv []model.Message) int {
	n := 0
	for _, m := range conv {
		n += tokensAbout(m)
	}
	return n
}

// requestTokens is about what a request's instructions and tools take, besides its messages.
func requestTokens(req model.ModelRequest) int {
	n := len(req.System)
	for _, t := range req.Tools {
		n += len(t.Name) + len(t.Description) + len(t.Parameters)
	}
	return n / 4
}

// compactCut finds where the words kept begin, or from if there is nothing worth summing up. It is always one of the
// employee's messages: a tool result must not lose its call, and the summary before it keeps the turns alternating.
// The least room in the chat decides how much stays and how little is worth a summary.
func compactCut(conv []model.Message, from, room int) int {
	keep, least := min(chatCompactKeep, room/10), min(chatCompactLeast, room/50)
	cut, kept := from, 0
	for i := len(conv) - 1; i > from; i-- {
		kept += tokensAbout(conv[i])
		if conv[i].Role != enum.RoleAssistant {
			continue
		}
		if cut != from && kept > keep {
			break
		}
		cut = i
	}
	if tokensOf(conv[from:cut]) < least {
		return from
	}
	return cut
}

// compactEntries are the lines of a transcript of messages, each block cut short.
func compactEntries(conv []model.Message, names map[string]string) []string {
	var out []string
	for _, m := range conv {
		who := string(m.Role)
		if name := names[m.By]; name != "" && m.Role == enum.RoleAssistant {
			who = name
		}
		for _, b := range m.Content {
			switch b.Type {
			case enum.BlockText:
				out = append(out, fmt.Sprintf("%s: %s\n\n", who, clip(b.Text, compactBlockRunes)))
			case enum.BlockToolCall:
				out = append(out, fmt.Sprintf("Tool call %s: %s\n\n", b.Name, clip(string(b.Args), compactBlockRunes)))
			case enum.BlockToolResult:
				out = append(out, fmt.Sprintf("Tool result: %s\n\n", clip(b.Text, compactBlockRunes)))
			case enum.BlockImage:
				out = append(out, "(image)\n\n")
			}
		}
	}
	return out
}

func compactTranscript(summary string, entries []string) string {
	var out strings.Builder
	if summary != "" {
		fmt.Fprintf(&out, "Summary so far:\n%s\n\n", summary)
	}
	for _, line := range entries {
		out.WriteString(line)
	}
	return out.String()
}

// compactParts splits a transcript into what each call to the summing up reads: as many lines as fit beside the
// summary so far, and at least one. A rune is counted as a token, which errs on the side of room.
func compactParts(entries []string, budget, summary int) (part, rest []string) {
	size, end := 0, 0
	for end < len(entries) {
		n := utf8.RuneCountInString(entries[end])
		if end > 0 && summary+size+n > budget {
			break
		}
		size += n
		end++
	}
	return entries[:end], entries[end:]
}

// summarize sums up a transcript on top of the summary before it, in as many calls as the model needs to read it all.
// The summary so far goes into every call whole, so nothing it holds is cut off for room. It returns the tokens spent
// even when it fails.
func (e *Engine) summarize(ctx context.Context, in chatRun, rules, prior string, entries []string) (string, int, error) {
	budget := in.chairRoom - reserveOf(in.chairRoom) - summaryWords(in.room)*2 - compactRulesTokens
	budget = max(budget, compactBlockRunes*2)
	summary, spent := prior, 0
	for call := 0; len(entries) > 0; call++ {
		var part []string
		part, entries = compactParts(entries, budget, utf8.RuneCountInString(summary))
		reply, err := in.chair.provider.Complete(ctx, model.ModelRequest{Cwd: in.folder, Session: fmt.Sprintf("%s-compact-%v-%d", in.id, e.clock(), call),
			Model: in.chair.model, Effort: in.chair.effort, System: rules, Messages: []model.Message{userText(compactTranscript(summary, part))}}, func(string) {})
		spent += tokensUsed(reply.Usage)
		if err != nil {
			return "", spent, err
		}
		var text strings.Builder
		for _, b := range reply.Content {
			if b.Type == enum.BlockText {
				text.WriteString(b.Text)
			}
		}
		if summary = strings.TrimSpace(text.String()); summary == "" {
			return "", spent, nil
		}
	}
	return summary, spent, nil
}

// compactChat sums up the older part of a chat and returns what to send the model from now on. The chat's chair sums
// it up for everyone in it. The summary's tokens count for the chat. When it fails the chat carries on as it was: the
// summary only ever saves room.
func (e *Engine) compactChat(ctx context.Context, in chatRun) ([]model.Message, bool) {
	e.mu.Lock()
	c := e.w.Chats[in.id]
	if c == nil || e.runs[in.id] != in.r {
		e.mu.Unlock()
		return nil, false
	}
	conv, prior := slices.Clone(e.w.Conversations[in.id]), clone(c.Compact)
	rules := chatCompactRules + fmt.Sprintf(" Keep it under about %d words.", summaryWords(in.room)) + "\n" + languageRule(e.w.Language)
	e.mu.Unlock()
	from, before := 0, ""
	if prior != nil {
		from, before = prior.Upto, prior.Summary
	}
	cut := compactCut(conv, from, in.room)
	if cut <= from {
		return nil, false
	}
	text, spent, err := e.summarize(ctx, in, rules, before, compactEntries(conv[from:cut], in.names))
	if err != nil && ctx.Err() == nil {
		e.log.Warn().Err(err).Str("chat", in.id).Msg("compact chat")
	}
	var view []model.Message
	kept := e.applyChat(in, func(c *model.Chat) {
		c.Tokens += spent
		if err != nil || text == "" {
			return
		}
		c.Compact = &model.ChatCompact{Upto: cut, Summary: text}
		c.Messages = append(c.Messages, model.ChatMessage{At: e.w.Now, From: "tool", Text: "auto_compact"})
		view = in.sees(slices.Clone(chatView(e.w.Conversations[c.ID], c.Compact)))
		c.Context = in.overhead + tokensOf(view)
	})
	return view, kept && view != nil
}
