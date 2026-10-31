# Team Work 後端

單人在本機使用的 Go 伺服器：管理公司、員工、任務流程與任務，並讓員工真的呼叫模型、改檔案、跑指令。任務流程規則與前端模擬器（`frontend/src/core/domain/sim.ts`）相同，名詞以 `CONTEXT.md` 為準。Agent 迴圈、工具、模型串流與訂閱登入參考 `mho` 的實作。

`make dev` 會同時啟動後端和前端，前端直接接這個 API；`make dev-mock` 的前端用模擬器，不需要後端。

```bash
make server        # 只啟動後端，聽 127.0.0.1:8787
make test-backend  # 測試
```

## 設定與儲存

`TEAM_WORK_HOME` 是資料目錄，預設 `~/.team-work`；必須是絕對路徑。網頁與桌面版使用相同預設目錄，請勿同時開兩個伺服器使用同一份資料。

| 路徑（相對於 `TEAM_WORK_HOME`） | 內容 |
|---|---|
| `config.yaml` | 全域啟動設定 |
| `teams/<team_id>/config.yaml` | 公司名稱、專案位置、目標分支、逾時與費用限制 |
| `teams/<team_id>/replicas/<replica_id>.json` | 每位員工的名稱、藍圖、外觀、模型、思考等級 |
| `blueprints/<blueprint_id>.yaml` | 每份員工藍圖 |
| `workflows/<workflow_id>.yaml` | 每條任務流程 |
| `provider.json` | 供應商設定，以供應商 id 為鍵；含網址、登入方式 `authKind`、模型、`thinking` 與價格，不含憑證 |
| `company.db` | SQLite：任務、子任務、交接、流程快照、對話、用量、員工記憶、登入狀態、憑證，以及項目識別與建立時間 |
| `worktrees/` | 任務工作目錄 |

公司共同指示仍在公司專案資料夾的 `AGENTS.md`，不放進設定檔。憑證沒有加密，靠檔案權限保護。

第一次啟動建立全域設定：

```yaml
host: 127.0.0.1
port: 8787
allowedOrigins:
  - http://localhost:5173
  - http://127.0.0.1:5173
debug: false
```

`config.yaml` 修改後需要重啟，不由「重新載入設定」套用。可用 `TEAM_WORK_HOST`、`TEAM_WORK_PORT`、`TEAM_WORK_ALLOWED_ORIGINS`（空白分隔）、`TEAM_WORK_DEBUG` 覆寫；桌面版會覆寫自己的本機連接埠與來源，不改檔案。只允許本機監聽位址。Claude 執行檔仍用 `MHO_CLAUDE_EXECUTABLE` 指定，預設 `claude`。

### 編輯與匯入

先啟動一次產生檔案，再直接編輯。YAML 使用和 API 相同的 camelCase 欄位；檔案內的 `id` 必須與檔名或公司資料夾一致，id 只允許英文字母、數字、底線與連字號。

- 複製一份藍圖或流程 YAML，修改檔名與 `id`，放進 `blueprints/` 或 `workflows/`，即可匯入。更新既有項目使用原本 id。這些檔案是完整實體欄位，並非新增藍圖表單的精簡 YAML 格式。
- 員工 JSON 的 `teamId` 必須和所在公司資料夾一致。`effort` 必須在供應商該模型的 `thinking` 清單或相容 API 的備用清單內；`default` 表示不送等級，不必列進清單。
- 供應商模型與思考等級可手改；按「重新取得模型」會以供應商回報取代它們。
- 新增公司、員工、供應商，以及刪除項目、修改登入方式，仍使用介面。公司資料夾不能透過設定檔搬移。刪除檔案不會觸發刪任務或清理 work tree，而是回報缺少設定。

儲存後到 **機場 → 設定 → 設定檔 → 重新載入設定**，或呼叫 `POST /api/v1/settings/reload`。所有實體設定整批驗證後才一起生效；失敗保留原本有效設定。既有任務保留流程快照，正在執行的模型請求不改動。啟動也會讀取設定，不自動監看檔案。

每個實體設定檔上限 16 MB，不接受符號連結、未知欄位或多份 YAML 文件。未改動的 YAML 保留註解與格式；從介面修改該項目時會重新序列化該檔案，註解不保留。

外部修改尚未載入時，介面儲存設定回傳 `conflict`，不覆蓋檔案；任務與記憶仍可寫入 SQLite。先重新載入，再重開編輯表單。避免同時在編輯器與介面儲存：外部編輯器不參與程式的鎖，程式只能在替換前再次檢查。

多檔更新有暫存寫入紀錄，和 SQLite 執行資料一起提交；重啟會完成中斷的寫入。這是當前格式的故障恢復，不是舊版遷移。若恢復期間發現外部修改，會停止並提示保留手改副本、還原該檔案再重啟。

**沒有舊格式相容、升級或搬移功能，也不讀取舊資料目錄。** 請使用新的資料目錄。備份前先關閉程式，備份整個 `TEAM_WORK_HOME`，還原時設定、SQLite 與 work tree 必須來自同一份備份。

## 安全

- API 沒有登入。所以只聽本機，並檢查 `Host` 與 `Origin`，別的網站不能透過使用者的瀏覽器連進來。
- API Key 和 ChatGPT Token 只存在 `company.db`（權限 `0600`）的 `secrets` 表，不會出現在任何回應或事件裡，API Key 對外只有最後 4 碼。
- `read_file`、`write_file` 限制在任務的 work tree 內（技能資料夾可讀），符號連結也擋。`read_file` 也能讀 PNG、JPEG、GIF、WebP 圖片（最大 3.75MB），圖片會交給模型看。
- `run_command` **沒有沙盒**：員工能做到伺服器使用者能做的任何事。只雇用你信任其指示的藍圖，也留意任務內容與網頁可能夾帶指示。

## API

路徑前綴 `/api/v1`。錯誤一律是 `{"error":{"code","message"}}`，`code` 是 `invalid_request`（400）、`forbidden`（403）、`not_found`（404）、`conflict`（409）、`unavailable`（502）或 `internal`（500）。

| 方法與路徑 | 說明 |
|---|---|
| `POST /settings/reload` | 驗證並重新載入實體設定檔（不含全域 config.yaml）；成功回 204，錯誤保留現有設定 |
| `GET /world` | 整個世界，欄位與前端 `types.ts` 相同 |
| `GET /events` | WebSocket：先送 `snapshot`，之後送 `patch`（實體異動）、`delta`（對話或討論裡員工正在寫的文字，`subId` 是對話或子任務的 id）、`deltaReset`（重試時收回已寫的文字）、`notice`（`review`、`awaitMerge`）。斷線重連會拿到新的 snapshot，以及寫到一半的文字 |
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
| `GET /teams/:id/uncommitted` | 公司資料夾有沒有未提交的改動 |
| `POST /teams/:id/open-folder` | 在 Finder 打開公司資料夾 |
| `GET /teams/:id/health` | 公司資料夾現在的狀態：`folder` 存在、`repo` 是 git repo、`targetBranch` 目標分支還在 |
| `GET /teams/:id/terminal?cols=&rows=` | WebSocket：在公司資料夾開一個載入 `~/.zshrc` 的 zsh。二進位訊息是輸入與畫面輸出，文字訊息 `{"cols","rows"}` 調整大小；斷線時結束 shell 和它的工作 |
| `POST /chats` | 開始對話（`teamId`、`replicaId`、`text`、可選的 `images`），用員工當下的模型，員工開始回覆 |
| `POST /chats/:id/say`、`POST /chats/:id/stop`、`DELETE /chats/:id` | 對話發言（`text`、`images`：data URL，最多 6 張，PNG、JPEG、GIF、WebP，單張最大 3.75MB）、中斷回覆、刪除 |
| `POST /chats/:id/rewind` | 收回第 `index` 則使用者訊息和它之後的所有內容，並中斷回覆；資料夾裡的改動不會還原 |
| `POST /chats/:id/task-draft` | 把對話整理成任務的 `title` 和 `description`，不會建立任務 |

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

第一次啟動時會建立六個員工藍圖：專案經理、產品負責人、設計師、後端工程師、前端工程師、測試工程師，只建一次，刪掉不會再出現。任務流程也一樣：「功能開發」「修 Bug」「產品規劃」，內容在 `internal/usecase/presets.go`。

任務流程由所有公司共用，任務開始時留一份，之後改任務流程不影響它。任務流程不指定員工，由每個任務決定。

## 藍圖來源

從 Git 來的藍圖如果沒有寫 `prompt`，執行時會讀那個 repo 的 `AGENTS.md`；技能來自它的 `skills/`。

## 執行方式

- **Work tree**：任務第一次開工時從目標分支開 `task/<編號>`，work tree 放在資料目錄。所有步驟共用它，每次交接自動 commit，同時進行的步驟會改到同一份檔案。
- **合併**：使用者按合併後，先把目標分支合進任務分支，有衝突由負責人解；再以 fast-forward 更新目標分支，然後移除 work tree 與分支。目標分支所在的資料夾有會被覆蓋的未 commit 變更時，合併會失敗並回到等待合併。取消或更換任務流程會直接刪除任務分支與 work tree。
- **失敗**：供應商暫時性錯誤先重試 3 次；之後依公司的「重試次數」重跑，再不行就等使用者選重試或略過。逾時（公司的 `timeoutMin`）同樣處理。
- **費用**：依供應商的 `prices` 計算。**沒設定價格的模型費用算 0，費用上限對它無效**，子任務 log 會提醒一次。
- **重新啟動**：進行中的工作回到佇列，從保存的對話接著做。

## 思考等級

每個模型能選的等級預設由供應商回報，也可在 `provider.json` 的 `thinking` 手動設定：Claude 訂閱的 `supportedEffortLevels`、ChatGPT 訂閱的 `supported_reasoning_levels`、Anthropic API 的 `capabilities.effort`、相容 API 的 `effort.supported_levels`。回報的內容存在供應商的 `thinking`（模型 → 等級）。

員工預設是 `default`，也就是不送等級，交給供應商決定。不在可選清單的等級會被拒絕；換模型或重新取得清單後，原等級不再可選時會回到 `default`。

OpenAI 相容（`compatible`）供應商若沒有回報等級，提供 `none / low / medium / high / xhigh / max` 作為備用選項，並保留 `default`。有非空的回報或手動設定清單時，以該清單為準。`none` 明確傳送 `reasoning_effort: "none"`，`default` 不送欄位。備用清單不代表模型保證支援，API 拒絕時會回報錯誤，不自動降級。

## 尚未支援

- OpenAI、Google API Key 的模型清單沒有回報思考等級，所以只有 `default`；OpenAI 相容類型則使用上述備用清單。
- 訂閱額度（5 小時、每週）不會顯示；用完時子任務會失敗並說明。
- 藍圖的自動更新（`autoUpdate`）：目前只能手動 `POST /blueprints/:id/update`。
- 長對話的壓縮：超過模型上限時子任務會失敗並等使用者處理。
