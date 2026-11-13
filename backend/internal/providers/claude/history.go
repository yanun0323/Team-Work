package claude

import (
	"crypto/rand"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"syscall"
	"time"
	"unicode/utf16"

	"golang.org/x/text/unicode/norm"
)

func newID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic(err)
	}
	b[6] = (b[6] & 15) | 64
	b[8] = (b[8] & 63) | 128
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[:4], b[4:6], b[6:8], b[8:10], b[10:])
}

type historyMessage struct {
	Role    string   `json:"role"`
	Content []object `json:"content"`
}

func blocksFor(blocks []Block) ([]object, error) {
	out := []object{}
	for _, b := range blocks {
		switch b.Type {
		case "text":
			if b.Text != "" {
				out = append(out, object{"type": "text", "text": b.Text})
			}
		case "thinking":
			if b.Text != "" {
				out = append(out, object{"type": "text", "text": "[Earlier reasoning]\n" + b.Text})
			}
		case "reasoning":
			var raw object
			if json.Unmarshal(b.Raw, &raw) != nil || (raw["type"] != "thinking" && raw["type"] != "redacted_thinking") {
				return nil, rejected("Unsupported conversation block.")
			}
			out = append(out, raw)
		case "image":
			out = append(out, object{"type": "image", "source": object{"type": "base64", "media_type": b.MimeType, "data": b.Data}})
		case "tool_call":
			args := b.Args
			if len(args) == 0 {
				args = json.RawMessage(`{}`)
			}
			out = append(out, object{"type": "tool_use", "id": b.ID, "name": toolPrefix + b.Name, "input": args})
		default:
			return nil, rejected("Unsupported conversation block.")
		}
	}
	return out, nil
}
func messagesFor(messages []ModelMessage) ([]historyMessage, error) {
	out := []historyMessage{}
	for _, m := range messages {
		if m.Role != "user" && m.Role != "assistant" && m.Role != "tool" {
			return nil, rejected("Invalid conversation message.")
		}
		blocks, err := blocksFor(m.Content)
		if err != nil {
			return nil, err
		}
		role := m.Role
		if role == "tool" {
			if m.CallID == "" {
				return nil, rejected("Tool results need a call ID.")
			}
			role = "user"
			blocks = []object{{"type": "tool_result", "tool_use_id": m.CallID, "content": blocks, "is_error": m.IsError}}
		}
		if len(blocks) == 0 {
			continue
		}
		if len(out) > 0 && out[len(out)-1].Role == role {
			out[len(out)-1].Content = append(out[len(out)-1].Content, blocks...)
		} else {
			out = append(out, historyMessage{role, blocks})
		}
	}
	return out, nil
}

// configDir is Team Work's own Claude Code configuration folder, set once at startup by UseConfigDir. Its sign-in,
// settings and saved conversations are apart from the user's ~/.claude.
var configDir string

// UseConfigDir makes every Claude Code process use dir as its configuration folder. Claude keys the macOS keychain
// sign-in to the folder's path, so the path is made absolute and resolved once and then never changes.
func UseConfigDir(dir string) error {
	if !filepath.IsAbs(dir) {
		return fmt.Errorf("claude config folder must be an absolute path")
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	resolved, err := filepath.EvalSymlinks(dir)
	if err != nil {
		return err
	}
	configDir = filepath.Clean(resolved)
	return nil
}

func claudeDir() string {
	if configDir != "" {
		return configDir
	}
	if dir := os.Getenv("CLAUDE_CONFIG_DIR"); dir != "" {
		return dir
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".claude")
}

// Match Claude's UTF-16 project-directory naming, including long and Unicode paths.
func projectHash(cwd string) string {
	units := utf16.Encode([]rune(norm.NFC.String(cwd)))
	sanitized := make([]byte, len(units))
	var hash int32
	for i, c := range units {
		hash = 31*hash + int32(c)
		if c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' {
			sanitized[i] = byte(c)
		} else {
			sanitized[i] = '-'
		}
	}
	if len(sanitized) <= 200 {
		return string(sanitized)
	}
	n := int64(hash)
	if n < 0 {
		n = -n
	}
	return string(sanitized[:200]) + "-" + strconv.FormatInt(n, 36)
}
func mirrorPath(dir, cwd, id string) string {
	return filepath.Join(dir, "projects", projectHash(cwd), id+".jsonl")
}

type mirror struct {
	prompt               []object
	resume, path, marker string
}

func (m *mirror) cleanup() {
	if m.path != "" {
		_ = os.Remove(m.path)
	}
	if m.marker != "" {
		_ = os.Remove(m.marker)
	}
}

func makeMirror(p CompleteParams) (_ *mirror, err error) {
	messages, err := messagesFor(p.Messages)
	if err != nil {
		return nil, err
	}
	if len(messages) == 0 {
		return nil, rejected("The conversation is empty.")
	}
	m := &mirror{prompt: []object{{"type": "text", "text": "Continue from the conversation above. Tool results have already been supplied; do not repeat completed actions."}}}
	last := messages[len(messages)-1]
	plain := last.Role == "user"
	for _, b := range last.Content {
		if b["type"] == "tool_result" {
			plain = false
		}
	}
	if plain {
		m.prompt = last.Content
		messages = messages[:len(messages)-1]
	}
	if len(messages) == 0 {
		return m, nil
	}
	m.resume = newID()
	dir := claudeDir()
	markerDir := filepath.Join(dir, "mho-company-owned")
	if err = os.MkdirAll(markerDir, 0700); err != nil {
		return nil, err
	}
	marker := filepath.Join(markerDir, m.resume+".json")
	// Exclusive creation establishes ownership; cleanup never removes a pre-existing file.
	f, err := os.OpenFile(marker, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return nil, err
	}
	m.marker = marker
	defer func() {
		if err != nil {
			m.cleanup()
		}
	}()
	err = json.NewEncoder(f).Encode(object{"pid": os.Getpid(), "cwd": p.Cwd})
	closeErr := f.Close()
	if err != nil {
		return nil, err
	}
	if closeErr != nil {
		return nil, closeErr
	}
	path := mirrorPath(dir, p.Cwd, m.resume)
	if err = os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return nil, err
	}
	f, err = os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return nil, err
	}
	m.path = path
	defer f.Close()
	var parent any
	enc := json.NewEncoder(f)
	for i, msg := range repairPairing(messages) {
		id := newID()
		body := object{"role": msg.Role, "content": msg.Content}
		record := object{"type": msg.Role, "uuid": id, "parentUuid": parent, "sessionId": m.resume, "timestamp": time.Now().Add(time.Duration(i) * time.Millisecond).UTC().Format(time.RFC3339Nano), "isSidechain": false, "cwd": p.Cwd, "userType": "external", "version": "2.1.83", "gitBranch": "HEAD", "slug": "mho-company-import", "entrypoint": "cli", "message": body}
		if msg.Role == "assistant" {
			stop := "end_turn"
			for _, b := range msg.Content {
				if b["type"] == "tool_use" {
					stop = "tool_use"
				}
			}
			body["id"] = "msg_syn_" + strings.ReplaceAll(newID(), "-", "")
			body["type"] = "message"
			body["model"] = p.Model
			body["stop_reason"] = stop
			body["stop_sequence"] = nil
			body["usage"] = object{"input_tokens": 0, "output_tokens": 0}
			record["requestId"] = "req_syn_" + strings.ReplaceAll(newID(), "-", "")
		}
		if err = enc.Encode(record); err != nil {
			return nil, err
		}
		parent = id
	}
	if err = f.Close(); err != nil {
		return nil, err
	}
	return m, nil
}

// Missing results are explicitly failed, never presented as executed actions.
func repairPairing(messages []historyMessage) []historyMessage {
	out := []historyMessage{}
	pending := []string{}
	missing := func(provided map[string]bool) []object {
		blocks := []object{}
		for _, id := range pending {
			if !provided[id] {
				blocks = append(blocks, object{"type": "tool_result", "tool_use_id": id, "content": "[no tool result recorded]", "is_error": true})
			}
		}
		return blocks
	}
	for _, m := range messages {
		if m.Role == "assistant" {
			if b := missing(nil); len(b) > 0 {
				out = append(out, historyMessage{"user", b})
			}
			pending = nil
			for _, b := range m.Content {
				if b["type"] == "tool_use" {
					id, _ := b["id"].(string)
					pending = append(pending, id)
				}
			}
			out = append(out, m)
			continue
		}
		provided := map[string]bool{}
		blocks := []object{}
		for _, b := range m.Content {
			if b["type"] != "tool_result" {
				blocks = append(blocks, b)
				continue
			}
			id, _ := b["tool_use_id"].(string)
			for _, want := range pending {
				if id == want && !provided[id] {
					blocks = append(blocks, b)
					provided[id] = true
					break
				}
			}
		}
		blocks = append(missing(provided), blocks...)
		pending = nil
		if len(blocks) > 0 {
			out = append(out, historyMessage{"user", blocks})
		} else if len(out) == 0 {
			out = append(out, historyMessage{"user", []object{{"type": "text", "text": "[orphaned tool result removed]"}}})
		}
	}
	if b := missing(nil); len(b) > 0 {
		out = append(out, historyMessage{"user", b})
	}
	return out
}

var markerName = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json$`)

func sweepMirrors() error {
	dir := claudeDir()
	markers := filepath.Join(dir, "mho-company-owned")
	entries, err := os.ReadDir(markers)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return err
	}
	for _, entry := range entries {
		if entry.Type()&os.ModeSymlink != 0 || entry.IsDir() || !markerName.MatchString(entry.Name()) {
			continue
		}
		raw, err := os.ReadFile(filepath.Join(markers, entry.Name()))
		if err != nil {
			continue
		}
		var m struct {
			PID int    `json:"pid"`
			Cwd string `json:"cwd"`
		}
		if json.Unmarshal(raw, &m) != nil || m.PID <= 0 || !filepath.IsAbs(m.Cwd) {
			continue
		}
		if syscall.Kill(m.PID, 0) != syscall.ESRCH {
			continue
		}
		path := mirrorPath(dir, m.Cwd, strings.TrimSuffix(entry.Name(), ".json"))
		if err = os.Remove(path); err != nil && !os.IsNotExist(err) {
			continue
		}
		if err = os.Remove(filepath.Join(markers, entry.Name())); err != nil && !os.IsNotExist(err) {
			return err
		}
	}
	return nil
}

func osHome() (string, error) { return os.UserHomeDir() }
