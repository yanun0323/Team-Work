# 刪除使用中的藍圖並轉移員工

## 問題

使用者整理藍圖時，想刪掉一個已經不用的藍圖，但只要還有任何員工（不分公司）是用它建立的，就刪不掉：

- 後端 `DeleteBlueprint`（`backend/internal/usecase/admin.go`）回 `CodeConflict`「還有員工是用這個藍圖建立的」。
- 前端藍圖詳情（`frontend/src/DrawerDetail.tsx` 的 `BlueprintDetail`）把刪除鈕變灰，顯示「還有 {users} 位員工使用這個藍圖，無法刪除」。

現在只能一位一位打開員工、改藍圖，全部改完才能刪。員工可能分散在好幾間公司，很難找齊。

## 範圍

- 有員工使用的藍圖也可以刪除：刪除前選一個藍圖，所有使用中的員工一起轉過去，接著刪除原藍圖。
- 所有使用中的員工都轉到**同一個**藍圖（使用者已決定）。
- 沒有員工使用的藍圖，刪除方式和現在一樣（按兩下垃圾桶）。

不做：

- 每位員工各自選藍圖、轉成自訂（之後想個別調整，可以到員工編輯畫面改）。
- 內建藍圖、來源提供的藍圖照舊不能刪；機場員工的藍圖不變。
- 員工的自訂設定（`owner` 是員工的藍圖）不走這個流程，它們本來就不出現在藍圖列表。
- mho 管理工具（`manage.go`）沒有刪藍圖的工具，這次也不加。

## 主要流程

1. 使用者打開一個有員工使用的藍圖。工具列的刪除鈕可以按，不再變灰。
2. 按下刪除鈕，會在上面疊一張「刪除 {藍圖名}」表單，和「解僱」表單的疊法一樣：
   - 「使用中的員工」：列出所有公司裡使用這個藍圖的員工，每列有頭像和名字；如果員工不屬於目前開著的公司，名字後面用淺色字附上公司名。
   - 「轉移到」：藍圖下拉選單（`BlueprintSelect`），選項和雇用時一樣（不含隱藏的、機場的），但不含要刪的這個藍圖。一開始沒有選。
   - 送出鈕「轉移並刪除」，還沒選藍圖前不能按。
3. 按下「轉移並刪除」：表單和藍圖詳情一起關掉。所有使用中的員工改用選好的藍圖，原藍圖從列表消失。
4. 員工的名字、外觀、模型、思考等級、記憶都不變。之後的工作（新的子任務、對話回覆）用新藍圖的 prompt、技能和工具。已經在執行的工作照舊跑完，不中斷。

## 邊界與錯誤情況

- 表單開著時，其他地方把最後一位使用者轉走或解僱：送出時照樣刪除（`to` 沒有作用）。
- 表單開著時，藍圖已經被刪除：表單顯示現有的 `Gone`（已不存在）畫面。
- 選好的目標藍圖在送出前被刪除或隱藏：後端回錯誤，什麼都不改，畫面照現有方式顯示錯誤。
- 重複送出：第一次成功後，第二次回「找不到藍圖」，不會造成其他改動。
- 轉移和刪除在同一次設定變更裡完成：任何一項檢查失敗，就沒有員工被轉移，藍圖也不會被刪。
- 原藍圖是隱藏狀態：照樣可以刪，刪除後從隱藏清單移除（現有行為）。

## 驗收條件

1. 有員工使用的自建藍圖，詳情頁的刪除鈕可以按，按下後開出「刪除 {藍圖名}」表單。
2. 表單列出所有公司裡 `blueprintId` 是這個藍圖的員工，一位不漏；不屬於目前公司的員工，名字後面顯示公司名。
3. 「轉移到」選單不含要刪的藍圖、隱藏的藍圖和機場藍圖；還沒選之前，「轉移並刪除」不能按。
4. 按下「轉移並刪除」後，這些員工的 `blueprintId` 都變成選好的藍圖，原藍圖不在 `world.blueprints` 裡，也不在隱藏清單裡。
5. 轉移後，員工的名字、外觀、模型、思考等級和記憶都和轉移前相同。
6. 沒有員工使用的藍圖，刪除流程和現在相同：按兩下垃圾桶就刪除，不開表單。
7. 內建藍圖和來源提供的藍圖，詳情頁沒有刪除鈕；直接呼叫 API 刪除，也會回現有的錯誤。
8. `DELETE /api/blueprints/{id}` 不帶 `to`，而且還有員工使用時，回 409 和現有訊息「還有員工是用這個藍圖建立的」，什麼都不改。
9. `to` 是要刪的藍圖本身、不存在、是員工的自訂設定、是機場藍圖或是隱藏的藍圖時，API 回錯誤（錯誤碼見介面一節），沒有員工被改，藍圖也還在。
10. `id` 是員工的自訂設定時，API 回 404「找不到藍圖」，自訂設定不被刪除。
11. 模擬模式（`MOCK`）的行為和真實後端相同：`sim.deleteBlueprint` 帶 `to` 時會轉移並刪除，不帶 `to` 而且還有員工使用時不刪除。
12. 新增的介面文字在英文、簡體中文、日文、韓文介面都有翻譯；不再使用的「還有 {users} 位員工使用這個藍圖，無法刪除」從各語言表中移除。
13. 後端與前端的測試、建置都通過（`make test` 或專案現有的對應指令）。

## 技術決策

### 決策 1：一個 API 呼叫完成轉移與刪除

選擇：`DELETE /api/blueprints/:id?to=<藍圖 id>`，後端在同一個 `doSettings` 裡轉移所有員工再刪除。

- 採用原因：一次寫入，不會出現轉了一半、藍圖卻沒刪的狀態；和解僱的 `DELETE /replicas/:id?heir=` 寫法一致。
- 不採用「前端逐一呼叫 `PATCH /replicas/:id` 改藍圖，最後再 `DELETE`」：要送 N+1 次請求，中途失敗會留下轉了一半的狀態，而且其他公司的員工也要前端自己找齊。
- 不採用「新增 `POST /blueprints/:id/transfer`」：多一個端點，刪除時還是要再呼叫一次，同樣不是一次完成。

### 決策 2：直接改 `BlueprintID`，不經過 `UpdateReplica`

使用中的員工 `BlueprintID` 等於要刪的藍圖，所以他們都沒有自訂設定，不用呼叫 `dropOwnBlueprint`。直接改欄位最簡單；目標藍圖的檢查（可雇用、沒隱藏）在迴圈前只做一次。

### 決策 3：刪除入口沿用疊表單的方式

新增 `Item` 種類 `{ kind: 'blueprintDelete'; id: string }`，做法和 `fire` 一樣：在藍圖詳情上方疊一張表單。不在詳情頁內展開選單，因為員工清單和下拉選單放在一起比較清楚，而且和「解僱」的操作一致。

## 介面

### 後端

`DELETE /api/blueprints/:id`

| 參數 | 位置 | 說明 |
| --- | --- | --- |
| `id` | 路徑 | 要刪除的藍圖 |
| `to` | query，選填 | 使用中的員工要轉去的藍圖 id；沒有人使用時忽略 |

成功：和現在一樣（`done(c, nil)` 的回應）。之後會照現有方式推送設定變更事件。

錯誤：沿用 `model.Errorf` 和現有的 HTTP 對應。檢查依下表由上往下，第一個不符合的就回傳：

| 情況 | 錯誤碼 | 訊息 |
| --- | --- | --- |
| 藍圖不存在，或是員工的自訂設定（`Owner != ""`） | `CodeNotFound` | 找不到藍圖（現有） |
| 內建或來源提供（`errLocked`） | `CodeConflict` | 現有訊息 |
| 有人使用，沒有 `to` | `CodeConflict` | 還有員工是用這個藍圖建立的（現有） |
| 有人使用，`to == id` | `CodeInvalid` | 要轉移到另一個藍圖（新增） |
| 有人使用，`to` 不存在、是自訂設定（`hireableBlueprint(to, "") == nil`）或是機場藍圖 | `CodeNotFound` | 找不到要轉移到的藍圖（新增） |
| 有人使用，`to` 已隱藏 | `CodeInvalid` | 這個藍圖已隱藏（現有） |

`Engine.DeleteBlueprint(id, to string) error`：簽名多一個參數。`server.go` 的 `deleteBlueprint` 傳 `c.QueryParam("to")`。現有測試呼叫處補上 `""`。

新增的兩則訊息加進 `backend/internal/i18n/{en,ja,ko,zh_hans}.go`。

### 前端

- `core/ops.ts`：`deleteBlueprint(w, id, to?)`，真實模式送 `DELETE /blueprints/${id}`，有 `to` 時加 `?to=${encodeURIComponent(to)}`。
- `core/domain/sim.ts`：`deleteBlueprint(w, id, to?)`。有人使用時，`to` 必須是存在、`owner` 為空、不是 `AIRPORT_BLUEPRINT`、也不是 `id` 的藍圖，否則回 `false`、不改任何東西。成功時把使用者的 `blueprintId` 改成 `to`，再刪除藍圖，回 `true`。這裡的隱藏清單在 prefs，模擬模式不檢查。
- `Pickers.tsx`：`BlueprintSelect` 加選填的 `exclude?: string`，把那個 id 從選項中拿掉。
- `DrawerDetail.tsx`：
  - `Item` 加 `{ kind: 'blueprintDelete'; id: string }`，在 render 裡接上新的 `BlueprintDelete` 表單。
  - `BlueprintDetail`：`users > 0` 時，刪除鈕是一般的垃圾桶按鈕（`aria-expanded` 標示表單是否開著），按下後 `onPush({ kind: 'blueprintDelete', id })`；`users === 0` 時照舊用 `DeleteTool`。
  - `BlueprintDelete`：照「流程」一節的版面。送出時先關表單和詳情（同 `onGoneBlueprint`），再 `act((x) => void deleteBlueprint(x, id, to))`。
- 新的 `tr` 文字：「刪除 {name}」（可能已經有，先查）、「使用中的員工」（已有）、「轉移到」、「轉移並刪除」。加進 `core/i18n.ts` 的 `en` 和 `core/locales/{zhHans,ja,ko}.ts`，並移除不再使用的「還有 {users} 位員工使用這個藍圖，無法刪除」。

## 工作拆分

前後端介面已經定好，兩邊可以同時做，各自改的檔案沒有重疊。

| # | 工作 | 誰 | 改的檔案 | 完成條件 |
| --- | --- | --- | --- | --- |
| 1 | 後端：`DeleteBlueprint(id, to)` 轉移後刪除、錯誤檢查、翻譯 | 後端開發 | `backend/internal/usecase/admin.go`、`backend/internal/delivery/server.go`、`backend/internal/i18n/*.go`、`backend/internal/usecase/*_test.go` | 驗收條件 4、5、7、8、9、10 都有測試涵蓋並通過；測試要包含員工分散在兩間公司、轉移失敗時沒有任何改動 |
| 2 | 前端：ops、sim、`BlueprintSelect.exclude`、刪除表單、翻譯 | 前端開發 | `frontend/src/core/ops.ts`、`frontend/src/core/domain/sim.ts`、`frontend/src/core/domain/sim.test.ts`、`frontend/src/Pickers.tsx`、`frontend/src/DrawerDetail.tsx`、`frontend/src/DrawerDetail.test.tsx`、`frontend/src/core/i18n.ts`、`frontend/src/core/locales/*.ts` | 驗收條件 1、2、3、6、11、12 都有測試涵蓋並通過；前端建置通過 |
| 3 | 驗收：逐條驗證驗收條件 1–13 | 驗收 | 不改檔案 | 每條都有結果和依據 |

順序：1 和 2 同時做，都完成後才做 3。

## 風險

| 風險 | 影響 | 處理 |
| --- | --- | --- |
| 正在執行的工作在轉移後，是否仍用舊藍圖的設定 | 如果執行途中重新讀藍圖，而藍圖已刪除，可能出錯 | 後端開發先確認 `run.go`／`prompt.go` 在執行途中是否會依 `BlueprintID` 再讀藍圖；如果會，要確認讀到新藍圖時不會出錯，並補測試。這是最需要先確認的一點 |
| 其他地方有快取藍圖 id（例如對話、任務快照） | 轉移後可能還指向舊 id | 用 `grep BlueprintID` 檢查；任務的 `Workflow` 快照只記員工 id，不記藍圖，目前看不受影響 |
| 刪除後無法復原 | 誤刪就要手動重建藍圖、手動把員工轉回來 | 用表單明確列出受影響的員工，並且要先選目標才能送出；這次不做復原功能 |

## 未決事項

無。轉移方式（全部轉到同一個藍圖）已由使用者決定。
