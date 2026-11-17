## 新功能

**員工可以用 MCP 工具**
把 MCP 伺服器寫進 `~/.team-work/mcp.json`，格式和 Claude Code、Cursor 一樣，能執行指令的員工就拿得到它們的工具。說明頁有寫法。

**員工工作時執行你自己的指令**
`~/.team-work/hooks.json` 照 Claude Code 的 hooks 格式，在收到訊息、呼叫工具這類時機執行你的指令。指令也可以擋下一次工具呼叫，並告訴員工原因。

## 修正

**會議對話的 token 數回來了**
人多的會議會把對話列表上的 token 數擠出那一列。現在它會固定在角落。
