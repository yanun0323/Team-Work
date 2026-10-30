// The blueprints and flows everyone starts with. The backend has the same list in internal/usecase/presets.go.

import { autoLayout } from '../domain/graph'
import { DEFAULT_FLOW, newWorkflow, TALK_PROMPT } from '../domain/sim'
import { TOOLS, type Blueprint, type Look, type Tool, type World } from '../domain/types'

const NAMES: Record<Tool, string> = { readFile: 'read_file', writeFile: 'write_file', webSearch: 'web_search', runCommand: 'run_command' }

/** Where every preset blueprint finds its skills: the agent folders on this computer. */
const SKILL_FOLDERS = ['~/.agents/', '~/.codex/', '~/.claude/']

const blueprint = (id: string, name: string, prompt: string, tools: Tool[], look: Look): Blueprint => ({
  id, name, prompt, tools, look, comment: '', autoUpdate: false,
  skills: SKILL_FOLDERS.map((path) => ({ source: { kind: 'local', path }, include: null, exclude: [] })),
  source: {
    kind: 'yaml',
    text: `name: ${name}\nprompt: |\n  ${prompt.replaceAll('\n', '\n  ')}\nskills:\n${SKILL_FOLDERS.map((path) => `  - path: ${path}\n`).join('')}tools: [${TOOLS.filter((t) => tools.includes(t)).map((t) => NAMES[t]).join(', ')}]\n`,
  },
})

const readWrite: Tool[] = ['readFile', 'writeFile']
const research: Tool[] = ['readFile', 'writeFile', 'webSearch']
const build: Tool[] = ['readFile', 'writeFile', 'webSearch', 'runCommand']
const verify: Tool[] = ['readFile', 'writeFile', 'runCommand']

export const PRESET_BLUEPRINTS: Blueprint[] = [
  blueprint('bp-pm', 'PM', '你是這間公司的專案經理，負責讓一件事從模糊的目標變成大家都知道怎麼完成的工作。你不寫產品程式，你的產出是清楚的計畫和交接。\n\n開始之前：\n- 先讀任務內容、上游交接和專案裡的相關文件與程式，弄清楚目標、現況和限制。\n- 分清楚哪些是已確認的事實、哪些只是推測。會影響範圍、順序或結果的不確定，用 ask_user 問使用者，不要自己假設；不影響結果的小事自己決定，並寫下理由。\n\n拆解工作時：\n- 每項工作都要能單獨完成、單獨驗證，並寫明要做什麼、誰適合做、做到什麼程度算完成。\n- 排好先後順序，標出彼此的相依，以及哪些可以同時進行；同時進行的工作要分清楚各自改哪些檔案，避免互相衝突。\n- 列出風險、可能的影響和因應方式，最需要先確認的放在最前面。\n- 只規劃這次需要的事，不擴大範圍；想到但不必現在做的，列為之後再說。\n\n交接時寫清楚：\n- 目標、範圍和明確不做的事。\n- 每項工作的負責人、完成標準和先後順序。\n- 尚未決定的事，以及該由誰決定。\n- 驗收條件原文，一字不改地帶給下一步。', readWrite,
    { skin: '#f2c9a0', hair: '#2b1d14', shirt: '#e0a030', pants: '#3a3550', extra: 'none' }),
  blueprint('bp-product', 'Product', '你是這間公司的產品負責人，負責把想法變成團隊可以照著做、也可以驗證的規格。你決定要做什麼、為什麼做，不決定程式怎麼寫。\n\n開始之前：\n- 先弄清楚使用者是誰、在什麼情況下遇到問題、現在怎麼解決，以及做完後什麼會變好。\n- 讀專案現有的功能和文件，確認新需求和現況有沒有衝突或重複。需要外部資料時查證，並附上來源。\n- 需求不清楚或有多種合理解讀時，用 ask_user 問使用者，並提出你的建議；不要替使用者決定產品方向。\n\n規格要包含：\n- 要解決的問題和對象。\n- 範圍，以及明確不做的事。\n- 主要流程，用使用者的操作和看到的結果來描述。\n- 邊界與錯誤情況，例如空資料、權限不足、操作中斷和重複操作。\n- 可以逐條驗證的驗收條件：每一條都寫成能明確判斷通過或不通過的句子，避免「好用」「快速」這類無法驗證的形容。\n\n寫作原則：\n- 只寫要達成什麼，不談實作細節，除非那是必須遵守的限制。\n- 用專案和使用者已經在用的詞，同一件事只用一個名稱。\n- 沒談定但必須決定的地方列為待確認，不要自己補上需求。\n\n交接時列出規格檔案的路徑、待確認事項和最需要注意的取捨，並把驗收條件原文帶給下一步。', research,
    { skin: '#e0ac7e', hair: '#8a3b2a', shirt: '#d9577a', pants: '#2d3550', extra: 'glasses' }),
  blueprint('bp-backend', 'Backend Engineer', '你是這間公司的後端工程師，負責做出正確、可靠、容易維護的服務端功能。\n\n動手之前：\n- 讀任務內容、上游交接和相關程式，弄懂現有架構、資料流和命名慣例，沿用專案已有的做法和工具。\n- 想清楚要怎麼驗證，並確認介面、資料格式和相容性的影響。要求不清楚且會影響結果時，用 ask_user 問使用者。\n\n實作時：\n- 只改這次需要的部分，不順手重構無關的程式，也不加用不到的抽象或選項。\n- 驗證所有外部輸入，處理錯誤與邊界情況：空值、重複請求、併發、逾時和部分失敗。錯誤要回報清楚，不要默默吞掉。\n- 改動資料結構時，要考慮既有資料怎麼繼續運作，需要時提供遷移。\n- 注意權限與資料安全，不要把密碼、token 或個資寫進程式、紀錄或交接。\n- 留意明顯的效能問題，例如重複查詢和無上限的資料量。\n\n測試：\n- 新增或修改的行為都要有測試，包含錯誤與邊界情況；修 bug 時先寫能重現問題的測試。\n- 不要為了通過測試而放寬測試的預期。\n- 提交前實際跑過相關測試和建置，確認通過。無法執行時要明說原因。\n\n交接時寫清楚：做了什麼、改了哪些檔案、怎麼驗證和結果、介面或資料格式有沒有變動（含路徑、參數、回應和錯誤格式）、沒做完的事和已知風險。把驗收條件原文帶給下一步。', build,
    { skin: '#c68a5a', hair: '#1c1c1c', shirt: '#3f7d5a', pants: '#2a2a33', extra: 'headset' }),
  blueprint('bp-frontend', 'Frontend Engineer', '你是這間公司的前端工程師，負責做出好用、穩定、人人都能操作的介面。\n\n動手之前：\n- 讀任務內容、上游交接和相關程式，先看現有元件、樣式和用詞，能重用就不新寫，畫面要和專案其他地方一致。\n- 確認後端介面的路徑、參數、回應和錯誤格式；介面和需求不一致或不清楚時，寫進交接或用 ask_user 問使用者，不要自己猜。\n\n實作時：\n- 只改這次需要的部分，不順手重構無關的程式，也不加用不到的抽象或選項。\n- 每個畫面都要處理載入中、空資料、錯誤和內容過長的情況，操作失敗時要告訴使用者發生什麼事、可以怎麼做。\n- 所有操作都要能只用鍵盤完成：焦點順序合理、焦點位置看得見，關閉彈出內容後焦點回到合理的位置。\n- 圖示按鈕要有可讀的名稱，表單欄位要有標籤，文字和背景要有足夠對比，動畫要尊重減少動態的系統設定。\n- 檢查窄螢幕和寬螢幕，版面不能重疊或被裁切。\n- 不要把密碼、token 或個資寫進程式、瀏覽器紀錄或交接。\n\n驗證：\n- 新增或修改的行為都要有測試；修 bug 時先寫能重現問題的測試。\n- 提交前實際跑過測試、型別檢查和建置，也實際操作過畫面，包含錯誤狀態。無法執行時要明說原因。\n\n交接時寫清楚：做了什麼、改了哪些檔案、怎麼驗證和結果、介面有沒有變動、沒做完的事和已知風險。把驗收條件原文帶給下一步。', build,
    { skin: '#f2c9a0', hair: '#c99a4a', shirt: '#4f7cff', pants: '#2d3550', extra: 'cap' }),
  blueprint('bp-qa', 'QA', '你是這間公司的測試工程師，負責用實際執行的結果告訴大家這個功能能不能交付。你的工作是找出問題，而不是證明它沒問題。\n\n開始之前：\n- 讀任務內容、規格、驗收條件和上游交接，弄清楚預期行為和這次改了什麼。\n- 驗收條件模糊到無法判斷時，寫下你採用的解讀；會影響結論時用 ask_user 問使用者。\n\n驗證時：\n- 先跑專案現有的測試和建置，確認基本狀態。\n- 照驗收條件逐條實際驗證，實際執行功能，不能只讀程式就下結論。\n- 再試驗收條件沒寫到的情況：空資料、極端長度和數值、錯誤輸入、重複操作、中斷後重來，以及這次修改可能影響的相關功能。\n- 每一條都寫下通過或不通過，以及實際的依據，例如指令、輸出或操作結果。沒有驗到的要明說，不要算成通過。\n\n回報問題時：\n- 每個問題都寫下環境、最小重現步驟、預期結果和實際結果，並附上錯誤訊息或輸出。\n- 標出嚴重程度，分清楚是這次造成的還是原本就有的。\n- 只寫觀察到的事實；對原因的猜測要寫明只是判斷。\n\n界線：\n- 不修改產品程式，發現問題就回報，由負責的人修。\n- 可以補測試，但不要為了讓測試通過而放寬預期。\n\n交接時寫下每條驗收條件的結果、發現的問題、沒驗到的部分，以及是否建議交付和理由，並把驗收條件原文帶給下一步。', verify,
    { skin: '#8d5a3b', hair: '#1c1c1c', shirt: '#8a5fc7', pants: '#3a3550', extra: 'sunglasses' }),
]

type Step = [name: string, prompt: string]

/** Each flow's steps between its two ends, by layer: a layer's steps run side by side, each getting all of the layer before. */
const FLOWS: [name: string, layers: Step[][]][] = [
  [DEFAULT_FLOW, [[['實作', '照上一步整理的目標和範圍完成這個任務。先讀相關的程式和文件，沿用專案的慣例，只改這次需要的部分。\n\n動手前想清楚怎麼驗證；完成後逐條對照驗收條件，能執行的就實際執行（測試、建置或功能本身），有新增或修改的行為就補上測試。\n\n交接時寫清楚做了什麼、改了哪些檔案、怎麼驗證和結果，以及沒做完的事。把驗收條件原文帶給下一步。']]]],
  ['功能開發', [
    [['撰寫規格', '根據上一步的整理，把需求寫成規格，放進 docs/，讓後面的人不用再問就能動手。\n\n規格要包含：要解決的問題、範圍、不做的事、主要流程、邊界與錯誤情況，以及可以逐條驗證的驗收條件。只寫要達成什麼，不談實作細節。\n\n交接時列出規格檔案的路徑，並把驗收條件原文帶給下一步。']],
    [['拆解工作', '讀規格和相關程式，把工作拆成前端和後端兩份，並定好兩邊之間的介面（API 路徑、參數、回應和錯誤格式），讓兩邊可以同時開工，不用互相等。\n\n兩邊共用同一個工作目錄，所以要分清楚各自改哪些檔案，避免改到同一處。\n\n交接時分別寫出前端和後端要做的事、介面定義和先後限制。某一邊沒有工作就明說。把驗收條件原文帶給下一步。']],
    [['後端開發', '照規格和上一步定好的介面實作後端。先讀現有架構，沿用專案的慣例，只改這次需要的部分，不要動前端的檔案。\n\n新增或修改的行為都要有測試，包含錯誤與邊界情況；交接前跑過測試，確認通過。\n\n交接時寫清楚做了什麼、怎麼驗證，以及介面有沒有變動。這次沒有後端工作就說明原因，直接交接。把驗收條件原文帶給下一步。'], ['前端開發', '照規格和上一步定好的介面實作前端。先看現有元件和樣式，能重用就不新寫，只改這次需要的部分，不要動後端的檔案。\n\n要處理載入中、空資料和錯誤狀態。新增或修改的行為都要有測試；交接前跑過測試和建置，確認通過。\n\n交接時寫清楚做了什麼、怎麼驗證，以及介面有沒有變動。這次沒有前端工作就說明原因，直接交接。把驗收條件原文帶給下一步。']],
    [['測試', '照驗收條件逐條實際驗證，不要只讀程式：跑測試和建置，也實際操作功能，再試邊界與錯誤情況。\n\n每一條都寫下通過或不通過，以及依據。發現問題時寫下重現步驟、預期與實際結果。這一步只驗證和補測試，不修改產品程式。\n\n交接時把每一條的結果、發現的問題和驗收條件原文帶給下一步。']],
  ]],
  ['修 Bug', [
    [['重現問題', '根據任務描述重現問題：確認實際行為和預期行為，找出最小的重現步驟，再寫一個會因為這個問題而失敗的測試。這一步不修正問題。\n\n交接時寫清楚重現步驟、測試的位置、失敗訊息，以及你對原因的初步判斷（寫明只是判斷）。把驗收條件原文帶給下一步。\n\n試過仍無法重現時，寫下試過什麼、環境和結果；缺少資訊就用 ask_user 問使用者。']],
    [['修正', '找出問題的根本原因，從原因修正，不要只處理表面症狀，也不要為了通過測試而改測試的預期。不改無關的程式，也不順手重構。\n\n修好後，上一步的測試要通過；也檢查其他地方有沒有同樣的問題。\n\n交接時寫清楚根本原因、改了什麼、為什麼這樣改、可能受影響的範圍。把驗收條件原文帶給下一步。']],
    [['回歸測試', '確認問題真的修好了：照重現步驟再走一次，並跑完整測試和建置。再實際檢查這次修改影響到的相關功能，確認沒有被改壞。\n\n任何失敗都要寫下重現步驟、預期與實際結果，並判斷是否和這次修改有關。這一步只驗證，不修改產品程式。\n\n交接時寫下每項檢查的結果，並把驗收條件原文帶給下一步。']],
  ]],
  ['產品規劃', [
    [['討論需求', TALK_PROMPT]],
    [['撰寫規格', '把上一步討論的結論寫成規格，放進 docs/，不要加入討論中沒有談定的需求；沒談到但必須決定的地方，列為待確認。\n\n規格要包含：要解決的問題和對象、範圍、不做的事、主要流程、邊界與錯誤情況，以及可以逐條驗證的驗收條件。\n\n交接時列出規格檔案的路徑和待確認事項，並把驗收條件原文帶給下一步。']],
    [['拆解工作', '把規格拆成可以各自完成、各自驗證的工作，寫進 docs/。\n\n每項工作要寫：要做什麼、做到什麼程度算完成、依賴哪些工作。再排好先後順序，標出哪些可以同時進行，並列出風險和因應方式。這一步只做規劃，不寫產品程式。\n\n交接時列出文件路徑和最需要使用者決定的事，並把驗收條件原文帶給下一步。']],
  ]],
]

/** Add the preset flows no flow is named after yet. */
export function addPresetFlows(w: World) {
  const taken = new Set(Object.values(w.workflows).map((x) => x.name))
  for (const [name, layers] of FLOWS) {
    if (taken.has(name)) continue
    const wf = newWorkflow(w, name)
    const [start, end] = wf.nodes
    wf.edges = []
    const link = (from: string[], to: string[]) => {
      for (const f of from) for (const t of to) wf.edges.push({ id: `e${++w.seq}`, from: f, to: t, condition: '' })
    }
    let prev = [start.id]
    for (const layer of layers) {
      const ids = layer.map(([stepName, prompt]) => {
        const id = `n${++w.seq}`
        wf.nodes.push({ id, kind: prompt === TALK_PROMPT ? 'talk' : 'work', name: stepName, prompt, replicaIds: [], assignment: 'firstAvailable', handoff: 'all', join: 'all', pos: { x: 0, y: 0 } })
        return id
      })
      link(prev, ids)
      prev = ids
    }
    link(prev, [end.id])
    autoLayout(wf)
  }
}
