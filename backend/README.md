# Team Work 後端

單人在本機使用的 Go 伺服器：管理公司、員工、任務藍圖與任務，並讓員工真的呼叫模型、改檔案、跑指令。任務藍圖規則與前端模擬器（`frontend/src/core/domain/sim.ts`）相同，名詞以 `CONTEXT.md` 為準。Agent 迴圈、工具、模型串流與訂閱登入參考 `mho` 的實作。

`make dev` 會同時啟動後端和前端，前端直接接這個 API；`make dev-mock` 的前端用模擬器，不需要後端。

```bash
make server        # 只啟動後端，聽 127.0.0.1:8787
make test-backend  # 測試
```

## 設定與儲存

`TEAM_WORK_HOME` 是資料目錄，預設 `~/.team-work`；必須是絕對路徑。`make dev` 沒有指定時改用 `~/.team-work-dev`，因此可以和 Mac App 同時執行。請勿同時開兩個伺服器使用同一份資料。

| 路徑（相對於 `TEAM_WORK_HOME`） | 內容 |
|---|---|
| `config.yaml` | 全域啟動設定 |
| `preferences.yaml` | 介面偏好：預設頁籤、紀錄排序、保留終端機、細節、陰影、民眾、飛機、雲朵與時間 |
| `company/<team_id>/config.yaml` | 公司名稱、專案位置、目標分支、逾時與費用限制 |
| `company/<team_id>/employee/<replica_id>.json` | 每位員工的名稱、藍圖、外觀、模型、思考等級 |
| `blueprints/<blueprint_id>.yaml` | 每份員工藍圖 |
| `workflows/<workflow_id>.yaml` | 每條任務藍圖 |
| `provider.json` | 供應商設定，以供應商 id 為鍵；含網址、登入方式 `authKind`、模型、`thinking` 與價格，不含憑證 |
| `data.db` | SQLite：任務、子任務、交接、流程快照、對話、用量、員工記憶、登入狀態、憑證、語言、公司位置與建築外觀，以及項目識別與建立時間 |
| `cache/worktrees/` | 任務工作目錄 |
| `cache/repos/` | Git 來源的快取：每個 repo 一份 mirror，每個 commit 一個資料夾 |
| `cache/attachments/` | 上傳的檔案，與交給員工的附件副本 |
| `cache/outputs/<task-or-chat-id>/` | `run_command` 太長的完整輸出；任務合併、取消或刪除時，以及刪除對話時一起刪掉 |
| `cache/airport/` | 機場服務人員的工作目錄 |
| `cache/search-cooldown.json` | `web_search` 被 Exa 限流時的暫停期限，重啟後沿用 |

模型專用的對話歷史（SQLite 的 `conv` 紀錄）啟動時只載入索引；續聊、收回、分岔、回覆審核或恢復子任務時才讀取內容。執行期間保留解析後的歷史，成功儲存且沒有執行中的工作後釋放；不快取原始 JSON，也不刪除磁碟紀錄。讀取失敗或紀錄毀損會明確失敗，不當作新對話；儲存失敗的變更保留待重試，使用者操作則沿用原有回復機制。舊版內嵌圖片在啟動時逐筆遷移，不一次載入所有模型歷史。儲存格式不變，公開訊息與執行中的長對話仍佔用記憶體，這不是後端總記憶體的硬上限。公開對話用成功儲存的獨立快照偵測變更，不另常駐整份 JSON；未變對話不重新編碼或寫入。舊全文 API 與同步事件仍提供完整內容，尚未送出的全文事件也仍會占用記憶體。

設定檔不重複寫路徑已表達的 id：藍圖、流程與公司檔沒有 `id`，員工檔沒有 `id` 與 `teamId`。舊檔裡留著的這些欄位會被忽略，以路徑為準。啟動時會把舊版的 `teams/<team_id>/replicas/` 搬到 `company/<team_id>/employee/`；兩個資料夾同時存在時拒絕啟動，請手動合併。

公司共同指示仍在公司專案資料夾的 `AGENTS.md`，不放進設定檔。所有員工共用的指示在資料目錄的 `AGENTS.md`（預設 `~/.team-work/AGENTS.md`），可在「機場 → 設定 → 系統」編輯，每次開工和對話回覆都會重新讀，接在公司指示之前。憑證沒有加密，靠檔案權限保護。

第一次啟動建立全域設定：

```yaml
host: 127.0.0.1
port: 8787
allowedOrigins:
  - http://localhost:5173
  - http://127.0.0.1:5173
debug: false
memoryDiagnostics: false
```

`config.yaml` 修改後需要重啟，不由「重新載入設定」套用。可用 `TEAM_WORK_HOST`、`TEAM_WORK_PORT`、`TEAM_WORK_ALLOWED_ORIGINS`（空白分隔）、`TEAM_WORK_DEBUG`、`TEAM_WORK_MEMORY_DIAGNOSTICS` 覆寫；桌面版會覆寫自己的本機連接埠與來源，不改檔案。只允許本機監聽位址。Claude 執行檔仍用 `MHO_CLAUDE_EXECUTABLE` 指定，預設 `claude`。

### 記憶體診斷

預設關閉。需要採樣時，在啟動前設定 `TEAM_WORK_MEMORY_DIAGNOSTICS=true`，或在全域 `config.yaml` 加上 `memoryDiagnostics: true`；關閉也需要重啟。沿用原本的連接埠與 Host／Origin 保護，並額外檢查實際連線來自 loopback，不信任轉送標頭；未啟用時以下路徑回 404。不會開啟完整的 `/debug/pprof`、讀取登入憑證或輸出物件內容。

- `GET /api/v1/diagnostics/memory`：回傳 `pid`、`goVersion`、`goroutines`、`memProfileRate` 與 Go `runtime.MemStats` 的 `memory` 欄位，大小單位都是 bytes。不接受查詢參數，不主動觸發 GC。
- `GET /api/v1/diagnostics/heap`：下載 Go pprof 二進位報告，保留標準抽樣率。不主動觸發 GC，內容可能落後最近的配置／釋放；`?gc=0` 相同。明確加上 `?gc=1` 才先強制 GC，可能短暫影響回覆延遲；不強制歸還作業系統記憶體，也不修改 GC 設定。其他參數、重複參數與非 GET 方法會被拒絕。

採樣須使用包含這項功能的新版本；不要同時啟動兩個後端讀寫同一份資料。重啟會失去舊程序的記憶體現場，應記錄版本並在相同操作情境重測。先保存未強制 GC 的統計與報告，經同意後再取 GC 後的報告。以下命令供確認採樣時機後使用；桌面版通常是 18787，獨立後端是 8787：

```bash
umask 077
base=http://127.0.0.1:18787/api/v1/diagnostics
curl --fail "$base/memory" -o memory-before.json
curl --fail "$base/heap" -o heap-before.pprof
# 確認可接受一次強制 GC 後才執行：
curl --fail "$base/heap?gc=1" -o heap-after-gc.pprof
curl --fail "$base/memory" -o memory-after.json
go tool pprof -top -inuse_space heap-after-gc.pprof
go tool pprof -top -alloc_space heap-after-gc.pprof
```

`HeapAlloc` 是尚未釋放的 Go 物件（可能含等待 GC 的垃圾）；`HeapInuse - HeapAlloc` 是使用中堆區的未使用空間，不能直接當成可歸還量；`HeapIdle - HeapReleased` 是閒置但尚未歸還系統的堆空間；`Sys - HeapReleased` 可估算 Go 管理且尚未歸還的空間，但不等於 macOS physical footprint，也不涵蓋所有原生／映射記憶體。`StackInuse`、`MSpanInuse`、`MCacheInuse`、`GCSys`、`OtherSys` 可協助檢查執行環境開銷。pprof 的 `inuse_space` 按配置堆疊估算仍存活物件；`alloc_space` 是程序啟動以來的累計配置，不是目前用量，也不能直接指出是哪個引用持有物件。報告含函式與程式路徑，應保留在本機，不要直接公開。

### 介面偏好與地圖

Mac App 和網頁版使用同一個 `TEAM_WORK_HOME` 時，共用介面偏好及地圖位置。`preferences.yaml` 在介面修改後立即儲存；手動編輯後按「重新載入設定」，不必重啟。省略的欄位使用預設值，未知欄位、`null`、錯誤型別或不存在的頁籤會被拒絕。

偏好欄位的預設值：`logOrder: newestFirst`（也可用 `newestLast`）、`defaultTab: tasks`（`chats`、`tasks`、`crew`、`terminal`、`settings`）、`defaultAirportTab: providers`（`chats`、`providers`、`blueprints`、`flows`、`sources`、`stats`、`terminal`、`prefs`、`about`）、`autoTab: chats`（`off`、`chats`、`tasks`：打開公司或機場時先顯示有事待處理的頁籤，兩者都有時先顯示選的那個；`off` 一律用預設頁籤。舊欄位 `openWaitingTab` 讀取時會自動換成它）、`chatTitleModel: ""`、`chatTitleEffort: ""`（有模型時，公司和機場的新對話會把第一則訊息最多約 2,000 字送給這個模型取一次名字，沒有工具，30 秒逾時、失敗不重試，用量算進該對話；空字串表示關閉，`effort` 空白或模型不支援就不指定思考等級）、`imageProvider: ""`（生圖用的 ChatGPT 訂閱供應商 id，空字串表示沒有 `image_gen`，見「訂閱登入」）；`detail`、`shadows`、`crowd`、`planes`、`clouds` 預設 `true`，`autoView` 預設 `panZoom`（也可用 `pan`、`off`；舊欄位 `autoZoom` 讀取時會自動換成它），`busyAnimation` 預設 `money`（也可用 `shout`，公司工作中時建築旁的動畫），`daylight` 預設 `minecraft`（也可用 `real`、`day`、`night`，小島的時間），`zoomSensitivity` 預設 100（接受 20–300 的整數），`idleFollow` 預設 15（主畫面閒置幾秒後鏡頭跟隨一位民眾，只接受 0、5、15、30、60、300、900、1800、3600、10800，0 表示關閉），`idleFollowTarget` 預設 `map`（閒置鏡頭僅跟隨地圖人物；`all` 包含辦公室員工；地圖民眾關閉且選 `map` 時不跟隨），`terminalCommand` 預設空字串，`keepTerminals` 預設 `false`，`mapClick` 預設 `sheets`（有詳細頁開著時點地圖先關掉所有詳細頁；`home` 時點地圖直接關掉公司或機場。舊欄位 `mapClickLeaves` 讀取時會自動換成它）。語言沿用 SQLite 儲存。聲音偏好 `muteInBackground`（預設 `true`）、`musicVolume`（預設 50）、`effectsVolume`（預設 100）接受 0–100 的整數，0 為靜音；`musicMuted`、`effectsMuted`（預設 `false`）直接靜音該聲道並保留音量；`soundTakeoff`、`soundLanding`、`soundFlyover`、`soundUI`、`soundNotice`、`soundOpenTeam`、`soundOpenAirport`、`soundWaves` 分別控制起飛、降落、飛越、介面、通知（待回覆任務與對話回覆）、打開公司、打開機場音效和持續循環的海浪聲，預設皆為 `true`。`systemNotices`（預設 `true`）讓 Mac App 在不在前景時，為待回覆的任務和對話發 macOS 通知，並在 Dock 圖示上顯示待回覆數量。`musicStyle` 可選 `bossa`（預設）、`chiptune`、`piano`、`ambient`。舊偏好檔缺少的欄位會補上預設值。

公司位置、建築樣式和配色種子存在 SQLite 的公司記錄，建立與移動時儲存，解散時一起移除。位置必須為整數格、兩軸各介於 -512 到 512，不可重疊公司或機場，並且整塊 16×16 用地都必須落在現有陸地格子向八個方向擴張 32 格的範圍內。搬家以搬動前的陸地計算，包含所選公司的原有陸地；機場保留兩格間距。前後端以相同的陸地格子（含連接陸地與填平的內湖）驗證。不讀取或搬移舊的網頁 `localStorage`；沒有共用位置的公司會重新配置位置與外觀。`make dev-mock` 的偏好和地圖只存在記憶體。

已連到同一個後端的頁面會同步更新；這不代表可以讓兩個後端同時使用同一資料目錄。

### 編輯與匯入

先啟動一次產生檔案，再直接編輯。YAML 使用和 API 相同的 camelCase 欄位；藍圖和流程的 id 就是檔名，檔案內不用寫 `id`（寫了也會被忽略）；公司設定和員工 JSON 內的 `id` 必須與公司資料夾或檔名一致。id 只允許英文字母、數字、底線與連字號。

- 複製一份藍圖或流程 YAML，修改檔名，放進 `blueprints/` 或 `workflows/`，即可匯入。更新既有項目使用原本的檔名。這些檔案是完整實體欄位，並非新增藍圖表單的精簡 YAML 格式。
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
- API Key 和 ChatGPT Token 只存在 `data.db`（權限 `0600`）的 `secrets` 表，不會出現在任何回應或事件裡，API Key 對外只有最後 4 碼。工具紀錄（對話、任務和合併的工具列）裡，名稱含 `api_key`、`token`、`secret`、`password` 的參數只顯示最後 4 碼。例外是使用者在對話裡打給員工的 Key，它和其他訊息一樣留在紀錄裡；模型自己的對話歷史也保留完整參數。
- `read_file`、`write_file`、`edit_file` 限制在任務的 work tree 內（技能資料夾可讀），符號連結也擋。有寫入檔案權限就同時有 `edit_file`（只替換檔案中一段唯一的文字，保留 BOM 和 CRLF）。`read_file` 依行讀取（一次最多 2000 行或 50KB，用 `offset`、`limit` 續讀），也能讀 PNG、JPEG、GIF、WebP 圖片（最大 3.75MB、2000 萬像素，壞掉的圖檔會被拒絕），圖片會交給模型看。
- `run_command` 優先用 `bash`，輸出超過 2000 行或 50KB 時只回最後一段，完整輸出存到資料目錄的 `outputs/<task-or-chat-id>/` 並附上路徑，員工可用 `read_file` 讀取。
- `web_search` 使用 Exa 免金鑰的公開服務，有使用額度。所有員工共用一個佇列，一次只送一個請求；Exa 回報額度用完（HTTP 429 或免費額度提示）時，工具回傳 `rate_limited` 錯誤，並依 `Retry-After` 暫停，沒有給時暫停 30 秒；暫停期限存在 `search-cooldown.json`，重啟後沿用。每次嘗試、限流和被暫停擋下都會寫進伺服器 log，不記搜尋內容。有網路搜尋權限就同時有 `web_fetch`：把公開網頁轉成編號段落（一次最多 100 段，用 `offset`、`limit` 續讀），只支援 HTML 和純文字、最大 2MB，不執行 JavaScript。連線前會檢查實際 IP，擋掉內網、本機和非 80、443 的連接埠，轉址也一樣檢查。
- `run_command` **沒有沙盒**：員工能做到伺服器使用者能做的任何事。只雇用你信任其指示的藍圖，也留意任務內容與網頁可能夾帶指示。
- **修改確認可以被 `run_command` 繞過**（已知限制）：有這個工具的員工仍可能直接改藍圖或流程的設定檔，再觸發重新載入（`POST /settings/reload`，即 `ReloadSettings`），不會出現確認卡。確認只約束 `save_blueprint`、`save_workflow`、`save_provider` 這三個工具。

## API

路徑前綴 `/api/v1`。錯誤一律是 `{"error":{"code","message"}}`，`code` 是 `invalid_request`（400）、`forbidden`（403）、`not_found`（404）、`conflict`（409）、`unavailable`（502）或 `internal`（500）。

| 方法與路徑 | 說明 |
|---|---|
| `PUT /settings/language` | 設定 App 語言與員工回覆語言（`zh` 或 `en`），存在 SQLite；世界資料的 `language` 會更新 |
| `PATCH /settings/preferences` | 部分更新介面偏好；讀取包含在 `/world`，更新透過事件同步 |
| `GET`/`PUT /settings/global-prompt` | 讀寫全域 `AGENTS.md`，內容在 `prompt` 欄位 |
| `POST /settings/open-folder` | 在 Finder 打開設定檔資料夾（`TEAM_WORK_HOME`） |
| `POST /settings/reload` | 驗證並重新載入實體設定檔（不含全域 config.yaml）；成功回 204，錯誤保留現有設定 |
| `GET /world` | 整個世界，欄位與前端 `types.ts` 相同 |
| `GET /events` | WebSocket：先送 `snapshot`，之後送 `patch`（實體異動）、`delta`（對話或討論裡員工正在寫的文字，`subId` 是對話或子任務的 id）、`deltaReset`（重試時收回已寫的文字）、`toolOutput`（對話裡正在跑的指令最後幾行輸出，取代上一次的內容；`text` 為空表示指令結束）、`notice`（`review`、`awaitMerge`）。斷線重連會拿到新的 snapshot，以及寫到一半的文字和正在跑的指令輸出 |
| `POST /teams`、`PATCH`/`DELETE /teams/:id` | 公司；建立與修改可帶 `plot: {at: [x,z], style, seed}`（省略時建立自動配置）；資料夾沒有 git 時會初始化並建立 `master`。關閉公司不會刪資料夾，但會刪它的任務分支與 work tree（只刪任務自己建的 work tree 所在的分支；同名但不是任務建的分支會留著） |
| `GET`/`PUT /teams/:id/notes` | 讀寫公司筆記（專案資料夾的 `.team-work/NOTES.md`），內容在 `text` 欄位；沒有檔案就是空的 |
| `GET /branches?folder=` | 查資料夾的分支（只讀），`repo` 是它是不是 git repo |
| `POST /teams/:id/prompt/refresh` | 重新讀專案的 `AGENTS.md`。公司的 `prompt` 就是這個檔案：`PATCH` 會寫回檔案（不會 commit），建立公司、啟動和員工開工時都會重新讀 |
| `POST /folder-picker` | 開系統的選擇資料夾視窗（目前只有 macOS），回傳完整路徑 `path`，取消時是空字串 |
| `POST /workflows`、`PUT`/`DELETE /workflows/:id`、`POST /workflows/:id/duplicate` | 任務藍圖，所有公司共用；不允許迴圈，內建的只能複製 |
| `POST /providers`、`PATCH`/`DELETE /providers/:id` | 模型供應商；模型清單由供應商提供，`prices` 是每百萬 token 的美元價格。ChatGPT 訂閱可帶 `imageDefault`：`true` 設成生圖供應商，`false` 且它原本是生圖供應商時清空 |
| `POST /blueprints`、`PUT`/`DELETE /blueprints/:id`、`POST /blueprints/:id/update` | 藍圖；`update` 把 Git 來源移到最新版 |
| `POST /replicas`、`PATCH /replicas/:id`、`DELETE /replicas/:id?heir=` | 雇用、修改（含記憶）、離職交接 |
| `POST /tasks`、`PATCH`/`DELETE /tasks/:id` | 任務；新任務留在待辦（`paused: true`、沒有 `pausedAt`），用 `resume` 開始；建立時可附 `images` 和 `files`；帶 `workflow`（完整流程）時任務用這份自訂流程、`workflowId` 為空，流程照任務藍圖的規則檢查，但不會存成任務藍圖；`PATCH` 改標題、說明、人員、負責人，不存在的節點 id 或把節點改成沒有人都會被拒絕。由員工或對話建立的任務有 `origin`（`kind` 為 `employee`、`chat` 或 `airport`，加 `id`、`name`、`depth`） |
| `POST /tasks/:id/{pause,resume,cancel,merge}` | 暫停、恢復、取消（要先暫停）、合併 |
| `POST /tasks/:id/return`、`POST /tasks/:id/workflow` | 退回（`feedback`）、更換任務藍圖（`workflowId`，要先暫停） |
| `GET /subtasks/:id/file?path=` | 讀子任務交接的檔案（該次 commit 的內容，上限 1 MB，只限文字檔） |
| `GET /subtasks/:id/diff?path=` | 交接的檔案和子任務開始時的版本逐行比對：`{ lines: [{ op: "same" \| "add" \| "del", text }] }`；檔案是這一步新增的、或子任務開始時沒記下版本就是 `{ lines: null }` |
| `GET /subtasks/:id/image?path=` | 讀子任務交接的圖片（該次 commit 的內容，上限 25 MB，只限 PNG、JPEG、GIF、WebP），直接回傳圖片本身 |
| `POST /subtasks/:id/review` | 回覆審核（`optionId`、`note`）；修改確認（`review.kind` 為 `change`，內容在 `review.change`）的 `optionId` 是 `approve` 或 `reject` |
| `POST /subtasks/:id/talk`、`POST /subtasks/:id/talk/end` | 討論發言（`text`；會議裡 `mentions` 是要回話的員工 id，依序回話，空的就由主持人回話）、結束（`kind`: `continue`/`back`/`stop`，`to`、`reason`） |
| `GET /teams/:id/uncommitted` | 公司資料夾有沒有未提交的改動 |
| `POST /teams/:id/open-folder?path=` | 在 Finder 打開公司資料夾，有 `path` 時打開其中的子資料夾 |
| `GET /teams/:id/file?path=` | 讀公司資料夾裡現在的檔案（訊息提及的 `#檔案`，上限 1 MB，只限文字檔；不能經由 `..` 或連結跑出資料夾） |
| `GET /teams/:id/image?path=` | 同上，讀圖片（PNG、JPEG、GIF、WebP，上限 25 MB） |
| `GET /chats/:id/skill?name=` | 讀對話裡提及的技能：從主持人開始，第一位有這個技能的人的 `SKILL.md` |
| `GET /teams/:id/health` | 公司資料夾現在的狀態：`folder` 存在、`repo` 是 git repo、`targetBranch` 目標分支還在 |
| `GET /teams/:id/terminal?cols=&rows=` | WebSocket：在公司資料夾開一個載入 `~/.zshrc` 的 zsh。二進位訊息是輸入與畫面輸出，文字訊息 `{"cols","rows"}` 調整大小；斷線時結束 shell 和它的工作 |
| `GET /airport/terminal?cols=&rows=` | WebSocket：機場的終端機，在家目錄開 zsh，其餘和公司的相同。機場對話裡藍圖有讀取檔案或執行指令的機場服務人員可用 `read_terminal` 讀它 |
| `POST /attachments` | 上傳一個檔案（請求內容就是檔案本身，最大 25MB），回傳放進 `images` 或 `files` 的 `url` |
| `GET /attachments/:hash` | 讀取附件；PNG、JPEG、GIF、WebP 可直接預覽，其他格式強制下載 |
| `POST /chats` | 開始對話（`teamId`、`replicaId`、`text`、可選的 `images` 和 `files`），用員工當下的模型，員工開始回覆。加上 `guests`（同公司員工的 id）就是會議，`replicaId` 是主持人；`mentions` 同 `say` |
| `POST /chats/:id/say`、`POST /chats/:id/stop`、`DELETE /chats/:id` | 對話發言（`text`、`images`、`files`：附件格式見下方；`mentions` 見會議）、中斷回覆、刪除。回覆中發言會排進對話的 `queue`，回覆正常結束後依序送出；中斷或失敗時留在 `queue` |
| `POST /chats/:id/queue/:queued/steer`、`DELETE /chats/:id/queue/:queued` | Steer：把排隊的訊息標成 `steer` 並排到其他排隊訊息前面，在下一次工具呼叫結束後送出；沒有回覆進行中就立刻送出。刪除：把訊息移出 `queue` |
| `GET /replicas/:id/skills` | 員工藍圖的技能（`name`、`description`），對話輸入框的 `$` 選單用 |
| `GET /blueprints/:id/skills` | 藍圖每個技能來源實際讀到的技能名稱，依來源順序；讀不到的來源是 `null`。藍圖詳情用 |
| `GET /teams/:id/files?q=` | 公司資料夾裡符合 `q` 的檔案和資料夾（`path`、`dir`，最多 50 筆，git 忽略的也列，只略過 `.git`），對話輸入框和任務說明的 `#` 選單用 |
| 對話裡的 `ask_user` | 員工可隨時用這個工具請使用者選擇：`chat.question.options` 是選項（至少一個，沒有選項的呼叫會被退回）。工具必填 `reply`（完整回覆）和 `options`；缺少、空白或型別錯誤的 `reply` 會被退回，即使先前已寫過文字也一樣。`reply` 以一般員工訊息存下並顯示在選項前，也保留在模型的對話文字中，讓接手的員工看得到。員工應把答案、建議和問題寫在 `reply`，不另寫一份相同回覆；這只保證有文字，不保證模型回答完整。舊對話和已開啟的選項仍可讀取及回答。下一則 `say` 的文字剛好是其中一個選項（不帶附件）才算回答；其他訊息都是新訊息，問題一樣結束，模型會被告知使用者沒有選 |
| `POST /airport/chats` | 開始機場對話（`model`、可選的 `effort`、`text`、`images`、`files`）：對象固定是機場服務人員，回傳的 `teamId` 為空。工作資料夾是資料目錄的 `airport/`，可用讀寫檔案、網路搜尋和執行指令；指令沒有沙盒。指示只有固定規則和全域 `AGENTS.md`。`say`、`stop`、`read`、`rewind`、`handoff`、刪除和公司對話共用，`task-draft` 會拒絕 |
| `POST /chats/:id/change` | 回答對話的修改確認（`approve`、可選的 `note`；內容在 `chat.change`），員工接著回覆。等待確認時改用 `say` 發言視為拒絕 |
| `PATCH /chats/:id/title` | 改對話名稱（`title`）：多個空白合成一個，最多 80 字，空字串清除名稱、改回顯示第一則訊息。手動取的名字不會被自動命名蓋掉 |
| `PATCH /chats/:id/pin` | 釘選或取消釘選對話（`pinned`）：釘選的對話記下 `pinnedAt`，在列表排最上面；已經釘選的再釘一次不改時間 |
| `PATCH /chats/:id/mind` | 更換機場對話下一次回覆的 `model` 和 `effort`；回覆中或公司對話會拒絕 |
| `POST /chats/:id/read` | 標記已讀，清除對話的 `unread` |
| `POST /chats/:id/rewind` | 收回第 `index` 則使用者訊息和它之後的所有內容，並中斷回覆；資料夾裡的改動不會還原 |
| `POST /chats/:id/handoff` | 把對話複製到第 `index` 則訊息為止，交給同公司的員工 `replicaId`（原本的員工就是單純複製；機場對話傳空字串），回傳新對話；從員工訊息複製會保留到該段回覆結束，只有正在寫的那段回覆不能複製。交給別人時新對話的 `handoffs` 記下從哪則訊息起換人（`before`、`replicaId`、`name`），接手的員工會被告知前面哪些回覆不是自己寫的；員工離開公司後，對話仍可交給別人 |
| `POST /chats/:id/task-draft` | 把對話整理成任務的 `title` 和 `description`，不會建立任務；會議由這一輪能對外動作的人整理 |
| 會議 | 對話有 `guests` 就是會議，最多 6 位員工。`say` 的 `mentions` 是這則訊息要給誰（員工 id，依序回覆），不在對話裡的人會被邀請加入；沒有 `mentions` 時所有人依序回覆，主持人最後。每人用自己加入時的模型，看得到前面的人說了什麼，但看不到別人用的工具。對外動作（建立或修改任務、藍圖、流程、`ask_user`）每輪只給一人：單獨被提及的人，否則是主持人。訊息的 `by` 是誰說的，`chat.speaker` 是這一輪正在或最後回覆的人，`chat.next` 是還沒輪到的人。`stop` 會停掉整輪；某人失敗時下一位照常回覆。從會議交給主持人是複製整場會議，交給其他人就變成和那個人的一對一對話 |
| `PATCH /chats/:id/chair` | 把會議的主持人換成來賓 `replicaId`，原主持人變成來賓；回覆中會拒絕 |

對話分頁是選用協定，不改 SQLite 紀錄。`GET /world?chats=paged` 和 `GET /events?chats=paged` 的對話只有摘要，`messages` 為空陣列；`history` 提供總數 `count`、版本 `version`、列表／通知預覽和教學狀態。沒有參數的舊 API 仍回傳全文。建立公司／機場對話與 `handoff` 也可加 `?chats=paged`，避免回傳整段複製歷史。

`GET /chats/:id/messages?before=N&limit=100&version=V` 回傳 `[start, before)` 的訊息、`start`、`total`、`version`，以及範圍內交接與加入紀錄；`before` 為不含在本頁內的原始訊息位置，`limit` 必須是 1–100（預設 100）。分頁交接紀錄的 `to` 是接手者名稱。版本不符回 `409 conflict`，參數不合法回 `400 invalid_request`，對話不存在回 `404 not_found`。省略版本可讀取當下的範圍，但跨頁應傳版本以防收回／修改造成混用。

摘要更新帶 `previous` 與 `changedFrom`，表示從哪個歷史版本、哪個位置開始改變；前端只在版本連續時重用未變前綴，再分頁取得變更尾端。未讀、名稱等變動不改歷史版本。重連丟棄前端分頁並重新讀取最新一頁。`rewind`、`handoff` 的 JSON 可帶 `version`，伺服器在修改鎖內檢查，不符就拒絕；舊呼叫不帶版本仍維持原行為。這減少前端傳輸與保留；畫面用的公開訊息仍完整保留在後端記憶體。

任務與對話的 `images`、`files` 都是 `{ "name": "檔名", "url": "…" }` 陣列，合計最多 6 個。`images` 接受 PNG、JPEG、GIF、WebP，每個最大 3.75MB；先上傳後使用附件網址，並帶上 `mimeType`（例如 `image/png`）。舊的 data URL 仍可送出。`files` 接受一般檔案，每個最大 25MB：`url` 是上傳後拿到的網址；舊資料的 data URL 仍可讀取，每個最大 3.75MB，省略 `files` 也可以。只有附件、沒有文字的對話也能發送。

圖片與上傳的檔案存於資料目錄的 `cache/attachments/uploads/`，內容相同只留一份；目前刪除任務或對話時不會清掉附件。公開對話與模型歷史只留圖片參照，送模型前才讀回原始圖片。啟動時會將既有內嵌圖片存成附件後更新紀錄，不刪除訊息或原圖；備份必須包含整個資料目錄，尤其是這個附件資料夾。新版紀錄不應交給不支援圖片參照的舊版後端讀取。

一般檔案另外存於資料目錄的 `attachments/<task-or-chat-id>/`，不會寫入或提交到公司專案。員工會收到檔名、絕對路徑和文字預覽（最多 50KB），可用藍圖允許的讀檔工具繼續讀取；二進位文件須使用可用的命令與解析工具，沒有內建 PDF／Office 轉換。介面支援下載、移除待送附件、複製任務附件及收回訊息後重新編輯附件。

## 員工的管理工具

任務中的員工、公司對話的員工和機場服務人員，可以用工具讀取任務、藍圖、任務藍圖和模型供應商，並新增或修改。能用哪些工具由藍圖勾選的工具決定，藍圖可選的工具仍是原本四個；實作在 `internal/usecase/manage.go`。

| 藍圖勾選 | 可使用 |
|---|---|
| `read_file` | `list_tasks`、`list_blueprints`、`list_workflows`、`list_employees`、`list_companies`、`list_providers` |
| `write_file` 或 `run_command` | 上面的讀取工具，加上 `create_task`、`update_task`、`save_blueprint`、`save_workflow`、`save_provider` |
| `web_search` | 沒有額外工具 |

機場服務人員四個工具都有，所以擁有全部能力。內建的 15 個藍圖都有讀寫能力。任務藍圖的「開會討論」步驟只有讀取工具。沒有刪除工具。錯誤和拒絕都以工具結果回傳給模型。

- **範圍**：公司的員工只能讀取、建立、修改自己公司的任務，也只列得到自己公司的員工和公司；機場服務人員可以跨公司，`create_task` 要帶 `team_id`。藍圖、任務藍圖和供應商由所有公司共用，修改會影響每間公司。
- **直接生效**：新增藍圖、新增任務藍圖、新增供應商、`create_task`、`update_task`。`update_task` 不用確認是暫定做法：舊內容會被直接蓋掉，員工也能換掉負責人和節點員工。正在執行的工作不受影響，之後的步驟會看到新內容。
- **要確認**：帶 `id` 的 `save_blueprint`、`save_workflow`、`save_provider`，包括員工修改自己用的藍圖。後端先檢查內容並算出差異，然後暫停，同意前不會寫入。任務的子任務進入等待回覆（`review.kind` 為 `change`），對話則是 `chat.change`；兩者都會保存，重新啟動後還在。同意或拒絕都會回傳給模型，模型接著工作。內容沒有差異時不會暫停。同一輪在這個呼叫之後的工具不會執行，模型會收到 `interrupted`。
- **不能修改**：`preset-` 開頭的內建項目和來源帶來的（id 含 `--`，例如官方的 `team-work--assistant`）項目（要新增一份自己的）、Git 來源的藍圖。修改要帶 `list_*` 回傳的 `version`，不符就拒絕；等待確認期間內容被改過或刪除時，同意也不會寫入，模型會收到原因。
- **設定檔**：寫入藍圖、任務藍圖和供應商的規則和介面相同：有外部修改尚未載入時回傳 `conflict`。
- **生效範圍**：任務建立時留一份任務藍圖，修改共用流程不影響進行中的任務。藍圖不同：同意後正在進行的步驟不變，但每次開始步驟都讀最新藍圖，所以同一任務之後的步驟會用新藍圖。
- **`create_task`**：帶標題、說明、任務藍圖，立即建立，不需要確認；任務和使用者建立的一樣留在待辦（`paused: true`、沒有 `pausedAt`），等使用者按開始（`POST /tasks/:id/resume`）。內建流程的步驟沒有指定員工，有步驟沒有人時會失敗並列出這些步驟，模型應該問使用者後再用 `staff` 或 `owner_id` 重試；模型自己填人選時後端無法分辨。
- **連鎖深度**：任務中的員工建立的任務，深度是來源任務加 1，最多 3 層（`maxTaskDepth`，暫定值），超過就拒絕並告知模型。從對話建立的任務深度是 0。同時執行的任務數量沒有限制。
- **`save_blueprint`**：模型不能設定外觀，新藍圖的外觀取自 `presets.json` 的 `looks` 之一。技能用 Git 來源時不會在儲存當下解析 commit，執行時才取 `origin/HEAD`，也不會套用 `ref`；要固定版本請呼叫 `POST /blueprints/:id/update`。
- **`save_workflow`**：`nodes`、`edges` 是完整的新清單，已存在的節點 id 沒帶的欄位保留原值。模型不指定座標，新節點由後端排版。有迴圈等無效內容會被拒絕。
- **`save_provider`**：新增時帶 `name`、`kind`、`api_key`（`compatible` 另帶 `base_url`），和介面新增一樣先向供應商查模型清單，Key 或網址錯誤就失敗。修改可改 `name`、`base_url`、`api_key`、`prices`（`prices` 是整份取代），不能改 `kind` 和登入方式；查模型清單在送出確認卡之前做；但只改 `base_url` 而沿用已存的 Key 時，確認前不連新網址，同意寫入後才用已存的 Key 到新網址重新讀模型清單。確認卡列出名稱、網址、Key 最後 4 碼、價格和模型清單的差異。新的 Key 在等待確認期間只放在記憶體，不寫進確認卡和狀態檔，所以重新啟動後同意會失敗並告知模型。訂閱登入要開瀏覽器，工具做不到：可用 `login: subscription` 新增，再請使用者到設定頁登入。`list_providers` 只回傳 Key 最後 4 碼。
- **請使用者輸入答案**：`ask_user` 一定要有選項，所以需要使用者打字的答案（例如名字、API Key），員工會在回覆裡直接問。輸入的內容和一般訊息一樣，會留在對話紀錄並交給模型；員工呼叫 `save_provider` 時，對話裡顯示的工具參數也包含 Key。

## 訂閱登入

用 `{"login":{"kind":"subscription"}}` 建立供應商後再登入，只有 `anthropic` 和 `openai` 可以。登入狀態在供應商的 `auth.signedIn`，進行中或失敗的登入在 `auth.login`，都會透過事件更新。

| 方法與路徑 | 說明 |
|---|---|
| `POST /providers/:id/login` | 開始登入（`method`: `browser` 或 `device`），回傳使用者要做的事 |
| `POST /providers/:id/login/paste` | 瀏覽器回不來時，貼上它停留的網址（`value`） |
| `DELETE /providers/:id/login` | 取消登入 |
| `POST /providers/:id/logout` | 登出 |
| `GET /quotas` | 各供應商的額度，以供應商 id 為鍵：訂閱回報 `fiveHour`、`weekly`（已用 %，0–100）與 `fiveHourResetAt`、`weeklyResetAt`（重置時刻，Unix 秒），來自 Claude Code 與 ChatGPT 的非公開用量端點；API Key 只有 OpenRouter（金鑰自身的額度上限）和 DeepSeek 回報 `balance` 與 `currency`。查不到的欄位或供應商不出現 |
| `POST /providers/:id/models` | 重新取得模型清單 |
| `GET /usage?since=&offset=` | 模型用量統計：`since` 是起始時刻（Unix 秒，0 為全部），`offset` 是時區（比 UTC 快幾分鐘）。回傳總計 `total`、依供應商再依模型的 `providers`（Token 多的在前）和逐日的 `days`（含沒有用量的日子；每天的 `parts` 是各 `providerId` 與 `model` 的 `tokens`）；每筆都有 `calls`、`input`（含快取）、`output`、`cacheRead`、`tokens`（不含快取讀取）、`costUsd` 和 `unpriced`（沒有價格的呼叫數）。每次呼叫模型時記在 `data.db` 的 `usage` 表，費用照當時的價格算；上線前的用量沒有記錄 |

- **ChatGPT（`openai`）**：以 Codex CLI 的方式走 OAuth。`browser` 會在伺服器這台電腦打開登入頁，並用 `127.0.0.1:1455` 等它回來（這個連接埠被占用時可以貼網址）；`device` 回傳一組代碼。Token 存在 `data.db` 的 `secrets` 表，到期前自動更新。
- **Claude（`anthropic`）**：透過本機的 Claude Code（`claude` 執行檔），登入由它自己管，這裡不保存憑證。可以用下面的 `/claude-code` 檢查、安裝和登入，或自己在終端機執行 `claude auth login`，再呼叫登入 API 確認。登出只影響這個供應商，不會登出 `claude`。可用 `MHO_CLAUDE_EXECUTABLE` 指定執行檔。設定了 `ANTHROPIC_API_KEY` 等環境變數時會拒絕執行，避免請求被轉到別的帳務。Claude 自己的工具全部關閉，只會用這裡提供的工具。
- 訂閱的模型 id 有前綴（`openai-codex/…`、`claude-code/…`），不會和同名的 API Key 模型混淆。
- **生圖**：偏好 `imageProvider` 指向一個已登入的 ChatGPT 訂閱時，所有員工（含 Claude 員工和機場服務人員）在任務和對話裡都多一個 `image_gen` 工具；討論步驟沒有。它呼叫 ChatGPT 後端的 `/codex/images/generations`（有來源圖時改用 `/codex/images/edits`），模型是 `gpt-image-2`。參數是 `prompt`、可選的 `images`（來源圖，1–5 張 PNG／JPEG／GIF，每張最大 5MiB）、`output_path`（工作目錄內的 `.png`，不覆蓋已有檔案；省略時存到 `generated-images/<隨機>.png`）和 `transparent_background`。每張圖最多等 5 分鐘。在對話裡，每張生成的圖會另存一份到上傳附件，附在一則 `from: tool` 的訊息（`text` 是檔案路徑，`images` 是這份副本），之後資料夾裡的檔案改掉或刪掉，對話仍看得到。設定頁只接受 ChatGPT 訂閱；該供應商被刪除或改成不能生圖時，設定會清空。
- 訂閱不是按 token 計費，所以費用記為 0，**費用上限對它無效**；消耗的 token 數照常記錄。

Claude Code 的設定：

| 方法與路徑 | 說明 |
|---|---|
| `GET /claude-code` | 檢查是否安裝、版本、是否已登入訂閱，以及可用的模型 |
| `POST /claude-code/install` | 下載並執行 [Anthropic 的安裝程式](https://code.claude.com/docs/en/install)（`curl -fsSL https://claude.ai/install.sh \| bash`）。要帶 `{"consent":true}`，表示使用者同意了；已安裝時不會重裝 |
| `POST /claude-code/login` | 執行 `claude auth login --claudeai`，會開瀏覽器，完成後才回應 |

後兩個會等到做完才回應（安裝最多 10 分鐘、登入最多 15 分鐘），一次只能跑一個；用戶端中斷請求就會停止它們。

## 語言

給使用者看的訊息和錯誤，寫入當下依 App 語言產生，以繁中為 key，英文在 `internal/i18n/en.go`；已寫入的紀錄不會改變。繁中文字都要經過 `i18n.T` 或 `model.Errorf`，測試會檢查是否都有英文。給員工的固定指示和交接內容一律是英文，不經過這裡。

## 預設內容

App 帶的十二個員工藍圖（通才、前端工程師、後端工程師、審查與測試、介面設計工程師、媒體設計師、功能規劃、研究員、寫手、DevOps 工程師、Matt Pocock、Poteto）和四條任務藍圖（「一般任務」「修 Bug」「功能開發」「程式審查」）來自官方來源 [Team-Work-Source](https://github.com/yanun0323/Team-Work-Source)，見下方「官方來源」。真正內建的只剩機場服務人員專用的 `preset-airport`（設定頁看得到，但不能拿來新增員工，`list_blueprints` 也不列），和 App 自己寫的固定文字（「整理需求」「驗收」範本、討論步驟的指示、員工自己做的藍圖可用的外觀），各語言都在 `internal/usecase/presets.json`。`preset-` 開頭的 id 不存進設定檔，也不能修改或刪除；世界資料裡是目前語言的版本，員工收到的一律是英文。自訂項目不能用這個開頭的 id。舊版內建的藍圖（例如 `preset-assistant`）不會自動換成官方來源的那份。

員工的藍圖不存在時（舊版內建的、來源不再帶來的、檔名改了或手動改了員工檔），設定照常載入，員工保留原樣：前端標「藍圖已不存在」，他負責的步驟開工時直接停下來問使用者（`ReviewFailed`，不重試），對話回覆也會失敗，都說明要編輯這位員工重新選擇藍圖。來源更新時拿掉某個藍圖，用它的員工仍會改成自訂設定（見 `putSourced`），不算在內。

任務藍圖由所有公司共用，任務開始時留一份，之後改任務藍圖不影響它。任務藍圖不指定員工，由每個任務決定。

## 官方來源

`team-work` 是固定 id 的 Git 來源，指向 `https://github.com/yanun0323/Team-Work-Source`，每個世界都有（設定檔沒有就補上），預設自動套用更新，不能刪除（`DELETE /sources/team-work` 回 409）。它帶來的藍圖和流程 id 是 `team-work--<檔名>`，所以每台電腦都一樣。App 不內附它：一開始沒有版本，伺服器啟動後檢查一次時下載，之後和其他 Git 來源一樣，每小時檢查。檢查時，新版要下載並讀完才會換過去，讀不到就留在原本的版本、記下錯誤；正在用的版本不在 `cache/repos/` 時（快取被刪掉），即使沒有新版也會重新下載。這兩條對所有 Git 來源都一樣。測試和模擬模式讀 `internal/usecase/testdata/official/` 那份，`make official-source`（`REF=` 可指定分支或 tag）從 GitHub 更新它。

來源的 YAML 裡，員工藍圖的 `name`、`prompt`、`comment`，以及流程和每個節點的 `name`、`prompt`，可以寫一段文字，也可以寫 `en`、`zh`、`zh-Hans`、`ja`、`ko` 對文字的對照；其他語言代碼或不是文字時，該檔案列在來源的讀取問題裡。世界資料用目前語言，沒有就用英文，再沒有就用檔案裡第一個；給員工的角色說明和流程（任務的那份也是）有英文就用英文。任務留的流程副本換語言時，只換名稱仍是來源寫的那幾個節點。

偏好 `codexSkills`、`claudeSkills` 關掉時，所有藍圖都不讀 `~/.codex/`、`~/.claude/`（和它們底下的資料夾）的技能，藍圖的技能清單不變，`GET /blueprints/:id/skills` 那一格是空的。

## 藍圖來源

從 Git 來的藍圖如果沒有寫 `prompt`，執行時會讀那個 repo 的 `AGENTS.md`；技能來自它的 `skills/`。

技能來源（Git 或本機資料夾）裡，有 `SKILL.md` 的資料夾就是一個技能。Git 來源可以用 `path` 指定 repo 裡的子資料夾，就從那裡開始找；貼上 `/tree/main/pstack` 這種網址時，第一段是版本，其餘是子資料夾。先找 `skills/` 底下，找不到才找來源根目錄；可以分類放（如 `skills/engineering/tdd/SKILL.md`），最多往下四層，會跟著符號連結，略過 `.` 開頭的資料夾和 `node_modules`，技能資料夾裡面不再往下找。

## 執行方式

- **起點與完成**：任務藍圖沒有固定的頭尾。沒有上游的節點都是起點，任務開始時同時啟動，各自直接拿到任務說明。所有實際啟動的支線都完成才進入等待合併，條件分支沒選到的不用等；`join: all` 的節點遇到確定不會啟動的上游時，把它當作已結清。負責人只代表誰對任務負責，不會自動接手任何節點。舊資料裡的 `kind: task` 讀入時當作工作節點。
- **退回**：工作節點的 `sendBack` 打開時，完成後可以把工作退回上游重做；只有一個上游、且該上游只交給這個節點時才能打開（`checkWorkflow` 不檢查，執行時不符合就當作關閉）。起點和討論節點不能退回。沒設定時照舊規則：終點和被退回過的節點可以。退回不會取消其他支線，一個任務最多退回兩次。多個終點時，等待合併的「退回」和合併由最後完成的終點決定，有上游的終點優先。
- **Work tree**：任務第一次開工時從目標分支開 `task/<編號>`，work tree 放在資料目錄。所有步驟共用它，每次交接自動 commit，同時進行的步驟會改到同一份檔案。
- **合併**：使用者按合併後，先把目標分支合進任務分支，有衝突由負責人解；再以 fast-forward 更新目標分支，然後移除 work tree 與分支。目標分支所在的資料夾有會被覆蓋的未 commit 變更時，合併會失敗並回到等待合併。取消或更換任務藍圖會直接刪除任務分支與 work tree。
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
- 藍圖本身是 Git repo 時不會自動更新，只能手動 `POST /blueprints/:id/update`；技能來源的自動套用設在來源上。
- 子任務的長對話壓縮：超過模型上限時子任務會失敗並等使用者處理。對話已會自動壓縮（`auto_compact`）。
