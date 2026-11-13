package tools

import (
	"context"
	"encoding/json"
	"errors"

	"github.com/yanun0323/Team-Work/internal/model"
	"github.com/yanun0323/Team-Work/internal/semantic"
)

// SemanticSearch searches the working directory by meaning as well as by keyword. It comes with read_file while
// the experimental semantic search is on, and always searches the folder the run works in.
type SemanticSearch struct {
	Service       *semantic.Service
	Task, Replica string
}

func (SemanticSearch) Spec() model.ToolSpec {
	return model.ToolSpec{Name: "semantic_search", Description: "Find code and text in the working directory by meaning as well as by keyword, for when you do not know the exact words to grep for. Returns JSON: mode (hybrid, or keyword while the index is not ready, with the reason), pendingFiles not indexed yet, and results with path, startLine, endLine and the lines as they are now. It does not replace grep or read_file.",
		Parameters: json.RawMessage(`{"type":"object","properties":{"query":{"type":"string","description":"What you are looking for, in a sentence"},"limit":{"type":"integer","minimum":1,"maximum":20,"description":"Most results, 10 when omitted"}},"required":["query"]}`)}
}

func (t SemanticSearch) Run(ctx context.Context, cwd string, raw json.RawMessage) model.ToolResult {
	var args struct {
		Query string `json:"query"`
		Limit int    `json:"limit"`
	}
	if err := decode(raw, &args); err != nil {
		return fail("invalid arguments: %v", err)
	}
	res, err := t.Service.Search(ctx, semantic.Query{Cwd: cwd, Text: args.Query, Limit: args.Limit, Task: t.Task, Replica: t.Replica})
	var user *semantic.UserError
	switch {
	case errors.As(err, &user):
		return fail("%s", user.Error())
	case err != nil:
		return fail("semantic search failed; use grep")
	}
	out, _ := json.Marshal(res)
	return model.ToolResult{Text: string(out)}
}
