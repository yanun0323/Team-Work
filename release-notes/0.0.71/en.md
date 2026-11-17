## What's new

**Employees can use MCP tools**
List MCP servers in `~/.team-work/mcp.json`, in the same format Claude Code and Cursor use, and employees who can run commands get their tools. The help page shows how.

**Run your own commands while employees work**
`~/.team-work/hooks.json` runs your commands at moments like a new message or a tool call, in Claude Code's hooks format. A command can also stop a tool call and tell the employee why.

## Fixes

**Meeting chats show their token count again**
A meeting with many people pushed the token count off its row in the chat list. It now stays in the corner.
