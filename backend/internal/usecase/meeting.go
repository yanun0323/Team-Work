package usecase

import (
	"context"
	"encoding/json"
	"fmt"
	"slices"
	"strings"

	"github.com/yanun0323/Team-Work/internal/model"
	"github.com/yanun0323/Team-Work/internal/model/enum"
)

// maxChatPeople keeps a meeting's rounds within reason: each message can ask every model in it.
const maxChatPeople = 6

// chatHas says whether an employee is the chair or a guest of a chat, whether or not they have left since.
func chatHas(c *model.Chat, replicaID string) bool {
	return replicaID == c.ReplicaID || slices.ContainsFunc(c.Guests, func(g model.ChatGuest) bool { return g.ReplicaID == replicaID })
}

// checkInvite refuses to bring into a chat whoever cannot join it: someone of another company, or one too many.
func (e *Engine) checkInvite(c *model.Chat, ids []string) error {
	if len(ids) == 0 {
		return nil
	}
	if c.AtAirport() {
		return model.Errorf(model.CodeInvalid, "機場的對話不能邀請員工")
	}
	people := 1 + len(c.Guests)
	for i, id := range ids {
		if chatHas(c, id) || slices.Contains(ids[:i], id) {
			continue
		}
		if r := e.w.Replicas[id]; r == nil || r.TeamID != c.TeamID {
			return model.Errorf(model.CodeNotFound, "找不到公司或員工")
		}
		if people++; people > maxChatPeople {
			return model.Errorf(model.CodeInvalid, "一個對話最多 %d 位員工", maxChatPeople)
		}
	}
	return nil
}

// invite brings into a chat those not in it yet, after checkInvite. With before at 0 or more, the chat shows they
// joined there; those it starts with did not join.
func (e *Engine) invite(c *model.Chat, ids []string, before int) {
	for _, id := range ids {
		if r := e.w.Replicas[id]; r != nil && !chatHas(c, id) {
			c.Guests = append(c.Guests, model.ChatGuest{ReplicaID: r.ID, Name: r.Name, Look: r.Look, Model: r.Model})
			if before >= 0 {
				c.Joins = append(c.Joins, model.ChatJoin{Before: before, ReplicaID: r.ID, Name: r.Name})
			}
		}
	}
}

// keepMarks has the lines between messages stay within the first n messages, after the rest are taken back.
func keepMarks(c *model.Chat, n int) {
	for i := range c.Handoffs {
		c.Handoffs[i].Before = min(c.Handoffs[i].Before, n)
	}
	for i := range c.Joins {
		c.Joins[i].Before = min(c.Joins[i].Before, n)
	}
}

// speakersFor are who reply to a message, in turn: those it mentions, in that order, or else the chair alone. "@All"
// comes as everyone mentioned, the chair last to sum up. Those who left are skipped. The airport staff are "".
func (e *Engine) speakersFor(c *model.Chat, mentions []string) []string {
	if c.AtAirport() {
		return []string{""}
	}
	var out []string
	add := func(id string) {
		if e.w.Replicas[id] != nil && chatHas(c, id) && !slices.Contains(out, id) {
			out = append(out, id)
		}
	}
	for _, id := range mentions {
		add(id)
	}
	if len(mentions) == 0 {
		add(c.ReplicaID)
	}
	return out
}

// actorOf is who may act outside the chat on a message: create tasks, change blueprints and flows, ask the user.
// Only one does each round: the one it mentions alone, or else the chair.
func actorOf(c *model.Chat, mentions []string) string {
	if len(mentions) == 1 {
		return mentions[0]
	}
	return c.ReplicaID
}

// roundActor is the actor of the round under way, from the user's last message.
func roundActor(c *model.Chat) string {
	for i := len(c.Messages) - 1; i >= 0; i-- {
		if c.Messages[i].From == "user" {
			return actorOf(c, c.Messages[i].Mentions)
		}
	}
	return c.ReplicaID
}

// chatNames are the names of everyone who has replied in a chat or is in it.
func chatNames(c *model.Chat) map[string]string {
	names := map[string]string{}
	for _, h := range c.Handoffs {
		names[h.ReplicaID] = h.Name
	}
	for _, g := range c.Guests {
		names[g.ReplicaID] = g.Name
	}
	names[c.ReplicaID] = c.Name
	return names
}

// beginRound has the user's message heard and the first of those it is for reply; the rest follow in turn.
func (e *Engine) beginRound(c *model.Chat, text string, images, files []model.Attachment, mentions []string) error {
	if err := e.checkInvite(c, mentions); err != nil {
		return err
	}
	// after the message that mentions them; those the first message mentions start the chat, so did not join
	before := len(c.Messages) + 1
	if len(c.Messages) == 0 {
		before = -1
	}
	e.invite(c, mentions, before)
	speakers := e.speakersFor(c, mentions)
	if len(speakers) == 0 {
		return model.Errorf(model.CodeInvalid, "對話裡沒有人可以回覆")
	}
	spec, err := e.chatSpec(c, speakers[0])
	if err != nil {
		return err
	}
	if err := e.saveAttachments(c.ID, files); err != nil {
		return err
	}
	e.chatHears(c, text, images, files, mentions)
	c.Next = speakers[1:]
	e.launchChat(c, speakers[0], spec)
	return nil
}

// nextSpeaker has the next one in the round reply, after the one before ended or failed. It stops while the chat
// waits on the user, who answers with a message of their own or goes on from the card.
func (e *Engine) nextSpeaker(c *model.Chat) bool {
	if c.Question != nil || c.Change != nil {
		return false
	}
	for len(c.Next) > 0 {
		id := c.Next[0]
		c.Next = slices.Clone(c.Next[1:])
		if e.w.Replicas[id] == nil {
			continue
		}
		spec, err := e.chatSpec(c, id)
		if err != nil {
			e.log.Warn().Err(err).Str("chat", c.ID).Msg("next speaker")
			continue
		}
		// what the one before left unfinished is closed, as the model refuses a call without a result
		conv := e.w.Conversations[c.ID]
		closed := answerPending(conv, "")
		if len(closed) > len(conv) {
			closed[len(closed)-1].By = c.Speaker
		}
		e.w.Conversations[c.ID] = closed
		e.dirty[c.ID] = true
		e.launchChat(c, id, spec)
		return true
	}
	return false
}

// InviteToChat brings an employee of the chat's company into it, as mentioning them would, while nobody is replying.
// They see the whole chat so far.
func (e *Engine) InviteToChat(id, replicaID string) error {
	return e.do(func() error {
		c := e.w.Chats[id]
		if c == nil {
			return model.Errorf(model.CodeNotFound, "找不到對話")
		}
		if c.ReplyAt != nil || c.Change != nil {
			return model.Errorf(model.CodeInvalid, "員工還在回覆")
		}
		ids := []string{replicaID}
		if err := e.checkInvite(c, ids); err != nil {
			return err
		}
		e.invite(c, ids, len(c.Messages))
		return nil
	})
}

// SetChatChair has a guest chair the meeting: they act for it when nobody is mentioned alone, and sum up last.
func (e *Engine) SetChatChair(id, replicaID string) error {
	return e.do(func() error {
		c := e.w.Chats[id]
		if c == nil {
			return model.Errorf(model.CodeNotFound, "找不到對話")
		}
		at := slices.IndexFunc(c.Guests, func(g model.ChatGuest) bool { return g.ReplicaID == replicaID })
		if at < 0 || e.w.Replicas[replicaID] == nil {
			return model.Errorf(model.CodeNotFound, "找不到公司或員工")
		}
		if c.ReplyAt != nil || c.Change != nil {
			return model.Errorf(model.CodeInvalid, "員工還在回覆")
		}
		g := c.Guests[at]
		c.Guests[at] = model.ChatGuest{ReplicaID: c.ReplicaID, Name: c.Name, Look: c.Look, Model: c.Model}
		c.ReplicaID, c.Name, c.Look, c.Model, c.Effort = g.ReplicaID, g.Name, g.Look, g.Model, ""
		return nil
	})
}

// meetingRule tells an employee in a meeting how the replies go round. It stays the same from round to round, so
// their provider's cache of the request's start holds; what changes comes in roundNote.
func meetingRule(c *model.Chat, speaker string) string {
	if len(c.Guests) == 0 {
		return ""
	}
	return "This chat is a meeting of the user and several employees; you are " + chatNames(c)[speaker] + ". " +
		"The employees the user @mentions reply one after another, and @All is everyone, the chair last; with no mention the chair replies alone. " +
		"Each sees what was said before them. What another employee said comes to you as a user message starting with their name in brackets, like \"[Ada] ...\": " +
		"it is theirs, not the user's. Speak only for yourself, add what is yours to add rather than repeat the others, and keep it short. " +
		"Only one employee a round may create or change tasks, blueprints and flows, or ask the user; when someone else needs to do that, say so for them to do. " +
		"Who is in the meeting, the order of this round and who acts in it come in a [Meeting] note at the end of the user's latest message.\n"
}

// roundNote is what an employee in a meeting needs to know about the round under way: who is there, who replies
// before and after them, and who may act outside the chat. It goes at the end of the user's latest message.
func (e *Engine) roundNote(c *model.Chat, speaker string) string {
	if len(c.Guests) == 0 {
		return ""
	}
	names := chatNames(c)
	who := func(id string) string {
		switch {
		case id == speaker && id == c.ReplicaID:
			return names[id] + " (you, chair)"
		case id == speaker:
			return names[id] + " (you)"
		case id == c.ReplicaID:
			return names[id] + " (chair)"
		}
		return names[id]
	}
	var here []string
	for _, id := range append([]string{c.ReplicaID}, guestIDs(c)...) {
		if e.w.Replicas[id] != nil {
			here = append(here, who(id))
		}
	}
	// those who replied since the user spoke went before; c.Next are still to come
	var round []string
	for i := len(c.Messages) - 1; i >= 0 && c.Messages[i].From != "user"; i-- {
		if by := c.Messages[i].By; by != "" && by != speaker && !slices.Contains(round, by) {
			round = append([]string{by}, round...)
		}
	}
	round = append(round, speaker)
	round = append(round, c.Next...)
	order := make([]string, len(round))
	for i, id := range round {
		order[i] = who(id)
	}
	actor := "you"
	if a := roundActor(c); a != speaker {
		actor = names[a]
	}
	return fmt.Sprintf("[Meeting] In it: %s. This round replies, in order: %s. This round %s may act outside the chat.",
		strings.Join(here, ", "), strings.Join(order, ", "), actor)
}

// withNote puts a note at the end of the user's latest words, on a copy, leaving what came before as it was sent.
func withNote(conv []model.Message, note string) []model.Message {
	if note == "" {
		return conv
	}
	for i := len(conv) - 1; i >= 0; i-- {
		m := conv[i]
		if m.Role != enum.RoleUser || !slices.ContainsFunc(m.Content, func(b model.Block) bool { return b.Type == enum.BlockText }) {
			continue
		}
		out := slices.Clone(conv)
		m.Content = append(slices.Clone(m.Content), model.Block{Type: enum.BlockText, Text: note})
		out[i] = m
		return out
	}
	return conv
}

func guestIDs(c *model.Chat) []string {
	out := make([]string, len(c.Guests))
	for i, g := range c.Guests {
		out[i] = g.ReplicaID
	}
	return out
}

// chatSees is the conversation as one employee reads it: what others said comes as said to them, marked with who
// said it, and the tools they ran are left out. Untagged messages, from before chats said who wrote what, are theirs.
func chatSees(conv []model.Message, speaker string, names map[string]string) []model.Message {
	theirs := func(m model.Message) bool { return m.By == "" || m.By == speaker }
	if !slices.ContainsFunc(conv, func(m model.Message) bool { return m.Role == enum.RoleAssistant && !theirs(m) }) {
		return conv
	}
	calls := map[string]bool{}
	var out []model.Message
	add := func(m model.Message) {
		if len(m.Content) == 0 {
			return
		}
		if n := len(out); n > 0 && out[n-1].Role == m.Role { // the turns have to alternate
			out[n-1].Content = append(slices.Clip(out[n-1].Content), m.Content...)
			return
		}
		out = append(out, m)
	}
	for _, m := range conv {
		switch {
		case m.Role == enum.RoleAssistant && theirs(m):
			for _, b := range m.Content {
				if b.Type == enum.BlockToolCall {
					calls[b.ID] = true
				}
			}
			add(m)
		case m.Role == enum.RoleAssistant:
			var words []string
			for _, b := range m.Content {
				if b.Type == enum.BlockText && strings.TrimSpace(b.Text) != "" {
					words = append(words, b.Text)
				}
			}
			if len(words) > 0 {
				name := names[m.By]
				if name == "" {
					name = "a former colleague"
				}
				add(userText("[" + name + "] " + strings.Join(words, "\n\n")))
			}
		default:
			kept := model.Message{Role: m.Role, By: m.By}
			for _, b := range m.Content {
				if b.Type != enum.BlockToolResult || calls[b.ID] {
					kept.Content = append(kept.Content, b)
				}
			}
			add(kept)
		}
	}
	return out
}

// actsOutside says whether a tool reaches outside the chat, which only the round's actor may do.
func actsOutside(name string) bool {
	switch name {
	case toolAskUser, toolCreateTask, toolUpdateTask, toolSaveBlueprint, toolSaveWorkflow, toolSaveProvider:
		return true
	}
	return false
}

// refusedTool is a tool offered to someone in a meeting who may not use it this round.
type refusedTool struct {
	spec  model.ToolSpec
	actor string
}

func (t refusedTool) Spec() model.ToolSpec { return t.spec }
func (t refusedTool) Run(context.Context, string, json.RawMessage) model.ToolResult {
	return toolError("only %s may do this in this round; say what is needed for them to do", t.actor)
}

// sees is the conversation as the one replying reads it, with the round's note.
func (in chatRun) sees(conv []model.Message) []model.Message {
	return withNote(chatSees(conv, in.speaker, in.names), in.note)
}
