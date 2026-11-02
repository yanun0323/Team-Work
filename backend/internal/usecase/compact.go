package usecase

import (
	"context"
	"fmt"
	"slices"
	"strings"

	"github.com/yanun0323/mho-company/internal/model"
	"github.com/yanun0323/mho-company/internal/model/enum"
)

const (
	// chatCompactAt is how many tokens the model may read before a chat compacts. A model with less room says so, and that compacts too.
	chatCompactAt = 150_000
	// chatCompactKeep is about how many tokens of the latest messages stay word for word.
	chatCompactKeep = 20_000
	// chatCompactLeast is the fewest tokens worth a summary, so a chat stuck on one huge message does not pay for one on every call.
	chatCompactLeast  = 4_000
	compactBlockRunes = 4_000
	compactTotalRunes = 600_000
	imageTokens       = 1_500
)

const chatCompactRules = "Summarize the earlier part of the conversation below so an employee can go on from it without seeing it. Keep the user's requests, decisions and preferences, what was done and which files changed, unfinished work and open questions. Keep exact paths, names and commands. Output only the summary."

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

// compactCut finds where the words kept begin, or from if there is nothing worth summing up. It is always one of the
// employee's messages: a tool result must not lose its call, and the summary before it keeps the turns alternating.
func compactCut(conv []model.Message, from int) int {
	cut, kept := from, 0
	for i := len(conv) - 1; i > from; i-- {
		kept += tokensAbout(conv[i])
		if conv[i].Role != enum.RoleAssistant {
			continue
		}
		if cut != from && kept > chatCompactKeep {
			break
		}
		cut = i
	}
	gone := 0
	for _, m := range conv[from:cut] {
		gone += tokensAbout(m)
	}
	if gone < chatCompactLeast {
		return from
	}
	return cut
}

func compactTranscript(conv []model.Message, compact *model.ChatCompact) string {
	var out strings.Builder
	if compact != nil {
		fmt.Fprintf(&out, "Summary so far:\n%s\n\n", compact.Summary)
	}
	for _, m := range conv {
		for _, b := range m.Content {
			switch b.Type {
			case enum.BlockText:
				fmt.Fprintf(&out, "%s: %s\n\n", m.Role, clip(b.Text, compactBlockRunes))
			case enum.BlockToolCall:
				fmt.Fprintf(&out, "Tool call %s: %s\n\n", b.Name, clip(string(b.Args), compactBlockRunes))
			case enum.BlockToolResult:
				fmt.Fprintf(&out, "Tool result: %s\n\n", clip(b.Text, compactBlockRunes))
			case enum.BlockImage:
				out.WriteString("(image)\n\n")
			}
		}
	}
	all := []rune(out.String())
	return string(all[max(len(all)-compactTotalRunes, 0):])
}

// compactChat sums up the older part of a chat and returns what to send the model from now on. The summary's tokens
// count for the chat. When it fails the chat carries on as it was: the summary only ever saves room.
func (e *Engine) compactChat(ctx context.Context, in chatRun) ([]model.Message, bool) {
	e.mu.Lock()
	c := e.w.Chats[in.id]
	if c == nil || e.runs[in.id] != in.r {
		e.mu.Unlock()
		return nil, false
	}
	conv, prior := slices.Clone(e.w.Conversations[in.id]), clone(c.Compact)
	rules := chatCompactRules + "\n" + languageRule(e.w.Language)
	e.mu.Unlock()
	from := 0
	if prior != nil {
		from = prior.Upto
	}
	cut := compactCut(conv, from)
	if cut <= from {
		return nil, false
	}
	reply, err := in.spec.provider.Complete(ctx, model.ModelRequest{Cwd: in.folder, Session: fmt.Sprintf("%s-compact-%v", in.id, e.clock()), Model: in.spec.model, Effort: in.spec.effort,
		System: rules, Messages: []model.Message{userText(compactTranscript(conv[from:cut], prior))}}, func(string) {})
	if err != nil {
		if ctx.Err() == nil {
			e.log.Warn().Err(err).Str("chat", in.id).Msg("compact chat")
		}
		return nil, false
	}
	var summary strings.Builder
	for _, b := range reply.Content {
		if b.Type == enum.BlockText {
			summary.WriteString(b.Text)
		}
	}
	text := strings.TrimSpace(summary.String())
	var view []model.Message
	kept := e.applyChat(in, func(c *model.Chat) {
		c.Tokens += tokensUsed(reply.Usage)
		if text == "" {
			return
		}
		c.Compact = &model.ChatCompact{Upto: cut, Summary: text}
		c.Context = 0
		c.Messages = append(c.Messages, model.ChatMessage{At: e.w.Now, From: "tool", Text: "auto_compact"})
		view = slices.Clone(chatView(e.w.Conversations[c.ID], c.Compact))
	})
	return view, kept && view != nil
}
