// The help: a sheet over the middle of the map, pasted on and taken off like a drawer. Topics down the
// left; the one picked on the right, a picture of that part of the app over the words. As with the
// drawers, a click on the map or Esc puts it away.

import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import blueprintShot from './help/blueprint.jpg'
import companyShot from './help/company.jpg'
import crewShot from './help/crew.jpg'
import flowShot from './help/flow.jpg'
import mapShot from './help/map.jpg'
import providerShot from './help/provider.jpg'
import startShot from './help/start.jpg'
import taskShot from './help/task.jpg'

interface Topic {
  id: string
  label: string
  /** A screenshot of that part of the app, and what it shows. */
  shot: string
  alt: string
  body: ReactNode
}

const TOPICS: Topic[] = [
  {
    id: 'start',
    shot: startShot,
    alt: '島上的兩間公司和機場，右上角是告示牌、新公司、編輯地圖、說明和設定（飛機）按鈕',
    label: '開始使用',
    body: (
      <>
        <p>Mho Company 把每個專案當成一間公司，蓋在島上的一棟大樓裡。公司裡的員工是 AI agent，照著流程一步步完成你交代的任務。</p>
        <ol>
          <li>在「設定 → 模型供應商」接上至少一個供應商，員工才有模型可用。</li>
          <li>按「＋ 新公司」，在地圖上選位置，再填專案資料夾、名稱和目標分支。</li>
          <li>在公司的「員工」頁籤新增員工：選一個員工藍圖和模型。</li>
          <li>在「任務」頁籤建立任務：寫下要做什麼、選流程，再為每一步挑員工（整理需求和驗收由任務負責人做）。</li>
          <li>員工照流程接力完成；打開任務看「進度」，有人等你回覆時回覆他。</li>
        </ol>
      </>
    ),
  },
  {
    id: 'map',
    shot: mapShot,
    alt: '編輯地圖時，選取的公司跟著游標出現一塊虛線用地',
    label: '地圖',
    body: (
      <>
        <p>島上每棟大樓是一間公司。大樓會跟著公司成長：完成的任務和員工越多，樓層越高、佔地越大（最大 10×10 格、10 層）。</p>
        <dl>
          <dt>移動視角</dt><dd>拖曳地圖，或用 WASD、方向鍵（按住 Shift 加速）；滾輪縮放：拉近時朝游標所在處，拉遠時以畫面中央為中心。</dd>
          <dt>打開公司</dt><dd>點大樓、它的用地或名牌。點地圖其他地方或按 Esc 收起。</dd>
          <dt>機場</dt><dd>島上固定的機場，有航廈、塔台、停機坪、直升機坪和跑道，飛機會降落、滑行到停機位、再起飛，偶爾也有其他飛機從高空飛越。點機場（或它的名牌）打開設定，鏡頭會移到機場；用右上角的飛機按鈕打開則不移動。機場不能搬，新公司也不能蓋在上面。</dd>
          <dt>告示牌</dt><dd>打開「所有任務」，依公司列出每間公司的任務，也可以直接新增任務。有任務等你回覆時，按鈕右上角的紅色圓形會顯示待回覆的任務數，那些任務的便利貼右上角也有紅色驚嘆號。</dd>
          <dt>＋ 新公司</dt><dd>虛線框跟著游標走，陸地或海上都能放；變紅就是太擠或離岸太遠。放在海上會自動長出陸地接回島上。放好後先看到大樓的預覽，外觀是隨機的，可以擲骰子換一套。</dd>
          <dt>編輯地圖</dt><dd>點一間公司選取它，再點新的位置就搬過去；放回原處則不變。搬走後原本的地留著。機場不能搬。按「完成」或 Esc 結束。</dd>
        </dl>
      </>
    ),
  },
  {
    id: 'company',
    shot: companyShot,
    alt: '打開的公司：左邊是剖開的辦公室，右邊是公司檔案的任務頁籤',
    label: '公司',
    body: (
      <>
        <p>一間公司對應一個專案資料夾和一個目標分支。打開公司後，右邊是公司檔案，左邊的辦公室裡看得到員工：有工作的人坐在位子上，沒事的人會起身走動、找同事聊天、坐沙發、喝咖啡或發呆。每間辦公室都有咖啡機和沙發。</p>
        <dl>
          <dt>任務</dt><dd>依狀態分成待辦、進行中、待回覆、完成。</dd>
          <dt>流程設計</dt><dd>這間公司做事的方法，可以有好幾條。</dd>
          <dt>員工</dt><dd>依員工藍圖分組。</dd>
          <dt>設定</dt><dd>公司資料和公司規章（給這間公司每位員工的共同指示），最下方是「解散公司」。解散會移除員工、流程和任務，大樓的地留著；可選擇同時刪除本地檔案（預設不勾）。</dd>
        </dl>
      </>
    ),
  },
  {
    id: 'task',
    shot: taskShot,
    alt: '任務的詳細內容：流程圖和每一步的進度',
    label: '任務',
    body: (
      <>
        <p>任務是你交給公司的一件工作，照一條流程進行。每個任務有一位「任務負責人」，負責開頭的「整理需求」和結尾的「驗收」。</p>
        <p>流程的每一步會變成一個子任務，交給那一步指定的員工；做完寫下交接摘要，交給下一步。詳細內容的「進度」列出每個子任務的狀態，點開可以看紀錄和交接的檔案。</p>
        <p>新增任務時可以附圖：按「＋」選圖片，或直接在文字框貼上截圖。</p>
        <p>驗收沒過時，工作會退回前一步重做，一個任務最多退回兩次。員工有問題、拿不定下一步、重試用完或費用到上限時，任務變成「待回覆」：「進度」裡那一步會寫出員工的完整訊息，下面可以選一個選項、寫回覆，按「確認」送出。驗收通過後任務也會變成「待回覆」，由你按「合併」讓任務負責人把它合併回目標分支，或按「退回」寫下要改什麼、退回重做。任務可以編輯、暫停和刪除。</p>
      </>
    ),
  },
  {
    id: 'flow',
    shot: flowShot,
    alt: '流程設計頁籤：從整理需求到驗收的便條紙流程圖',
    label: '流程',
    body: (
      <>
        <p>流程是做事的步驟，由左到右畫成便條紙和箭頭。每條流程都從「整理需求」開始、以「驗收」結束（紅色便條紙，固定由任務負責人執行）。</p>
        <p>中間的每一步寫下指示和交接方式。一步可以分給好幾個下一步，也可以等好幾個前一步；虛線箭頭代表「選一個下一步」或「任一個前一步完成就開始」。</p>
        <p>流程不指定員工，由每個任務決定這次誰來做。流程可以新增、編輯、複製和刪除，公司至少要留一條。</p>
      </>
    ),
  },
  {
    id: 'crew',
    shot: crewShot,
    alt: '員工頁籤：依員工藍圖分組，名字下寫著模型和思考等級',
    label: '員工',
    body: (
      <>
        <p>員工是在公司裡工作的 AI agent。每位員工由一個員工藍圖建立，再選自己的模型和思考等級（低、中、高、最高），還可以擲骰子換外觀。</p>
        <p>員工的詳細內容有工作紀錄和記憶。解僱員工前要選一位接手的人，他手上的任務和步驟會交接過去；公司只剩一位員工時不能解僱。</p>
      </>
    ),
  },
  {
    id: 'blueprint',
    shot: blueprintShot,
    alt: '員工藍圖的詳細內容：來源、提示詞、技能和工具',
    label: '員工藍圖',
    body: (
      <>
        <p>員工藍圖是員工的範本：名稱、提示詞、技能和允許的工具。藍圖不含模型，模型由每位員工自己選。所有公司共用藍圖，在「設定 → 員工藍圖」管理。</p>
        <dl>
          <dt>來源</dt><dd>從 GitHub repo 匯入，或直接寫 YAML。</dd>
          <dt>技能</dt><dd>可以來自本機資料夾或多個 GitHub repo，用 include、exclude 挑選。每個 GitHub 來源都會標出更新狀態。</dd>
          <dt>工具</dt><dd>只有讀取檔案、寫入檔案、網路搜尋、執行指令四種。</dd>
        </dl>
        <p>還有員工使用的藍圖不能刪除。</p>
      </>
    ),
  },
  {
    id: 'provider',
    shot: providerShot,
    alt: '模型供應商的詳細內容：連線方式、模型和使用中的員工',
    label: '模型供應商',
    body: (
      <>
        <p>模型供應商提供員工可用的模型，在「設定 → 模型供應商」管理。類型有 Anthropic、OpenAI、Google Gemini 和 OpenAI 相容（例如 DeepSeek、本機的 Ollama）。</p>
        <dl>
          <dt>API Key</dt><dd>填入 API Key，只會保存最後四碼供辨認。OpenAI 相容要填 API 位址。</dd>
          <dt>訂閱登入</dt><dd>Anthropic 和 OpenAI 可以改用 Claude 或 ChatGPT 訂閱登入，不需要 API Key。</dd>
        </dl>
        <p>模型由供應商提供，不用自己輸入。還有員工使用它的模型時不能刪除。</p>
        <p>「設定 → 設定」可以調整任務紀錄的排序，以及關掉細節、陰影、路人、飛機動畫或雲朵來讓畫面跑得更順；設定會記在這台電腦的瀏覽器裡。</p>
      </>
    ),
  },
]

export function Help({ leaving, onGone }: {
  leaving: boolean
  /** Called when the sheet has come off. */
  onGone: () => void
}) {
  const [topic, setTopic] = useState(TOPICS[0].id)
  const title = useRef<HTMLHeadingElement>(null)
  const tabs = useRef<Array<HTMLButtonElement | null>>([])
  useEffect(() => title.current?.focus({ preventScroll: true }), [])
  const current = TOPICS.find((t) => t.id === topic) ?? TOPICS[0]

  // up and down move between topics, as in any vertical tab list
  const onTabKey = (e: KeyboardEvent) => {
    const i = TOPICS.findIndex((t) => t.id === topic)
    const next = { ArrowDown: i + 1, ArrowUp: i - 1, Home: 0, End: TOPICS.length - 1 }[e.key]
    if (next === undefined) return
    e.preventDefault()
    const j = (next + TOPICS.length) % TOPICS.length
    setTopic(TOPICS[j].id)
    tabs.current[j]?.focus()
  }

  return (
    <aside className={leaving ? 'fx-drawer fx-help leaving' : 'fx-drawer fx-help'} role="dialog" aria-modal="true" aria-labelledby="fx-help-title"
      aria-hidden={leaving || undefined} inert={leaving || undefined}
      onAnimationEnd={(e) => { if (leaving && e.target === e.currentTarget) onGone() }}>
      <span className="fx-tape fx-tape-l" aria-hidden="true" />
      <span className="fx-tape fx-tape-r" aria-hidden="true" />
      <div className="fx-sheet">
        <header className="fx-head fx-head-rule fx-help-head">
          <h1 id="fx-help-title" ref={title} tabIndex={-1}>使用說明</h1>
        </header>
        <div className="fx-help-body">
          <nav className="fx-help-nav" role="tablist" aria-orientation="vertical" aria-label="說明項目" onKeyDown={onTabKey}>
            {TOPICS.map((t, i) => (
              <button key={t.id} ref={(el) => void (tabs.current[i] = el)} type="button" role="tab"
                id={`fx-help-tab-${t.id}`} aria-controls="fx-help-panel" aria-selected={topic === t.id}
                tabIndex={topic === t.id ? 0 : -1} onClick={() => setTopic(t.id)}>
                {t.label}
              </button>
            ))}
          </nav>
          {/* keyed, so each topic turns in like a fresh page */}
          <section key={current.id} id="fx-help-panel" className="fx-page fx-help-page" role="tabpanel" aria-labelledby={`fx-help-tab-${current.id}`}>
            <h2>{current.label}</h2>
            <img className="fx-help-shot" src={current.shot} alt={current.alt} />
            {current.body}
          </section>
        </div>
      </div>
    </aside>
  )
}
