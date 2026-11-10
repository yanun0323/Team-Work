# 電塔：配對遠端電腦，並切換到對方的島（規格）

任務 #34。這份文件寫「要做到什麼」，實作方式由前後端自行決定；但第 7 節的介面是前後端之間的約定，改動前要兩邊都同意。

## 1. 問題

使用者有好幾台裝了 Team Work 的電腦，現在每台各自為政：要看另一台上的公司、任務、聊天，只能走到那台電腦前。目標是兩台配對一次之後，就能從自己的地圖「前往」對方的島，直接操作那座島。島上的公司、員工、模型供應商、員工藍圖、任務藍圖都用對方電腦的設定，工作也在對方電腦上執行。本機關掉或斷線時，對方電腦上的工作照常進行。

## 2. 名詞

| 名詞 | 意思 |
| --- | --- |
| 本機 | 使用者正在看的這台電腦（畫面和它的後端）。 |
| 對方、遠端 | 配對過的另一台電腦。 |
| 被操作的那台 | 這次要被別台操作的電腦，也就是在配對時「開始等待配對」、按下同意的那台。 |
| 允許它操作我 | 本機對每台配對電腦各有一個開關。開著，對方才能操作本機。 |
| 配對位址 | 被操作的那台開始等待配對時，畫面上顯示的一串 Tailcat 位址（`tc` 開頭，大約 250 個字元）。只在這次等待期間有效。 |
| 通行證 | 配對成功時兩台各自發給對方的隨機祕密。對方每個請求都要附上它。 |
| 遠端入口 | 每台電腦另外開的一個入口，只透過 Tailcat 接受配對電腦的請求，和原本只給本機用的 API 入口分開。 |
| 遠端相容版本 | 後端程式裡的一個整數，從 1 開始。只要 World 或 API 的格式改到不相容，就要往上加。兩台的這個數字一樣，才算相容。 |

## 3. 已確認的決定

1. 連線用 Tailcat 的 Go 函式庫（`github.com/tailscale/tailcat`），版本固定在正式版 **v0.7.0**（使用者選的）。v0.7.0 沒有連線層的允許名單（`AllowClient`），也沒有查出連進來的是哪台電腦（`PeerKey`）的功能，所以**誰能進來，完全靠通行證決定**。
2. 每一組配對各自決定方向：配對成功後，被操作的那台對這台電腦的「允許它操作我」預設開著；發起配對的那台對被操作那台的開關預設關著。之後哪一台想讓對方操作自己，在自己的電塔裡把開關打開就好，不用再配對一次。打開開關的人就是被操作那台的使用者，所以這也算「被操作的那台同意」。
3. 只做「自己的幾台電腦互連」：連上就能操作整座島，不做「只開放某間公司」這類細分權限。
4. 在對方的島上，**介面偏好和語言維持本機的**（使用者選的）。介面偏好和「島上工作設定」怎麼分，見 6.4。
5. 相容與否看「遠端相容版本」，不看 App 版本號（使用者選的）。
6. 這一版不做「把自己的藍圖複製到對方的島」。
7. 被操作的那台必須開著 Team Work，因為後端跟著 App 一起關（`backend/cmd/server/main.go` 的 `-desktop`：stdin 一關就停）。這是限制，不用處理。

## 4. Tailcat 實驗結果（2026-11-10，本機兩個行程，經官方免費中繼站）

實驗程式沒有留下來，結果記在這裡。

| 項目 | v0.7.0 結果 |
| --- | --- |
| 包進後端（Go 函式庫，不用另外安裝） | 可以。後端執行檔（`-s -w`）會從約 21MB 增加到約 40MB。`go.mod` 會加入 `tailscale.com` 等不少間接依賴，`github.com/gorilla/websocket` 會被拉到 `v1.5.4-0.20250319132907-e064f32e3674`。 |
| 伺服器端 | `tailcat.Server{Key, PresharedKey, Logf}` 加上 `Start()`，再用 `Server.Listen(ctx, "tcp", ":80")` 拿到 `net.Listener`，直接交給 `http.Server.Serve`。 |
| 用戶端 | `tailcat.Client{Server: addr, Key, Logf}`。HTTP 要用 `DialTCPPort(ctx, 80)` 當 `http.Transport.DialContext`，**不能用** `Client.Dial`，因為 `Dial` 會真的去 DNS 查主機名稱，然後失敗。 |
| HTTP | 可以。第一次請求約 1.3 秒（含建立通道）。 |
| WebSocket | 可以（gorilla `websocket.Dialer{NetDialContext: ...}`），雙向收發都正常。 |
| 位址不變 | 伺服器的 `Key` 和 `PresharedKey` 用 `MarshalText`/`UnmarshalText` 存起來再讀回，重啟後位址完全一樣。 |
| 斷線重連 | 伺服器重啟後，**原本那個 `Client` 物件再也連不回來**（重試 5 分鐘都逾時）；**換一個新的 `Client` 物件**（同一把金鑰）1.2 秒就連上，HTTP 和 WebSocket 都正常。所以重連要丟掉舊的 `Client`，重新建一個。 |
| 伺服器關掉時的 WebSocket | 用戶端不會收到關閉通知，只會讀到逾時。所以要靠心跳或讀取期限，才發現得了斷線。 |
| 位址錯誤 | 格式錯誤，解析時馬上就會失敗；格式對但沒人在聽的位址，只會一直等到逾時，不會有「被拒絕」的回應。 |
| 沒測到 | 兩台真正不同的電腦、跨網路直連打洞、中繼站限速下的速度。 |

注意：位址裡含有 WireGuard 的預共用金鑰（pre-shared key），本身就是祕密。官方免費中繼站有流量限制，也沒有服務保證。

## 5. 範圍

### 5.1 要做

- (a) 地圖上的電塔建築，和電塔裡的配對清單畫面。
- (b) Tailcat 連線和配對流程，配對資料要能保存。
- (c) 只給配對電腦用的遠端入口，以及每個請求都要驗通行證。
- (d) 切換到對方的島：畫面接到對方的後端，換成對方的 World；一直標示目前在哪台電腦，隨時能回自己的島。
- 在對方島上不能用、或會在對方螢幕上跳視窗的功能，要改掉或停用。
- 版本相容檢查、斷線重連、不重複執行同一個操作。
- Help（中、英、日、韓、簡中）和 README（5 種語言）補上電塔的說明。

### 5.2 不做

- 「只開放某間公司」這類細分權限；把藍圖複製到對方的島。
- 讓電腦只能當控制端或只能當被控制端的全機設定。
- 修改配對電腦的名稱（顯示對方回報的電腦名稱就好）。
- 在對方的島上時，繼續收本機的即時更新和通知（回到自己的島就會收到最新狀態）。
- 自架中繼站、改用其他連線方案。
- 讓對方的電塔可以被遠端管理（遠端入口一律擋下電塔相關 API）。
- 「它現在正在操作我」的即時提示。

## 6. 主要流程

### 6.1 電塔建築與清單（a）

- 地圖上固定有一座電塔，和機場一樣不能移動；放公司時不能放在它上面，`layout.ts` 的佔地檢查要把它算進去。外觀參考機場的做法（`frontend/src/Airport.tsx`），位置由前端決定，靠近機場、不擋住現有建築就好。
- 點電塔（或用鍵盤選到它再按 Enter）會打開電塔面板，鏡頭移到電塔，做法和機場打開設定一樣。地圖名牌標示「電塔」，各語言名稱建議：中「電塔」、英「Power Tower」、日「電波塔」、韓「송전탑」、簡中「电塔」。
- 面板內容：
  - **已配對的電腦清單**，每一列有電腦名稱、連線狀態（見 7.2 的 `status`）、「允許它操作我」開關、「前往」按鈕、「解除配對」按鈕（要再確認一次）。
  - **「等待配對」**：按下去後顯示配對位址（可以一鍵複製）、剩下的等待時間、「停止等待」。等待期間有人來請求配對，就顯示對方的電腦名稱，以及「同意」和「拒絕」。
  - **「連到別台」**：一個輸入配對位址的欄位加送出。送出後顯示「正在連線」，接著是「等待對方同意」，最後顯示結果。
  - 沒有配對時，清單位置顯示清楚的空白畫面，說明先在要被操作的那台按「等待配對」，再把位址輸入到這台（字句要短，照全域規則不要放多餘說明）。
- 整個流程只用鍵盤也能操作：Tab 順序合理，開關、按鈕、輸入欄都能聚焦，Esc 關閉面板，焦點要看得見。
- 面板打開時，前端每 3 秒向本機後端讀一次清單（7.2 的 `GET /towers`）。讀取中、讀取失敗都要有狀態顯示。
- 在對方的島上點電塔，打開的仍然是**本機**的電塔（7 節裡 `/api/v1/towers…` 的請求一律送本機後端）。在那裡可以回自己的島，或改去別台。

### 6.2 配對（b）

以「A 要操作 B」為例，B 就是被操作的那台。

1. B 在電塔按「等待配對」。B 的後端開一個**一次性**的 Tailcat 伺服器，回傳配對位址和到期時間（10 分鐘）。畫面顯示位址。
2. 使用者把位址帶到 A（自己複製貼上），在 A 的電塔「連到別台」輸入後送出。
   - 格式錯了：A 馬上顯示「配對位址格式不正確」，不會連線。
   - 輸入的是自己正在等待的位址：A 顯示「不能和自己配對」。
3. A 的後端連到這個位址，把自己的電腦名稱、電腦 ID、遠端相容版本、A 的長期位址、A 發給 B 的通行證送過去。A 的畫面顯示「等待對方同意」。
   - 30 秒內連不上：A 顯示「連不上這個位址，請確認位址正確、對方還在等待配對」。
4. B 的畫面出現「A 想要配對」，以及「同意」和「拒絕」兩個按鈕。
   - 兩邊的遠端相容版本不一樣：B 不給同意，自動回絕。兩邊都顯示「版本不相容」，並寫明要更新哪一台（數字小的那台）。
   - B 正在處理另一個請求：後來的 A 收到「對方正在處理另一個配對請求」。
   - A 放棄（關掉 App 或斷線）：B 畫面上的請求消失。
5. B 按「拒絕」：A 顯示「對方拒絕了配對」，B 回到等待狀態，或照 B 的選擇停止等待。B 按「同意」：B 把 B 的名稱、ID、相容版本、B 的長期位址、B 發給 A 的通行證回傳給 A。
6. 兩邊都存下對方的資料。B 對 A 的「允許它操作我」是**開**，A 對 B 的開關是**關**。這次的配對位址隨即失效，B 停止等待。
7. 10 分鐘到了還沒配對成功：B 停止等待，A（如果在等）顯示「配對等待已結束」。
8. 已經配對過的同一台電腦（電腦 ID 相同）再配對一次：取代舊資料，換發新的通行證，不會出現兩列。

配對之後：

- 每台電腦只要有一台以上配對電腦，就會在背景開著自己的**長期** Tailcat 伺服器，也就是遠端入口；位址每次重開 App 都一樣，所以重開 App 不用重新配對。
- 每台電腦會用對方發的通行證，定時（建議每 30 秒；電塔面板開著時更頻繁）問對方「我能不能操作你」。結果會反映成清單上的狀態：在線可前往、對方沒有允許、對方已解除配對、版本不相容、離線、檢查中。
- 連不上只顯示「離線」，配對照樣保留。只有使用者自己按「解除配對」才會刪掉。
- 解除配對：刪掉本機對這台電腦的所有資料（含雙向通行證），並盡量通知對方。對方收到通知後，把狀態改成「對方已解除配對」，同時讓自己發給這台的通行證失效。那一列留著，讓使用者自己刪掉。對方收不到通知時，下次檢查會得到「通行證不對」，結果一樣是「對方已解除配對」。

### 6.3 遠端入口（c）

- 遠端入口只聽 Tailcat 的長期伺服器，**不是** config 的 host/port。`backend/config/config.go` 限定只能聽本機位址的規定維持不變；原本的 API 入口和 `guard` 也不改寬。
- 每個請求都要在 `Authorization: Bearer <通行證>` 標頭附上通行證。**不接受**放在網址參數裡。檢查順序如下：
  1. 沒有通行證，或找不到相符的配對：401，`unauthorized`。
  2. 本機對這台的「允許它操作我」是關的：403，`peer_denied`。
  3. 都通過後，才轉給原本的 API。
- 撤銷配對或關掉開關，**立刻**生效：之後的請求照上面的規則擋下；這台電腦已經開著的長連線（`/events`、終端機的 WebSocket）也要立刻斷掉。
- 轉給原本 API 時：
  - 只轉 `/api/v1/` 底下的路徑，其他路徑（例如前端靜態檔）一律回 404。
  - 移除 `Authorization`、`Origin`、`Cookie` 標頭，`Host` 改成本機位址，讓原本的 `guard` 照常放行。這些請求不能被當成從本機回環位址（loopback）來的：例如 `/api/v1/diagnostics` 檢查的是連線來源位址，必須照樣擋住。
  - **一律擋下**以下路徑（403，`remote_unavailable`）。這些不是會在被操作那台的螢幕上跳出視窗，就是不該從遠端改：
    - `/api/v1/towers` 和底下全部，以及 `/api/v1/remote/…`（不能從遠端管理配對，也不能轉接到第三台）。
    - `POST /api/v1/folder-picker`、`POST /api/v1/settings/open-folder`、`POST /api/v1/teams/:id/open-folder`、`POST /api/v1/airport/open-folder`。
    - `POST /api/v1/git/install`（會在對方電腦開 Apple 安裝視窗）。
    - `POST /api/v1/claude-code/login`（會在對方電腦開瀏覽器）。
    - `POST /api/v1/providers/:id/login`，method 是 `browser` 或空白時（瀏覽器登入要開對方的瀏覽器，回呼也落在對方本機；`device` 照常允許）。
    - `PUT /api/v1/settings/language`、`PATCH /api/v1/tutorial`（語言和教學屬於本機）。
    - `/api/v1/diagnostics/…`。
  - `PATCH /api/v1/settings/preferences` 只接受 6.4 的「島上工作設定」欄位，含其他欄位就整個回 400，`invalid_request`。
- 不重複執行（見 6.6）：除了 GET 以外，每個請求都必須帶 `Idempotency-Key`，沒帶就回 400，`invalid_request`。
- 祕密（通行證、Tailcat 私鑰、預共用金鑰、長期位址、配對位址）：
  - 不印到 log。Tailcat 函式庫自己的 log 也要關掉，或過濾掉祕密。
  - 不放進 World 快照，也不放進 `/events` 推送的任何內容。
  - 不出現在本機 API 的回應裡；7.2 只有配對位址例外，因為要讓使用者複製。
  - 不放在設定重新載入（settings reload）會讀的設定檔裡。
- 保存：配對資料存在資料夾（`TEAM_WORK_HOME`）裡，檔案權限只限擁有者（0600）。重開 App 後仍在。被操作的那台只存自己所發通行證的雜湊值，比對時用常數時間比較；需要拿去用的通行證（對方發給我的）才存原文。

### 6.4 切換到對方的島（d）

- 在清單按某台的「前往」：前端先叫本機後端立即檢查那台（7.2 的 `POST /towers/peers/:id/check`）。
  - 狀態是 `online`：切換。
  - 其他狀態：留在原地，顯示原因（離線、對方沒有允許、對方已解除配對、版本不相容，並說明要更新哪一台）。
- 切換時，前端把**所有**後端請求的基底從 `/api/v1` 換成 `/api/v1/remote/{peerId}`（見 7.3）。範圍包括：
  - `request()`、`/events` 的 WebSocket、終端機的 WebSocket；
  - `claudeCode.ts` 自己發的 `fetch`；
  - 圖片和檔案網址（`handedImageUrl`、`projectImageUrl`、附件網址等）。
  - **例外**：電塔 API（`/api/v1/towers…`）、`PUT /settings/language`、`PATCH /tutorial`、介面偏好的寫入，一律送本機。
- 切換過程：先清空畫面上的 World，顯示載入中，等對方的快照到了再畫出對方的島。地圖、建築、公司、員工、任務、聊天、終端機、機場（對方的供應商、藍圖、任務藍圖），都用現有畫面直接顯示。
- **一直標示目前在哪台電腦**：在對方島上時，畫面上固定顯示「正在操作：{對方名稱}」，旁邊有「回到自己的島」按鈕，鍵盤可以操作。在自己島上不顯示（照全域規則不放多餘標示）。
- 回到自己的島：基底換回 `/api/v1`，重新連本機的 `/events`，畫出本機 World。
- App 每次啟動都先在自己的島，不記住上次在哪座島。
- 介面偏好和語言：
  - **島上工作設定**（會影響對方電腦上怎麼工作的偏好，用對方 World 裡的值，在對方島上改的也是對方的）：`terminalCommand`、`chatTitleModel`、`chatTitleEffort`、`imageProvider`、`codexSkills`、`claudeSkills`、`hiddenBlueprints`、`hiddenWorkflows`、`compact1M`、`compact256K`、`compact128K`、`compactSmall`。
  - **其他 `Prefs` 欄位都是介面偏好**，加上 `language` 和教學進度：在對方島上一律用本機的值，不被對方 World 覆蓋。設定頁的介面偏好區在對方島上停用，旁邊說明「回到自己的島再改」。語言選單照樣能用，改的是本機語言。
  - 教學清單和教學提示在對方島上隱藏。
- 本機暫存的東西不能跨島混在一起：聊天草稿、檔案草稿、聊天輸入紀錄、終端機工作階段等以 id 為鍵的暫存，要依電腦分開，或切換時清掉。對方島上的 id 可能剛好和本機的一樣。離開一座島時，那座島的終端機工作階段一律關掉（不管有沒有開「保留終端機」）。
- 對方後端回的錯誤訊息，可能是對方電腦的語言。這可以接受，不用處理。

### 6.5 在對方島上的特殊功能

| 功能 | 在對方島上 |
| --- | --- |
| 新增公司選資料夾 | 改成在畫面裡瀏覽**對方電腦**的資料夾（7.4 的 `GET /folders`，經轉接到對方），不在對方螢幕跳出系統視窗，也不用 Mac App 的原生選資料夾（那會選到本機路徑）。可以從家目錄一層層往下點、回上一層、選定目前這層；只用鍵盤也能操作；讀取中、空資料夾、錯誤都要有狀態顯示。手動輸入路徑的欄位照樣保留。 |
| 打開設定資料夾、在 Finder 打開專案或檔案 | 停用，提示說明「這會在對方電腦上打開視窗，這裡不能用」。 |
| Claude Code 登入 | 停用，說明原因。 |
| 訂閱供應商用瀏覽器登入 | 停用，說明原因；用裝置碼（device）登入和貼上授權碼照常可用。 |
| 介面偏好、教學 | 見 6.4。 |
| 其他（任務、聊天、終端機、檔案瀏覽和編輯、圖片、附件上傳、供應商、藍圖、任務藍圖、公司設定、用量） | 照常，全部在對方電腦上執行。 |

在自己的島上，以上功能的行為都不變。

附件：在對方島上上傳的附件，對方後端回傳的網址是對方視角的 `/api/v1/attachments/<hash>`。送回對方的請求（例如說話時附上）照原樣送；只有顯示（`<img src>`、下載連結）時，前端才把開頭的 `/api/v1/` 換成目前的基底。`data:` 網址不用改。

### 6.6 斷線、重連、不重複

- 前端在**所有**非 GET 請求都加上 `Idempotency-Key`（每個使用者動作產生一個新的隨機值）。在自己的島上，本機後端忽略這個標頭。
- 本機轉接對方時，如果還沒收到對方的回應連線就斷了，會用**同一個** key 自動重試（建議 30 秒內最多 3 次；需要時換一個新的 Tailcat `Client`，見第 4 節）。
- 對方的遠端入口把（配對電腦, key）的回應保留 10 分鐘：
  - 同一個 key 再來一次：直接回傳保留的回應，加上 `Idempotent-Replayed: true` 標頭，不會再執行一次。
  - 第一次還在執行中就收到重複的：等第一次執行完，回傳同一份結果。
- `/events` 斷線：前端每秒重連一次（沿用現在的 `connect`）。重連後拿到的是新快照，所以看到的一定是最新進度；這段期間不會補送、也不會排隊任何操作。
- 在對方島上斷線時，顯示「和 {名稱} 的連線中斷，正在重新連線」，「回到自己的島」照樣能按。重連時發現狀態變成 `denied`、`unpaired`、`incompatible`，或那台已在本機被解除配對：自動回到自己的島，並顯示原因。
- 工作都在對方電腦的引擎上跑，本機關掉或斷線不影響。

### 6.7 版本相容

- 遠端相容版本是後端裡的一個整數常數，從 `1` 開始，旁邊要有註解說明「World 或 API 格式改到不相容時要加 1」。
- 配對時兩邊都要檢查；每次狀態檢查，以及「前往」之前，也要檢查。
- 不相容時清楚寫明要更新哪一台：本機的數字小，就是「這台的 Team Work 太舊，請更新這台」；對方的小，就是「{名稱} 的 Team Work 太舊，請更新那台」。
- 轉接時，本機後端如果已經知道對方不相容，直接回 409，`incompatible`，不把請求轉過去。

## 7. 前後端介面

所有錯誤都沿用現有格式：`{"error":{"code":"…","message":"…"}}`，`message` 可以直接顯示。新增的錯誤碼：

| code | HTTP | 意思 |
| --- | --- | --- |
| `unauthorized` | 401 | 只在遠端入口用：沒有通行證、通行證錯誤或已撤銷。 |
| `peer_denied` | 403 | 對方沒有允許這台操作它。 |
| `peer_unpaired` | 403 | 對方已解除配對（本機轉接時，把對方回的 401 換成這個）。 |
| `remote_unavailable` | 403 | 這個功能在遠端不能用。 |
| `incompatible` | 409 | 遠端相容版本不一樣。 |
| `pair_rejected` / `pair_expired` / `pair_busy` / `pair_self` | 用在 `outgoing.code` | 配對結果，見 7.2。 |

既有的錯誤碼照用：`not_found` 404、`invalid_request` 400、`conflict` 409、`unavailable` 502（對方離線、暫時連不上）。

### 7.1 型別（JSON）

```ts
type PeerStatus = 'checking' | 'online' | 'offline' | 'denied' | 'unpaired' | 'incompatible'

interface Peer {
  id: string            // 對方的電腦 ID
  name: string          // 對方回報的電腦名稱
  status: PeerStatus    // 這台能不能操作對方：online 才能前往
  allowInbound: boolean // 本機的「允許它操作我」
  protocol?: number     // 對方的遠端相容版本，最近一次知道的
  lastSeenAt?: number   // 最近一次連上的時間，Unix 秒
  pairedAt: number      // Unix 秒
  message?: string      // status 不是 online 時的說明，可以直接顯示（例如要更新哪一台）
}

interface Towers {
  me: { id: string; name: string; protocol: number }
  pairing: null | {           // 本機正在等待配對
    address: string           // 配對位址（只在這裡出現）
    expiresAt: number         // Unix 秒
    request: null | { id: string; name: string; protocol: number; compatible: boolean }
  }
  outgoing: null | {          // 本機發出的配對請求
    state: 'connecting' | 'waiting' | 'paired' | 'failed'
    name?: string             // 對方名稱，連上之後才有
    code?: string             // failed 時：invalid_request | unavailable | pair_rejected | pair_expired | pair_busy | pair_self | incompatible
    message?: string          // failed 時可以直接顯示
    peerId?: string           // paired 時
  }
  peers: Peer[]               // 依 pairedAt 排序
}
```

### 7.2 電塔 API（只在本機，遠端入口一律擋下）

| 方法與路徑 | 輸入 | 回應 | 錯誤 |
| --- | --- | --- | --- |
| `GET /api/v1/towers` | — | 200 `Towers` | — |
| `POST /api/v1/towers/pairing` | — | 201 `Towers['pairing']`；已經在等待就回現有的那筆 | 502 `unavailable`（連不上中繼站） |
| `DELETE /api/v1/towers/pairing` | — | 204 | — |
| `POST /api/v1/towers/pairing/approve` | `{ "requestId": string }` | 201 `Peer` | 404 `not_found`（請求已經不在）、409 `incompatible` |
| `POST /api/v1/towers/pairing/reject` | `{ "requestId": string }` | 204 | 404 `not_found` |
| `POST /api/v1/towers/pair` | `{ "address": string }` | 202 `Towers['outgoing']`；結果之後從 `GET /towers` 讀 | 400 `invalid_request`（格式錯誤，立即回）、400 `pair_self`、409 `conflict`（已經有一筆在進行） |
| `DELETE /api/v1/towers/outgoing` | — | 204（取消進行中的請求，或清掉已顯示的結果） | — |
| `PATCH /api/v1/towers/peers/:id` | `{ "allowInbound": boolean }` | 200 `Peer` | 404 `not_found` |
| `POST /api/v1/towers/peers/:id/check` | — | 200 `Peer`（立即檢查，最多等 15 秒） | 404 `not_found` |
| `DELETE /api/v1/towers/peers/:id` | — | 204 | 404 `not_found` |

`message` 用本機語言（`i18n.T`）。

### 7.3 轉接到對方

- `ANY /api/v1/remote/:id/*`：轉到對方遠端入口的 `/api/v1/*`。查詢字串、請求內容、`Content-Type`、`Idempotency-Key` 原樣帶過去；WebSocket 升級（`/events`、`/teams/:id/terminal`、`/airport/terminal`）也一樣轉接，雙向收發。
- 對方的回應（狀態碼、內容、`Content-Type`、`Idempotent-Replayed`）原樣傳回前端，只有下面這幾種會換掉：
  - 找不到這台配對：404 `not_found`。
  - 連不上：502 `unavailable`，訊息「連不上 {名稱}」。
  - 對方回 401：403 `peer_unpaired`。
  - 對方回 403 `peer_denied`：403 `peer_denied`，訊息改用本機語言。
  - 已知不相容：409 `incompatible`。
- 這條路徑一樣要先過本機的 `guard`（瀏覽器只能從本機頁面來）。

### 7.4 瀏覽資料夾（新的一般 API，本機和遠端都能用）

`GET /api/v1/folders?path=<絕對路徑>`。`path` 空白時從家目錄開始。

- 200：`{ "path": string, "parent": string | null, "home": string, "folders": [{ "name": string, "path": string }] }`
  - 只列子資料夾，不列檔案，不列 `.` 開頭的隱藏資料夾，依名稱排序。
  - 跟著符號連結走，但只列出指向資料夾的連結。
- 錯誤：
  - 路徑不是絕對路徑：400 `invalid_request`。
  - 不存在：404 `not_found`。
  - 不是資料夾：400 `invalid_request`。
  - 沒有權限讀：400 `invalid_request`，訊息寫明「沒有權限讀取這個資料夾」。

### 7.5 遠端入口（後端對後端，前端不會直接用）

只要兩邊後端一致就好，前端不受影響。這裡列出必要的部分：

- 長期伺服器、遠端入口：
  - `GET /tower/v1/hello`：要帶通行證。回 `{id, name, protocol}`；失敗時回 401 `unauthorized` 或 403 `peer_denied`。
  - `POST /tower/v1/unpair`：要帶通行證，通知對方「我解除了配對」。
  - `/api/v1/*`：照 6.3 處理。
- 一次性的配對伺服器只接 `GET /tower/v1/pair` 的 WebSocket 升級。連線會一直等，直到同意、拒絕、到期或放棄為止。每 2 秒雙向確認存活，10 秒未回應就移除請求；同意前另做一次帶隨機挑戰值的往返確認。停止等待或到期時，送出 `pair_expired` 並等待發起方確認收到（最多 10 秒），才關閉 Tailcat 入口，避免結果被入口關閉丟棄。
- 各種 key、通行證、位址在雙方之間怎麼交換，由後端決定，但要符合 6.2 和 6.3。

## 8. 邊界與錯誤情況（整理）

- 配對位址格式錯誤、和自己配對、連不上、被拒絕、到期、對方忙碌、版本不合：兩邊都看得到清楚的訊息（6.2）。
- 同一台重新配對：取代舊資料，不會變成兩列。
- 被操作的那台關掉 App：對方的清單顯示離線，配對保留；那台重開後自動恢復在線，不用再配對。
- 本機關掉 App：對方電腦上的任務、聊天照樣執行；本機重開後再前往，看到的是最新進度。
- 正在對方島上時，那台把開關關掉：本機的請求立刻被拒，`/events` 斷線，前端回到自己的島並說明原因。
- 正在對方島上時，本機在電塔解除了這台的配對：回到自己的島。
- 轉接的請求斷在半途：用同一個 key 重試，對方不會執行兩次；重試都失敗時，顯示「連不上 {名稱}」，畫面上不會自己再送一次。
- 對方的中繼站限速，或連線很慢：載入中要一直有狀態顯示，不能卡住整個畫面。「回到自己的島」隨時能按。
- 兩台互相都開了允許：兩邊都可以前往對方，互不影響。
- Mock 模式（`make dev-mock`）：電塔照常顯示，清單是空的，配對和前往的按鈕停用，並說明「模擬模式不能配對」。

## 9. 驗收條件

1. 地圖上有電塔，點進去能看到已配對的電腦、各自的連線狀態，以及「允許它操作我」的開關；沒有配對時有清楚的空白畫面，整個流程只用鍵盤也能操作。
2. 兩台電腦能透過 Tailcat 完成配對：一台產生位址，另一台輸入，被操作的那台按同意後才算配對成功；拒絕或位址錯誤時，雙方都會看到清楚的訊息。
3. 配對過後，重新開啟 App 或斷線重連時，都不用再配對一次。
4. 撤銷配對或關掉「允許它操作我」之後，對方的請求立刻被拒絕。
5. 沒有通行證、通行證錯誤或通行證已撤銷的請求，都進不了遠端入口，也碰不到原本只給本機用的服務；這點要有測試。
6. 能從電塔「前往」對方的島，看到並操作對方的公司、員工、任務、聊天和終端機，用的是對方電腦的模型和設定；畫面一直標示目前在哪台電腦，也能隨時回到自己的島。
7. 在對方的島上新增公司時，在畫面裡瀏覽和挑選對方電腦的資料夾，不會在對方螢幕上跳出系統視窗。
8. 本機 App 關閉或斷線時，對方電腦上的任務繼續執行；重新連上後看到的是最新進度，而且沒有重複執行的操作。
9. 兩邊版本不相容時，連線前就清楚告訴使用者要更新。
10. 配對時產生的祕密不會出現在 log 或 World 裡。
11. 後端 `go test -count=1 ./...`（在 backend/ 裡跑）、前端 `tsc -b` 和 `vitest run --no-fsModuleCache` 都通過；做不到實際兩台電腦測試的部分，在交接裡寫明。

### 每條要怎麼驗

| # | 驗證方式 |
| --- | --- |
| 1 | 前端測試：電塔畫面在空清單、有資料、讀取中、讀取失敗時的顯示；開關和按鈕有可聚焦的 role 和 label；Esc 可以關閉。地圖佔地測試：公司不能放在電塔上。 |
| 2 | 後端測試：用假的 Tailcat 傳輸跑完整配對流程，包含同意、拒絕、格式錯誤、連不上、到期、忙碌、和自己配對、版本不合，檢查雙方的 `Towers` 狀態和訊息。前端測試：`outgoing` 和 `pairing` 各種狀態的顯示。 |
| 3 | 後端測試：配對後重新建立服務（同一個資料夾），長期位址不變，用原本的通行證照樣能通過遠端入口；轉接斷線之後會換一個新的連線重連。 |
| 4 | 後端測試：撤銷或關掉開關之後，下一個請求得到 401 或 403；已開著的 `/events` WebSocket 被關掉。 |
| 5 | 後端測試：遠端入口的處理器收到沒有、錯誤、已撤銷的通行證，以及通行證放在網址參數裡時，都回 401，而且原本的 API 處理器沒有被呼叫；被擋的路徑（6.3 列出的全部）都回 403 `remote_unavailable`；`/api/v1/` 以外的路徑回 404；轉過去的請求不帶 `Authorization`，也不會被當成從本機回環位址（loopback）來的。 |
| 6 | 前端測試：切換基底之後，`request`、`/events`、終端機、`claudeCode.ts`、圖片和附件網址都用 `/api/v1/remote/{id}`，電塔、語言、教學、介面偏好的請求仍然送本機；有「正在操作」標示和回家按鈕；介面偏好不被對方的 World 覆蓋；暫存資料不跨島。手動測試寫在交接。 |
| 7 | 後端測試：`GET /folders` 的正常、空白、不存在、不是資料夾、相對路徑等情況。前端測試：在遠端模式下，新增公司用畫面內的瀏覽器，不會呼叫 `/folder-picker`，也不會用 Mac App 的原生選資料夾。 |
| 8 | 後端測試：同一個 `Idempotency-Key` 送兩次只執行一次，第二次帶 `Idempotent-Replayed: true`；兩次同時送也只執行一次；非 GET 請求沒有 key 就回 400；轉接斷在半途時，用同一個 key 重試。 |
| 9 | 後端測試：配對時版本不同會被拒，「前往」前的檢查回 `incompatible`，而且訊息寫明要更新哪一台。前端測試：顯示這個訊息，並且不會切換。 |
| 10 | 後端測試：跑完一次配對後，log 輸出、World 快照、`/events` 推送和 `GET /towers` 的 `peers` 裡，都找不到通行證、位址、金鑰的字串；檔案權限是 0600。 |
| 11 | 跑指令。後端測試不能連網路，Tailcat 要能換成記憶體裡的假傳輸。 |

## 10. 前後端分工

兩邊可以同時開始。前端照第 7 節的介面寫，測試時用假資料就好，不用等後端。

### 10.1 後端

要做：6.2、6.3、6.6、6.7 的全部，7.2 到 7.5 的所有路徑，祕密的保存，加入 Tailcat v0.7.0 依賴，`GET /folders`，還有各語言的訊息。

會改或新增的檔案（前端不碰）：

- `backend/go.mod`、`backend/go.sum`
- `backend/cmd/server/main.go`（接上電塔服務和長期伺服器）
- `backend/internal/delivery/server.go`：只加路由註冊，還有新錯誤碼對應的 HTTP 狀態（`handleError`）。`guard` 不能放寬。
- 新增 `backend/internal/delivery/tower.go`（電塔 API 和轉接）、`backend/internal/delivery/gateway.go`（遠端入口）、`backend/internal/delivery/folders.go`，以及它們的 `_test.go`
- 新增套件，例如 `backend/internal/tower/`（Tailcat 傳輸、配對狀態、保存；傳輸要能在測試裡換成假的）
- `backend/internal/model/errors.go`（新錯誤碼）
- `backend/internal/i18n/en.go`、`ja.go`、`ko.go`、`zh_hans.go`（新訊息）
- `README.md`、`README-tw.md`、`README-ja.md`、`README-ko.md`、`README-cn.md`（功能清單加上電塔一項，並提醒「被操作的那台要開著 Team Work」）
- 需要的話，`backend/internal/repository/` 新增電塔資料的保存檔

### 10.2 前端

要做：6.1、6.4、6.5 的畫面部分、6.6 前端的部分（`Idempotency-Key`、斷線提示、自動回家）、Help 五種語言、所有新字串。

會改或新增的檔案（後端不碰）：

- 新增 `frontend/src/PowerTower.tsx`（建築）、`frontend/src/TowerPanel.tsx`（清單和配對畫面）、`frontend/src/FolderBrowser.tsx`（畫面內的資料夾瀏覽器）、`frontend/src/core/towers.ts`（電塔 API 和目前所在電腦的狀態），以及它們的測試
- `frontend/src/core/backend.ts`（請求和 WebSocket 的基底、`Idempotency-Key`、網址改寫）
- `frontend/src/core/ops.ts`、`frontend/src/core/store.ts`、`frontend/src/terminalSessions.ts`、`frontend/src/claudeCode.ts`、`frontend/src/pickFolder.ts`、`frontend/src/attachments.tsx`
- `frontend/src/World.tsx`、`frontend/src/layout.ts`（電塔位置和佔地）
- `frontend/src/NewCompany.tsx`、`frontend/src/Settings.tsx`、`frontend/src/Drawer.tsx`、`frontend/src/FileBrowser.tsx`、`frontend/src/FileSheets.tsx`、`frontend/src/ChatSheet.tsx`、`frontend/src/SubscriptionLogin.tsx`、`frontend/src/ClaudeAccount.tsx`、`frontend/src/LanguageMenu.tsx`、`frontend/src/TutorialList.tsx`（遠端時停用或隱藏）
- `frontend/src/prefs.ts`（區分介面偏好和島上工作設定）
- 草稿和紀錄類的暫存：`frontend/src/chatDraft.ts`、`frontend/src/fileDrafts.ts`、`frontend/src/chatHistory.ts`（依電腦分開）
- `frontend/src/core/i18n.ts`、`frontend/src/Help.tsx`、`HelpEn.tsx`、`HelpJa.tsx`、`HelpKo.tsx`、`HelpZhHans.tsx`
- `frontend/src/fusion.css`（`fx-` 樣式）

如果要挑選員工，照公司規則用 `frontend/src/Pickers.tsx` 的 `CrewRow`。這一版預期沒有需要挑選員工的地方。

### 10.3 順序與共用

- 沒有一定要誰先做完。介面只照第 7 節；要改介面，先在交接裡寫清楚，並更新這份文件。
- 兩邊共用的只有這份文件。`docs/power-tower.md` 由寫規格的人負責，前後端改到介面時，在同一份文件第 7 節更新，並在交接裡說明。
- 整合測試（兩台真的電腦）做不到的話，在最後的交接寫明。手動測試步驟建議如下：兩台電腦各開 Team Work → B 按等待配對 → A 輸入位址 → B 同意 → A 前往 B → 建一個任務 → 關掉 A → 確認 B 上的任務繼續 → 重開 A 再前往，確認進度是最新的、任務只有一個。
