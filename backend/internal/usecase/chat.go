package usecase

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"slices"
	"strings"
	"time"

	"github.com/yanun0323/mho-company/internal/adapter"
	"github.com/yanun0323/mho-company/internal/i18n"
	"github.com/yanun0323/mho-company/internal/model"
	"github.com/yanun0323/mho-company/internal/model/enum"
	"github.com/yanun0323/mho-company/internal/usecase/tools"
)

const chatRules = "You are a company employee chatting with the user to discuss things or do simple work. The working directory is the project folder itself, and changes reach the user's files immediately: change only what was asked, and commit only if the user asks.\n" +
	"Reply in plain text. If the work grows or needs several steps, suggest creating a task from this chat.\n" +
	dataRule

const chatDraftRules = "Write the chat below as a task for a colleague who has not seen it. First line: the task title, with no markup. Then a blank line and the description: goal, decisions, constraints and acceptance criteria. Use only what the chat says. Output nothing else."

// maxChatImages keeps a message within what the API takes in one request.
const maxChatImages = 6

// NewChat starts a chat: it exists from the user's first message on.
type NewChat struct {
	TeamID    string             `json:"teamId"`
	ReplicaID string             `json:"replicaId"`
	Text      string             `json:"text"`
	Images    []model.Attachment `json:"images"`
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
		if err := checkSaid(text, in.Images); err != nil {
			return err
		}
		c := &model.Chat{ID: e.uid("chat"), TeamID: in.TeamID, ReplicaID: r.ID, Name: r.Name, Look: r.Look, Model: r.Model, CreatedAt: e.w.Now, Messages: []model.ChatMessage{}}
		spec, err := e.chatSpec(c)
		if err != nil {
			return err
		}
		e.w.Chats[c.ID] = c
		e.chatHears(c, text, in.Images)
		e.launchChat(c, spec)
		out = clone(c)
		return nil
	})
	return out, err
}

// SayInChat adds the user's message and has the employee reply. Nothing can be said while they still write.
func (e *Engine) SayInChat(id, text string, images []model.Attachment) error {
	return e.do(func() error {
		c := e.w.Chats[id]
		if c == nil {
			return model.Errorf(model.CodeNotFound, "找不到對話")
		}
		text = strings.TrimSpace(text)
		if err := checkSaid(text, images); err != nil {
			return err
		}
		if c.ReplyAt != nil {
			return model.Errorf(model.CodeInvalid, "員工還在回覆")
		}
		if e.w.Replicas[c.ReplicaID] == nil {
			return model.Errorf(model.CodeInvalid, "%s 已經離開公司", c.Name)
		}
		spec, err := e.chatSpec(c)
		if err != nil {
			return err
		}
		e.chatHears(c, text, images)
		e.launchChat(c, spec)
		return nil
	})
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
		if e.w.Replicas[c.ReplicaID] == nil {
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
		c.ReplyAt = nil
		c.Messages = c.Messages[:index]
		e.w.Conversations[c.ID] = e.w.Conversations[c.ID][:end]
		e.dirty[c.ID] = true
		return nil
	})
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
func checkSaid(text string, images []model.Attachment) error {
	if text == "" && len(images) == 0 {
		return model.Errorf(model.CodeInvalid, "訊息不能是空的")
	}
	if len(images) > maxChatImages {
		return model.Errorf(model.CodeInvalid, "一則訊息最多附 %d 張圖", maxChatImages)
	}
	for _, img := range images {
		mime, data, ok := parseDataURL(img.URL)
		raw, err := base64.StdEncoding.DecodeString(data)
		if !ok || err != nil || !tools.CanLookAt(mime, len(raw)) {
			return model.Errorf(model.CodeInvalid, "圖片只能是 PNG、JPEG、GIF 或 WebP，單張最大 3.75MB")
		}
	}
	return nil
}

// StopChat interrupts the reply being written; the chat goes on from what is there.
func (e *Engine) StopChat(id string) error {
	return e.do(func() error {
		c := e.w.Chats[id]
		if c == nil {
			return model.Errorf(model.CodeNotFound, "找不到對話")
		}
		e.stopRun(c.ID)
		c.ReplyAt = nil
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
	delete(e.w.Chats, id)
	delete(e.w.Conversations, id)
	delete(e.dirty, id)
}

// endChatsOf stops the replies of an employee who is leaving. Their chats stay to read.
func (e *Engine) endChatsOf(replicaID string) {
	for _, c := range e.w.Chats {
		if c.ReplicaID == replicaID && c.ReplyAt != nil {
			e.stopRun(c.ID)
			c.ReplyAt = nil
		}
	}
}

// interruptChats runs at start. A reply is not picked up again: it works in the user's own folder, and whatever
// it was doing may not be safe to repeat.
func (e *Engine) interruptChats() {
	for _, c := range e.w.Chats {
		if c.ReplyAt != nil {
			c.ReplyAt = nil
			c.Messages = append(c.Messages, model.ChatMessage{At: e.w.Now, From: "agent", Text: i18n.T("（伺服器重新啟動，這次回覆中斷了）")})
		}
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

// chatHears puts the user's message into the chat and the conversation. Calls left without a result by an
// interrupted reply are closed first, as the model refuses them otherwise.
func (e *Engine) chatHears(c *model.Chat, text string, images []model.Attachment) {
	c.Messages = append(c.Messages, model.ChatMessage{At: e.w.Now, From: "user", Text: text, Images: images})
	said := model.Message{Role: enum.RoleUser}
	if text != "" { // a model refuses an empty text block
		said.Content = append(said.Content, model.Block{Type: enum.BlockText, Text: text})
	}
	for _, img := range images {
		if mime, data, ok := parseDataURL(img.URL); ok {
			said.Content = append(said.Content, model.Block{Type: enum.BlockImage, MimeType: mime, Data: data})
		}
	}
	e.w.Conversations[c.ID] = append(answerPending(e.w.Conversations[c.ID], ""), said)
	e.dirty[c.ID] = true
}

// chatSpec is a task's spec without the task: the chat's model, the employee's role, the company's rules.
func (e *Engine) chatSpec(c *model.Chat) (agentSpec, error) {
	r := e.w.Replicas[c.ReplicaID]
	if r == nil {
		return agentSpec{}, model.Errorf(model.CodeInvalid, "%s 已經離開公司", c.Name)
	}
	// the chat stays on the model it began with; if the employee has moved on, their thinking level no longer applies
	picked := *r
	if picked.Model != c.Model {
		picked.Model, picked.Effort = c.Model, model.ThinkingDefault
	}
	spec, err := e.buildSpec(nil, nil, &picked)
	if err != nil {
		return agentSpec{}, err
	}
	team, bp := e.w.Teams[c.TeamID], e.w.Blueprints[r.BlueprintID]
	e.readPrompt(team)
	var b strings.Builder
	b.WriteString(chatRules + "\n" + languageRule(e.w.Language) + "\n")
	if team.Prompt != "" {
		fmt.Fprintf(&b, "\n# Company rules\n%s\n", team.Prompt)
	}
	if role := agentRole(bp); role != "" {
		fmt.Fprintf(&b, "\n# Your role\n%s\n", role)
	}
	if len(r.Memory) > 0 {
		b.WriteString("\n# Your memory\n")
		for _, m := range r.Memory {
			fmt.Fprintf(&b, "- %s\n", m.Text)
		}
	}
	spec.system = b.String()
	return spec, nil
}

type chatRun struct {
	r      *run
	id     string
	spec   agentSpec
	conv   []model.Message
	folder string
}

// launchChat starts a reply. Its run names no employee: a chat does not keep them from their tasks.
func (e *Engine) launchChat(c *model.Chat, spec agentSpec) {
	e.stopRun(c.ID)
	c.ReplyAt = ptr(e.w.Now)
	team := e.w.Teams[c.TeamID]
	ctx, cancel := context.WithCancel(e.ctx)
	if d := time.Duration(team.Settings.TimeoutMin * float64(time.Minute)); d > 0 {
		ctx, cancel = context.WithTimeout(e.ctx, d)
	}
	r := &run{cancel: cancel}
	e.runs[c.ID] = r
	e.wg.Add(1)
	go e.runChat(ctx, chatRun{r: r, id: c.ID, spec: spec, conv: slices.Clone(e.w.Conversations[c.ID]), folder: team.Folder})
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

func (e *Engine) runChat(ctx context.Context, in chatRun) {
	defer e.wg.Done()
	defer in.r.cancel()
	defer func() {
		e.mu.Lock()
		defer e.mu.Unlock()
		if e.runs[in.id] == in.r {
			delete(e.runs, in.id)
			delete(e.live, in.id)
			if c := e.w.Chats[in.id]; c != nil {
				c.ReplyAt = nil
			}
			e.settle()
		}
	}()
	failed := func(detail string) {
		e.applyChat(in, func(c *model.Chat) {
			c.Messages = append(c.Messages, model.ChatMessage{At: e.w.Now, From: "agent", Text: i18n.T("（回覆失敗：%s）", detail)})
		})
	}
	if own := in.spec.own; own != nil {
		role, err := e.ownPrompt(ctx, own)
		if err != nil {
			e.log.Warn().Err(err).Str("repo", own.Repo).Msg("read blueprint for chat")
		}
		in.spec.system += role
	}
	skills, roots, _ := e.loadSkills(ctx, in.spec.packs)
	list := tools.For(in.spec.allowed, roots)
	specs := make([]model.ToolSpec, len(list))
	byName := make(map[string]adapter.Tool, len(list))
	for i, tool := range list {
		specs[i] = tool.Spec()
		byName[specs[i].Name] = tool
	}
	t := &turn{
		provider: in.spec.provider,
		req:      model.ModelRequest{Cwd: in.folder, Session: in.id, Model: in.spec.model, Effort: in.spec.effort, System: in.spec.system + skillsPrompt(skills), Messages: in.conv, Tools: specs},
		tools:    byName, cwd: in.folder,
		onStart: func() { e.restartLive(in.id, in.r) },
		onText:  func(text string) { e.addLive(in.id, in.r, text) },
		onReply: func(reply model.ModelReply) bool {
			return e.applyChat(in, func(c *model.Chat) {
				delete(e.live, c.ID) // now it is a message
				e.w.Conversations[c.ID] = append(e.w.Conversations[c.ID], model.Message{Role: enum.RoleAssistant, Content: reply.Content})
				e.dirty[c.ID] = true
				for _, b := range reply.Content {
					if b.Type == enum.BlockText && strings.TrimSpace(b.Text) != "" {
						c.Messages = append(c.Messages, model.ChatMessage{At: e.w.Now, From: "agent", Text: b.Text})
					}
				}
			})
		},
		onTool: func(call model.Block) {
			e.applyChat(in, func(c *model.Chat) {
				c.Messages = append(c.Messages, model.ChatMessage{At: e.w.Now, From: "tool", Text: call.Name + " " + clip(string(call.Args), 200)})
			})
		},
		onResults: func(msg model.Message) {
			e.applyChat(in, func(c *model.Chat) {
				e.w.Conversations[c.ID] = append(e.w.Conversations[c.ID], msg)
				e.dirty[c.ID] = true
			})
		},
	}
	if _, err := t.run(ctx); err != nil {
		switch {
		case errors.Is(ctx.Err(), context.DeadlineExceeded):
			failed(i18n.T("執行逾時"))
		case ctx.Err() != nil: // stopped on purpose
		default:
			var known *model.Error
			if !errors.As(err, &known) {
				e.log.Error().Err(err).Str("chat", in.id).Msg("chat failed")
			}
			failed(safeText(err))
		}
	}
}

// ChatTaskDraft has the chat's model write the chat up as a task. It changes nothing: the user reads it first.
func (e *Engine) ChatTaskDraft(ctx context.Context, id string) (ChatDraft, error) {
	e.mu.Lock()
	c := e.w.Chats[id]
	if c == nil {
		e.mu.Unlock()
		return ChatDraft{}, model.Errorf(model.CodeNotFound, "找不到對話")
	}
	spec, err := e.chatSpec(c)
	folder := e.w.Teams[c.TeamID].Folder
	draftRules := chatDraftRules + "\n" + languageRule(e.w.Language)
	var transcript strings.Builder
	for _, m := range c.Messages {
		switch m.From {
		case "user":
			fmt.Fprintf(&transcript, "User: %s", m.Text)
			if len(m.Images) > 0 {
				fmt.Fprintf(&transcript, " (%d images attached)", len(m.Images))
			}
			transcript.WriteString("\n\n")
		case "agent":
			fmt.Fprintf(&transcript, "Employee: %s\n\n", m.Text)
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
