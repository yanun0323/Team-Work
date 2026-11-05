package usecase

import (
	"bytes"
	"cmp"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"time"

	"github.com/yanun0323/Team-Work/internal/adapter"
	"github.com/yanun0323/Team-Work/internal/i18n"
	"github.com/yanun0323/Team-Work/internal/model"
	"github.com/yanun0323/Team-Work/internal/model/enum"
	"github.com/yanun0323/Team-Work/internal/usecase/tools"
)

const chatRules = "You are a company employee chatting with the user to discuss things or do work for them. The working directory is the project folder itself, and changes reach the user's files immediately: change only what was asked, and commit only if the user asks. Attached files may be read from their supplied paths outside the project, but must not be modified.\n" +
	mentionRule + "\n" +
	"Reply in plain text. Do the work right here in the chat by default. Suggest creating a task from this chat only when it helps, such as running in the background on its own branch or passing through several employees; when you do, also offer to do it here.\n" +
	askInChatRule + "\n" +
	unseenThinkingRule + "\n" +
	memoryRule + "\n" +
	sharedFilesRule + "\n" +
	dataRule

// askInChatRule steers questions to ask_user, so the user can answer with a click instead of typing.
const askInChatRule = "When you need the user's answer to go on, ask with ask_user instead of ending your reply with a question, and give options whenever the answer is a choice, such as yes or no, or which of a few ways to go."

const airportChatRules = "You are the airport's service staff in Team Work, an app where the user runs companies of AI employees. You chat with the user to answer questions or do work for them on their computer. You do not belong to any company. The working directory is your own folder and stays between chats; it is not a project. Attached files may be read from their supplied paths, but must not be modified. Commands can reach the rest of the computer: change only what was asked, and ask with ask_user before deleting or overwriting anything outside your folder.\n" +
	"Reply in plain text.\n" +
	askInChatRule + "\n" +
	unseenThinkingRule + "\n" +
	sharedFilesRule + "\n" +
	dataRule

const (
	// airportChatTimeout stands in for a company's sub-task timeout, at the value a new company starts with.
	airportChatTimeout = 30 * time.Minute
	airportStaffName   = "Airport staff" // the interface shows its own words for them
)

// airportBlueprintID is the built-in blueprint the airport staff work by: their role, tools and skills.
const airportBlueprintID = model.PresetPrefix + "airport"

const chatDraftRules = "Write the chat below as a task for a colleague who has not seen it. First line: the task title, with no markup. Then a blank line and the description: goal, decisions, constraints and acceptance criteria. Use only what the chat says. " +
	taskBranchRule + " Output nothing else."

// taskBranchRule tells whoever writes a task how it runs, so the chat's own rules on committing do not end up in it.
const taskBranchRule = "A task runs on its own branch in a separate work tree, started from the target branch's latest commit: changes not yet committed in the project folder are not in it. " +
	"Each step's handoff commits its work, and the user decides whether to merge at the end. So the description should not say how to commit, branch, push or merge. " +
	"Write paths to the project's files relative to the project folder, since the work tree is elsewhere."

// maxChatImages keeps a message within what the API takes in one request.
const maxChatImages = 6

// NewChat starts a chat: it exists from the user's first message on.
type NewChat struct {
	TeamID    string `json:"teamId"`
	ReplicaID string `json:"replicaId"`
	// Guests make it a meeting, which the employee chairs.
	Guests []string `json:"guests"`
	// Mentions are who the first message is for, as in SayInChatTo.
	Mentions []string           `json:"mentions"`
	Text     string             `json:"text"`
	Images   []model.Attachment `json:"images"`
	Files    []model.Attachment `json:"files"`
}

// NewAirportChat starts a chat with the airport staff.
type NewAirportChat struct {
	Model  string             `json:"model"`
	Effort string             `json:"effort"`
	Text   string             `json:"text"`
	Images []model.Attachment `json:"images"`
	Files  []model.Attachment `json:"files"`
}

// ChatDraft is a task written from a chat, for the user to go over.
type ChatDraft struct {
	Title       string `json:"title"`
	Description string `json:"description"`
}

// CreateChat starts a chat with the user's first message; the employee starts replying.
func (e *Engine) CreateChat(in NewChat) (*model.Chat, error) {
	var out *model.Chat
	err := e.do(func() error {
		r := e.w.Replicas[in.ReplicaID]
		if e.w.Teams[in.TeamID] == nil || r == nil || r.TeamID != in.TeamID {
			return model.Errorf(model.CodeNotFound, "找不到公司或員工")
		}
		text := strings.TrimSpace(in.Text)
		if err := e.checkSaid(text, in.Images, in.Files); err != nil {
			return err
		}
		c := &model.Chat{ID: e.uid("chat"), TeamID: in.TeamID, ReplicaID: r.ID, Name: r.Name, Look: r.Look, Model: r.Model, CreatedAt: e.w.Now, Messages: []model.ChatMessage{}}
		if err := e.checkInvite(c, in.Guests); err != nil {
			return err
		}
		e.invite(c, in.Guests, -1)
		e.w.Chats[c.ID] = c
		if err := e.beginRound(c, text, in.Images, in.Files, in.Mentions); err != nil {
			delete(e.w.Chats, c.ID)
			return err
		}
		e.startChatTitle(c, text, e.w.Teams[in.TeamID].Folder)
		out = clone(c)
		return nil
	})
	return out, err
}

// CreateAirportChat starts a chat with the airport staff with the user's first message.
func (e *Engine) CreateAirportChat(in NewAirportChat) (*model.Chat, error) {
	var out *model.Chat
	err := e.do(func() error {
		effort, err := e.checkMind(in.Model, in.Effort)
		if err != nil {
			return err
		}
		text := strings.TrimSpace(in.Text)
		if err := e.checkSaid(text, in.Images, in.Files); err != nil {
			return err
		}
		c := &model.Chat{ID: e.uid("chat"), Name: airportStaffName, Model: in.Model, Effort: effort, CreatedAt: e.w.Now, Messages: []model.ChatMessage{}}
		e.w.Chats[c.ID] = c
		if err := e.beginRound(c, text, in.Images, in.Files, nil); err != nil {
			delete(e.w.Chats, c.ID)
			return err
		}
		e.startChatTitle(c, text, e.airportFolder())
		out = clone(c)
		return nil
	})
	return out, err
}

// SetChatMind changes what an airport chat's next reply runs on. A company's chat stays on what it began with.
func (e *Engine) SetChatMind(id, modelID, effort string) error {
	return e.do(func() error {
		c := e.w.Chats[id]
		if c == nil {
			return model.Errorf(model.CodeNotFound, "找不到對話")
		}
		if !c.AtAirport() {
			return model.Errorf(model.CodeInvalid, "只有機場的對話可以更換模型")
		}
		if c.ReplyAt != nil {
			return model.Errorf(model.CodeInvalid, "員工還在回覆")
		}
		effort, err := e.checkMind(modelID, effort)
		if err != nil {
			return err
		}
		c.Model, c.Effort = modelID, effort
		return nil
	})
}

// checkMind refuses a model nobody offers or a level it does not have; no level means the default.
func (e *Engine) checkMind(modelID, effort string) (string, error) {
	if effort == "" {
		effort = model.ThinkingDefault
	}
	if e.providerFor(modelID) == nil {
		return "", model.Errorf(model.CodeInvalid, "沒有模型供應商提供 %s", modelID)
	}
	if !e.takesEffort(modelID, effort) {
		return "", model.Errorf(model.CodeInvalid, "%s 沒有思考等級 %s", modelID, effort)
	}
	return effort, nil
}

// chatLeft says whether the employee of a chat has left the company. The airport staff never do.
func (e *Engine) chatLeft(c *model.Chat) bool {
	return !c.AtAirport() && e.w.Replicas[c.ReplicaID] == nil
}

// SayInChat adds the user's message and has the employee reply. While they still write it is queued for when they are done.
func (e *Engine) SayInChat(id, text string, images []model.Attachment, attached ...[]model.Attachment) error {
	var files []model.Attachment
	for _, batch := range attached {
		files = append(files, batch...)
	}
	return e.SayInChatTo(id, text, images, files, nil)
}

// SayInChatTo is SayInChat for the employees mentioned, in that order, who join the chat if they are not in it yet.
// With none mentioned, everyone in it replies.
func (e *Engine) SayInChatTo(id, text string, images, files []model.Attachment, mentions []string) error {
	return e.do(func() error {
		c := e.w.Chats[id]
		if c == nil {
			return model.Errorf(model.CodeNotFound, "找不到對話")
		}
		text = strings.TrimSpace(text)
		if err := e.checkSaid(text, images, files); err != nil {
			return err
		}
		if e.chatLeft(c) {
			return model.Errorf(model.CodeInvalid, "%s 已經離開公司", c.Name)
		}
		if c.ReplyAt != nil {
			if err := e.checkInvite(c, mentions); err != nil {
				return err
			}
			if err := e.saveAttachments(c.ID, files); err != nil {
				return err
			}
			c.Queue = append(c.Queue, model.QueuedMessage{ID: e.uid("queued"), At: e.w.Now, Text: text, Images: images, Files: files, Mentions: mentions})
			e.w.Tutorial.Learn("queue")
			return nil
		}
		return e.beginRound(c, text, images, files, mentions)
	})
}

// SteerChat has a queued message go as soon as the tool call being run ends, ahead of the rest of the queue.
// With no reply being written it goes now.
func (e *Engine) SteerChat(id, queuedID string) error {
	return e.do(func() error {
		c := e.w.Chats[id]
		if c == nil {
			return model.Errorf(model.CodeNotFound, "找不到對話")
		}
		at := slices.IndexFunc(c.Queue, func(q model.QueuedMessage) bool { return q.ID == queuedID })
		if at < 0 {
			return model.Errorf(model.CodeNotFound, "找不到排隊的訊息")
		}
		if e.chatLeft(c) {
			return model.Errorf(model.CodeInvalid, "%s 已經離開公司", c.Name)
		}
		q := c.Queue[at]
		q.Steer = true
		rest := slices.Delete(slices.Clone(c.Queue), at, at+1)
		if c.ReplyAt == nil {
			c.Queue = append([]model.QueuedMessage{q}, rest...)
			return e.sendQueued(c)
		}
		steered := 0
		for steered < len(rest) && rest[steered].Steer {
			steered++
		}
		c.Queue = slices.Insert(rest, steered, q)
		return nil
	})
}

// UnqueueChat takes a message out of the queue, for the user to change it.
func (e *Engine) UnqueueChat(id, queuedID string) error {
	return e.do(func() error {
		c := e.w.Chats[id]
		if c == nil {
			return model.Errorf(model.CodeNotFound, "找不到對話")
		}
		at := slices.IndexFunc(c.Queue, func(q model.QueuedMessage) bool { return q.ID == queuedID })
		if at < 0 {
			return model.Errorf(model.CodeNotFound, "找不到排隊的訊息")
		}
		c.Queue = slices.Delete(slices.Clone(c.Queue), at, at+1)
		return nil
	})
}

// sendQueued sends the first queued message as the user's next, when no reply is being written.
func (e *Engine) sendQueued(c *model.Chat) error {
	if len(c.Queue) == 0 || c.ReplyAt != nil || e.chatLeft(c) {
		return nil
	}
	q := c.Queue[0]
	c.Queue = slices.Clone(c.Queue[1:])
	return e.beginRound(c, q.Text, q.Images, q.Files, q.Mentions)
}

// RewindChat takes back one of the user's messages and all that came after it, stopping a reply being written.
// What the employee already changed in the folder stays.
func (e *Engine) RewindChat(id string, index int) error {
	return e.do(func() error {
		c := e.w.Chats[id]
		if c == nil {
			return model.Errorf(model.CodeNotFound, "找不到對話")
		}
		if index < 0 || index >= len(c.Messages) || c.Messages[index].From != "user" {
			return model.Errorf(model.CodeInvalid, "只能編輯自己的訊息")
		}
		if e.chatLeft(c) {
			return model.Errorf(model.CodeInvalid, "%s 已經離開公司", c.Name)
		}
		nth := 0
		for _, m := range c.Messages[:index] {
			if m.From == "user" {
				nth++
			}
		}
		end := saidAt(e.w.Conversations[c.ID], nth)
		if end < 0 {
			return model.Errorf(model.CodeConflict, "這段對話的紀錄對不上，無法編輯")
		}
		e.stopRun(c.ID)
		c.ReplyAt, c.Next = nil, nil
		c.Question = nil
		c.Change = nil
		c.Messages = c.Messages[:index]
		keepMarks(c, index)
		e.w.Conversations[c.ID] = e.w.Conversations[c.ID][:end]
		if c.Compact != nil && end < c.Compact.Upto {
			c.Compact = nil // it summed up what was just taken back
		}
		c.Context = 0
		e.dirty[c.ID] = true
		return nil
	})
}

// HandOffChat copies a chat up to a message into a new chat that goes on by itself, with an employee of the same
// company: the one it had, or another who takes over from there. From one of the user's messages it ends there,
// unanswered; from an employee's it keeps the rest of that reply, as a reply cannot be split in the conversation the
// model reads. Nothing runs until the user says something in the copy. While a reply is being written the original
// carries on, and only that unfinished reply cannot be handed off from. An airport chat stays with the airport staff.
func (e *Engine) HandOffChat(id string, index int, replicaID string) (*model.Chat, error) {
	var out *model.Chat
	err := e.do(func() error {
		c := e.w.Chats[id]
		if c == nil {
			return model.Errorf(model.CodeNotFound, "找不到對話")
		}
		if index < 0 || index >= len(c.Messages) || c.Messages[index].From == "tool" {
			return model.Errorf(model.CodeInvalid, "只能從訊息複製對話")
		}
		if c.ReplyAt != nil && !slices.ContainsFunc(c.Messages[index:], func(m model.ChatMessage) bool { return m.From == "user" }) {
			return model.Errorf(model.CodeInvalid, "員工還在回覆")
		}
		taker := e.w.Replicas[replicaID]
		switch {
		case c.AtAirport() && replicaID != "", !c.AtAirport() && replicaID == "":
			return model.Errorf(model.CodeInvalid, "找不到公司或員工")
		case replicaID == c.ReplicaID && e.chatLeft(c):
			return model.Errorf(model.CodeInvalid, "%s 已經離開公司", c.Name)
		case !c.AtAirport() && (taker == nil || taker.TeamID != c.TeamID):
			return model.Errorf(model.CodeNotFound, "找不到公司或員工")
		}
		conv := e.w.Conversations[c.ID]
		nth := 0
		for _, m := range c.Messages[:index] {
			if m.From == "user" {
				nth++
			}
		}
		keep, end := index+1, 0
		if c.Messages[index].From == "user" {
			end = saidAt(conv, nth) + 1
		} else if next := slices.IndexFunc(c.Messages[index:], func(m model.ChatMessage) bool { return m.From == "user" }); next < 0 {
			keep, end = len(c.Messages), len(conv)
		} else {
			keep, end = index+next, saidAt(conv, nth)
		}
		if end <= 0 {
			return model.Errorf(model.CodeConflict, "這段對話的紀錄對不上，無法複製")
		}
		fork := &model.Chat{ID: e.uid("chat"), TeamID: c.TeamID, ReplicaID: c.ReplicaID, Name: c.Name, Look: c.Look, Model: c.Model, Effort: c.Effort, CreatedAt: e.w.Now, Messages: clone(c.Messages[:keep]), Handoffs: clone(c.Handoffs), Guests: clone(c.Guests)}
		for _, j := range c.Joins { // who joined after where it is copied from did so in the original alone
			if j.Before <= keep {
				fork.Joins = append(fork.Joins, j)
			}
		}
		if replicaID != c.ReplicaID { // a meeting handed to one of its own or anyone else goes on with them alone
			fork.Guests = nil
			// they take over from the user's message, or after the reply it ends with
			before := keep
			if c.Messages[index].From == "user" {
				before = index
			}
			fork.Handoffs = append(fork.Handoffs, model.ChatHandoff{Before: before, ReplicaID: c.ReplicaID, Name: c.Name})
			fork.ReplicaID, fork.Name, fork.Look, fork.Model, fork.Effort = taker.ID, taker.Name, taker.Look, taker.Model, ""
		}
		if keep == len(c.Messages) {
			fork.Question = clone(c.Question)
		}
		for _, m := range fork.Messages {
			if err := e.saveAttachments(fork.ID, m.Files); err != nil {
				return err
			}
		}
		// the copy may read only its own attachments and command output, so what the model was told has to point there
		from, to := e.attachmentRoot(c.ID), e.attachmentRoot(fork.ID)
		fromOut, toOut := e.outputRoot(c.ID), e.outputRoot(fork.ID)
		if err := os.CopyFS(toOut, os.DirFS(fromOut)); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
		copied := clone(conv[:end])
		for _, m := range copied {
			for i := range m.Content {
				m.Content[i].Text = strings.ReplaceAll(strings.ReplaceAll(m.Content[i].Text, from, to), fromOut, toOut)
				m.Content[i].Args = bytes.ReplaceAll(bytes.ReplaceAll(m.Content[i].Args, []byte(from), []byte(to)), []byte(fromOut), []byte(toOut))
			}
		}
		if c.Compact != nil && end >= c.Compact.Upto {
			fork.Compact = &model.ChatCompact{Upto: c.Compact.Upto, Summary: strings.ReplaceAll(strings.ReplaceAll(c.Compact.Summary, from, to), fromOut, toOut)}
		}
		e.w.Chats[fork.ID] = fork
		e.w.Conversations[fork.ID] = copied
		e.dirty[fork.ID] = true
		e.w.Tutorial.Learn("fork") // the id it was learned under before it was called handing off
		out = clone(fork)
		return nil
	})
	return out, err
}

// saidAt finds the user's nth message in a conversation, where tool results also come as the user's; -1 if it has none.
func saidAt(conv []model.Message, nth int) int {
	for i, m := range conv {
		if m.Role != enum.RoleUser || (len(m.Content) > 0 && m.Content[0].Type == enum.BlockToolResult) {
			continue
		}
		if nth == 0 {
			return i
		}
		nth--
	}
	return -1
}

// checkSaid refuses a message that is empty, or holds pictures not every provider can take.
func (e *Engine) checkSaid(text string, images, files []model.Attachment) error {
	if text == "" && len(images)+len(files) == 0 {
		return model.Errorf(model.CodeInvalid, "訊息不能是空的")
	}
	if len(images) > maxChatImages {
		return model.Errorf(model.CodeInvalid, "一則訊息最多附 %d 張圖", maxChatImages)
	}
	return e.checkFiles(images, files)
}

// StopChat interrupts the reply being written; the chat goes on from what is there. A line says the reply stopped,
// and it can be tried again.
func (e *Engine) StopChat(id string) error {
	return e.do(func() error {
		c := e.w.Chats[id]
		if c == nil {
			return model.Errorf(model.CodeNotFound, "找不到對話")
		}
		e.stopRun(c.ID)
		if c.ReplyAt != nil {
			c.ReplyAt, c.Next = nil, nil
			// the user stopped it and has seen it stop, so the chat stays read
			c.Messages = append(c.Messages, model.ChatMessage{At: e.w.Now, From: "agent", Text: i18n.T("（已停止回覆）"), By: c.Speaker, Failed: true})
		}
		return nil
	})
}

// RetryChat has the employee whose reply failed, the chat's last message, try it again from where it stopped.
func (e *Engine) RetryChat(id string) error {
	return e.do(func() error {
		c := e.w.Chats[id]
		if c == nil {
			return model.Errorf(model.CodeNotFound, "找不到對話")
		}
		if c.ReplyAt != nil || c.Question != nil || c.Change != nil {
			return model.Errorf(model.CodeConflict, "員工還在回覆")
		}
		if len(c.Messages) == 0 || !c.Messages[len(c.Messages)-1].Failed {
			return model.Errorf(model.CodeInvalid, "沒有可以重試的回覆")
		}
		if e.chatLeft(c) {
			return model.Errorf(model.CodeInvalid, "%s 已經離開公司", c.Name)
		}
		speaker := cmp.Or(c.Messages[len(c.Messages)-1].By, c.ReplicaID)
		spec, err := e.chatSpec(c, speaker)
		if err != nil {
			return err
		}
		c.Messages = c.Messages[:len(c.Messages)-1]
		keepMarks(c, len(c.Messages))
		// a call the failed reply left without a result is closed, as the model refuses it otherwise
		conv := e.w.Conversations[c.ID]
		closed := answerPending(conv, "")
		if len(closed) > len(conv) {
			closed[len(closed)-1].By = speaker
		}
		e.w.Conversations[c.ID] = closed
		e.dirty[c.ID] = true
		c.Next = nil
		e.launchChat(c, speaker, spec)
		return nil
	})
}

// ReadChat records that the user has seen what the employee said.
func (e *Engine) ReadChat(id string) error {
	return e.do(func() error {
		c := e.w.Chats[id]
		if c == nil {
			return model.Errorf(model.CodeNotFound, "找不到對話")
		}
		c.Unread = false
		return nil
	})
}

// DeleteChat removes a chat and stops its reply. What the employee already changed in the folder stays.
func (e *Engine) DeleteChat(id string) error {
	return e.do(func() error {
		if e.w.Chats[id] == nil {
			return model.Errorf(model.CodeNotFound, "找不到對話")
		}
		e.dropChat(id)
		return nil
	})
}

func (e *Engine) dropChat(id string) {
	e.stopRun(id)
	e.removeOutputs(id)
	delete(e.w.Chats, id)
	delete(e.w.Conversations, id)
	delete(e.dirty, id)
}

// endChatsOf stops the replies of an employee who is leaving. Their chats stay to read; a meeting goes on without them.
func (e *Engine) endChatsOf(replicaID string) {
	for _, c := range e.w.Chats {
		c.Next = slices.DeleteFunc(c.Next, func(id string) bool { return id == replicaID })
		if c.ReplicaID != replicaID && c.Speaker != replicaID {
			continue
		}
		if c.Speaker == replicaID || c.ReplicaID == replicaID && c.Speaker == "" {
			c.Change = nil // nobody is left to go on with the answer
		}
		if c.ReplyAt != nil {
			e.stopRun(c.ID)
			c.ReplyAt, c.Next = nil, nil
		}
		// a meeting goes on, chaired by the first guest still here; the one who left stays a guest, so their name does
		if c.ReplicaID == replicaID {
			at := slices.IndexFunc(c.Guests, func(g model.ChatGuest) bool { return g.ReplicaID != replicaID && e.w.Replicas[g.ReplicaID] != nil })
			if at >= 0 {
				g := c.Guests[at]
				c.Guests[at] = model.ChatGuest{ReplicaID: c.ReplicaID, Name: c.Name, Look: c.Look, Model: c.Model}
				c.ReplicaID, c.Name, c.Look, c.Model, c.Effort = g.ReplicaID, g.Name, g.Look, g.Model, ""
			}
		}
	}
}

// interruptChats runs at start. A reply is not picked up again: it works in the user's own folder, and whatever
// it was doing may not be safe to repeat. It ends as a failed reply, to try again, and the rest of a meeting's round
// goes on, as they had not started.
func (e *Engine) interruptChats() {
	for _, c := range e.w.Chats {
		if c.ReplyAt == nil {
			continue
		}
		c.ReplyAt = nil
		e.chatSays(c, i18n.T("（伺服器重新啟動，這次回覆中斷了）"))
		c.Messages[len(c.Messages)-1].Failed = true
		e.nextSpeaker(c)
	}
}

// Uncommitted says whether a company's folder has changes not yet committed.
func (e *Engine) Uncommitted(ctx context.Context, teamID string) (bool, error) {
	e.mu.Lock()
	team := e.w.Teams[teamID]
	folder := ""
	if team != nil {
		folder = team.Folder
	}
	e.mu.Unlock()
	if team == nil {
		return false, model.Errorf(model.CodeNotFound, "找不到公司")
	}
	return e.git.Uncommitted(ctx, folder)
}

// chatSays adds what the one replying said, for the user to read.
func (e *Engine) chatSays(c *model.Chat, text string) {
	c.Messages = append(c.Messages, model.ChatMessage{At: e.w.Now, From: "agent", Text: text, By: c.Speaker})
	c.Unread = true
}

// chatHears puts the user's message into the chat and the conversation. Calls left without a result by an
// interrupted reply are closed first, as the model refuses them otherwise.
func (e *Engine) chatHears(c *model.Chat, text string, images, files []model.Attachment, mentions []string) {
	c.Messages = append(c.Messages, model.ChatMessage{At: e.w.Now, From: "user", Text: text, Images: images, Files: files, Mentions: mentions})
	said := model.Message{Role: enum.RoleUser}
	if text != "" { // a model refuses an empty text block
		said.Content = append(said.Content, model.Block{Type: enum.BlockText, Text: text})
	}
	for _, img := range images {
		if mime, data, ok := parseDataURL(img.URL); ok {
			said.Content = append(said.Content, model.Block{Type: enum.BlockImage, MimeType: mime, Data: data})
		}
	}
	said.Content = append(said.Content, e.fileBlocks(c.ID, files)...)
	// the answer goes as a message of its own, so it can hold attachments and be taken back like any other
	answer := ""
	if c.Question != nil {
		answer = "see their next message"
		c.Question = nil
	}
	conv := e.w.Conversations[c.ID]
	if c.Change != nil { // saying something else instead of agreeing is saying no
		conv = answerChange(conv, "The user did not agree, so nothing was written; see their next message", true)
		c.Change = nil
	}
	e.w.Conversations[c.ID] = append(answerPending(conv, answer), said)
	e.dirty[c.ID] = true
}

// chatSpec is a task's spec without the task, for one in the chat: the model they joined on, their role, the
// company's rules, and in a meeting how its rounds go.
func (e *Engine) chatSpec(c *model.Chat, speaker string) (agentSpec, error) {
	if c.AtAirport() {
		return e.airportChatSpec(c)
	}
	r := e.w.Replicas[speaker]
	name, joined := c.Name, c.Model
	if speaker != c.ReplicaID {
		at := slices.IndexFunc(c.Guests, func(g model.ChatGuest) bool { return g.ReplicaID == speaker })
		if at < 0 {
			return agentSpec{}, model.Errorf(model.CodeNotFound, "找不到公司或員工")
		}
		name, joined = c.Guests[at].Name, c.Guests[at].Model
	}
	if r == nil {
		return agentSpec{}, model.Errorf(model.CodeInvalid, "%s 已經離開公司", name)
	}
	// each stays on the model they joined on; if the employee has moved on, their thinking level no longer applies
	picked := *r
	if picked.Model != joined {
		picked.Model, picked.Effort = joined, model.ThinkingDefault
	}
	spec, err := e.buildSpec(nil, nil, &picked)
	if err != nil {
		return agentSpec{}, err
	}
	team, bp := e.w.Teams[c.TeamID], e.w.Blueprints[r.BlueprintID]
	e.readPrompt(team)
	spec.prompt = promptParts{
		rules:  chatRules + "\n" + languageRule(e.w.Language) + "\n" + chatPriorityRule + "\n" + chatHandoffRule(c) + meetingRule(c, speaker),
		shared: sharedRules(e.runGlobalPrompt(), team.Prompt),
		role:   rolePart(bp),
		memory: memorySection(r),
	}
	return spec, nil
}

// chatHandoffRule tells an employee a chat came to them from others, and whose the replies before were. They are counted
// by the user's messages, which the model can count too.
func chatHandoffRule(c *model.Chat) string {
	if len(c.Handoffs) == 0 {
		return ""
	}
	var parts []string
	from := 0
	for _, h := range c.Handoffs {
		upto := 0
		for _, m := range c.Messages[:min(h.Before, len(c.Messages))] {
			if m.From == "user" {
				upto++
			}
		}
		if upto <= from {
			continue
		}
		who := h.Name
		if h.ReplicaID == c.ReplicaID {
			who = "you"
		}
		which := fmt.Sprintf("messages %d to %d", from+1, upto)
		if upto == from+1 {
			which = fmt.Sprintf("message %d", upto)
		}
		if len(parts) == 0 {
			parts = append(parts, fmt.Sprintf("The replies to the user's %s came from %s", which, who))
		} else {
			parts = append(parts, fmt.Sprintf("to %s, from %s", which, who))
		}
		from = upto
	}
	if len(parts) == 0 {
		return "This chat was handed over to you before you replied in it. Carry on from here as yourself.\n"
	}
	return "This chat was handed over to you, so not every earlier reply is yours. " + strings.Join(parts, "; ") + ". Carry on from where they left off, as yourself.\n"
}

// airportChatSpec is the chat's own model and level, with the staff's rules, the global prompt and their built-in
// blueprint: no company or memory.
func (e *Engine) airportChatSpec(c *model.Chat) (agentSpec, error) {
	bp := e.w.Blueprints[airportBlueprintID]
	if bp == nil {
		return agentSpec{}, model.Errorf(model.CodeInvalid, "找不到 %s 的藍圖", c.Name)
	}
	spec, err := e.modelSpec(c.Model, c.Effort)
	if err != nil {
		return agentSpec{}, err
	}
	if err := os.MkdirAll(e.airportFolder(), 0o700); err != nil {
		return agentSpec{}, err
	}
	spec.name, spec.allowed, spec.packs = c.Name, slices.Clone(bp.Tools), e.packsOf(bp)
	mention := ""
	if home, err := os.UserHomeDir(); err == nil { // what "#" offers, so read_file can open what the user names
		spec.read = []string{home}
		mention = fmt.Sprintf("\nA word like #path or #\"path with spaces\" in what the user writes names a file or folder in the user's home folder, %s, relative to it.", home)
	}
	spec.prompt = promptParts{
		rules:  airportChatRules + mention + "\n" + languageRule(e.w.Language) + "\nWhen instructions in this prompt conflict, follow the higher one in this order: these opening rules, Global rules, Your role, Skills.\n",
		shared: sharedRules(e.runGlobalPrompt(), ""),
		role:   rolePart(bp),
	}
	return spec, nil
}

// airportFolder is where the airport staff work.
func (e *Engine) airportFolder() string {
	folder, _ := filepath.Abs(filepath.Join(e.dataDir, "cache", "airport"))
	return folder
}

type chatRun struct {
	r      *run
	id     string
	spec   agentSpec
	conv   []model.Message
	folder string
	// team is the company the chat is in, "" at the airport
	team string
	// said is the user's words alone: an attached file's text in the conversation names no skill
	said string
	// peers are the packs of the others in a meeting: a skill the user names with "$" is everyone's, as the list
	// they pick it from is, and whoever replies first brings it for the round
	peers []packRoot
	// context is how much the model read last time; compact is what stands in for the conversation's start
	context int
	compact *model.ChatCompact
	// memory is whether the chat is with an employee, who has notes to keep
	memory bool
	// speaker is who replies, "" for the airport staff; actor is whether they may act outside the chat this round
	speaker string
	actor   bool
	// actorName is who may act this round, for a refusal to name
	actorName string
	// note is what changes from round to round in a meeting, put at the end of the user's latest words
	note    string
	session string
	names   map[string]string
}

// launchChat starts a reply by one in the chat. Its run names no employee: a chat does not keep them from their tasks.
func (e *Engine) launchChat(c *model.Chat, speaker string, spec agentSpec) {
	e.stopRun(c.ID)
	c.ReplyAt = ptr(e.w.Now)
	c.Speaker = speaker
	folder, timeout := e.airportFolder(), airportChatTimeout
	if team := e.w.Teams[c.TeamID]; team != nil {
		folder, timeout = team.Folder, time.Duration(team.Settings.TimeoutMin*float64(time.Minute))
		spec.packs = append(projectPacks(team.Folder, e.w.Preferences), spec.packs...)
	}
	ctx, cancel := context.WithCancel(e.ctx)
	if timeout > 0 {
		ctx, cancel = context.WithTimeout(e.ctx, timeout)
	}
	r := &run{cancel: cancel}
	e.runs[c.ID] = r
	said := ""
	if last := c.Messages[len(c.Messages)-1]; last.From == "user" { // going on from an answer on a card, no one said anything
		said = last.Text
	}
	e.wg.Add(1)
	session := c.ID
	if len(c.Guests) > 0 { // each keeps their own, whoever chairs, so their provider's cache stays theirs
		session = c.ID + "-" + speaker
	}
	var peers []packRoot
	for _, id := range append([]string{c.ReplicaID}, guestIDs(c)...) {
		if p := e.w.Replicas[id]; id != speaker && p != nil && p.TeamID == c.TeamID {
			if bp := e.w.Blueprints[p.BlueprintID]; bp != nil {
				peers = append(peers, e.packsOf(bp)...)
			}
		}
	}
	go e.runChat(ctx, chatRun{r: r, id: c.ID, spec: spec, conv: slices.Clone(e.w.Conversations[c.ID]), folder: folder, team: c.TeamID, said: said, peers: peers, context: c.Context, compact: clone(c.Compact), memory: !c.AtAirport(),
		speaker: speaker, actor: speaker == roundActor(c), actorName: chatNames(c)[roundActor(c)], note: e.roundNote(c, speaker), session: session, names: chatNames(c)})
}

// applyChat changes a chat for a run, unless the run was stopped or replaced meanwhile.
func (e *Engine) applyChat(in chatRun, fn func(c *model.Chat)) bool {
	e.mu.Lock()
	defer e.mu.Unlock()
	c := e.w.Chats[in.id]
	if e.runs[in.id] != in.r || c == nil {
		return false
	}
	e.w.Now = e.clock()
	fn(c)
	e.settle()
	return true
}

// chatKeepsImage shows each picture image_gen saves under its tool line. The copy is an upload, so the chat still
// shows it after the file in the folder is changed or removed.
func (e *Engine) chatKeepsImage(in chatRun) func(output string, data []byte) {
	return func(output string, data []byte) {
		url, err := e.SaveUpload(bytes.NewReader(data))
		if err != nil {
			return // the file is saved; only the thumbnail is missing
		}
		e.applyChat(in, func(c *model.Chat) {
			c.Messages = append(c.Messages, model.ChatMessage{At: e.w.Now, From: "tool", Text: filepath.ToSlash(output),
				Images: []model.Attachment{{Name: filepath.Base(output), URL: url}}, By: c.Speaker})
		})
	}
}

// chatAskUser ends the reply with a question. The user's next message answers it.
func (e *Engine) chatAskUser(in chatRun) adapter.Tool {
	return funcTool{model.ToolSpec{Name: toolAskUser, Description: "End your reply and ask the user something; you go on with their answer. Do not call it together with other tools: call it once their results are in. " + askUserHow,
		Parameters: json.RawMessage(askUserSchema)},
		func(_ context.Context, _ string, raw json.RawMessage) model.ToolResult {
			var a struct {
				Prompt  string   `json:"prompt"`
				Options []string `json:"options"`
			}
			if err := json.Unmarshal(raw, &a); err != nil || strings.TrimSpace(a.Prompt) == "" {
				return toolError("prompt is required")
			}
			options := []string{}
			for _, o := range a.Options {
				if o = strings.TrimSpace(o); o != "" && !slices.Contains(options, o) {
					options = append(options, o)
				}
			}
			e.applyChat(in, func(c *model.Chat) {
				e.chatSays(c, a.Prompt)
				c.Question = &model.ChatQuestion{Options: options}
			})
			return model.ToolResult{Stop: true}
		}}
}

// chatMemoryTools let the employee keep and drop notes while chatting. The chat already shows each call.
func (e *Engine) chatMemoryTools(in chatRun) []adapter.Tool {
	remember := func(_ context.Context, _ string, raw json.RawMessage) model.ToolResult {
		var a struct {
			Text string `json:"text"`
		}
		if err := json.Unmarshal(raw, &a); err != nil || strings.TrimSpace(a.Text) == "" {
			return toolError("text is required")
		}
		e.applyChat(in, func(c *model.Chat) {
			e.remember(&in.speaker, strings.TrimSpace(a.Text), "chat", "")
		})
		return model.ToolResult{Text: "remembered"}
	}
	forget := func(_ context.Context, _ string, raw json.RawMessage) model.ToolResult {
		var a struct {
			ID string `json:"id"`
		}
		if err := json.Unmarshal(raw, &a); err != nil || a.ID == "" {
			return toolError("id is required")
		}
		found := false
		e.applyChat(in, func(c *model.Chat) {
			_, found = e.forget(&in.speaker, a.ID)
		})
		if !found {
			return toolError("no note with id %s", a.ID)
		}
		return model.ToolResult{Text: "forgotten"}
	}
	search := e.searchMemoryTool(func() *string { return &in.speaker })
	return []adapter.Tool{funcTool{rememberSpec, remember}, funcTool{forgetSpec, forget}, funcTool{searchMemorySpec, search}}
}

func (e *Engine) runChat(ctx context.Context, in chatRun) {
	defer e.wg.Done()
	defer in.r.cancel()
	finished, stopped := false, false
	defer func() {
		e.mu.Lock()
		defer e.mu.Unlock()
		if e.runs[in.id] == in.r {
			delete(e.runs, in.id)
			delete(e.live, in.id)
			e.clearOutput(in.id)
			if e.closed {
				// the server is stopping, not the user: the chat is left replying, so the next start says the
				// reply was cut off and has the rest of the round go on
				return
			}
			if c := e.w.Chats[in.id]; c != nil {
				c.ReplyAt = nil
				// in a meeting the next one replies even if this one failed; a stopped reply stops the round.
				// A failed one leaves the queue for the user to send
				if !stopped && e.nextSpeaker(c) {
					// it goes on
				} else if finished {
					if err := e.sendQueued(c); err != nil {
						e.log.Warn().Err(err).Str("chat", in.id).Msg("send queued message")
					}
				}
			}
			e.settle()
		}
	}()
	failed := func(detail string, err error) {
		e.applyChat(in, func(c *model.Chat) {
			e.chatSays(c, i18n.T("（回覆失敗：%s）", detail))
			said := &c.Messages[len(c.Messages)-1]
			said.Failed = true
			var known *model.Error
			if errors.As(err, &known) && known.Code == model.CodeSignedOut {
				if p := e.providerFor(in.spec.model); p != nil {
					said.SignedOut = p.ID
				}
			}
		})
	}
	repoRole := ""
	if own := in.spec.own; own != nil {
		role, err := e.ownPrompt(ctx, own)
		if err != nil {
			e.log.Warn().Err(err).Str("repo", own.Repo).Msg("read blueprint for chat")
		}
		repoRole = role
	}
	skills, roots, _ := e.loadSkills(ctx, in.spec.packs)
	// the speaker's own come first, so where two have the same name theirs counts
	known := skills
	if len(in.peers) > 0 {
		peers, peerRoots, _ := e.loadSkills(ctx, in.peers)
		known = append(slices.Clip(skills), peers...)
		roots = append(roots, peerRoots...)
	}
	// kept with the message from here on, so what the employee was told does not change under the conversation
	if last := len(in.conv) - 1; last >= 0 {
		if said, named := withSkills(in.conv[last], in.said, known); named {
			in.conv[last] = said
			kept := e.applyChat(in, func(c *model.Chat) {
				conv := e.w.Conversations[c.ID]
				conv[len(conv)-1] = said
				e.dirty[c.ID] = true
			})
			if !kept {
				return
			}
		}
	}
	read := append(append(roots, e.attachmentRoot(in.id)), in.spec.read...)
	list := tools.For(in.spec.allowed, tools.Env{Read: read, Output: e.outputRoot(in.id), Search: e.search})
	list = append(list, e.chatAskUser(in))
	if in.team != "" && (slices.Contains(in.spec.allowed, enum.ToolReadFile) || slices.Contains(in.spec.allowed, enum.ToolRunCommand)) {
		list = append(list, e.readTerminalTool(in.team))
	}
	list = append(list, imageTools(in.spec, read, e.chatKeepsImage(in))...)
	if in.memory {
		list = append(list, e.chatMemoryTools(in)...)
	}
	list = append(list, e.manageTools(e.managerOfChat(in), in.spec.allowed, true)...)
	// in a meeting everyone has the same tools every round, so their provider's cache of the request's start holds;
	// the one who may not act this round is refused at the call instead
	if !in.actor {
		for i, tool := range list {
			if actsOutside(tool.Spec().Name) {
				list[i] = refusedTool{tool.Spec(), in.actorName}
			}
		}
	}
	specs := make([]model.ToolSpec, len(list))
	byName := make(map[string]adapter.Tool, len(list))
	for i, tool := range list {
		specs[i] = tool.Spec()
		byName[specs[i].Name] = tool
	}
	t := &turn{
		provider: in.spec.provider,
		req:      model.ModelRequest{Cwd: in.folder, Session: in.session, Model: in.spec.model, Effort: in.spec.effort, System: in.spec.prompt.compose(repoRole, skills), Messages: in.sees(chatView(in.conv, in.compact)), Tools: specs},
		tools:    byName, cwd: in.folder,
		onStart:  func() { e.restartLive(in.id, in.r) },
		onText:   func(text string) { e.addLive(in.id, in.r, text) },
		onOutput: func(text string) { e.setOutput(in.id, in.r, text) },
		onReply: func(reply model.ModelReply) bool {
			return e.applyChat(in, func(c *model.Chat) {
				delete(e.live, c.ID) // now it is a message
				c.Tokens += tokensUsed(reply.Usage)
				c.Context = reply.Usage.Input
				e.w.Conversations[c.ID] = append(e.w.Conversations[c.ID], model.Message{Role: enum.RoleAssistant, Content: reply.Content, By: in.speaker})
				e.dirty[c.ID] = true
				for _, b := range reply.Content {
					if b.Type == enum.BlockText && strings.TrimSpace(b.Text) != "" {
						e.chatSays(c, b.Text)
					}
				}
			})
		},
		onTool: func(call model.Block) {
			if call.Name == toolAskUser {
				return // it shows as the question itself
			}
			e.applyChat(in, func(c *model.Chat) {
				c.Messages = append(c.Messages, model.ChatMessage{At: e.w.Now, From: "tool", Text: toolLine(call), By: in.speaker})
			})
		},
		onResults: func(msg model.Message) {
			msg.By = in.speaker
			e.applyChat(in, func(c *model.Chat) {
				e.w.Conversations[c.ID] = append(e.w.Conversations[c.ID], msg)
				e.dirty[c.ID] = true
			})
		},
	}
	t.compact = func(ctx context.Context) ([]model.Message, bool) { return e.compactChat(ctx, in) }
	t.steer = func() []model.Message {
		var heard []model.Message
		e.applyChat(in, func(c *model.Chat) {
			before := len(e.w.Conversations[c.ID])
			for len(c.Queue) > 0 && c.Queue[0].Steer {
				q := c.Queue[0]
				c.Queue = slices.Clone(c.Queue[1:])
				e.chatHears(c, q.Text, q.Images, q.Files, q.Mentions)
				conv := e.w.Conversations[c.ID]
				conv[len(conv)-1], _ = withSkills(conv[len(conv)-1], q.Text, known)
			}
			heard = slices.Clone(e.w.Conversations[c.ID][before:])
		})
		return heard
	}
	if in.context >= chatCompactAt {
		if shorter, ok := t.compact(ctx); ok {
			t.req.Messages = shorter
		}
	}
	_, err := t.run(ctx)
	finished = err == nil
	if err != nil {
		switch {
		case errors.Is(ctx.Err(), context.DeadlineExceeded):
			failed(i18n.T("執行逾時"), err)
		case ctx.Err() != nil: // stopped on purpose
			stopped = true
		default:
			var known *model.Error
			if !errors.As(err, &known) {
				e.log.Error().Err(err).Str("chat", in.id).Msg("chat failed")
			}
			failed(safeText(err), err)
		}
	}
}

// withSkills adds the skills the user's words name to their message in the conversation; false if they name none.
func withSkills(said model.Message, words string, skills []skill) (model.Message, bool) {
	named := mentionedSkills(words, skills)
	if len(named) == 0 {
		return said, false
	}
	said.Content = slices.Clip(said.Content)
	for _, text := range named {
		said.Content = append(said.Content, model.Block{Type: enum.BlockText, Text: text})
	}
	return said, true
}

// ChatTaskDraft has the chat's model write the chat up as a task. It makes no task, the user reads it first; the chat only counts the tokens.
func (e *Engine) ChatTaskDraft(ctx context.Context, id string) (ChatDraft, error) {
	e.mu.Lock()
	c := e.w.Chats[id]
	if c == nil {
		e.mu.Unlock()
		return ChatDraft{}, model.Errorf(model.CodeNotFound, "找不到對話")
	}
	if c.AtAirport() {
		e.mu.Unlock()
		return ChatDraft{}, model.Errorf(model.CodeInvalid, "機場的對話不能建立任務")
	}
	actor := roundActor(c) // the one who may create the task writes it
	if e.w.Replicas[actor] == nil {
		actor = c.ReplicaID
	}
	spec, err := e.chatSpec(c, actor)
	folder := e.w.Teams[c.TeamID].Folder
	names := chatNames(c)
	draftRules := chatDraftRules + "\n" + languageRule(e.w.Language)
	var transcript strings.Builder
	for _, m := range c.Messages {
		if m.Failed { // the app's line that a reply did not come, not anything the employee said
			continue
		}
		switch m.From {
		case "user":
			fmt.Fprintf(&transcript, "User: %s", m.Text)
			if len(m.Images) > 0 {
				fmt.Fprintf(&transcript, " (%d images attached)", len(m.Images))
			}
			for _, f := range m.Files {
				fmt.Fprintf(&transcript, " (file attached: %q)", f.Name)
			}
			transcript.WriteString("\n\n")
		case "agent":
			who := "Employee"
			if len(c.Guests) > 0 && names[m.By] != "" {
				who = names[m.By]
			}
			fmt.Fprintf(&transcript, "%s: %s\n\n", who, m.Text)
		}
	}
	e.mu.Unlock()
	if err != nil {
		return ChatDraft{}, err
	}
	// its own session and no tools: this is writing, apart from the chat
	reply, err := spec.provider.Complete(ctx, model.ModelRequest{Cwd: folder, Session: id + "-draft-" + fmt.Sprint(e.clock()), Model: spec.model, Effort: spec.effort,
		System: draftRules, Messages: []model.Message{userText(transcript.String())}}, func(string) {})
	if err != nil {
		if !errors.As(err, new(*model.Error)) {
			e.log.Error().Err(err).Str("chat", id).Msg("write task from chat")
		}
		return ChatDraft{}, model.Errorf(model.CodeUnavailable, "整理對話失敗：%s", safeText(err))
	}
	e.mu.Lock()
	if c := e.w.Chats[id]; c != nil { // it may have been deleted while the model wrote
		c.Tokens += tokensUsed(reply.Usage)
		e.settle()
	}
	e.mu.Unlock()
	var text strings.Builder
	for _, b := range reply.Content {
		if b.Type == enum.BlockText {
			text.WriteString(b.Text)
		}
	}
	return parseChatDraft(text.String())
}

func parseChatDraft(text string) (ChatDraft, error) {
	title, description, _ := strings.Cut(strings.TrimSpace(text), "\n")
	title = strings.TrimSpace(strings.TrimLeft(strings.TrimSpace(title), "#* "))
	title = strings.TrimSpace(strings.TrimRight(title, "* "))
	if title == "" {
		return ChatDraft{}, model.Errorf(model.CodeUnavailable, "模型沒有寫出任務內容")
	}
	return ChatDraft{Title: title, Description: strings.TrimSpace(description)}, nil
}
