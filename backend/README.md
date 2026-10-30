# Team Work 後端

單人在本機使用的 Go 伺服器：管理公司、員工、任務流程與任務，並讓員工真的呼叫模型、改檔案、跑指令。任務流程規則與前端模擬器（`frontend/src/core/domain/sim.ts`）相同，名詞以 `CONTEXT.md` 為準。Agent 迴圈、工具、模型串流與訂閱登入參考 `mho` 的實作。

`make dev` 會同時啟動後端和前端，前端直接接這個 API；`make dev-mock` 的前端用模擬器，不需要後端。

```bash
make server        # 只啟動後端，聽 127.0.0.1:8787
make test-backend  # 測試
```

## 設定

| 環境變數 | 預設 | 說明 |
|---|---|---|
| `MHO_COMPANY_HOST` | `127.0.0.1` | 只能是本機位址，其他值會拒絕啟動 |
| `MHO_COMPANY_PORT` | `8787` | |
| `MHO_COMPANY_DATA_DIR` | `~/.mho-company` | 資料庫 `company.db`、work tree 與技能來源的快取 |
| `MHO_COMPANY_ALLOWED_ORIGINS` | `http://localhost:5173,http://127.0.0.1:5173` | 可以連 API 的網頁來源，逗號分隔 |
| `MHO_COMPANY_DEBUG` | `false` | 詳細 log |
| `MHO_CLAUDE_EXECUTABLE` | `claude` | Claude 訂閱使用的執行檔 |

## 安全

- API 沒有登入。所以只聽本機，並檢查 `Host` 與 `Origin`，別的網站不能透過使用者的瀏覽器連進來。
- API Key 和 ChatGPT Token 只存在 `company.db`（權限 `0600`）的 `secrets` 表，不會出現在任何回應或事件裡，API Key 對外只有最後 4 碼。
- `read_file`、`write_file` 限制在任務的 work tree 內（技能資料夾可讀），符號連結也擋。
- `run_command` **沒有沙盒**：員工能做到伺服器使用者能做的任何事。只雇用你信任其指示的藍圖，也留意任務內容與網頁可能夾帶指示。

## API

路徑前綴 `/api/v1`。錯誤一律是 `{"error":{"code","message"}}`，`code` 是 `invalid_request`（400）、`forbidden`（403）、`not_found`（404）、`conflict`（409）、`unavailable`（502）或 `internal`（500）。

| 方法與路徑 | 說明 |
|---|---|
| `GET /world` | 整個世界，欄位與前端 `types.ts` 相同 |
| `GET /events` | WebSocket：先送 `snapshot`，之後送 `patch`（實體異動）、`delta`（員工正在寫的文字）、`notice`（`review`、`awaitMerge`）。斷線重連會拿到新的 snapshot |
| `POST /teams`、`PATCH`/`DELETE /teams/:id` | 公司；資料夾沒有 git 時會初始化並建立 `master`。關閉公司不會刪資料夾，但會刪它的任務分支與 work tree |
| `GET /branches?folder=` | 查資料夾的分支（只讀），`repo` 是它是不是 git repo |
| `POST /teams/:id/prompt/refresh` | 重新讀專案的 `AGENTS.md`。公司的 `prompt` 就是這個檔案：`PATCH` 會寫回檔案（不會 commit），建立公司、啟動和員工開工時都會重新讀 |
| `POST /folder-picker` | 開系統的選擇資料夾視窗（目前只有 macOS），回傳完整路徑 `path`，取消時是空字串 |
| `POST /workflows`、`PUT`/`DELETE /workflows/:id`、`POST /workflows/:id/duplicate` | 任務流程，所有公司共用；不允許迴圈，至少留一條 |
| `POST /providers`、`PATCH`/`DELETE /providers/:id` | 模型供應商；模型清單由供應商提供，`prices` 是每百萬 token 的美元價格 |
| `POST /blueprints`、`PUT`/`DELETE /blueprints/:id`、`POST /blueprints/:id/update` | 藍圖；`update` 把 Git 來源移到最新版 |
| `POST /replicas`、`PATCH /replicas/:id`、`DELETE /replicas/:id?heir=` | 雇用、修改（含記憶）、離職交接 |
| `POST /tasks`、`PATCH`/`DELETE /tasks/:id` | 任務；`PATCH` 改標題、說明、人員、負責人 |
| `POST /tasks/:id/{pause,resume,cancel,merge}` | 暫停、恢復、取消（要先暫停）、合併 |
| `POST /tasks/:id/return`、`POST /tasks/:id/workflow` | 退回（`feedback`）、更換任務流程（`workflowId`，要先暫停） |
| `GET /subtasks/:id/file?path=` | 讀子任務交接的檔案（該次 commit 的內容，上限 1 MB，只限文字檔） |
| `POST /subtasks/:id/review` | 回覆審核（`optionId`、`note`） |
| `POST /subtasks/:id/talk`、`POST /subtasks/:id/talk/end` | 討論發言（`text`）、結束（`kind`: `continue`/`back`/`stop`，`to`、`reason`） |

## 訂閱登入

用 `{"login":{"kind":"subscription"}}` 建立供應商後再登入，只有 `anthropic` 和 `openai` 可以。登入狀態在供應商的 `auth.signedIn`，進行中或失敗的登入在 `auth.login`，都會透過事件更新。

| 方法與路徑 | 說明 |
|---|---|
| `POST /providers/:id/login` | 開始登入（`method`: `browser` 或 `device`），回傳使用者要做的事 |
| `POST /providers/:id/login/paste` | 瀏覽器回不來時，貼上它停留的網址（`value`） |
| `DELETE /providers/:id/login` | 取消登入 |
| `POST /providers/:id/logout` | 登出 |
| `POST /providers/:id/models` | 重新取得模型清單 |

- **ChatGPT（`openai`）**：以 Codex CLI 的方式走 OAuth。`browser` 會在伺服器這台電腦打開登入頁，並用 `127.0.0.1:1455` 等它回來（這個連接埠被占用時可以貼網址）；`device` 回傳一組代碼。Token 存在 `company.db` 的 `secrets` 表，到期前自動更新。
- **Claude（`anthropic`）**：透過本機的 Claude Code（`claude` 執行檔），登入由它自己管，這裡不保存憑證。可以用下面的 `/claude-code` 檢查、安裝和登入，或自己在終端機執行 `claude auth login`，再呼叫登入 API 確認。登出只影響這個供應商，不會登出 `claude`。可用 `MHO_CLAUDE_EXECUTABLE` 指定執行檔。設定了 `ANTHROPIC_API_KEY` 等環境變數時會拒絕執行，避免請求被轉到別的帳務。Claude 自己的工具全部關閉，只會用這裡提供的工具。
- 訂閱的模型 id 有前綴（`openai-codex/…`、`claude-code/…`），不會和同名的 API Key 模型混淆。
- 訂閱不是按 token 計費，所以費用記為 0，**費用上限對它無效**。

Claude Code 的設定：

| 方法與路徑 | 說明 |
|---|---|
| `GET /claude-code` | 檢查是否安裝、版本、是否已登入訂閱，以及可用的模型 |
| `POST /claude-code/install` | 下載並執行 [Anthropic 的安裝程式](https://code.claude.com/docs/en/install)（`curl -fsSL https://claude.ai/install.sh \| bash`）。要帶 `{"consent":true}`，表示使用者同意了；已安裝時不會重裝 |
| `POST /claude-code/login` | 執行 `claude auth login --claudeai`，會開瀏覽器，完成後才回應 |

後兩個會等到做完才回應（安裝最多 10 分鐘、登入最多 15 分鐘），一次只能跑一個；用戶端中斷請求就會停止它們。

## 預設內容

第一次啟動時會建立五個員工藍圖：PM、Product、Backend Engineer、Frontend Engineer、QA，只建一次，刪掉不會再出現。任務流程也一樣：「預設任務流程」（整理需求、實作、驗收）「功能開發」「修 Bug」「產品規劃」，內容在 `internal/usecase/presets.go`。

任務流程由所有公司共用，公司只記自己的預設任務流程，任務開始時留一份，之後改任務流程不影響它。任務流程不指定員工，由每個任務決定。舊資料裡各公司自己的任務流程，啟動時會自動合併：內容相同的變成一條，同名但內容不同的在名稱後面加上公司名。

## 藍圖來源

從 Git 來的藍圖如果沒有寫 `prompt`，執行時會讀那個 repo 的 `AGENTS.md`；技能來自它的 `skills/`。

## 執行方式

- **Work tree**：任務第一次開工時從目標分支開 `task/<編號>`，work tree 放在資料目錄。所有步驟共用它，每次交接自動 commit，同時進行的步驟會改到同一份檔案。
- **合併**：使用者按合併後，先把目標分支合進任務分支，有衝突由負責人解；再以 fast-forward 更新目標分支，然後移除 work tree 與分支。目標分支所在的資料夾有會被覆蓋的未 commit 變更時，合併會失敗並回到等待合併。取消或更換任務流程會直接刪除任務分支與 work tree。
- **失敗**：供應商暫時性錯誤先重試 3 次；之後依公司的「重試次數」重跑，再不行就等使用者選重試或略過。逾時（公司的 `timeoutMin`）同樣處理。
- **費用**：依供應商的 `prices` 計算。**沒設定價格的模型費用算 0，費用上限對它無效**，子任務 log 會提醒一次。
- **重新啟動**：進行中的工作回到佇列，從保存的對話接著做。

## 思考等級

每個模型能選的等級由供應商回報，不是寫死的清單：Claude 訂閱的 `supportedEffortLevels`、ChatGPT 訂閱的 `supported_reasoning_levels`、Anthropic API 的 `capabilities.effort`、相容 API 的 `effort.supported_levels`。回報的內容存在供應商的 `thinking`（模型 → 等級）。

員工預設是 `default`，也就是不送等級，交給供應商決定。模型不支援的等級會被拒絕；換模型或供應商不再回報時，員工會回到 `default`。舊資料的供應商會在啟動時補問一次。

## 尚未支援

- OpenAI、Google API Key 的模型清單沒有回報思考等級，所以只有 `default`；相容 API 也要回報 `effort.supported_levels` 才有其他等級。
- 訂閱額度（5 小時、每週）不會顯示；用完時子任務會失敗並說明。
- 藍圖的自動更新（`autoUpdate`）：目前只能手動 `POST /blueprints/:id/update`。
- 長對話的壓縮：超過模型上限時子任務會失敗並等使用者處理。
