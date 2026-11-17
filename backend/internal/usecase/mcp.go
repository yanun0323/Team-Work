package usecase

import (
	"context"
	"encoding/json"
	"slices"
	"strconv"
	"strings"

	"github.com/yanun0323/Team-Work/internal/adapter"
	"github.com/yanun0323/Team-Work/internal/mcp"
	"github.com/yanun0323/Team-Work/internal/model"
	"github.com/yanun0323/Team-Work/internal/model/enum"
)

// mcpTool is a tool of an MCP server, run on the server.
type mcpTool struct {
	hub  *mcp.Hub
	tool mcp.Tool
	spec model.ToolSpec
}

func (t mcpTool) Spec() model.ToolSpec { return t.spec }

func (t mcpTool) Run(ctx context.Context, _ string, args json.RawMessage) model.ToolResult {
	return t.hub.Call(ctx, t.tool, args)
}

// ReadOnly is the server's word that the tool changes nothing, so a script's calls to it run side by side.
func (t mcpTool) ReadOnly() bool { return t.tool.ReadOnly }

// mcpSet is what the MCP servers offer a run.
type mcpSet struct {
	// direct are offered like any tool; scripts are called from exec scripts, which the run then has whatever the
	// script tool's setting.
	direct, scripts []adapter.Tool
	// about lists the servers whose tools only scripts call, for exec's description.
	about string
}

// mcpTools are the MCP servers' tools for a run whose blueprint lets it run commands: a server's tools reach as far
// as a command could. What keeps a server out is told
// through notice. Call it not holding the lock: it may wait on servers starting.
func (e *Engine) mcpTools(ctx context.Context, allowed []enum.Tool, notice func(string)) mcpSet {
	if !slices.Contains(allowed, enum.ToolRunCommand) {
		return mcpSet{}
	}
	l := e.mcp.Tools(ctx)
	if notice != nil {
		for _, p := range l.Problems {
			notice(p)
		}
	}
	var set mcpSet
	scripted := map[string]int{}
	for _, t := range l.Tools {
		spec := model.ToolSpec{Name: t.Name, Description: t.Description, Parameters: t.Schema}
		if t.Exposure == mcp.Script {
			// a script reads what to pass from ALL_TOOLS, which has only the description
			spec.Description += "\n\nArguments (JSON Schema): " + string(t.Schema)
			set.scripts = append(set.scripts, mcpTool{e.mcp, t, spec})
			scripted[t.Server]++
			continue
		}
		set.direct = append(set.direct, mcpTool{e.mcp, t, spec})
	}
	var lines []string
	for _, s := range l.Servers {
		if n := scripted[s.Name]; n > 0 {
			// a server's name has only letters, digits, _ and -, and its tools' names turn - into _
			line := "- " + s.Name + " (" + strconv.Itoa(n) + " tools, named mcp__" + strings.ReplaceAll(s.Name, "-", "_") + "__…)"
			if s.About != "" {
				line += ": " + s.About
			}
			lines = append(lines, line)
		}
	}
	if len(lines) > 0 {
		set.about = "\n\nMCP servers whose tools only scripts call; ALL_TOOLS gives each one's description and arguments:\n" + strings.Join(lines, "\n")
	}
	return set
}
