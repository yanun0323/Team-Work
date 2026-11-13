package semantic

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

const (
	// Revision is EmbeddingGemma-2-CoreAI v1.2. main has moved on since, so only this commit is ever downloaded.
	Revision = "ae7b263853425a991f3ed7472298f10cc97ec40f"
	// manifestSHA256 pins CHECKSUMS.sha256 at Revision, which in turn pins every file below.
	manifestSHA256 = "b3090ae71ead0441b4c03670e3ee62f12897952be2b90836d91fc5e2e1ead9cd"
	// TokenizerSHA256 is model/tokenizer/tokenizer.json at Revision; it is part of every vector's key.
	TokenizerSHA256 = "4d777ef5bdc1aa36227abdfb77c3e49e7b9c892d16e1b6bda41c393504828be4"
	modelBase       = "https://huggingface.co/EverPaper/embeddinggemma-2-coreai/resolve/" + Revision + "/"
)

// assets are the text model and what it needs: config, tokenizer, license and attribution, and the reference data
// the correctness check runs. The image and audio models are never downloaded.
var assets = []string{
	"LICENSE", "NOTICE", "model/MODEL-ATTRIBUTION.json", "model/config.json",
	"model/tokenizer/tokenizer.json", "model/tokenizer/tokenizer_config.json",
	"model/embeddinggemma-2-text-mm.aimodel/main.hash", "model/embeddinggemma-2-text-mm.aimodel/metadata.json",
	"model/embeddinggemma-2-text-mm.aimodel/main.mlirb",
	"tests/smoke-reference.json", "tests/tokenizer-cases.json",
}

// downloadError says which stage failed, for the status and the log.
type downloadError struct {
	code, stage, file string
	err               error
}

func (e *downloadError) Error() string { return fmt.Sprintf("%s %s: %v", e.stage, e.file, e.err) }
func (e *downloadError) Unwrap() error { return e.err }

// progressFunc hears how far a download has come; total is -1 while unknown.
type progressFunc func(done, total int64, files, totalFiles int)

// fetcher downloads the model once into dir/<Revision>, checking every file, and says where it is.
type fetcher struct {
	base   string
	client *http.Client
	dir    string
	log    *logger
	// pin is the SHA-256 CHECKSUMS.sha256 must have; manifestSHA256 unless a test serves its own files.
	pin string
}

func (f *fetcher) ready() string {
	final := filepath.Join(f.dir, Revision)
	if _, err := os.Stat(filepath.Join(final, ".verified")); err == nil {
		return final
	}
	return ""
}

// fetch returns the folder of the verified model, downloading what is missing into a partial folder first: a
// half-written or wrong file is never where the helper loads from.
func (f *fetcher) fetch(ctx context.Context, progress progressFunc) (string, error) {
	if dir := f.ready(); dir != "" {
		f.log.info("semantic_download").Str("result", "cached").Str("revision", Revision).Send()
		return dir, nil
	}
	start := time.Now()
	partial := filepath.Join(f.dir, Revision+".partial")
	if err := os.MkdirAll(partial, 0o755); err != nil {
		return "", &downloadError{"download_failed", "download", "", err}
	}
	manifest, err := f.get(ctx, "CHECKSUMS.sha256", 1<<20, nil)
	if err != nil {
		return "", &downloadError{"download_failed", "download", "CHECKSUMS.sha256", err}
	}
	if sum := sha256.Sum256(manifest); hex.EncodeToString(sum[:]) != f.pin {
		f.log.warn("semantic_checksum").Str("file", "CHECKSUMS.sha256").Bool("ok", false).Send()
		return "", &downloadError{"checksum_mismatch", "verify", "CHECKSUMS.sha256", errors.New("checksum does not match")}
	}
	f.log.info("semantic_checksum").Str("file", "CHECKSUMS.sha256").Bool("ok", true).Send()
	sums := parseSums(manifest)
	var total int64
	known := true
	sizes := map[string]int64{}
	for _, name := range assets {
		if sums[name] == "" {
			return "", &downloadError{"checksum_mismatch", "verify", name, errors.New("not in CHECKSUMS.sha256")}
		}
		size, err := f.size(ctx, name)
		if err != nil || size < 0 {
			known = false
		}
		sizes[name] = size
		total += size
	}
	if !known {
		total = -1
	}
	var done int64
	for i, name := range assets {
		path := filepath.Join(partial, filepath.FromSlash(name))
		if hashFile(path) == sums[name] { // kept from an earlier try
			done += sizes[name]
			progress(done, total, i+1, len(assets))
			continue
		}
		fileStart := time.Now()
		base := done
		if err := f.save(ctx, name, path, func(n int64) { progress(base+n, total, i, len(assets)) }); err != nil {
			code := "download_failed"
			return "", &downloadError{code, "download", name, err}
		}
		ok := hashFile(path) == sums[name]
		ev := f.log.info("semantic_checksum")
		if !ok {
			ev = f.log.warn("semantic_checksum")
		}
		ev.Str("file", name).Bool("ok", ok).Send()
		if !ok {
			_ = os.Remove(path)
			return "", &downloadError{"checksum_mismatch", "verify", name, errors.New("checksum does not match")}
		}
		info, _ := os.Stat(path)
		if info != nil {
			done = base + info.Size()
		}
		progress(done, total, i+1, len(assets))
		f.log.info("semantic_download").Str("file", name).Int64("bytes", sizeOf(info)).Int64("doneBytes", done).Int64("totalBytes", total).Int64("ms", time.Since(fileStart).Milliseconds()).Send()
	}
	if err := os.WriteFile(filepath.Join(partial, ".verified"), []byte(Revision+"\n"), 0o644); err != nil {
		return "", &downloadError{"download_failed", "download", "", err}
	}
	final := filepath.Join(f.dir, Revision)
	_ = os.RemoveAll(final)
	if err := os.Rename(partial, final); err != nil {
		return "", &downloadError{"download_failed", "download", "", err}
	}
	f.log.info("semantic_download").Str("result", "done").Int64("bytes", done).Int64("ms", time.Since(start).Milliseconds()).Send()
	return final, nil
}

func sizeOf(info os.FileInfo) int64 {
	if info == nil {
		return 0
	}
	return info.Size()
}

func (f *fetcher) request(ctx context.Context, method, name string) (*http.Response, error) {
	req, err := http.NewRequestWithContext(ctx, method, f.base+name, nil)
	if err != nil {
		return nil, err
	}
	// Anonymous on purpose: no Hugging Face sign-in is ever sent.
	req.Header.Set("User-Agent", "Team-Work-semantic-search")
	resp, err := f.client.Do(req)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode != http.StatusOK {
		resp.Body.Close()
		return nil, fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	return resp, nil
}

func (f *fetcher) size(ctx context.Context, name string) (int64, error) {
	resp, err := f.request(ctx, http.MethodHead, name)
	if err != nil {
		return -1, err
	}
	resp.Body.Close()
	return resp.ContentLength, nil
}

func (f *fetcher) get(ctx context.Context, name string, limit int64, _ func(int64)) ([]byte, error) {
	resp, err := f.request(ctx, http.MethodGet, name)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, limit+1))
	if err == nil && int64(len(data)) > limit {
		err = errors.New("too large")
	}
	return data, err
}

func (f *fetcher) save(ctx context.Context, name, path string, progress func(int64)) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	resp, err := f.request(ctx, http.MethodGet, name)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	tmp := path + ".tmp"
	file, err := os.Create(tmp)
	if err != nil {
		return err
	}
	w := &counter{w: file, report: progress, last: time.Now()}
	_, err = io.Copy(w, resp.Body)
	if cerr := file.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		_ = os.Remove(tmp)
		return err
	}
	return os.Rename(tmp, path)
}

type counter struct {
	w      io.Writer
	n      int64
	report func(int64)
	last   time.Time
}

func (c *counter) Write(p []byte) (int, error) {
	n, err := c.w.Write(p)
	c.n += int64(n)
	if time.Since(c.last) > 200*time.Millisecond {
		c.last = time.Now()
		c.report(c.n)
	}
	return n, err
}

func parseSums(manifest []byte) map[string]string {
	sums := map[string]string{}
	s := bufio.NewScanner(bytes.NewReader(manifest))
	for s.Scan() {
		sum, name, ok := strings.Cut(strings.TrimSpace(s.Text()), "  ")
		if ok && len(sum) == 64 {
			sums[strings.TrimPrefix(name, "*")] = sum
		}
	}
	return sums
}

func hashFile(path string) string {
	f, err := os.Open(path)
	if err != nil {
		return ""
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return ""
	}
	return hex.EncodeToString(h.Sum(nil))
}
