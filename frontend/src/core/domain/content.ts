// Fake agent output. Everything here is placeholder content for the prototype.

import { between, chance, hex, pick, rand, sample } from './rng'
import type { Handoff, LogKind, Script, Task, World, WorkflowNode } from './types'

export type Role = 'intake' | 'research' | 'report' | 'dev' | 'review' | 'docs' | 'test' | 'generic'

const KEYWORDS: [Role, RegExp][] = [
  ['research', /研究|調查|紀錄|research|investigat|log/i],
  ['report', /報告|report|summary/i],
  ['dev', /開發|實作|程式|修正|dev|build|implement|code|fix/i],
  ['review', /驗收|審查|審核|review/i],
  ['docs', /文件|docs?|writ/i],
  ['test', /測試|重現|test|qa|reproduc/i],
]

export function roleOf(node: WorkflowNode): Role {
  if (node.kind === 'task') return 'intake'
  return KEYWORDS.find(([, re]) => re.test(node.name))?.[0] ?? 'generic'
}

type Line = [LogKind, string]

const LINES: Record<Role, Line[]> = {
  intake: [
    ['think', '先讀任務描述，找出目標與驗收條件。'],
    ['tool', 'read_file README.md'],
    ['tool', 'git log --oneline -n 20'],
    ['think', '描述裡沒有寫時程，先當成本週內完成。'],
    ['say', '需求整理完成：目標、範圍、驗收條件各一段。'],
    ['tool', 'write_file .team/intake.md'],
  ],
  research: [
    ['think', '先看現有程式怎麼處理「{t}」相關的部分。'],
    ['tool', 'grep -rn "menu" src/'],
    ['tool', 'web_search "best practice {t}"'],
    ['tool', 'read_file src/pages/home.tsx'],
    ['think', '有兩種做法：改既有元件，或另外做新區塊。'],
    ['say', '比較兩種做法的成本與風險。'],
    ['tool', 'write_file .team/research.md'],
  ],
  report: [
    ['think', '把研究筆記整理成給人看的版本。'],
    ['tool', 'read_file .team/research.md'],
    ['say', '先寫一句話結論，再列建議與下一步。'],
    ['tool', 'write_file docs/reports/{slug}.md'],
    ['think', '刪掉太技術的段落，改用例子說明。'],
  ],
  dev: [
    ['think', '依交接內容，先改資料層再改畫面。'],
    ['tool', 'read_file src/components/Menu.tsx'],
    ['tool', 'apply_patch src/components/Menu.tsx'],
    ['tool', 'npm test -- menu'],
    ['say', '1 個測試失敗，是快照過期。'],
    ['tool', 'npm test -- -u'],
    ['tool', 'npm test'],
    ['say', '全部 128 個測試通過。'],
    ['tool', 'git commit -m "feat: {t}"'],
  ],
  review: [
    ['tool', 'git diff main...HEAD --stat'],
    ['think', '先看有沒有遺漏的錯誤處理。'],
    ['tool', 'read_file src/components/Menu.tsx'],
    ['say', '有一處沒處理空陣列，列為必須修改。'],
    ['tool', 'npm test'],
    ['say', '測試通過，命名有兩處建議修改。'],
  ],
  docs: [
    ['tool', 'read_file docs/api.md'],
    ['think', '對照程式，找出文件和實作不一致的地方。'],
    ['tool', 'apply_patch docs/api.md'],
    ['say', '補上 3 個新參數的說明與範例。'],
  ],
  test: [
    ['tool', 'npm test -- --coverage'],
    ['think', '覆蓋率 71%，結帳流程最低。'],
    ['tool', 'write_file tests/checkout.test.ts'],
    ['tool', 'npm test'],
    ['say', '新增 6 個測試，全部通過。'],
  ],
  generic: [
    ['think', '先理解交接內容。'],
    ['tool', 'read_file .team/handoff.md'],
    ['say', '依節點說明處理中。'],
    ['tool', 'write_file .team/output.md'],
  ],
}

const ASKS: Partial<Record<Role, { prompt: string; options: string[] }[]>> = {
  intake: [{ prompt: '任務沒有寫完成期限，要以什麼為準？', options: ['本週內', '下個版本', '不急，品質優先'] }],
  research: [
    { prompt: '找到兩個可行方案，要往哪個方向深入？', options: ['改既有元件', '另外做新區塊'] },
    { prompt: '要不要把競品也納入比較？', options: ['要', '不用'] },
  ],
  dev: [
    { prompt: '這個改動會影響舊版 API，要保留相容嗎？', options: ['保留相容', '直接改，發 breaking change'] },
    { prompt: '測試資料庫連不上，要改用假資料繼續嗎？', options: ['改用假資料', '等我修好資料庫'] },
  ],
  review: [{ prompt: '有一處風格和既有程式不一致，要求修改還是放行？', options: ['要求修改', '放行'] }],
}

const MEMORY: Record<Role, string[]> = {
  intake: ['使用者的任務描述通常不寫期限，預設本週內。', '這間公司的驗收條件以「能在 staging 操作」為準。'],
  research: ['專案的 UI 元件都在 src/components，樣式用 CSS Modules。', 'web_search 對這個領域的結果品質不高，優先看官方文件。'],
  report: ['使用者偏好先看一句話結論，再看細節。', '報告放在 docs/reports/，檔名用英文 slug。'],
  dev: ['測試指令是 npm test，快照過期要先確認再用 -u 更新。', 'src/legacy/ 不要改，之後會整個移除。'],
  review: ['公司規定 PR 不能有 console.log。', '錯誤訊息要同時有中文與英文。'],
  docs: ['API 文件的範例統一用 curl。'],
  test: ['結帳流程的測試要 mock 金流 SDK。'],
  generic: ['交接內容放在 .team/ 資料夾。'],
}

const OUTPUTS: Record<Role, string[]> = {
  intake: ['.team/intake.md'],
  research: ['.team/research.md'],
  report: ['docs/reports/{slug}.md'],
  dev: ['src/components/Menu.tsx', 'src/components/Menu.test.tsx'],
  review: ['.team/review.md'],
  docs: ['docs/api.md'],
  test: ['tests/checkout.test.ts'],
  generic: ['.team/output.md'],
}

const HEADLINE: Record<Role, string[]> = {
  intake: ['需求已整理好，目標和驗收條件都寫清楚了。'],
  research: ['建議改既有元件，風險較低，約兩天可完成。', '找到可行做法，主要風險是舊資料相容。'],
  report: ['報告完成，結論是值得做，建議分兩階段上線。'],
  dev: ['功能做好了，測試全部通過。', '改動完成，順便修了一個舊的空值錯誤。'],
  review: ['驗收通過，留了兩個不影響上線的建議。', '有一處必須修改，已直接修正並重新跑過測試。'],
  docs: ['文件已更新，補上新參數的說明。'],
  test: ['補上 6 個測試，覆蓋率從 71% 提升到 83%。'],
  generic: ['這個步驟完成了。'],
}

// why a review does not pass, and why a step sent back sends it further back
const SEND_BACK: Partial<Record<Role, string[]>> = {
  review: ['少了錯誤處理的測試，補上再送審。', '空資料時畫面會出錯，修正後再送審。', '命名和既有程式不一致，必須修改。'],
}
const SEND_BACK_UP = ['問題出在上一步的結論，需要重新確認。', '交接的資料不完整，請補齊再交過來。']

const fill = (s: string, task: Task) =>
  s.replaceAll('{t}', task.title).replaceAll('{slug}', `task-${task.number}`)

export function makeScript(w: World, role: Role, task: Task, override?: Partial<Script>): Script {
  const raw = LINES[role]
  const lines = raw.map(([kind, text], i) => ({
    p: Math.min(0.95, (i + 0.5) / raw.length + between(w, -0.03, 0.03)),
    kind,
    text: fill(text, task),
  }))
  const asks = ASKS[role]
  const script: Script = {
    lines,
    duration: between(w, 18, 30),
    costRate: between(w, 0.012, 0.03),
    route: chance(w, 0.12) ? 'unsure' : rand(w) < 0.5 ? 0 : 1,
  }
  if (asks && chance(w, 0.18)) {
    const a = pick(w, asks)
    script.ask = { p: between(w, 0.35, 0.65), prompt: a.prompt, options: a.options }
  }
  if (chance(w, 0.08)) script.fail = { p: between(w, 0.3, 0.7), reason: chance(w, 0.5) ? 'timeout' : 'error', times: 1 }
  if (chance(w, 0.35)) script.memory = { p: between(w, 0.3, 0.8), text: pick(w, MEMORY[role]) }
  if (chance(w, 0.5)) script.retro = pick(w, MEMORY[role])
  script.sendBack = { roll: rand(w), reason: pick(w, SEND_BACK[role] ?? SEND_BACK_UP) }
  return { ...script, ...override }
}

export function makeHandoff(w: World, role: Role, task: Task, node: WorkflowNode): Handoff {
  const commit = hex(w)
  const outputs = OUTPUTS[role].map((o) => fill(o, task))
  const done = sample(w, LINES[role].filter(([k]) => k === 'say').map(([, t]) => fill(t, task)), 2)
  return {
    commit,
    agent: {
      goal: `${task.title}｜${node.name}`,
      done: done.length ? done : [`${node.name}完成`],
      outputs: [...outputs, `commit ${commit} @ ${task.branch}`],
      decisions: chance(w, 0.6) ? ['沿用既有元件，不新增相依套件'] : [],
      open: chance(w, 0.4) ? ['行動版的間距還沒有逐頁確認'] : [],
    },
    human: {
      headline: pick(w, HEADLINE[role]),
      did: done.length ? done : [`完成${node.name}`],
      outputs,
    },
  }
}
