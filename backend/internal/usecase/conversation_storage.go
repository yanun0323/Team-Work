package usecase

import (
	"context"
	"fmt"
	"time"

	"github.com/yanun0323/Team-Work/internal/model"
	"github.com/yanun0323/Team-Work/pkg/jsonx"
)

// loadConversation runs under the engine lock, before any mutation that needs
// history. Map membership keeps unloaded records distinct from new/deleted ones.
func (e *Engine) loadConversation(id string) error {
	conv, exists := e.w.Conversations[id]
	if !exists || conv != nil {
		return nil
	}
	ctx := e.ctx
	if ctx == nil {
		ctx = context.Background()
	}
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	raw, err := e.store.LoadConversation(ctx, id)
	if err == nil {
		err = jsonx.Unmarshal(raw, &conv)
	}
	if err != nil {
		e.log.Error().Err(err).Str("conversation", id).Msg("read conversation")
		return model.Errorf(model.CodeUnavailable, "讀取對話歷史失敗，請稍後重試；原有紀錄未變更")
	}
	if conv == nil {
		conv = []model.Message{}
	}
	e.w.Conversations[id] = conv
	return nil
}

// releaseConversations runs only after a successful save. An active run needs
// its full history for tools and compaction; failed writes must remain retryable.
func (e *Engine) releaseConversations() {
	for id := range e.w.Conversations {
		key := docKey(kindConv, id)
		if _, saved := e.prev[key]; !saved || e.dirty[id] {
			continue
		}
		e.prev[key] = nil
		if e.runs[id] == nil && !e.speaking(id) {
			e.w.Conversations[id] = nil
		}
	}
}

// Old inline images are migrated one conversation at a time, before runs start.
// No history is removed, and a failed write leaves that record untouched.
func (e *Engine) migrateConversationImages(ctx context.Context) error {
	ids, err := e.store.InlineConversations(ctx)
	if err != nil {
		return fmt.Errorf("find inline conversation images: %w", err)
	}
	for _, id := range ids {
		raw, err := e.store.LoadConversation(ctx, id)
		if err != nil {
			return fmt.Errorf("read conversation %s: %w", id, err)
		}
		var conv []model.Message
		if err = jsonx.Unmarshal(raw, &conv); err != nil {
			return fmt.Errorf("read conversation %s: %w", id, err)
		}
		stored, changed, err := e.storeMessageImages(conv)
		if err != nil {
			return fmt.Errorf("store conversation images %s: %w", id, err)
		}
		if !changed {
			continue
		}
		raw, err = jsonx.Marshal(stored)
		if err != nil {
			return err
		}
		if err = e.store.Apply(ctx, []model.Doc{{Kind: kindConv, ID: id, Data: raw}}, nil, nil); err != nil {
			return fmt.Errorf("save conversation images %s: %w", id, err)
		}
	}
	return nil
}
