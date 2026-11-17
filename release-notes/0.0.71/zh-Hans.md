## 新功能

**员工可以用 MCP 工具**
把 MCP 服务器写进 `~/.team-work/mcp.json`，格式和 Claude Code、Cursor 一样，能执行命令的员工就拿得到它们的工具。帮助页有写法。

**员工工作时执行你自己的命令**
`~/.team-work/hooks.json` 照 Claude Code 的 hooks 格式，在收到消息、调用工具这类时机执行你的命令。命令也可以拦下一次工具调用，并告诉员工原因。

## 修正

**会议对话的 token 数回来了**
人多的会议会把对话列表上的 token 数挤出那一行。现在它会固定在角落。
