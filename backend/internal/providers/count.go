package providers

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"strings"

	"github.com/yanun0323/Team-Work/internal/model"
	"github.com/yanun0323/Team-Work/internal/model/enum"
	"github.com/yanun0323/Team-Work/internal/providers/codex"
)

// countImageWords is the rough worth a picture holds in a request counted at an endpoint that cannot price one:
// the same share the conversation's rough measure gives it, so a chat heavy with pictures is never called short
// because a counting answer left them out. Keep it the worth usecase counts a picture at.
const countImageWords = 1_500

// CountTokens asks OpenAI what a request would send, without running it. The endpoint takes the same input the
// reply call would, the system message among it, and answers with one number.
// https://platform.openai.com/docs/api-reference/responses/input-tokens
func (o openAIResponses) CountTokens(ctx context.Context, req model.ModelRequest) (int, bool, error) {
	body := codex.Request(req, "openai:"+req.Model, reasons(req.Model))
	// what a reply call streams, stores or caches says nothing to a count, and the counting endpoint takes only
	// the request's words: these fields are not in its parameters
	for _, drop := range []string{"stream", "store", "include", "prompt_cache_key"} {
		delete(body, drop)
	}
	res, err := o.do(ctx, http.MethodPost, "/responses/input_tokens", body, o.auth)
	if err != nil {
		return 0, false, err
	}
	defer res.Body.Close()
	n, err := readCount(res.Body, "input_tokens")
	return n, true, err
}

// CountTokens asks a self-hosted server to tokenize what the next request carries, and says that the number
// counts only the request's words: what the server wraps them in, its chat template with the roles and the
// separators, is not counted, and a picture goes at the rough share since this endpoint sees only text. The
// number is a floor the caller may count up to, not under. A server with no such endpoint answers 404 and is
// left unasked for a while; the conversation is counted the rough way meanwhile. The model is named, so a
// router counts with its vocabulary and not another one's.
// https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md
func (o openAI) CountTokens(ctx context.Context, req model.ModelRequest) (int, bool, error) {
	if !o.askServer {
		return 0, false, model.Errorf(model.CodeUnavailable, "這個供應商的計數要用它自己的端點")
	}
	root := o.serverBase()
	if root == "" {
		return 0, false, model.Errorf(model.CodeInvalid, "供應商位址不正確")
	}
	n, ok := o.tokenizeCount(ctx, root, req.Model, countableText(req, chatOrigin(o.base, req.Model)))
	if !ok {
		return 0, false, model.Errorf(model.CodeUnavailable, "計數回覆沒有可用的數")
	}
	return n + roughImages(req.Messages), false, nil
}

// serverBase is where a self-hosted server's own endpoints sit beside its OpenAI-compatible API: the address set
// for the provider with only the /v1 that ends its path taken off, so a server proxied under a path prefix is
// asked at the same prefix and not at the host's root. The prefix is kept as it was written, an escaped one
// keeping its escaping, since a proxy does not promise /team%2Fa and /team/a to be the same service. A query
// or fragment says nothing about where the endpoints are - /team?route=/v1 does not end in /v1, whatever its
// tail says - and neither does a path that stops anywhere else; counting is given up rather than sent to a
// stranger on the host.
func (o openAI) serverBase() string {
	u, err := url.Parse(o.base)
	if err != nil || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return ""
	}
	path := strings.TrimRight(u.EscapedPath(), "/")
	if !strings.HasSuffix(path, "/v1") {
		return ""
	}
	return u.Scheme + "://" + u.Host + strings.TrimSuffix(path, "/v1")
}

// tokenizeCount counts one text at a server's /tokenize, and says whether it answered with token ids.
func (o openAI) tokenizeCount(ctx context.Context, root, modelID, text string) (int, bool) {
	ask := map[string]any{"model": modelID, "content": text, "add_special": false}
	res, err := client{base: root, key: o.key, http: o.http}.do(ctx, http.MethodPost, "/tokenize", ask, o.auth)
	if err != nil {
		return 0, false // a refused or unreachable endpoint: the rough way a 404 already takes
	}
	defer res.Body.Close()
	n, err := countTokenIDs(res.Body)
	return n, err == nil && n > 0
}

// countTokenIDs reads a /tokenize answer as it arrives and counts its token ids: the document is exactly
// {"tokens":[0,1,2]}, every item a plain number. A big conversation tokenizes to hundreds of thousands of ids,
// well past a megabyte of JSON, so the answer is walked item by item and never held whole in memory. Anything
// else - a quoted number among the ids, a null, a fraction, a second document, a stray character at the end -
// makes the whole answer unusable, since a count of part of it must not stand in for the safe estimate.
func countTokenIDs(body io.Reader) (int, error) {
	bad := model.Errorf(model.CodeUnavailable, "計數回覆格式不正確")
	dec := json.NewDecoder(body)
	dec.UseNumber() // an item then tells a number from a quoted one by its own kind
	want := func(brace rune) error {
		if got, err := dec.Token(); err != nil || got != json.Delim(brace) {
			return bad
		}
		return nil
	}
	if err := want('{'); err != nil {
		return 0, err
	}
	out := 0
	for dec.More() {
		key, err := dec.Token() // a document's key comes whole, ahead of its value
		if err != nil {
			return 0, bad
		}
		if name, ok := key.(string); !ok || name != "tokens" {
			if err := dec.Decode(new(json.RawMessage)); err != nil { // a field besides the tokens is small
				return 0, bad // beside them: read past it unread
			}
			continue
		}
		if err := want('['); err != nil {
			return 0, err
		}
		for dec.More() {
			item, err := dec.Token()
			if err != nil {
				return 0, bad
			}
			id, ok := item.(json.Number) // null answers as nil, a quoted number as a string, an object as a brace
			if !ok {
				return 0, bad
			}
			for _, d := range id.String() { // digits only: 1.5, 1e3 and -1 are not how ids come
				if d < '0' || d > '9' {
					return 0, bad
				}
			}
			if len(id) > 1 && id[0] == '0' { // 007 is not either
				return 0, bad
			}
			out++
		}
		if err := want(']'); err != nil { // the bracket that closes the array
			return 0, err
		}
	}
	if err := want('}'); err != nil { // and the document with it
		return 0, err
	}
	if _, err := dec.Token(); !errors.Is(err, io.EOF) { // nothing after the one document
		return 0, bad
	}
	return out, nil
}

// countableText is what a Chat Completions request puts before the model, as one string: the instructions, the
// tools, and the words and arguments that really go out, in the shape chatMessages sends them. Reasoning is
// left out as the endpoint never sees it, and a raw item only travels with its own call of this model at this
// address, exactly as in the request. A picture goes as a blank space: its worth comes from roughImages, not
// from the base64 the wire carries.
func countableText(req model.ModelRequest, origin string) string {
	var b strings.Builder
	b.WriteString(req.System)
	for _, t := range req.Tools {
		b.WriteString(t.Name)
		b.WriteString(t.Description)
		b.WriteString(string(t.Parameters))
	}
	for _, m := range req.Messages {
		for _, blk := range m.Content {
			switch blk.Type {
			case enum.BlockText:
				b.WriteString(blk.Text)
			case enum.BlockToolCall:
				b.WriteString(blk.Name)
				b.WriteString(string(blk.Args))
				if m.Role == enum.RoleAssistant && blk.Origin == origin && len(blk.Raw) > 0 {
					b.WriteString(string(blk.Raw))
				}
			case enum.BlockToolResult:
				b.WriteString(blk.Text)
			case enum.BlockImage:
				b.WriteString(" ")
			}
			if blk.Type != enum.BlockImage && blk.Data != "" {
				b.WriteString(" ")
			}
		}
	}
	return b.String()
}

// roughImages is what the pictures a request carries are held at where no endpoint can price one, the same
// worth the conversation's rough measure gives them.
func roughImages(conv []model.Message) int {
	n := 0
	for _, m := range conv {
		for _, b := range m.Content {
			if b.Type == enum.BlockImage || b.Data != "" || b.ImageRef != "" {
				n += countImageWords
			}
		}
	}
	return n
}

// readCount takes one number out of a counting reply.
func readCount(body io.Reader, field string) (int, error) {
	var doc map[string]json.RawMessage
	if json.NewDecoder(io.LimitReader(body, 1<<20)).Decode(&doc) != nil {
		return 0, model.Errorf(model.CodeUnavailable, "計數回覆格式不正確")
	}
	var n int
	if json.Unmarshal(doc[field], &n) != nil || n <= 0 {
		return 0, model.Errorf(model.CodeUnavailable, "計數回覆沒有可用的數")
	}
	return n, nil
}
