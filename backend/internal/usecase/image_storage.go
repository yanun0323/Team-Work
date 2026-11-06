package usecase

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"slices"
	"strings"

	"github.com/yanun0323/Team-Work/internal/model"
	"github.com/yanun0323/Team-Work/internal/model/enum"
)

// Image bytes live in the existing content-addressed attachment store. Like mho,
// history keeps references; only a provider request receives the original bytes.
func (e *Engine) imageBytes(img model.Attachment) (string, []byte, error) {
	if hash, ok := uploadHash(img); ok {
		raw, err := e.readImage(hash)
		if err != nil {
			return "", nil, err
		}
		mime := http.DetectContentType(raw)
		return mime, raw, nil
	}
	mime, data, ok := parseDataURL(img.URL)
	if !ok || len(data) > base64.StdEncoding.EncodedLen(maxFileBytes) {
		return "", nil, fmt.Errorf("invalid image")
	}
	raw, err := base64.StdEncoding.DecodeString(data)
	return mime, raw, err
}

func (e *Engine) readImage(hash string) ([]byte, error) {
	if !validUploadHash(hash) {
		return nil, model.Errorf(model.CodeInvalid, "找不到附件")
	}
	f, err := e.UploadFile(hash)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Size() > maxFileBytes {
		return nil, model.Errorf(model.CodeInvalid, "找不到附件")
	}
	raw, err := io.ReadAll(io.LimitReader(f, maxFileBytes+1))
	sum := sha256.Sum256(raw)
	if err != nil || len(raw) > maxFileBytes || hex.EncodeToString(sum[:]) != hash {
		return nil, model.Errorf(model.CodeInvalid, "找不到附件")
	}
	return raw, nil
}

func (e *Engine) storeImage(data string) (string, error) {
	if len(data) > base64.StdEncoding.EncodedLen(maxFileBytes) {
		return "", fmt.Errorf("image exceeds storage limit")
	}
	raw, err := base64.StdEncoding.DecodeString(data)
	if err != nil {
		return "", fmt.Errorf("invalid stored image encoding: %w", err)
	}
	url, err := e.SaveUpload(bytes.NewReader(raw))
	if err != nil {
		return "", err
	}
	hash := strings.TrimPrefix(url, uploadURLPrefix)
	// An existing object must match too; never replace history with a broken reference.
	if _, err := e.readImage(hash); err != nil {
		return "", err
	}
	return hash, nil
}

// Copy on write: running turns and undo snapshots may share the old slices.
func (e *Engine) storeImages(images []model.Attachment) ([]model.Attachment, error) {
	out := images
	copied := false
	for i, img := range images {
		if _, ok := uploadHash(img); ok {
			if img.MimeType == "" {
				mime, _, err := e.imageBytes(img)
				if err != nil {
					return images, err
				}
				if !copied {
					out = slices.Clone(images)
					copied = true
				}
				out[i].MimeType = mime
			}
			continue
		}
		mime, data, ok := parseDataURL(img.URL)
		if !ok || !strings.HasPrefix(mime, "image/") {
			continue
		}
		hash, err := e.storeImage(data)
		if err != nil {
			return images, err
		}
		if !copied {
			out = slices.Clone(images)
			copied = true
		}
		// mime is a substring of the large data URL; do not keep its backing string alive.
		out[i].URL, out[i].MimeType = uploadURLPrefix+hash, strings.Clone(mime)
	}
	return out, nil
}

func imageBlocks(images []model.Attachment) []model.Block {
	var out []model.Block
	for _, img := range images {
		if hash, ok := uploadHash(img); ok {
			out = append(out, model.Block{Type: enum.BlockImage, MimeType: img.MimeType, ImageRef: hash})
		} else if mime, data, ok := parseDataURL(img.URL); ok {
			out = append(out, model.Block{Type: enum.BlockImage, MimeType: mime, Data: data})
		}
	}
	return out
}

func (e *Engine) storeMessageImages(messages []model.Message) ([]model.Message, bool, error) {
	out := messages
	copied := false
	for i, m := range messages {
		blocks := m.Content
		blockCopy := false
		for j, b := range m.Content {
			if b.Data == "" || !strings.HasPrefix(b.MimeType, "image/") {
				continue
			}
			hash, err := e.storeImage(b.Data)
			if err != nil {
				return messages, false, err
			}
			if !copied {
				out = slices.Clone(messages)
				copied = true
			}
			if !blockCopy {
				blocks = slices.Clone(m.Content)
				blockCopy = true
			}
			blocks[j].Data, blocks[j].ImageRef = "", hash
			out[i].Content = blocks
		}
	}
	return out, copied, nil
}

// Normalize legacy records on load and new tool images before persistence. Files
// are published first: a failed database write leaves original evidence intact.
func (e *Engine) storeHistoryImages(loading bool) error {
	if loading {
		for _, c := range e.w.Chats {
			for i := range c.Messages {
				if !hasInlineImage(c.Messages[i].Images) {
					continue
				}
				images, err := e.storeImages(c.Messages[i].Images)
				if err != nil {
					return err
				}
				c.Messages[i].Images = images
			}
			for i := range c.Queue {
				images, err := e.storeImages(c.Queue[i].Images)
				if err != nil {
					return err
				}
				c.Queue[i].Images = images
			}
		}
		for _, t := range e.w.Tasks {
			images, err := e.storeImages(t.Images)
			if err != nil {
				return err
			}
			t.Images = images
		}
	}
	for id, conv := range e.w.Conversations {
		if !loading && !e.dirty[id] {
			continue
		}
		stored, changed, err := e.storeMessageImages(conv)
		if err != nil {
			return err
		}
		if changed {
			e.w.Conversations[id] = stored
			e.dirty[id] = true
		}
	}
	return nil
}

func (e *Engine) resolveImages(ctx context.Context, messages []model.Message) ([]model.Message, error) {
	out := messages
	copied := false
	for i, m := range messages {
		blockCopy := false
		for j, b := range m.Content {
			if b.ImageRef == "" {
				continue
			}
			if err := ctx.Err(); err != nil {
				return nil, err
			}
			if b.Data != "" || (b.Type != enum.BlockImage && b.Type != enum.BlockToolResult) {
				return nil, model.Errorf(model.CodeInvalid, "找不到附件")
			}
			raw, err := e.readImage(b.ImageRef)
			if err != nil {
				return nil, err
			}
			if !copied {
				out = slices.Clone(messages)
				copied = true
			}
			if !blockCopy {
				out[i].Content = slices.Clone(m.Content)
				blockCopy = true
			}
			out[i].Content[j].Data = base64.StdEncoding.EncodeToString(raw)
			out[i].Content[j].ImageRef = ""
		}
	}
	return out, nil
}

func hasInlineImage(images []model.Attachment) bool {
	for _, img := range images {
		if strings.HasPrefix(img.URL, "data:image/") {
			return true
		}
	}
	return false
}
