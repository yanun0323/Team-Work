package claude

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

// saved is what Team Work remembers of a conversation Claude Code saved itself, so that a later process can take
// it up with --resume and be sent only what is new. Claude keeps there what a transcript rebuilt by makeMirror
// lacks, such as the context it adds after the first message, so a resumed conversation starts the way Claude
// cached it. The record holds only fingerprints, never the conversation, and is good only between a finished turn
// and the next request: a request takes it, and a cleanly finished turn writes it again.
type saved struct {
	Session   string    `json:"session"`
	Cwd       string    `json:"cwd"`
	Signature string    `json:"signature"`
	Count     int       `json:"count"`
	Digest    string    `json:"digest"`
	Used      time.Time `json:"used"`
}

// keepSaved is how long a saved conversation is worth resuming. Claude's prompt cache lasts an hour after its last
// use; past that, resuming costs as much as rebuilding, so neither the record nor Claude's transcript is kept.
const keepSaved = time.Hour

var sessionID = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)

func savedDir() string { return filepath.Join(claudeDir(), "team-work-sessions") }
func savedPath(key string) string {
	sum := sha256.Sum256([]byte(key))
	return filepath.Join(savedDir(), hex.EncodeToString(sum[:])+".json")
}

// fingerprint stands for the settings a process was started with, which quote the instructions, in a record.
func fingerprint(signature string) string {
	sum := sha256.Sum256([]byte(signature))
	return hex.EncodeToString(sum[:])
}

// digest fingerprints a history the way sameJSON compares it: object key order does not count.
func digest(messages []ModelMessage) string {
	raw, _ := json.Marshal(messages)
	var v any
	_ = json.Unmarshal(raw, &v)
	raw, _ = json.Marshal(v)
	sum := sha256.Sum256(raw)
	return hex.EncodeToString(sum[:])
}

func readSaved(path string) *saved {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	var s saved
	if json.Unmarshal(raw, &s) != nil || !sessionID.MatchString(s.Session) || !filepath.IsAbs(s.Cwd) {
		return nil
	}
	return &s
}
func loadSaved(key string) *saved { return readSaved(savedPath(key)) }

func storeSaved(key string, s saved) error {
	if err := os.MkdirAll(savedDir(), 0o700); err != nil {
		return err
	}
	raw, _ := json.Marshal(s)
	f, err := os.CreateTemp(savedDir(), ".saving-*")
	if err != nil {
		return err
	}
	_, err = f.Write(raw)
	if closeErr := f.Close(); err == nil {
		err = closeErr
	}
	if err == nil {
		err = os.Rename(f.Name(), savedPath(key))
	}
	if err != nil {
		_ = os.Remove(f.Name())
	}
	return err
}

// removeTranscript removes a conversation Claude Code saved, with the folder it keeps beside it.
func removeTranscript(cwd, id string) {
	if !sessionID.MatchString(id) || cwd == "" {
		return
	}
	path := mirrorPath(claudeDir(), cwd, id)
	_ = os.Remove(path)
	_ = os.RemoveAll(strings.TrimSuffix(path, ".jsonl"))
}

// takeSaved removes the conversation's record and returns it when p can resume it in cwd; a record it cannot use
// goes with its transcript.
func takeSaved(key string, p CompleteParams, cwd string, now time.Time) *saved {
	s := resumable(key, p, cwd, now)
	old := loadSaved(key)
	_ = os.Remove(savedPath(key))
	if s == nil && old != nil {
		removeTranscript(old.Cwd, old.Session)
	}
	return s
}

// resumable returns the saved conversation p continues, or nil: same folder and settings, the history Claude
// holds unchanged, and nothing after it but new user messages.
func resumable(key string, p CompleteParams, cwd string, now time.Time) *saved {
	s := loadSaved(key)
	if s == nil || s.Cwd != cwd || s.Signature != fingerprint(signature(p)) || now.Sub(s.Used) > keepSaved || s.Count <= 0 ||
		len(p.Messages) <= s.Count || digest(p.Messages[:s.Count]) != s.Digest {
		return nil
	}
	for _, m := range p.Messages[s.Count:] {
		if m.Role != "user" {
			return nil
		}
	}
	if _, err := os.Stat(mirrorPath(claudeDir(), cwd, s.Session)); err != nil {
		return nil
	}
	return s
}

// sweepSaved drops the records, and their transcripts, that outlived Claude's cache or cannot be read.
func sweepSaved(now time.Time) {
	entries, err := os.ReadDir(savedDir())
	if err != nil {
		return
	}
	for _, entry := range entries {
		if entry.IsDir() || entry.Type()&os.ModeSymlink != 0 {
			continue
		}
		path := filepath.Join(savedDir(), entry.Name())
		if strings.HasPrefix(entry.Name(), ".saving-") {
			if info, err := entry.Info(); err == nil && now.Sub(info.ModTime()) > keepSaved {
				_ = os.Remove(path)
			}
			continue
		}
		s := readSaved(path)
		if s != nil && now.Sub(s.Used) <= keepSaved {
			continue
		}
		_ = os.Remove(path)
		if s != nil {
			removeTranscript(s.Cwd, s.Session)
		}
	}
}
