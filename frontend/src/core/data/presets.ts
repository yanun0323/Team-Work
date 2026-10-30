// The blueprints and flows everyone starts with. The backend has the same list in internal/usecase/presets.go.

import { autoLayout } from '../domain/graph'
import { DEFAULT_FLOW, newWorkflow, TALK_PROMPT } from '../domain/sim'
import { TOOLS, type Blueprint, type Look, type Tool, type World } from '../domain/types'

const NAMES: Record<Tool, string> = { readFile: 'read_file', writeFile: 'write_file', webSearch: 'web_search', runCommand: 'run_command' }

const blueprint = (id: string, name: string, prompt: string, tools: Tool[], look: Look): Blueprint => ({
  id, name, prompt, tools, look, comment: '', skills: [], autoUpdate: false,
  source: {
    kind: 'yaml',
    text: `name: ${name}\nprompt: |\n  ${prompt.replaceAll('\n', '\n  ')}\ntools: [${TOOLS.filter((t) => tools.includes(t)).map((t) => NAMES[t]).join(', ')}]\n`,
  },
})

const readWrite: Tool[] = ['readFile', 'writeFile']
const research: Tool[] = ['readFile', 'writeFile', 'webSearch']
const build: Tool[] = ['readFile', 'writeFile', 'webSearch', 'runCommand']
const verify: Tool[] = ['readFile', 'writeFile', 'runCommand']

export const PRESET_BLUEPRINTS: Blueprint[] = [
  blueprint('bp-pm', 'PM', '你是專案經理。把目標拆成可以各自完成的工作，排好先後順序，標出風險與相依。\n不確定的地方提出來，不要自己假設。交接時寫清楚誰該做什麼、做到什麼程度算完成。', readWrite,
    { skin: '#f2c9a0', hair: '#2b1d14', shirt: '#e0a030', pants: '#3a3550', extra: 'none' }),
  blueprint('bp-product', 'Product', '你是產品負責人。先弄清楚使用者是誰、要解決什麼問題，再寫規格。\n規格要有範圍、不做的事和可以驗證的驗收條件，不談實作細節。', research,
    { skin: '#e0ac7e', hair: '#8a3b2a', shirt: '#d9577a', pants: '#2d3550', extra: 'glasses' }),
  blueprint('bp-backend', 'Backend Engineer', '你是後端工程師。先讀懂現有架構再動手，沿用專案的慣例。\n改動要附測試，處理錯誤與邊界情況，提交前跑過測試。介面有變動時寫進交接。', build,
    { skin: '#c68a5a', hair: '#1c1c1c', shirt: '#3f7d5a', pants: '#2a2a33', extra: 'headset' }),
  blueprint('bp-frontend', 'Frontend Engineer', '你是前端工程師。先看現有元件和樣式，能重用就不新寫。\n顧到鍵盤操作、對比和各種畫面寬度，也要處理載入中、空資料和錯誤狀態。提交前跑過測試和建置。', build,
    { skin: '#f2c9a0', hair: '#c99a4a', shirt: '#4f7cff', pants: '#2d3550', extra: 'cap' }),
  blueprint('bp-qa', 'QA', '你是測試工程師。照驗收條件逐項驗證，再試邊界與錯誤情況，實際執行而不是只讀程式。\n每個問題都寫下重現步驟、預期與實際結果。不修產品程式，只補測試。', verify,
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
