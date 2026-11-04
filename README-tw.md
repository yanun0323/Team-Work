<p align="center">
  <a href="."><img height="160" src="./macos/AppIcon.iconset/icon_512x512.png" alt="Team Work"></a>
</p>

<p align="center">
  <a href="README.md"><img src="https://img.shields.io/badge/English-Click-yellow" alt="English"></a>
  <a href="README-tw.md"><img src="https://img.shields.io/badge/繁體中文-點擊查看-orange" alt="繁體中文"></a>
  <a href="README-cn.md"><img src="https://img.shields.io/badge/简体中文-点击查看-orange" alt="简体中文"></a>
  <a href="README-ja.md"><img src="https://img.shields.io/badge/日本語-クリック-blue" alt="日本語"></a>
  <a href="README-ko.md"><img src="https://img.shields.io/badge/한국어-클릭-yellow" alt="한국어"></a>
</p>

# Team Work

Team Work 是一個 macOS App，讓一群 AI Agent 在你自己的專案裡工作。每個專案是像素風小島上的一間公司，公司的員工是 AI Agent，他們照著任務藍圖一步步完成工作，每個任務都在自己的 Git 分支上進行，最後由你審核並合併。

![打開一間公司：左邊是辦公室，右邊是任務看板](./frontend/src/help/zh/company.jpg)

## 功能

- **公司**：一個專案資料夾和一個目標分支就是一間公司。公司完成越多任務、員工越多，大樓就長得越大。
- **員工**：由藍圖（Prompt、技能和允許的工具）產生，每位員工各自選模型和思考等級。也可以不用藍圖，替員工自訂 Prompt、技能和工具，或複製藍圖後再微調。內建 16 個藍圖，例如後端工程師、程式審查員、技術文件寫手。
- **任務藍圖**：任務要經過的步驟，從「整理需求」開始、以「驗收」結束。中間的步驟可以交給員工執行工作，或和你討論。內建 6 條任務藍圖，例如功能開發、修 Bug、重構。
- **任務**：每個任務在自己的 Git work tree 和 `task/編號` 分支上進行。員工有問題時任務會等你回覆；驗收通過後，由你合併回目標分支或退回重做。
- **對話**：在專案資料夾裡和員工聊天。輸入 `$` 選技能，輸入 `#` 提及檔案。選多位員工或用 `@` 提及員工，就能開會。
- **模型供應商**：Anthropic、OpenAI、Google Gemini 和任何 OpenAI 相容 API，也可以用 Claude 或 ChatGPT 訂閱登入。
- **技能**：藍圖可以從本機資料夾或 GitHub repo 載入技能。
- **終端機**：每間公司都有一個開在專案資料夾的 zsh 終端機。
- **語言**：繁體中文和英文。

## 安裝

1. 從 [Releases](https://github.com/yanun0323/Team-Work/releases) 下載 `Team-Work-macOS.zip`。
2. 解壓縮後，把 `Team Work.app` 移到「應用程式」資料夾。

需要 macOS 12 以上，支援 Apple Silicon 和 Intel。任務需要 Git，專案資料夾也必須是 Git repo。

## 開始使用

1. 在「機場 → 模型供應商」至少新增一個供應商，員工才有模型可用。
2. 按「＋ 新公司」，在地圖上選位置，再填專案位置、名稱和目標分支。
3. 在公司的「員工」頁籤新增員工：選一個藍圖和模型。
4. 在「任務」頁籤建立任務：寫下要做的事、選任務藍圖，再為每一步選員工。
5. 打開任務看「進度」，有紅色驚嘆號的步驟正在等你回覆。

右上角的問號會打開完整的使用說明。

## 資料與安全

- 資料存在 `~/.team-work`。要改用其他資料夾，把 `TEAM_WORK_HOME` 設成絕對路徑。
- API Key 和登入憑證存在 `data.db`，檔案權限是 `0600`，沒有加密。
- 執行指令沒有沙盒，只在信任的藍圖裡允許「執行指令」工具。

## 從原始碼建置

需要 Go（版本見 `backend/go.mod`）、Node.js 和 npm，以及 Xcode 命令列工具。

```sh
make dev           # 同時啟動後端和前端，開在 http://localhost:5173
make dev-mock      # 只啟動前端，使用模擬資料
make test-backend  # 後端測試
make build         # 建置 dist/Team Work.app（未簽署）
```

執行 `make help` 可列出所有指令。更多細節見[後端說明](backend/README.md)和[前端說明](frontend/README.md)。

## 授權

[Apache License 2.0](LICENSE)
