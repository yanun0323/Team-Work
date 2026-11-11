// The help: a sheet over the middle of the map, pasted on and taken off like a drawer. Topics down the
// left; the one picked on the right, a picture of that part of the app over the words. As with the
// drawers, a click on the map or Esc puts it away.
//
// Each topic is written in two layers: first a few lines on what it is and when to use it, then the
// pitfall people hit most (fx-help-pit), if there is one, both shown on a white note; then the
// reference, one <dl> drawn in a dashed box. Leave out what the screen already makes plain and what is only decoration, and write a
// rule in one topic only.

import { Children, isValidElement, useCallback, useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { appLanguage, tr } from './core/i18n'
import { HELP_EN, type HelpTopic } from './HelpEn'
import { HELP_JA } from './HelpJa'
import { HELP_KO } from './HelpKo'
import { HELP_ZH_HANS } from './HelpZhHans'
import { GALLERIES, GALLERY_NAMES, Looks, SampleSheet, type Gallery, type Sample } from './HelpLooks'
import type { Locale } from './core/domain/types'

/** Each topic's screenshot: help/<set>/<topic>.jpg, the Chinese set or the English one, whichever reads closer. */
const SHOTS = import.meta.glob<string>('./help/*/*.jpg', { eager: true, query: '?url', import: 'default' })
const SHOT_SET: Record<Locale, 'zh' | 'en'> = { zh: 'zh', 'zh-Hans': 'zh', en: 'en', ja: 'en', ko: 'en' }

/** The help in every language but the Chinese below. */
const HELP: Record<Exclude<Locale, 'zh'>, Record<string, HelpTopic>> = { en: HELP_EN, 'zh-Hans': HELP_ZH_HANS, ja: HELP_JA, ko: HELP_KO }

const GROUPS = ['機場', '公司'] as const
type Group = (typeof GROUPS)[number]

interface Topic {
  id: string
  label: string
  /** The heading it sits under in the list; the first topics stand on their own. */
  group?: Group
  /** Its title on the page, when the label alone would be unclear. */
  title?: string
  /** What its screenshot shows. */
  alt: string
  body: ReactNode
}

const TOPICS: Topic[] = [
  {
    id: 'start',
    alt: '島上的兩間公司和機場，右上角是新公司、編輯地圖、語言、說明和設定（飛機）按鈕',
    label: '快速開始',
    body: (
      <>
        <p>Team Work 把每個專案當成一間公司，蓋在島上的一棟大樓裡。公司裡的員工是 AI agent，照著任務藍圖一步步完成你交代的任務。</p>
        <ol>
          <li>在「機場 → 模型供應商」接上至少一個供應商，員工才有模型可用。</li>
          <li>按「＋ 新公司」，在地圖上選位置，再填專案資料夾、名稱和目標分支。</li>
          <li>在公司的「員工」頁籤新增員工：選一個員工藍圖和模型。官方來源帶來的藍圖和任務藍圖可以直接用。</li>
          <li>小事在「對話」頁籤直接交代；大一點的工作在「任務」頁籤建立任務，選任務藍圖，再挑任務負責人和每一步的員工。</li>
          <li>任務負責人照任務藍圖把每一步派給員工；打開任務就是和負責人的對話，要你決定的事固定在輸入框上方。做完後按「合併」，改動才會回到你的專案。</li>
        </ol>
        <p className="fx-help-pit">對話裡的員工直接改你的專案資料夾；任務則在另一份資料夾裡做，看不到你還沒 commit 的改動，要合併後才會回到專案。</p>
        <dl>
          <dt>缺了什麼</dt><dd>公司頁籤上方的紅色印章會告訴你先做哪一步，詳見「公司」。</dd>
          <dt>收起</dt><dd>按 Esc 或點地圖空白處，收起打開的公司、機場或說明。</dd>
          <dt>語言</dt><dd>按右上角的地球切換。</dd>
          <dt>教學</dt><dd>時鐘旁的清單列出接下來可以試的操作，點一項會帶你到要操作的地方。</dd>
        </dl>
      </>
    ),
  },
  {
    id: 'map',
    alt: '編輯地圖時，選取的公司跟著游標出現一塊虛線用地',
    label: '地圖',
    body: (
      <>
        <p>島上每棟大樓是一間公司，位置由你決定。用「＋ 新公司」蓋新的，用「編輯地圖」把現有的公司搬到別處。</p>
        <dl>
          <dt>移動視角</dt><dd>拖曳地圖，或用 WASD、方向鍵（按住 Shift 加速）；滾輪縮放，拉近時朝游標所在處，拉遠時以畫面中央為中心。</dd>
          <dt>選位置</dt><dd>虛線框跟著游標走，陸地或海上都能放；整塊用地要在目前陸地往外 32 格內，且不能重疊其他公司或機場，不行時框會變紅，點下去提示列會說明原因。白色格線和淡色底標出能放的範圍，綠色半透明的是會長出來的陸地。</dd>
          <dt>外觀</dt><dd>放好後先看到大樓的預覽，外觀是隨機的，可以擲骰子換一套。</dd>
          <dt>搬公司</dt><dd>按「編輯地圖」，點一間公司選取，再點新位置就搬過去；再點一次同一間取消選取。按「完成」或 Esc 結束。機場不能搬。</dd>
          <dt>跟隨民眾</dt><dd>在主畫面一段時間沒有點按、拖曳、縮放或按鍵，鏡頭會隨機挑一個人跟著走：預設僅挑島上的民眾；設定的「閒置鏡頭跟隨目標」改為「所有人物」後，也會挑辦公室裡的員工（他的大樓會切開，頭上顯示名字）。擋住他的大樓也會切開看得到裡面。這時點按、拖曳、縮放或按任何鍵都會取消，鏡頭回到原本的位置；點到的若是大樓、機場或按鈕，也會直接打開。每次挑的人都不一樣。等多久在設定的「閒置時跟隨民眾」選（預設 15 秒，可關閉）；關掉「地圖民眾」時，「僅地圖人物」不會跟隨，「所有人物」只會跟隨員工。</dd>
          <dt>解散或搬走後</dt><dd>只為那間公司長出來的陸地會變回海，其他公司或機場還用到的陸地留著。</dd>
        </dl>
      </>
    ),
  },
  {
    id: 'tower',
    alt: '打開的基地台：已配對的電腦和允許它操作我的開關，下方配對新電腦',
    label: '基地台',
    body: (
      <>
        <p>基地台讓兩台裝了 Team Work 的電腦配對。配對後可以從這台「前往」對方的島，直接操作那裡的公司、員工、任務、對話和終端機；工作在對方電腦上執行，用對方的模型供應商、藍圖和設定，這台關掉也不影響。</p>
        <p className="fx-help-pit">被操作的那台要一直開著 Team Work：它一關，別台就連不進去，它上面的工作也會停。</p>
        <dl>
          <dt>配對</dt><dd>在「配對新電腦」，要被操作的那台選「讓別台操作這台」，按「等待配對」並複製位址；另一台選「操作別台」，貼上位址送出。被操作的那台按「同意」才算完成。位址 10 分鐘後失效。配對過後，重開 App 或斷線都不用再配對。</dd>
          <dt>允許它操作我</dt><dd>每台配對電腦各有一個開關，開著對方才能操作這台。剛配對時只有被操作的那台開著；反方向也要的話，在自己的基地台打開。關掉開關或解除配對，對方立刻被擋下。</dd>
          <dt>前往和回來</dt><dd>按「前往」會先確認能不能操作對方，可以就切到對方的島。左下角一直標示正在操作哪台，按「回到自己的島」回來。在對方的島上點基地台，打開的是這台的基地台。</dd>
          <dt>在對方的島上</dt><dd>介面設定、語言和教學用這台的。新增公司時，在畫面裡瀏覽對方的資料夾。會在對方螢幕跳出視窗的功能（在 Finder 打開、開啟設定檔資料夾、用瀏覽器登入）不能用。</dd>
          <dt>版本</dt><dd>兩台的 Team Work 不相容時不能配對或前往，畫面會寫明要更新哪一台。</dd>
        </dl>
      </>
    ),
  },
  {
    id: 'airport',
    alt: '打開的機場：地圖上的機場和右邊的機場檔案',
    label: '機場',
    body: (
      <>
        <p>機場放著所有公司共用的東西：對話、模型供應商、員工藍圖、任務藍圖、來源、統計、終端機和設定，每一項在左邊「機場」底下有自己的說明。點地圖上的機場或它的名牌打開，鏡頭會拉近；用右上角的飛機按鈕打開則不移動。</p>
        <p className="fx-help-pit">在這裡改的藍圖、任務藍圖、來源和供應商，所有公司都會受影響。</p>
        <dl>
          <dt>機場的位置</dt><dd>機場固定在島上，不能搬，新公司也不能蓋在上面。</dd>
          <dt>先開哪一頁</dt><dd>在「設定」的「預設機場頁面」和「自動切換預設頁面」決定。</dd>
        </dl>
      </>
    ),
  },
  {
    id: 'company',
    alt: '打開的公司：左邊是剖開的辦公室，右邊是公司檔案的任務頁籤',
    label: '公司',
    body: (
      <>
        <p>一間公司對應一個專案資料夾和一個目標分支。點大樓、它的用地或名牌打開公司：右邊是公司檔案，頁籤有對話、任務、員工、檔案瀏覽、終端機和設定；左邊的辦公室看得到員工，有工作的人坐在位子上。</p>
        <p className="fx-help-pit">缺了什麼時，頁籤上方會蓋紅色印章，對應的新增按鈕也會停用；照印章說的補上就會恢復。</p>
        <dl>
          <dt>印章：模型供應商</dt><dd>沒有，或無法使用：到機場新增、登入或重新取得模型。影響對話、任務和員工。</dd>
          <dt>印章：員工</dt><dd>公司還沒有員工：先新增。影響對話和任務。某位員工的模型失效時只會提醒，其他員工照常。</dd>
          <dt>印章：專案資料夾</dt><dd>找不到資料夾：放回原位。影響對話、任務和終端機。</dd>
          <dt>印章：git repo</dt><dd>資料夾不是 git repo：在終端機執行 <code>git init</code>。影響任務。</dd>
          <dt>印章：目標分支</dt><dd>分支不見了：到公司的「設定」更換。影響任務。</dd>
          <dt>沒有 git</dt><dd>這台 Mac 還沒有 git 時，整個 App 會停下來變灰，中間貼一張便條紙：按「安裝」，在 Apple 跳出的視窗裝好開發者工具，裝完就恢復。</dd>
          <dt>公司筆記</dt><dd>右上角釘著的便條紙，點開顯示 Markdown，點一下內容就能編輯，邊打邊存。存在專案資料夾的 <code>.team-work/NOTES.md</code>，不會自動 commit，也不會交給員工。</dd>
          <dt>換公司</dt><dd>打開時其他公司的名牌還在，點了直接換過去。</dd>
          <dt>先開哪一頁</dt><dd>在「機場 → 設定」的「預設公司頁面」和「自動切換預設頁面」決定。</dd>
          <dt>大樓</dt><dd>員工越多，佔地越大（最大 10×10 格）；專案檔案越大，樓層越高（最多 10 層）；完成的任務越多，外觀裝飾越多：招牌、旗子、廣告看板、霓虹燈，最後是 LED 螢幕。</dd>
        </dl>
      </>
    ),
  },
  {
    id: 'airchat',
    alt: '機場的對話頁籤：和機場服務人員的對話',
    label: '對話',
    group: '機場',
    title: '機場的對話',
    body: (
      <>
        <p>和機場服務人員對話，不用選員工，也不屬於任何公司。適合問 App 怎麼用，或做跨公司的事：查看、建立或修改各公司的任務，管理藍圖、任務藍圖和模型供應商。</p>
        <p className="fx-help-pit">機場服務人員執行指令時能碰到整台電腦，不限於某個專案資料夾；它建立或修改任務不用你確認。</p>
        <dl>
          <dt>和公司對話的差別</dt><dd>輸入 # 從家目錄逐層選檔案或資料夾，不是從專案資料夾。對話裡可以隨時換模型和思考等級，回覆中除外。其他用法（附件、排隊、編輯、交給…）和公司的「對話」相同。</dd>
          <dt>藍圖</dt><dd>照內建的「機場服務人員」藍圖工作，角色、工具和技能都來自它；這份藍圖不能拿來新增員工。</dd>
          <dt>工作資料夾</dt><dd>資料目錄裡的 airport 資料夾。</dd>
          <dt>未讀標示</dt><dd>沒看過的回覆和等你回答的對話，會顯示在地圖上機場名牌的藍色標示。</dd>
        </dl>
      </>
    ),
  },
  {
    id: 'provider',
    alt: '模型供應商的詳細內容：連線方式、模型和使用中的員工',
    label: '模型供應商',
    group: '機場',
    body: (
      <>
        <p>模型供應商提供員工可用的模型，至少要有一個才能新增員工。類型有 Anthropic、OpenAI、Google Gemini 和 OpenAI 相容（例如 DeepSeek、本機的 Ollama），用 API Key 或訂閱登入；模型由供應商提供，不用自己輸入。清單在 App 啟動時重新取得，打開挑模型的選單時若距離上次超過 8 小時也會在背景更新；想馬上看到新模型，在供應商頁按右上角的重新讀取。</p>
        <p className="fx-help-pit">訂閱在別處登出或過期時，供應商會變回未登入，員工的回覆會失敗：按那則訊息下的「重新登入」，登入後再按「重新回覆」。</p>
        <dl>
          <dt>API Key</dt><dd>畫面上只顯示最後四碼，完整的 Key 存在這台電腦的資料庫，不會寫進設定檔。OpenAI 相容要填 Base URL。</dd>
          <dt>訂閱登入</dt><dd>Anthropic 和 OpenAI 可以改用 Claude 或 ChatGPT 訂閱，不需要 API Key。Claude 訂閱透過 Claude Code 使用：這台電腦沒有的話，會先問你是否同意安裝，再到瀏覽器登入。網頁版要先啟動後端（<code>make dev</code>）。</dd>
          <dt>剩餘額度</dt><dd>主畫面左上角時鐘下方列出每個供應商的額度。訂閱有「5 小時」和「每週」兩個圓環，數字是剩下的百分比，下面寫多久後重置；剩一半以上是綠色，20% 到 50% 是黃色，低於 20% 是紅色。API Key 查得到餘額時顯示餘額，查不到就不列出。</dd>
          <dt>圖片</dt><dd>不支援看圖的模型收到圖片時，供應商可能回報錯誤。</dd>
          <dt>刪除</dt><dd>還有員工使用它的模型時不能刪除。</dd>
        </dl>
      </>
    ),
  },
  {
    id: 'blueprint',
    alt: '員工藍圖的詳細內容：來源、Prompt、技能和工具',
    label: '員工藍圖',
    group: '機場',
    body: (
      <>
        <p>員工藍圖是員工的範本：Prompt、技能和允許的工具，不含模型，模型由每位員工自己選。所有公司共用藍圖。不知道該用哪個就用官方的「通才」；想改官方或內建的藍圖，按右上角的複製，存成自己的再改。</p>
        <p className="fx-help-pit">「執行指令」沒有沙盒，員工能碰到整台電腦，只給你信任的藍圖。</p>
        <dl>
          <dt>官方藍圖</dt><dd>通才、前端工程師、後端工程師、審查與測試、介面設計工程師、媒體設計師、功能規劃、研究員、寫手、DevOps 工程師、Matt Pocock 和 Poteto，共十二個，來自官方來源，不能修改或刪除。Matt Pocock 和 Poteto 照同名作者在 GitHub 公開的技能工作。官方藍圖跟著語言顯示，實際給員工的是英文，再加上回覆語言的規則；你自己的藍圖照你寫的內容給。</dd>
          <dt>內建藍圖</dt><dd>只有機場服務人員，它只在機場對話裡工作，不能拿來新增員工。</dd>
          <dt>來源提供的藍圖</dt><dd>來源可以帶來員工藍圖。列表依出處分組：我的、各個來源（標題是來源名稱）、內建。來源提供的藍圖和內建的一樣不能修改或刪除，要改就複製一份，複製出來的放在「我的」。</dd>
          <dt>技能</dt><dd>列出「機場 → 來源」的每個來源和它的技能，點一下技能就會亮起，代表使用。勾選來源名稱會使用它全部的技能，之後新增的也會使用，點暗的技能會排除；沒勾來源名稱時只用亮著的技能。不同來源使用了同名的技能時會變成紅底白字，點暗其中一個即可。</dd>
          <dt>公司資料夾的技能</dt><dd>不論哪個藍圖，員工都會讀取公司資料夾裡 <code>.agents/</code>、<code>.team-work/</code>、<code>.codex/</code>、<code>.claude/</code> 的技能，和藍圖的技能同名時以公司的為準。</dd>
          <dt>工具</dt><dd>讀取檔案、寫入檔案、網路搜尋、執行指令四種。讀取檔案也能讓員工看 PNG、JPEG、GIF、WebP 圖片（單張最大 3.75MB）。</dd>
          <dt>管理能力</dt><dd>工具也決定員工能否管理任務、藍圖、任務藍圖和模型供應商：勾讀取檔案可以查看，勾寫入檔案或執行指令還可以新增和修改，只勾網路搜尋則都不行。官方和內建藍圖都能讀寫。</dd>
          <dt>隱藏</dt><dd>滑鼠移到列表上的藍圖，按右邊的眼睛就能隱藏，官方的也可以；藍圖頁右上也有同一個按鈕。隱藏的藍圖會變淡，聘用員工時選不到，員工也看不到；已經用它的員工照常工作，你仍然可以修改。</dd>
          <dt>員工新增或修改</dt><dd>員工新增的藍圖立刻可用；修改要你同意才會寫入，包括員工改自己用的藍圖。同意後正在進行的步驟不變，之後的步驟用新藍圖。內建、從 Git 來的和來源提供的藍圖不能修改。</dd>
          <dt>已知限制</dt><dd>有執行指令的員工仍可能直接改設定檔再重新載入，繞過你的確認。</dd>
          <dt>舊的 GitHub 藍圖</dt><dd>之前從 GitHub 匯入的藍圖仍可改名稱、Repo 和版本。</dd>
          <dt>刪除</dt><dd>沒有員工使用的藍圖，按兩下垃圾桶就刪除。還有員工使用時，會先列出所有公司裡用它的員工，選一個藍圖讓他們全部轉過去，再刪除；員工的名字、外觀、模型和記憶不變，正在跑的工作照舊跑完，之後的工作用新藍圖。</dd>
        </dl>
      </>
    ),
  },
  {
    id: 'flow',
    alt: '編輯任務藍圖：一排步驟便條紙，箭頭中間有小圓點，下面是新增步驟',
    label: '任務藍圖',
    group: '機場',
    body: (
      <>
        <p>任務藍圖是任務要走的步驟，由左到右畫成便條紙和箭頭：白色是交給員工做的工作，綠色是和你討論。它不指定員工，每個任務再決定誰做哪一步。所有公司共用，官方來源帶來的「一般任務」「修 Bug」「功能開發」「程式審查」可以直接用。</p>
        <p className="fx-help-pit">改了任務藍圖只影響之後開的任務，已經開始的照舊。</p>
        <dl>
          <dt>起點和終點</dt><dd>沒有箭頭指進來的步驟都是起點，任務開始時同時開工，各自拿到任務說明；沒有箭頭指出去的是終點。</dd>
          <dt>分岔和等待</dt><dd>一步可以分給好幾個下一步，也可以等好幾個前一步。虛線箭頭代表「交給其中一個下一步」或「任一個前一步完成就開始」。</dd>
          <dt>討論步驟</dt><dd>可以排一位員工，或排好幾位開會，第一位是主持人。</dd>
          <dt>編輯步驟</dt><dd>點便條紙會往上打開一層，改這一步的名稱、種類、Prompt、開始條件、交接和下一步；按「完成」關掉，整份任務藍圖要按「儲存」才會寫入。</dd>
          <dt>接上步驟</dt><dd>編輯時按住便條紙拖到另一張就接上；拖到空白處會長出新的下一步。</dd>
          <dt>改箭頭</dt><dd>游標移到箭頭中間的小圓點，「＋」在這裡插入步驟，「×」拿掉這條箭頭。</dd>
          <dt>可以退回</dt><dd>打開的步驟覺得前一步要重做時，可以把工作退回去，一個任務最多退回兩次。新增的最後一步預設打開。只有一個前一步、而且那個前一步只交給這一步時才能打開；起點和討論步驟沒有這個開關。</dd>
          <dt>不能儲存時</dt><dd>有步驟沒有名稱，或箭頭繞回前面的步驟。</dd>
          <dt>來源提供的任務藍圖</dt><dd>列在「我的」後面，以來源名稱分組，官方的也在這裡；不能修改或刪除，複製後會用目前顯示的語言變成自己的。</dd>
          <dt>隱藏</dt><dd>和員工藍圖一樣可以隱藏：新增任務時選不到，員工也看不到，已經用它的任務照常進行。</dd>
          <dt>新任務帶入</dt><dd>新增任務時會帶入這間公司上次選的任務藍圖，還沒選過就帶第一條。</dd>
          <dt>員工新增或修改</dt><dd>有權限的員工新增的立刻可用，修改要你同意才會寫入。有迴圈這類無效內容、來源帶來的、或員工讀取之後你又改過的，都會被拒絕。</dd>
        </dl>
      </>
    ),
  },
  {
    id: 'sources',
    alt: '來源的詳細內容：版本、更新內容和技能',
    label: '來源',
    group: '機場',
    body: (
      <>
        <p>來源是技能、員工藍圖和任務藍圖的出處：一個 GitHub repo 加分支，或本機的一個資料夾。所有藍圖和自訂員工共用，在藍圖裡從來源挑要用的技能；來源帶來的員工藍圖和任務藍圖列在各自的頁籤，以來源名稱分組。</p>
        <p className="fx-help-pit">來源有新版本時預設不會自動換：打開它按「套用更新」，或打開「自動套用更新」。</p>
        <dl>
          <dt>新增</dt><dd>新增 GitHub 來源時會先讀出它的技能、員工藍圖和任務藍圖，至少讀到一樣才能新增。同一個 repo 和分支只會下載一份。</dd>
          <dt>員工藍圖和任務藍圖</dt><dd>放在來源最上層的 <code>blueprints/</code> 和 <code>workflows/</code>，一個 YAML 檔一份，檔名只能用英文字母、數字、<code>-</code> 和 <code>_</code>。員工藍圖寫 <code>name</code>、<code>prompt</code>、<code>comment</code>、<code>tools</code>（<code>read_file</code>、<code>write_file</code>、<code>web_search</code>、<code>run_command</code>）、<code>skills</code>，可加 <code>look</code>；<code>skills</code> 每一項寫 <code>repo</code>（可加 <code>ref</code>、<code>path</code>）、本機資料夾的完整路徑，或來源裡的資料夾，再用 <code>include</code>、<code>exclude</code> 挑技能。任務藍圖的格式和 <code>~/.team-work/workflows/</code> 裡的檔案相同，不指定員工，沒寫位置會自動排好。讀不了的檔案列在來源頁的「無法讀取」。<code>~/.team-work/</code> 是 App 自己的資料夾，只讀技能。</dd>
          <dt>多種語言</dt><dd>員工藍圖的 <code>name</code>、<code>prompt</code>、<code>comment</code>，以及任務藍圖和每個步驟的 <code>name</code>、<code>prompt</code>，可以只寫一段，也可以用 <code>en</code>、<code>zh</code>、<code>zh-Hans</code>、<code>ja</code>、<code>ko</code> 各寫一段。畫面照你選的語言顯示，沒有就用英文，再沒有就用第一個寫的；給員工的有英文就用英文。</dd>
          <dt>官方來源</dt><dd><code>yanun0323/Team-Work-Source</code> 帶來官方藍圖和任務藍圖，每個人都有、不能移除，預設自動套用更新。第一次使用要連上網路下載，之後沒有網路也能用已下載的版本。員工用的藍圖不見時（來源拿掉了、檔名改了，或從舊版升級），他會標上「藍圖已不存在」，排到員工列表最前面；在他身上的步驟會停下來問你，編輯他、重新選一個藍圖就能繼續。</dd>
          <dt>自動列入</dt><dd><code>~/.agents/</code>、<code>~/.team-work/</code>、<code>~/.codex/</code>、<code>~/.claude/</code> 會自動列為本機來源；官方藍圖讀的 GitHub repo（例如 Matt Pocock 讀的 <code>mattpocock/skills</code>）也會自動列入，和你新增的一樣檢查更新。</dd>
          <dt>檢查更新</dt><dd>每小時自動檢查一次，想馬上檢查就按來源右上角的重新整理按鈕。有新版本時，列表上的來源前面會出現紅色驚嘆號，打開後列出新增和移除的技能、員工藍圖和任務藍圖，以及受影響的藍圖和員工。本機資料夾沒有版本，改了檔案後按右上角的「重新讀取」。</dd>
          <dt>藍圖被移除時</dt><dd>新版本拿掉了員工正在用的藍圖時，套用後這些員工改用自訂設定，保留原本的內容；套用前會列在「改用自訂設定」底下。</dd>
          <dt>技能</dt><dd>來源頁依資料夾列出它的技能，點一下技能會在旁邊打開一張，顯示它的說明、檔案位置和完整內容。</dd>
          <dt>自動套用更新</dt><dd>預設關閉。打開後來源右邊蓋上「自動更新」印章，檢查到新版本就直接套用，來源前面出現紅點，打開來源後消失。</dd>
          <dt>版本</dt><dd>同一個來源的使用者都用同一個版本。進行中的工作沿用開始時的版本；連不上網路時，已下載的版本照常可用。</dd>
          <dt>刪除</dt><dd>還有藍圖或員工使用的來源不能刪除，包括用它提供的藍圖的員工；來源自己的藍圖不算，刪除時一起移除。</dd>
        </dl>
      </>
    ),
  },
  {
    id: 'stats',
    alt: '機場的統計頁籤：用量總數、每日長條圖和依供應商與模型的列表',
    label: '統計',
    group: '機場',
    body: (
      <>
        <p>看整個 App 用了多少模型：Token、費用和每天的趨勢，再依供應商和模型列出，用來找出哪個模型最花錢、或用量突然變多的那天。</p>
        <p className="fx-help-pit">費用只算有設定價格的模型，訂閱和沒有價格的顯示「—」；只算得到開始記錄之後的用量。</p>
        <dl>
          <dt>統計區間</dt><dd>過去 30 天或所有歷史。</dd>
          <dt>長條圖</dt><dd>每天一條，依模型分色。指到某一條時，下方列表會暫時換成那一天的數字。</dd>
          <dt>佔比</dt><dd>每列 Token 佔列表總數的比例；指到長條時就是佔那一天的比例。</dd>
          <dt>Token</dt><dd>不含從快取讀回的部分。快取命中率是讀回的部分佔全部輸入的比例。</dd>
        </dl>
      </>
    ),
  },
  {
    id: 'airterminal',
    alt: '機場的終端機頁籤：家目錄裡的 zsh',
    label: '終端機',
    group: '機場',
    title: '機場的終端機',
    body: (
      <>
        <p>在家目錄開一個真正的 zsh，不屬於任何公司，適合做跟專案無關的事，例如登入命令列工具或安裝軟體。第一次切到這個頁籤才會開始執行。</p>
        <p className="fx-help-pit">預設關閉機場時終端機就結束，跑到一半的指令會中斷；要保留就在「設定」勾選「保留終端機」。</p>
        <dl>
          <dt>員工讀終端機</dt><dd>機場對話裡，機場服務人員可以讀這個終端機最後 5000 行顯示過的文字，不能打字。公司對話讀的是公司自己的終端機。</dd>
          <dt>其他</dt><dd>鍵盤、什麼時候結束和終端機預設指令都和公司的「終端機」相同。</dd>
        </dl>
      </>
    ),
  },
  {
    id: 'settings',
    alt: '機場的設定頁籤：一般、操作、功能和遊戲物件',
    label: '設定',
    group: '機場',
    title: '機場設定',
    body: (
      <>
        <p>整個 App 的偏好，改了立刻生效。語言存在後端，其他選項只記在這台電腦上。</p>
        <p className="fx-help-pit">在 App 外面改了 <code>~/.team-work</code> 裡的設定檔，要按「重新載入設定」才會生效。</p>
        <dl>
          <dt>語言</dt><dd>介面、官方和內建的藍圖、任務藍圖顯示的語言，也是員工回覆你時用的語言。員工從下一則回覆開始換，舊訊息不變。</dd>
          <dt>預設頁面</dt><dd>打開機場或公司時先顯示哪個頁籤，預設分別是「模型供應商」和「任務」。</dd>
          <dt>自動切換預設頁面</dt><dd>預設為「開：未讀對話優先」。有任務待回覆就先顯示任務，有未讀或等你回答的對話就先顯示對話，兩者都有時照選項；沒有才用預設頁籤。機場只看對話。</dd>
          <dt>自動檢視</dt><dd>點公司、機場或新公司的位置時鏡頭怎麼動。「位移和縮放」（預設）移過去並拉近，地圖不能平移縮放；「位移」只移過去，不能平移但可以縮放；「關閉」鏡頭不動。</dd>
          <dt>點選地圖</dt><dd>公司或機場開著時點地圖會怎樣。「直接回到主畫面」連開著的詳細頁一起收起；「先關閉頁面」（預設）在有詳細頁開著時先收起所有詳細頁，再點一次才收起公司或機場。</dd>
          <dt>任務紀錄排序</dt><dd>新的在最上面或最下面，套用到任務、子任務和員工的紀錄。</dd>
          <dt>音樂與音效</dt><dd>背景音樂和音效音量分開調，拉桿旁可以靜音；各種音效也能各自關掉或試聽。「背景執行時靜音」預設勾選，切到別的程式時停下。通知音在任務等你回覆或合併、或對話有新回覆時響，正開著的對話不會響。第一次點擊或按鍵後才開始播放。</dd>
          <dt>系統通知</dt><dd>只在 Mac App 裡有，預設勾選。App 不在前景時，任務等你回覆或合併、或對話有新回覆，就跳 macOS 通知，點一下直接打開那個任務或對話；Dock 圖示上的數字是待處理的總數。第一次會先問能不能發通知，按了不允許之後，要到「系統設定 → 通知」打開。</dd>
          <dt>保留終端機</dt><dd>預設不勾選。勾選後，離開公司或機場時終端機繼續執行，回來接著用，關閉 App 才結束。</dd>
          <dt>終端機預設指令</dt><dd>在「進階」，填了以後每個新開的終端機啟動時會自動執行。</dd>
          <dt>遊戲物件</dt><dd>關掉細節、陰影、地圖民眾、飛機動畫或雲朵，畫面會跑得更順。「時間」決定白天和夜晚：跟隨真實時間、Minecraft（20 分鐘過完一天）、永遠白天或永遠夜晚。「建築工作動畫」選公司工作中時大樓兩側的動畫。</dd>
          <dt>自動命名對話</dt><dd>在「系統」，預設關閉。勾選後選模型和思考等級，新對話會把第一則訊息送給這個模型取名字，用量算進該對話的 Token。沒取好時列表顯示第一則訊息。對話上方的名稱可以直接改，清空就回到第一則訊息；手動取的名字不會被蓋掉。</dd>
          <dt>圖片生成</dt><dd>在「系統」選一個 ChatGPT 訂閱，所有員工就能用 <code>image_gen</code> 工具生圖或改圖，存成工作資料夾裡的 PNG，要動圖時存成 2–16 格的 GIF。新增或編輯 ChatGPT 訂閱時也可以勾「作為預設圖片生成供應商」。選「沒有」就關閉。</dd>
          <dt>使用 Codex Skill／使用 Claude Skill</dt><dd>在「系統」，預設都勾選。取消勾選後，所有藍圖都不再讀 <code>~/.codex/</code> 或 <code>~/.claude/</code> 的技能，藍圖上仍列著這個資料夾；公司資料夾裡的 <code>.codex/</code>、<code>.claude/</code> 也跟著這兩個選項。</dd>
          <dt>全域員工規則</dt><dd>在「系統」，所有公司的每位員工都會收到。存在 <code>~/.team-work/AGENTS.md</code>，在外面改的話下次開工或回覆就會生效。</dd>
          <dt>教學</dt><dd>主畫面時鐘旁的清單，一次顯示 5 項，做完的打勾消失；從現有資料看得出已做過的直接算完成。「略過教學」把清單藏起來，「重新開始教學」從頭來過。</dd>
          <dt>設定檔</dt><dd>介面偏好、教學進度、公司、員工、自己的藍圖和任務藍圖，以及供應商都存成檔案，在 <code>~/.team-work</code> 下；內建和來源帶來的不在裡面。重新載入時整批檢查通過才生效，有錯就保留原本的設定。「開啟設定檔資料夾」在 Finder 打開這個位置。</dd>
          <dt>重設回預設值</dt><dd>在設定頁最下面，要按兩次。這一頁的設定都回到預設值，包括語言和終端機預設指令；全域員工規則會保留。</dd>
        </dl>
      </>
    ),
  },
  {
    id: 'about',
    alt: '機場的關於頁籤：相關連結、授權條款和版本號',
    label: '關於',
    group: '機場',
    body: (
      <>
        <p>「關於」頁籤有相關連結、授權條款、版本號和問題回報。這裡也說明怎麼更新和結束 App。</p>
        <dl>
          <dt>問題回報</dt><dd>在 GitHub 開新的 issue，內容已附上版本號；圖片請直接貼到 issue 裡。</dd>
          <dt>檢查更新</dt><dd>主畫面左上角時間下方是版本號。Mac App 開啟時和之後每小時自動檢查，有新版本時時間右邊會出現紅色驚嘆號，按下就開始更新，下載和安裝在跳出的視窗裡進行。想馬上檢查就按版本號，或用選單的「檢查更新…」。網頁版沒有這些按鈕。</dd>
          <dt>退出</dt><dd>Mac App 的「機場」標題右邊有關機按鈕，按下或用選單的「結束 Team Work」（⌘Q）都會先確認一次；開著的終端機也會一起結束。</dd>
        </dl>
      </>
    ),
  },
  {
    id: 'chat',
    alt: '和員工的對話：你的訊息下方有編輯用的筆，下面是輸入框和附件按鈕',
    label: '對話',
    group: '公司',
    body: (
      <>
        <p>不必開任務，直接和員工討論事情或處理小工作，適合問問題、小改動，或先討論清楚再開任務。也可以找好幾位員工一起開會。</p>
        <p className="fx-help-pit">對話裡的員工直接在專案資料夾工作，改動馬上生效，沒有另開分支；資料夾有未提交的改動時會提醒你。編輯或刪除訊息不會還原員工改過的檔案。</p>
        <dl>
          <dt>開始</dt><dd>按「＋ 新對話」選員工，預設是這間公司上次開新對話的員工，模型跟著員工走。送出第一句後對話才成立，之後不能換員工或模型。</dd>
          <dt>會議</dt><dd>開新對話時打開「多人對話」選兩位以上的員工，第一個選的是主持人；對話中用 @ 提及不在場的人就會邀請他加入，新加入的人看得到之前的對話。最多 6 位。名單上最大的名字是主持人，按「更換主持人」換人；主持人離開公司時由下一位接任。</dd>
          <dt>誰回答</dt><dd>被 @ 提及的人依序回答；@All 是所有人依序回答，主持人最後；沒有提及任何人時只有主持人回答。輸入框上方的「送給」會列出這則訊息由誰回答。每個人都看得到前面的人說了什麼。建立任務、修改藍圖或流程、向你提問這類動作，每輪只有一個人能做：單獨被提及的人，否則是主持人。任務裡的討論步驟也照這些規則。</dd>
          <dt>按鍵</dt><dd>Enter 送出，Shift+Enter 換行，Tab 和 Shift+Tab 增減縮排。回覆中可以按暫停。</dd>
          <dt>排隊和插話</dt><dd>員工回覆時送出的訊息會排在輸入框上方，標著「排隊」，等這次回覆結束再依序送出。按「插話」改成在員工下一次工具呼叫結束後立刻送出。按筆可以拿回輸入框修改。暫停或回覆失敗時，排隊的訊息會留著不送，按「插話」就會送出。</dd>
          <dt>技能和檔案</dt><dd>輸入 $ 從對話裡所有員工的技能中選，輸入 # 選專案裡的檔案或資料夾。訊息裡的 $技能名稱 會把這份技能的說明一起交給員工；多人對話時，這一輪回覆的人都會拿到。送出後，訊息裡提到的員工、檔案、資料夾和技能都可以點開。新增或編輯任務的「說明」欄也能用 #。</dd>
          <dt>員工提問</dt><dd>員工需要你決定時會停下來問你，點選項或直接打字回覆，員工就會接著做。</dd>
          <dt>確認修改</dt><dd>員工要修改藍圖或任務藍圖時會停下來，列出修改前後的內容。按「同意」才會寫入，按「拒絕」則不變，員工都會接著做；直接打字送出也算拒絕。</dd>
          <dt>附件</dt><dd>按迴紋針選圖片或檔案，或直接貼上截圖。每個最大 25MB，一則合計最多 6 個；超過 3.75MB 的圖片會自動縮小。文字檔會提供內容預覽給員工；PDF、Office 等格式要靠員工的工具讀取，不保證能解析。</dd>
          <dt>複製訊息</dt><dd>訊息下方的複製按鈕會複製這則訊息的文字。</dd>
          <dt>編輯訊息</dt><dd>按自己訊息下方的筆，這則和之後的內容都會消失，文字和附件回到輸入框讓你改了再送；正在回覆時按也會中斷回覆。沒有復原。</dd>
          <dt>草稿</dt><dd>輸入框裡還沒送出的文字和附件，關掉對話後還會留著，回來接著寫；關閉 App 後就沒了。</dd>
          <dt>交給…</dt><dd>按訊息下方的分岔圖示選一位員工，把對話到這裡為止複製成新對話，原本的對話不變，畫面換成新對話。選原本的員工就是單純複製；選別人就由他接手，他會知道前面的回覆不是自己寫的。新對話沿用原本的名稱、前面加上「交接：」，不會跟著置頂，排在列表最上面，要等你發言才會開始回覆；裡面的虛線寫著從哪個對話 ID 交給誰，點一下就在上面打開原本的對話。員工離開公司後，他的對話也能這樣交給別人。會議不論交給主持人或其他人，都會變成和他一對一的對話；機場的對話只會複製給機場服務人員。</dd>
          <dt>建立任務</dt><dd>按「建立任務」，員工會把對話整理成新任務，你改好再建立。有權限的員工也能自己建立或修改任務，直接生效。在對話裡建立的任務，和員工新建的員工藍圖、任務藍圖、供應商，會貼在當時的訊息下方，點了就能打開。</dd>
          <dt>列表與名牌</dt><dd>員工回覆時列表上有跳動的三個點，沒看過的回覆有圓點。地圖上公司名牌的藍色數字是待處理的對話（未讀或等你回答），紅色是待回覆的任務；名字前轉動的灰色圈圈是進行中的對話加任務數。</dd>
          <dt>長對話</dt><dd>對話太長時，員工會把較早的內容整理成摘要再繼續，對話裡出現一條「已整理較早的對話」分隔線。訊息都還在；畫面先載入最新 100 則，按「顯示更早訊息」每次再讀 100 則，尚未顯示的內容不能搜尋或選取。員工之後只讀摘要；整理的 Token 也算進這段對話。輸入框下方的數字是下一次大約會送給模型的量，以及模型最多能讀的量。Google 和自訂相容 API 的上限要在供應商裡填，沒填就當 128K，填太大會讓對話來不及整理就失敗。用到上限的幾成就整理，在機場「設定」的「自動整理對話」依上限大小分組調整，另外一律至少留 20K 給下一次回覆。多人對話只要有一人到了就整理，由主持人的模型寫摘要。</dd>
          <dt>釘選</dt><dd>按對話右上角或列表上的圖釘，對話會固定在列表最上面；再按一次取消。</dd>
          <dt>刪除</dt><dd>右上角可以刪除對話，資料夾裡的改動會留著。員工離開公司後，對話留著可以看，但不能再發言。</dd>
        </dl>
      </>
    ),
  },
  {
    id: 'task',
    alt: '任務的詳細內容：任務藍圖圖和每一步的進度',
    label: '任務',
    group: '公司',
    body: (
      <>
        <p>任務是你交給公司的一件工作：任務負責人照任務藍圖把每一步派給員工、收下交付、決定下一步，最後等你合併。比較大、要好幾個人分工，或不想動到你手邊檔案的工作就開任務；小事用對話就好。</p>
        <p className="fx-help-pit">每個任務開工時，會從目標分支最新的 commit 另開一份資料夾來做。專案資料夾裡還沒 commit 的改動，員工看不到；需要的話先 commit。</p>
        <dl>
          <dt>負責人和每一步</dt><dd>任務負責人主導整個任務：照計畫把每一步派給員工並附上指示，收下交付後再決定下一步，在任務對話裡回報，合併時也由他把分支合併回去。沒有負責人的任務不能開始。每一步由誰做在任務裡另外挑，不同模型的員工可以一起做；「套用到所有節點」讓每一步都由任務負責人執行。</dd>
          <dt>任務對話</dt><dd>打開任務就是和負責人的對話。你的訊息只交給負責人，隨時可以改方向或請他召集會議；員工的交付、問題和會議發言以本人署名，點標籤打開那一步。負責人可以在員工做事時插話，員工不用停下來，做完手上這輪工具就會讀到；員工在讀到之前就交付或停下時，對話裡會有一行「插話未送達」。派工、暫停、退回和計畫調整是短短一行，工具紀錄留在步驟裡。你送出的訊息下方標著已收到、處理中或已生效，沒送到可以重試。範圍以外的事可以請負責人另開成任務：新任務留在待辦，點對話裡那一行就能打開。</dd>
          <dt>待你回答</dt><dd>要你決定的問題固定在輸入框上方，可以同時有好幾題，各自回答；按「原訊息」回到問的地方。加入名單外的員工、提高預算、修改設定和合併只有你能決定，負責人不能代答。</dd>
          <dt>退回一步</dt><dd>點上方的步驟打開，按「退回這一步」寫下原因。原本的紀錄保留，另開一筆重做，讀過它的後續步驟標成待重驗；任務先暫停，按繼續後才重做。退回不會刪檔或還原改動。</dd>
          <dt>舊任務</dt><dd>這一版以前建立的任務照原本的方式跑完，標著「舊制流程」，沒有負責人對話；想用新方式就複製成新任務。</dd>
          <dt>子任務和交接</dt><dd>任務藍圖的每一步變成一個子任務，做完寫下交接摘要交給下一步。「進度」列出每個子任務的狀態，點開看紀錄和交接的檔案；這一步改過的檔案，可以用「上下」或「左右」和這一步開始前的版本比對。</dd>
          <dt>分支</dt><dd>每個任務有自己的分支，寫在標題下方，每一步都把工作提交到這個分支。</dd>
          <dt>四個欄位</dt><dd>待辦、進行中、待回覆、完成。紅色驚嘆號要你回覆，綠色合併圖示等你合併，見「回覆與討論」。</dd>
          <dt>開始和暫停</dt><dd>新任務留在待辦，按詳細內容右上角的開始，負責人才開始派工；之後同一個按鈕暫停和繼續。暫停會先擋住新的派工並停止正在做的步驟，停好之前不能繼續；暫停中仍可以和負責人討論，但不會自動復工。停止不會還原已改的檔案或已做的外部操作。</dd>
          <dt>附件</dt><dd>按「＋」選取或在文字框貼上截圖。每個最大 25MB，合計最多 6 個；超過 3.75MB 的圖片會自動縮小。</dd>
          <dt>自訂流程</dt><dd>「流程」切到「自訂」就能直接寫這次任務的流程：從空白步驟開始，或從任務藍圖匯入再改，編法和任務藍圖一樣。自訂流程只屬於這個任務；想重複使用就按「存成任務藍圖」。</dd>
          <dt>複製任務</dt><dd>按詳細內容右上角的複製，會打開一張填好標題、說明、附件、任務藍圖和人員的新任務。</dd>
          <dt>員工建立的任務</dt><dd>有權限的員工可以建立任務，同樣留在待辦等你開始，標題下方寫著由誰建立。員工只能建立和修改自己公司的任務，機場服務人員可以跨公司。連續建立任務最多 3 層。</dd>
          <dt>員工修改任務</dt><dd>員工可以改標題、說明、負責人和每一步的員工，立刻生效。正在進行的工作不受影響，之後的步驟看到新內容。</dd>
          <dt>費用和 Token</dt><dd>子任務會記下花費，任務花費到達公司設定的上限時會停下來問你。Token 不含讀取快取的部分，訂閱也會記錄；費用上限不看 Token。</dd>
          <dt>完成</dt><dd>負責人確認每一步都完成、沒有待處理的事之後回報完成，任務就等你合併；條件分支沒選到的步驟不用做。</dd>
          <dt>編輯和刪除</dt><dd>可以改標題、說明、負責人和每一步的員工；任務藍圖開始後不能換。改到正在做的步驟的員工時，「儲存，下一步起生效」讓原本的人做完這一步，「儲存並立刻換人」馬上交給新的人，從原本的進度接著做。被退回重做的步驟，由當時排在那一步的員工做。</dd>
        </dl>
      </>
    ),
  },
  {
    id: 'reply',
    alt: '子任務裡的討論：員工和你來回的訊息，下面是輸入框和結束討論按鈕',
    label: '回覆與討論',
    group: '公司',
    body: (
      <>
        <p>任務需要你決定時會移到「待回覆」：紅色驚嘆號要你回覆，綠色合併圖示是做完了等你合併。打開任務，在輸入框上方的「待你回答」處理；舊制任務點開「進度」裡有徽章的那一步。</p>
        <p className="fx-help-pit">合併會更新你專案資料夾的目標分支；那裡有還沒 commit 的改動時合併會失敗，處理好再按一次「合併」。</p>
        <dl>
          <dt>回答問題</dt><dd>員工有問題、拿不定下一步、重試用完或費用到上限時，選一個選項、寫回覆，按「確認」送出。</dd>
          <dt>確認修改</dt><dd>員工要修改藍圖或任務藍圖時，這一步列出修改前後的內容。選「同意」或「拒絕」，可以再寫回覆，按「確認」送出。</dd>
          <dt>開會討論</dt><dd>輪到綠色的討論步驟時，員工會先讀完前面的交接再問你，可以來回好幾輪。排了好幾位員工時就是開會，誰回答的規則和「對話」相同。</dd>
          <dt>結束討論</dt><dd>談定後按「結束討論」，選「繼續」交給下一步、「退回」寫下要改什麼，或「停止任務」。</dd>
          <dt>合併</dt><dd>按「合併」讓任務負責人把分支合併回目標分支，有衝突時由他先解；要改什麼就直接告訴負責人。舊制任務也可以按「退回」寫下要改什麼，退回重做。也可以在任務對話請負責人合併，他會送出一張合併卡，按卡上的「合併」才會開始。</dd>
        </dl>
      </>
    ),
  },
  {
    id: 'crew',
    alt: '員工頁籤：依員工藍圖分組，名字下寫著模型和思考等級',
    label: '員工',
    group: '公司',
    body: (
      <>
        <p>員工是在公司裡工作的 AI agent，由一個員工藍圖建立，再選自己的模型和思考等級。一位員工可以同時做好幾個子任務和對話。</p>
        <p className="fx-help-pit">同時做的工作越多，費用和訂閱額度消耗得越快。</p>
        <dl>
          <dt>模型和思考等級</dt><dd>模型選單依供應商分組，沒有供應商提供但還有員工在用的模型列在「其他」。思考等級能選哪些由供應商決定，預設是 default。</dd>
          <dt>自訂</dt><dd>「設定方式」選「自訂」，可以從員工藍圖匯入再改，之後不隨原藍圖更新；選「無」會清空。自訂的設定只屬於這位員工，解僱時一起刪除，列表上排在最前面的「自訂」分組。</dd>
          <dt>列表</dt><dd>名字下寫著模型和思考等級，有工作時右邊標出正在做哪一步，+N 是其他正在做的工作數。挑人的選單裡，白色便利貼是他能用的工具。</dd>
          <dt>記憶</dt><dd>員工的詳細內容有工作紀錄和記憶。記憶只留在這間公司，不包含任務進度；員工會自己記下和移除，你也可以修改或刪除。</dd>
          <dt>解僱</dt><dd>要先選一位接手的人，他手上的任務和步驟會交接過去；公司只剩一位員工時不能解僱。</dd>
        </dl>
      </>
    ),
  },
  {
    id: 'files',
    alt: '公司檔案的檔案瀏覽頁籤：專案資料夾的檔案樹',
    label: '檔案瀏覽',
    group: '公司',
    body: (
      <>
        <p>瀏覽公司的專案資料夾，看檔案、看圖或改幾行字，不用離開 App。只能看和編輯現有的檔案，不能新增、刪除、搬移或改名。</p>
        <p className="fx-help-pit">打開後檔案若被員工、終端機或其他編輯器改過，存檔會被拒絕，不會蓋掉別人的修改：先把自己的修改複製出來，再按「重新讀取」。</p>
        <dl>
          <dt>檔案樹</dt><dd>資料夾展開時才讀那一層，所以隱藏檔、<code>.git</code>、<code>node_modules</code> 都看得到；被 <code>.gitignore</code> 忽略的顯示成淡色。滑鼠移到資料夾上，右邊會出現在 Finder 打開它的按鈕。切回這個頁籤或回到 App 時會重讀展開的資料夾。</dd>
          <dt>開啟</dt><dd>Markdown 會排版，程式碼會上色，png、jpg、gif、webp 顯示圖片，svg 畫成圖、編輯時看原始碼；其他檔案和超過 1 MiB 的文字檔顯示原因，可以在 Finder 顯示。</dd>
          <dt>編輯</dt><dd>按文字檔右上角的編輯。程式碼邊打邊上色，Markdown 用純文字框。按「儲存」存檔並收起，Command+S（Ctrl+S）存檔後繼續編輯。CRLF 換行的檔案存回去仍是 CRLF。</dd>
          <dt>草稿</dt><dd>沒存就收起，草稿會留著，檔案樹上有紅點，再按編輯接著改；「捨棄修改」丟掉草稿。草稿在關閉 App 前都在；關掉公司檔案或換公司時，有沒儲存的修改會先問一次。</dd>
        </dl>
      </>
    ),
  },
  {
    id: 'terminal',
    alt: '公司檔案的終端機頁籤：黑色便利貼上的 zsh',
    label: '終端機',
    group: '公司',
    body: (
      <>
        <p>在專案資料夾開一個真正的 zsh，會載入你的 <code>~/.zshrc</code>，可以直接跑指令、用 vim、按 Ctrl+C。第一次切到這個頁籤才會開始執行。</p>
        <p className="fx-help-pit">預設關閉公司檔案或換公司時終端機就結束，跑到一半的指令會中斷；要保留就到「機場 → 設定」勾選「保留終端機」。</p>
        <dl>
          <dt>什麼時候結束</dt><dd>切頁籤時繼續執行。勾了「保留終端機」時，到關閉 App 或解散公司才結束；網頁版重新整理也算關閉。</dd>
          <dt>員工讀終端機</dt><dd>公司對話裡，藍圖有「讀取檔案」或「執行指令」的員工可以讀終端機最後 5000 行顯示過的文字，不能打字。vim 這類全螢幕程式的畫面不算；重新開啟終端機就從頭記起。</dd>
          <dt>鍵盤</dt><dd>焦點跑到別處時直接打字也會回到終端機（正在其他輸入框打字時除外），按 F6 離開。Option 當作 Alt；Option+←→ 跳一個字，Command+←→ 跳到行首行尾，Command+Delete 刪到行首，Shift+Enter 換行不送出，Command+K 清除畫面，Command+↑↓ 捲到最上或最下。</dd>
        </dl>
      </>
    ),
  },
  {
    id: 'teamset',
    alt: '公司檔案的設定頁籤：名稱、目標分支、公司員工規則和執行限制',
    label: '設定',
    group: '公司',
    title: '公司設定',
    body: (
      <>
        <p>這間公司自己的規則和限制：給員工的共同指示、任務合併回去的分支，以及子任務跑多久、花多少錢就停下來問你。</p>
        <p className="fx-help-pit">「公司員工規則」就是專案資料夾裡的 AGENTS.md，兩邊改都會同步，但不會自動 commit。</p>
        <dl>
          <dt>公司員工規則</dt><dd>給這間公司每位員工的共同指示，接在藍圖的 Prompt 之上。</dd>
          <dt>目標分支</dt><dd>任務完成後合併回去的分支。清單在建立公司時存下，之後新開的分支不會出現。</dd>
          <dt>子任務逾時</dt><dd>一個子任務最多跑多久。</dd>
          <dt>任務費用上限</dt><dd>任務花到這個金額就停下來問你。</dd>
          <dt>失敗重試</dt><dd>子任務失敗時自動重試幾次，用完就問你。</dd>
          <dt>解散公司</dt><dd>會移除員工和任務，開著的終端機也會結束，沒用到的陸地變回海。藍圖留著；可選擇同時刪除本地檔案（預設不勾）。</dd>
        </dl>
      </>
    ),
  },
]

const calm = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches

/** Everything in the list in order, for the arrow keys: the topics, then the galleries of looks at the bottom. */
const ORDER = [...TOPICS.map((t) => t.id), ...GALLERIES]
const isGallery = (id: string): id is Gallery => (GALLERIES as readonly string[]).includes(id)

/** A topic in the language picked. */
const inLanguage = (t: Topic): Topic => {
  const language = appLanguage()
  return language === 'zh' ? t : { ...t, title: undefined, ...HELP[language][t.id] }
}

export const helpTopicIdsForTest = () => TOPICS.map((t) => t.id)

/** Every topic's body in every language, to check how they are laid out. */
export const helpBodiesForTest = () =>
  TOPICS.flatMap((t) => [{ id: t.id, body: t.body }, ...Object.entries(HELP).map(([l, help]) => ({ id: `${t.id} (${l})`, body: help[t.id]?.body }))])

/** A topic's opening lines and pitfall on a white note, then its reference in the dashed box. */
function TopicBody({ body }: { body: ReactNode }) {
  const parts = Children.toArray(isValidElement<{ children?: ReactNode }>(body) ? body.props.children : body)
  const at = parts.findIndex((p) => isValidElement(p) && p.type === 'dl')
  const end = at < 0 ? parts.length : at
  return (
    <>
      <div className="fx-help-note">{parts.slice(0, end)}</div>
      {parts.slice(end)}
    </>
  )
}

export function Help({ leaving, onGone }: {
  leaving: boolean
  /** Called when the sheet has come off. */
  onGone: () => void
}) {
  const [topic, setTopic] = useState<string>(TOPICS[0].id)
  const title = useRef<HTMLHeadingElement>(null)
  const tabs = useRef<Array<HTMLButtonElement | null>>([])
  useEffect(() => title.current?.focus({ preventScroll: true }), [])
  const gallery = isGallery(topic) ? topic : null
  const current = TOPICS.find((t) => t.id === topic) ?? TOPICS[0]
  const shown = inLanguage(current)

  // a sample opened from a gallery, on a sheet over this one; it stays for its fade-out once put away, but with
  // reduced motion there is none, so it goes at once. Focus goes back to its note once the help is uncovered.
  const [sample, setSample] = useState<(Sample & { leaving: boolean }) | null>(null)
  const note = useRef<HTMLElement | null>(null)
  const covered = !!sample && !sample.leaving
  useEffect(() => {
    if (covered) return
    note.current?.focus({ preventScroll: true })
    note.current = null
  }, [covered])
  const openSample = (id: string) => {
    if (!gallery) return
    note.current = document.activeElement as HTMLElement | null
    setSample({ gallery, id, leaving: false })
  }
  const putAway = useCallback(() => setSample((s) => (!s ? s : calm ? null : { ...s, leaving: true })), [])

  // up and down move between topics too
  const onTabKey = (e: KeyboardEvent) => {
    const i = ORDER.indexOf(topic)
    const next = { ArrowDown: i + 1, ArrowUp: i - 1, Home: 0, End: ORDER.length - 1 }[e.key]
    if (next === undefined) return
    e.preventDefault()
    const j = (next + ORDER.length) % ORDER.length
    setTopic(ORDER[j])
    tabs.current[j]?.focus()
  }

  const link = (id: string, label: string) => (
    <button key={id} ref={(el) => void (tabs.current[ORDER.indexOf(id)] = el)} type="button"
      aria-current={topic === id ? 'page' : undefined} aria-controls="fx-help-panel" onClick={() => setTopic(id)}>
      {label}
    </button>
  )
  const topicLink = (t: Topic) => link(t.id, inLanguage(t).label)

  return (
    <>
    <aside className={leaving ? 'fx-drawer fx-help leaving' : 'fx-drawer fx-help'} role="dialog" aria-modal="true" aria-labelledby="fx-help-title"
      aria-hidden={leaving || undefined} inert={leaving || undefined}
      onAnimationEnd={(e) => { if (leaving && e.target === e.currentTarget) onGone() }}>
      <span className="fx-tape fx-tape-l" aria-hidden="true" />
      <span className="fx-tape fx-tape-r" aria-hidden="true" />
      <div className="fx-sheet" inert={covered || undefined}>
        <header className="fx-head fx-head-rule fx-help-head">
          <h1 id="fx-help-title" ref={title} tabIndex={-1}>{tr('使用說明')}</h1>
        </header>
        <div className="fx-help-body">
          <nav className="fx-help-nav" aria-label={tr('說明項目')} onKeyDown={onTabKey}>
            {TOPICS.filter((t) => !t.group).map(topicLink)}
            {GROUPS.map((g) => (
              <section key={g} aria-labelledby={`fx-help-group-${g}`}>
                <h2 id={`fx-help-group-${g}`}>{tr(g)}</h2>
                {TOPICS.filter((t) => t.group === g).map(topicLink)}
              </section>
            ))}
            <section aria-labelledby="fx-help-group-looks">
              <h2 id="fx-help-group-looks">{tr('外觀')}</h2>
              {GALLERIES.map((g) => link(g, tr(GALLERY_NAMES[g])))}
            </section>
          </nav>
          {/* keyed, so each topic turns in like a fresh page */}
          {gallery ? (
            <section key={gallery} id="fx-help-panel" className="fx-page fx-help-page" aria-labelledby="fx-help-page-title">
              <h2 id="fx-help-page-title">{tr(GALLERY_NAMES[gallery])}</h2>
              <Looks gallery={gallery} open={sample && !sample.leaving && sample.gallery === gallery ? sample.id : null} onOpen={openSample} />
            </section>
          ) : (
            <section key={current.id} id="fx-help-panel" className="fx-page fx-help-page" aria-labelledby="fx-help-page-title">
              <h2 id="fx-help-page-title">{shown.title ?? shown.label}</h2>
              {SHOTS[`./help/${SHOT_SET[appLanguage()]}/${current.id}.jpg`] && <img className="fx-help-shot" src={SHOTS[`./help/${SHOT_SET[appLanguage()]}/${current.id}.jpg`]} alt={shown.alt} />}
              <TopicBody body={shown.body} />
            </section>
          )}
        </div>
      </div>
      {covered && !leaving && <button type="button" className="fx-detail-cover" aria-label={tr('收起上面那張，回到這張')} onClick={putAway} />}
    </aside>
    {sample && (
      <SampleSheet key={`${sample.gallery}/${sample.id}`} sample={sample} leaving={leaving || sample.leaving} onBack={putAway}
        onGone={() => setSample((s) => (s?.leaving ? null : s))} />
    )}
    </>
  )
}
