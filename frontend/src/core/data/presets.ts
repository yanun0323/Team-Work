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
  [DEFAULT_FLOW, []],
  ['功能開發', [
    [['撰寫規格', '把需求寫成規格：範圍、不做的事、驗收條件。']],
    [['拆解工作', '依規格拆成前端和後端的工作，定好兩邊之間的介面。']],
    [['後端開發', '依規格實作後端並附測試，小步提交。這次沒有後端工作就說明原因，直接交接。'], ['前端開發', '依規格實作前端並附測試，小步提交。這次沒有前端工作就說明原因，直接交接。']],
    [['測試', '照驗收條件實際驗證，寫下每一條的結果和發現的問題。']],
  ]],
  ['修 Bug', [
    [['重現問題', '寫一個會失敗的測試重現問題，找不到重現方式就說明試過什麼。']],
    [['修正', '找出根本原因，讓失敗的測試通過，不改無關的程式。']],
    [['回歸測試', '跑完整測試，確認問題已修好，相關功能也沒有壞。']],
  ]],
  ['產品規劃', [
    [['討論需求', TALK_PROMPT]],
    [['撰寫規格', '把討論的結論寫成規格，放進 docs/：範圍、不做的事、驗收條件。']],
    [['拆解工作', '把規格拆成可以各自完成的工作，排好順序，標出風險。']],
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
