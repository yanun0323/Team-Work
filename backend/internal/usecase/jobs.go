package usecase

import (
	"context"
	"strings"
	"time"

	"github.com/yanun0323/Team-Work/internal/model"
	"github.com/yanun0323/Team-Work/internal/model/enum"
	"github.com/yanun0323/Team-Work/internal/usecase/tools"
)

// A background command belongs to a scope: a task step's run, which it does not outlive, or a chat, after whose
// reply it goes on.
const (
	subJobs  = "sub:"
	chatJobs = "chat:"
)

func chatJobScope(chatID string) string { return chatJobs + chatID }

// jobsHeader starts the message that tells the model how its background commands ended.
const jobsHeader = "[Background commands ended]"

// jobsMessage tells the model how its background commands ended.
func jobsMessage(ended []tools.JobReport) model.Message {
	parts := make([]string, len(ended))
	for i, r := range ended {
		parts[i] = r.Text()
	}
	return userText(jobsHeader + "\n" + strings.Join(parts, "\n\n"))
}

// isJobsMessage says whether m is a jobsMessage: kept after a call that waits on the user, it stays after the call's
// result once that comes.
func isJobsMessage(m model.Message) bool {
	return m.Role == enum.RoleUser && len(m.Content) == 1 && m.Content[0].Type == enum.BlockText && strings.HasPrefix(m.Content[0].Text, jobsHeader+"\n")
}

// stepJobsHeard takes how a step's background commands ended, keeps it in the step's conversation and returns it to
// send. Nothing when none ended, or the run was stopped or replaced.
func (e *Engine) stepJobsHeard(in subRun) []model.Message {
	ended := e.jobs.Ended(in.jobs)
	if len(ended) == 0 {
		return nil
	}
	msg := jobsMessage(ended)
	if !e.apply(in, func(_ *model.Task, s *model.SubTask) {
		e.w.Conversations[s.ID] = append(e.w.Conversations[s.ID], msg)
		e.dirty[s.ID] = true
	}) {
		return nil
	}
	return []model.Message{msg}
}

// awaitJobs waits, while a step has background commands running and nothing else to read, for one of them to end or
// the owner to say something. It ends with the run.
func (e *Engine) awaitJobs(ctx context.Context, in subRun) error {
	tick := time.NewTicker(time.Second) // the owner's words come with no signal
	defer tick.Stop()
	for {
		ended := e.jobs.Signal(in.jobs)
		if e.jobs.HasEnded(in.jobs) || len(e.jobs.Running(in.jobs)) == 0 || !in.talk && e.steersFor(in) {
			return nil
		}
		select {
		case <-ended:
		case <-tick.C:
		case <-ctx.Done():
			return ctx.Err()
		}
	}
}

// chatJobsHeard adds how a chat's background commands ended to it: a tool line each not shown yet, for the user, and
// one message for the model, which it returns. Call it holding the lock, with the conversation loaded.
func (e *Engine) chatJobsHeard(c *model.Chat, by string) []model.Message {
	ended := e.jobs.Ended(chatJobScope(c.ID))
	if len(ended) == 0 {
		return nil
	}
	e.showJobs(c, ended, by)
	msg := jobsMessage(ended)
	msg.By = by
	e.w.Conversations[c.ID] = append(e.w.Conversations[c.ID], msg)
	e.dirty[c.ID] = true
	return []model.Message{msg}
}

// showJobs adds a tool line for each command whose end the chat does not show yet. A tool line, never one from the
// system: the chat shows anything else as the user's own words.
func (e *Engine) showJobs(c *model.Chat, ended []tools.JobReport, by string) {
	for _, r := range ended {
		if !r.Shown {
			c.Messages = append(c.Messages, model.ChatMessage{At: e.w.Now, From: "tool", Text: "run_command " + r.Line(), By: by})
			c.Unread = true
		}
	}
}

// jobEnded hears that a background command ended. A step reads it in its own loop; a chat replying reads it after its
// next tools or once its reply ends, and an idle one is woken for it.
func (e *Engine) jobEnded(scope string) {
	chatID, ok := strings.CutPrefix(scope, chatJobs)
	if !ok {
		return
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.closed {
		return
	}
	e.w.Now = e.clock()
	e.wakeForJobs(chatID)
	e.settle()
}

// wakeForJobs has the one who spoke last in an idle chat tell the user how its background commands ended. Call it
// holding the lock.
func (e *Engine) wakeForJobs(chatID string) { e.chatJobsEnded(chatID, true) }

// chatJobsEnded keeps how an idle chat's background commands ended: a tool line each for the user, and in the
// conversation for the model, at once, so a restart loses none of it. wake has the one who spoke last tell the user
// now, unless the chat waits on the user's answer to a question or a change, or nobody is left to: they read it with
// the answer, or the user's next words. Call it holding the lock.
func (e *Engine) chatJobsEnded(chatID string, wake bool) {
	c := e.w.Chats[chatID]
	scope := chatJobScope(chatID)
	if c == nil || e.runs[chatID] != nil || c.ReplyAt != nil || !e.jobs.HasEnded(scope) {
		return
	}
	speaker := ""
	if !c.AtAirport() {
		speaker = c.Speaker
		if e.w.Replicas[speaker] == nil || !chatHas(c, speaker) {
			speaker = c.ReplicaID
		}
	}
	if err := e.loadConversation(chatID); err != nil {
		// shown now, told when the conversation can be read
		e.log.Warn().Err(err).Str("chat", chatID).Msg("load conversation for background commands")
		e.showJobs(c, e.jobs.Show(scope), speaker)
		return
	}
	wake = wake && c.Question == nil && c.Change == nil && !e.chatLeft(c)
	var spec agentSpec
	if wake {
		var err error
		if spec, err = e.chatSpec(c, speaker); err != nil {
			wake = false
		}
	}
	if len(e.chatJobsHeard(c, speaker)) == 0 || !wake {
		return
	}
	c.Next = nil
	e.launchChat(c, speaker, spec)
}
