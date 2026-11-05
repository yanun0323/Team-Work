# 公司檔案的「檔案瀏覽」分頁

## 問題

想在 App 裡看一眼公司專案資料夾的某個檔案、改幾行，現在只能開終端機用 vim，或切到 Finder 和外部編輯器。對話裡的 `#` 只能讀不能改，也無法瀏覽資料夾。

## 目標

公司 drawer 多一個「檔案瀏覽」分頁（英文 Files），在 App 內瀏覽公司專案資料夾、新增檔案和資料夾、編輯文字檔、預覽圖片。第一版求「方便看檔案、改幾行」，不是完整開發工具。

## 範圍

- 只處理公司的專案資料夾（`Team.Folder`）。不含機場（家目錄），也不含任務的工作樹（`dataDir/cache/worktrees/...`）。
- 檔案樹：一次只讀「被展開的那一層」資料夾的內容，直接看磁碟。**不排除任何檔案**：隱藏檔、被 `.gitignore` 忽略的檔案、`.git`、`node_modules`、`dist` 等都照樣列出；它們不展開就不會被讀取。
- 開啟文字檔 → 純文字框編輯；開啟圖片（png、jpg/jpeg、gif、webp）→ 只預覽；其他檔案 → 顯示「無法預覽」。
- 在某個資料夾（含根目錄）新增檔案或資料夾。
- 手動儲存（按鈕與 Cmd/Ctrl+S），存檔時比對開啟時的內容指紋，防止蓋掉別處的修改。
- 草稿按「公司 + 路徑」存著，切換分頁、關閉再打開 drawer 後都還在，直到儲存、捨棄或關閉 App。

## 不做

- 刪除、搬移、改名、複製、批次操作、拖放。
- 語法高亮、行號、外部編輯器元件（第一版用純文字框）。
- 搜尋檔案、自動存檔、檔案變動即時推送（檔案樹不自動刷新，有手動重新整理）。
- 機場與任務工作樹的檔案。
- 模擬器（`MOCK`）：跟終端機一樣，模擬器沒有真的資料夾，不顯示這個分頁。

## 主要流程

1. **打開分頁**：點「檔案瀏覽」分頁（在「終端機」右邊；模擬器沒有終端機時也不出現）。左邊（或上方，依版面）是檔案樹，列出專案資料夾根目錄這一層；資料夾在前、檔案在後，各自依名稱排序（不分大小寫）。
2. **展開資料夾**：點資料夾或在它上面按 Enter／Space → 讀那一層並展開；再按一次收合。展開過的內容在分頁內保留，收合再展開不必重讀；有「重新整理」可重讀已展開的資料夾。
3. **開啟檔案**：點檔案 → 右邊（或下方）顯示：
   - 文字檔：檔名、相對路徑、文字框（內容就是檔案原文），「儲存」按鈕。
   - 圖片：圖片預覽，不能編輯。
   - 其他（二進位、非 UTF-8、超過 1 MiB 的文字檔）：顯示「無法預覽」，附原因（不是文字檔／太大），以及「在 Finder 顯示」所在資料夾（沿用既有 `open-folder`）。
4. **編輯與儲存**：改文字後檔名旁出現未儲存標記，檔案樹上這個檔案也標示未儲存。按「儲存」或 Cmd/Ctrl+S（焦點在編輯區內時；要擋掉瀏覽器自己的存檔對話框）→ 送出內容與開啟時的指紋 → 成功後指紋換成新的、標記消失。
5. **衝突**：檔案在開啟後被別處改過（員工、終端機、外部編輯器），後端拒絕寫入 → 顯示「檔案已在別處被修改」，提供「重新讀取」（捨棄草稿、讀新版本）和「保留我的修改」（留在畫面上，讓使用者自行複製）。不提供強制覆寫。
6. **新增檔案／資料夾**：在檔案樹的資料夾列（含根目錄）有「新增檔案」「新增資料夾」→ 在那一層出現名稱輸入框 → Enter 送出、Esc 取消 → 成功後那一層重讀並選到新項目；新檔案直接開啟（空白內容）。失敗時錯誤顯示在輸入框旁，輸入框保留讓使用者修正。
7. **關閉檔案**：有「關閉」；有未儲存內容時先確認「捨棄未儲存的修改？」，確認才丟掉草稿。
8. **切換開啟的檔案**：從 A 換到 B 時，A 的草稿保留（樹上仍標示未儲存），不跳確認；回到 A 看到的是草稿。
9. **離開**：關閉公司 drawer 或換到別的公司時，若這間公司有未儲存的草稿 → 跳確認，可以「留下」或「離開」（離開後草稿仍保留在記憶體，回來還在）。網頁版重新整理或關閉頁面時，若任何公司有未儲存草稿 → 用瀏覽器的 `beforeunload` 提醒。

## 邊界與錯誤情況

| 情況 | 期望行為 |
| --- | --- |
| 公司還沒設專案資料夾，或資料夾不在了 | 分頁顯示錯誤畫面（說明找不到專案資料夾），不顯示空樹 |
| 空資料夾 | 展開後顯示「空資料夾」，新增按鈕仍可用 |
| 一層裡項目很多（例如 `node_modules` 根層幾千項） | 後端最多回 5000 項並標示 `truncated`；前端在最後顯示「只列出前 5000 項」 |
| 讀取中 | 資料夾列與檔案內容區都有載入中狀態；讀取慢不會卡住其他操作 |
| symlink | 依它指向的東西顯示為資料夾或檔案；指到專案資料夾外面或已斷掉的 link 照樣列出（當作檔案），開啟／展開時回「檔案路徑不正確」或「找不到」 |
| 路徑含 `..`、絕對路徑、經 symlink 繞到資料夾外 | 讀、列、寫、新增全部拒絕（400），訊息「檔案路徑不正確：…」 |
| 文字檔是 CRLF 換行 | 存回去時保持 CRLF，不因文字框把換行改成 LF 而整檔變動 |
| 存檔時檔案已被刪除 | 拒絕（409），提示檔案已不在，可「重新讀取」（會顯示找不到）或保留草稿 |
| 存檔內容超過 1 MiB | 拒絕（400）「太大」 |
| 存檔指紋不符 | 拒絕（409），不寫入，見流程 5 |
| 新增：名稱空白、`.`、`..`、含 `/`、`\`、控制字元、超過 255 bytes | 拒絕（400）「名稱不正確：…」 |
| 新增：同名檔案或資料夾已存在 | 拒絕（409）「已經有 …」 |
| 新增：上層資料夾不存在或不是資料夾 | 404／400，訊息說明 |
| 磁碟寫入失敗（權限等） | 502 `unavailable`，訊息說明寫不進去；原檔不會被寫成半截 |
| 讀取／寫入時網路錯誤 | 顯示錯誤訊息，草稿保留，可再按儲存 |
| 寫入保留檔案原有權限（例如可執行的 script 存完仍可執行） | — |

## 前後端介面

所有路徑在 `/api/v1` 底下。`:id` 是公司 id。`path` 一律是相對專案資料夾、用 `/` 分隔的路徑；空字串代表專案資料夾本身（只有列目錄與新增的上層允許空字串）。

錯誤格式沿用現有：`{"error": {"code": "...", "message": "..."}}`，`message` 已依語言翻好，可直接顯示。

### 1. 列一層資料夾（新）

`GET /teams/:id/tree?path=<資料夾>`

- 200：
  ```json
  {
    "entries": [
      { "name": "src", "path": "frontend/src", "kind": "dir" },
      { "name": "main.go", "path": "backend/main.go", "kind": "file" }
    ],
    "truncated": false
  }
  ```
  - `kind`：`"dir"` 或 `"file"`（跟隨 symlink 判斷；斷掉或指到外面的 link 為 `"file"`）。
  - 排序：`dir` 在前、`file` 在後，同類依名稱不分大小寫排序。
  - 最多 5000 項，超過時 `truncated: true`（截掉排序後面的）。
  - `entries` 沒有東西時是 `[]`，不是 `null`。
- 錯誤：公司不存在 404 `not_found`；路徑不正確或繞出 400 `invalid_request`；資料夾不存在 404 `not_found`；`path` 指向檔案 400 `invalid_request`；專案資料夾未設或不存在 400 `invalid_request`。

### 2. 讀文字檔（擴充既有）

`GET /teams/:id/file?path=<檔案>`

- 200：`{ "text": "...", "hash": "<sha256 十六進位小寫，對檔案原始 bytes 計算>" }`（新增 `hash` 欄位；`/airport/file` 也會帶，舊呼叫者忽略即可）。
- 錯誤：
  - 不是文字檔、超過 1 MiB → **415 `unsupported`**（新的錯誤碼；原本是 400 `invalid_request`），訊息沿用「… 不是文字檔／太大，請到專案資料夾打開」。前端據此顯示「無法預覽」而不是讀取錯誤。`/airport/file` 也一起改成 415。
  - 其餘照舊（400 路徑不正確、404 找不到）。

### 3. 預覽圖片（既有，不變）

`GET /teams/:id/image?path=<檔案>`，前端用 `projectImageUrl` 當 `<img src>`。

### 4. 存檔（新）

`PUT /teams/:id/file`

- 請求：`{ "path": "a/b.txt", "text": "...", "hash": "<開啟時拿到的 hash>" }`
- 200：`{ "hash": "<新內容的 sha256>" }`
- 行為：只能寫已存在的一般檔案（新檔案先用新增端點建立）；寫入前重新計算磁碟上檔案的 hash，與請求的 `hash` 相同才寫；寫入的 bytes 就是 `text` 的 UTF-8（換行由前端保留原樣）；保留原檔權限；寫入失敗不留下半截檔案。
- 錯誤：
  - `hash` 不符 → 409 `conflict`「檔案已在別處被修改，請重新讀取」
  - 檔案已不在 → 409 `conflict`「檔案已不在，請重新讀取」
  - `path` 是資料夾、不正確或繞出 → 400 `invalid_request`
  - `hash` 空白 → 400 `invalid_request`
  - `text` 超過 1 MiB → 400 `invalid_request`
  - 寫不進去 → 502 `unavailable`（沿用 `CodeUnavailable` 現有的狀態碼對應）
  - 原檔不是文字檔（非 UTF-8 或含 NUL）→ 415 `unsupported`

### 5. 新增檔案或資料夾（新）

`POST /teams/:id/tree`

- 請求：`{ "parent": "a/b", "name": "new.txt", "kind": "file" }`；`parent` 空字串表示根目錄；`kind` 是 `"file"` 或 `"dir"`。
- 201：`{ "name": "new.txt", "path": "a/b/new.txt", "kind": "file" }`
- 行為：檔案建成空檔；不會覆蓋已存在的東西（包括競爭時同時被建立的情況）。
- 錯誤：
  - 名稱不合法（見邊界表）或 `kind` 不是 file/dir → 400 `invalid_request`「名稱不正確：…」
  - 已存在同名項目 → 409 `conflict`「已經有 …」
  - `parent` 不正確或繞出 → 400 `invalid_request`
  - `parent` 不存在 → 404 `not_found`；`parent` 是檔案 → 400 `invalid_request`
  - 寫不進去 → 502 `unavailable`

### 沙箱

列目錄、讀、寫、新增全部經過 `usecase/project.go` 的 `projectPath` 同一套檢查（拒絕 `..`、絕對路徑，`EvalSymlinks` 後必須仍在專案資料夾內）。新增時目標還不存在，檢查的是上層資料夾，名稱本身另行驗證。

### 新錯誤碼

`unsupported` → HTTP 415。在 `model/errors.go` 新增常數，`delivery/server.go` 的 `handleError` 對應狀態碼。前端的 `request` 目前只把 `message` 丟出來，前端需要能拿到 `code`（或 HTTP 狀態）以分辨 `conflict`、`unsupported`。

## 分工與檔案

前後端可以同時開工：介面以上面為準。前端在後端完成前可以用測試替身（mock `request`）開發。

### 後端（Backend development）

- `backend/internal/usecase/project.go`：讀檔回 hash、不是文字／太大改用 `unsupported`；新的列目錄、存檔、新增邏輯可放同檔或新檔 `backend/internal/usecase/project_files.go`。
- `backend/internal/usecase/project_test.go`（或新的 `project_files_test.go`）：測試。
- `backend/internal/model/errors.go`：`CodeUnsupported = "unsupported"`。
- `backend/internal/delivery/server.go`：新路由 `GET /teams/:id/tree`、`POST /teams/:id/tree`、`PUT /teams/:id/file`；`/file` 回應加 `hash`；`handleError` 加 415。
- `backend/internal/delivery/*_test.go`：路由層測試（狀態碼與錯誤格式）。
- `backend/internal/i18n/en.go`：所有新的中文訊息的英文對照。

### 前端（Frontend development）

- `frontend/src/DrawerTabs.tsx`：`Tab` 加 `'files'`，`TABS` 放在 `terminal` 後面（模擬器不顯示）。
- `frontend/src/Drawer.tsx`：分頁內容、離開提醒（關 drawer／換公司時的確認、`beforeunload`）。編輯器 chunk 用 `lazy` + `Suspense`（同終端機）。
- 新檔 `frontend/src/FileBrowser.tsx`（樹 + 檢視／編輯區）與其測試。
- 新檔 `frontend/src/fileDrafts.ts`（zustand store，以「公司 id + 路徑」存草稿、開啟時的 hash、原文換行格式）與其測試。
- `frontend/src/core/ops.ts`：`listProjectTree`、`saveProjectFile`、`createProjectEntry`；`readProjectFile` 回傳含 `hash`（既有呼叫者 `DrawerDetail.tsx` 的 `ProjectFileDetail` 跟著調整，只取 `text`）。`core/ops.test.ts` 補測試。
- `frontend/src/core/backend.ts`：`request` 丟出的錯誤帶 `code`／`status`（不破壞現有只用 `message` 的呼叫者）。
- `frontend/src/core/i18n.ts`：新標籤的英文（「檔案瀏覽」→ `Files` 等）。
- `frontend/src/fusion.css`：樣式。
- `frontend/src/Help.tsx`、`frontend/src/HelpEn.tsx`、`frontend/src/Help.test.tsx`：新增「檔案瀏覽」說明條目。
- `README.md`、`README-tw.md`（以及 `README-cn.md`、`README-ja.md`、`README-ko.md` 若有對應的功能清單）：功能清單加一行。

兩邊不碰對方的檔案。唯一的先後關係：前端整合測試（實際打後端）要等後端完成；單元測試不需要等。

## 驗收條件

1. drawer 有「檔案瀏覽」分頁（中英文標籤都有），位置在「終端機」旁，可用鍵盤操作。
2. 分頁顯示公司專案資料夾的檔案樹，可展開資料夾；每次只讀被展開的那一層，不排除任何檔案（包含隱藏檔、被 .gitignore 忽略的檔案、.git、node_modules、dist、.cache、.tmp），不展開就不會讀；大型 repo 開啟不卡。
3. 可以開啟文字檔編輯、預覽圖片；非文字且非圖片的檔案顯示無法預覽。
4. 可以新增檔案與資料夾；名稱不合法、已存在或路徑超出專案資料夾時，清楚報錯。
5. 手動儲存，支援 Cmd/Ctrl+S；切換分頁後草稿還在；有未儲存內容時，關閉檔案或離開會提醒。
6. 存檔帶開啟時的內容指紋（雜湊），後端寫入前比對；檔案已被別處改動時拒絕寫入，提示使用者重新讀取，不會蓋掉別人的修改。
7. 所有寫入與新增都經過 projectPath 的同一套沙箱檢查，有測試涵蓋路徑穿越與 symlink 繞出。
8. 載入中、空資料夾、讀取／寫入錯誤都有對應畫面。
9. 後端 go test ./...（在 backend/ 跑）、前端 tsc -b 與 vitest 都通過；應用程式內說明（Help.tsx / HelpEn.tsx）與 README 如有需要一併更新。

（第 2 條依使用者 2026-11-05 的決定修改：原文「不包含 .git、node_modules、dist、.cache、.tmp」改為不排除任何檔案、只讀展開的那一層。）
