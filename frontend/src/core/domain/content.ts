// Fake agent output. Everything here is placeholder content for the prototype.

import { between, chance, hex, pick, rand, sample } from './rng'
import type { Handoff, Locale, LogKind, Script, Task, World, WorkflowNode } from './types'

export type Role = 'intake' | 'research' | 'report' | 'dev' | 'review' | 'docs' | 'test' | 'talk' | 'generic'

const KEYWORDS: [Role, RegExp][] = [
  ['research', /研究|調查|紀錄|research|investigat|log/i],
  ['report', /報告|report|summary/i],
  ['dev', /開發|實作|程式|修正|dev|build|implement|code|fix/i],
  ['review', /驗收|審查|審核|review/i],
  ['docs', /文件|docs?|writ/i],
  ['test', /測試|重現|test|qa|reproduc/i],
]

export function roleOf(node: WorkflowNode): Role {
  if (node.kind === 'task' || /整理需求|clarify requirements/i.test(node.name)) return 'intake'
  if (node.kind === 'talk') return 'talk'
  return KEYWORDS.find(([, re]) => re.test(node.name))?.[0] ?? 'generic'
}

type Line = [LogKind, string]
/** Each table in both languages, the same length and order, so a world picks the same things in either. */
type Both<T> = Record<Locale, T>

const LINES: Both<Record<Role, Line[]>> = {
  zh: {
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
    talk: [
      ['think', '先讀前面的交接，找出需要使用者決定的地方。'],
      ['tool', 'read_file .team/handoff.md'],
      ['say', '把要決定的事整理成幾個問題。'],
    ],
    generic: [
      ['think', '先理解交接內容。'],
      ['tool', 'read_file .team/handoff.md'],
      ['say', '依節點說明處理中。'],
      ['tool', 'write_file .team/output.md'],
    ],
  },
  en: {
    intake: [
      ['think', 'Reading the task description first, to find the goal and what counts as done.'],
      ['tool', 'read_file README.md'],
      ['tool', 'git log --oneline -n 20'],
      ['think', 'The description gives no deadline, so I will assume this week.'],
      ['say', 'Requirements written up: one part each for the goal, the scope and what counts as done.'],
      ['tool', 'write_file .team/intake.md'],
    ],
    research: [
      ['think', 'Looking at how the code handles what "{t}" touches.'],
      ['tool', 'grep -rn "menu" src/'],
      ['tool', 'web_search "best practice {t}"'],
      ['tool', 'read_file src/pages/home.tsx'],
      ['think', 'Two ways to go: change the existing component, or build a new section.'],
      ['say', 'Compared the cost and risk of both ways.'],
      ['tool', 'write_file .team/research.md'],
    ],
    report: [
      ['think', 'Turning the research notes into something people can read.'],
      ['tool', 'read_file .team/research.md'],
      ['say', 'Opened with a one-line conclusion, then the advice and next steps.'],
      ['tool', 'write_file docs/reports/{slug}.md'],
      ['think', 'Cutting the parts that are too technical and using examples instead.'],
    ],
    dev: [
      ['think', 'Following the handoff: the data layer first, then the screen.'],
      ['tool', 'read_file src/components/Menu.tsx'],
      ['tool', 'apply_patch src/components/Menu.tsx'],
      ['tool', 'npm test -- menu'],
      ['say', '1 test failed: an out-of-date snapshot.'],
      ['tool', 'npm test -- -u'],
      ['tool', 'npm test'],
      ['say', 'All 128 tests pass.'],
      ['tool', 'git commit -m "feat: {t}"'],
    ],
    review: [
      ['tool', 'git diff main...HEAD --stat'],
      ['think', 'Checking for missing error handling first.'],
      ['tool', 'read_file src/components/Menu.tsx'],
      ['say', 'One place does not handle an empty list: must be fixed.'],
      ['tool', 'npm test'],
      ['say', 'Tests pass; two names could be better.'],
    ],
    docs: [
      ['tool', 'read_file docs/api.md'],
      ['think', 'Comparing with the code to find where the docs and the code disagree.'],
      ['tool', 'apply_patch docs/api.md'],
      ['say', 'Documented 3 new parameters, with examples.'],
    ],
    test: [
      ['tool', 'npm test -- --coverage'],
      ['think', 'Coverage is 71%, lowest in checkout.'],
      ['tool', 'write_file tests/checkout.test.ts'],
      ['tool', 'npm test'],
      ['say', 'Added 6 tests; all pass.'],
    ],
    talk: [
      ['think', 'Reading the handoffs so far, to find what the user has to decide.'],
      ['tool', 'read_file .team/handoff.md'],
      ['say', 'Turned what needs deciding into a few questions.'],
    ],
    generic: [
      ['think', 'Reading the handoff first.'],
      ['tool', 'read_file .team/handoff.md'],
      ['say', 'Working on it as the step says.'],
      ['tool', 'write_file .team/output.md'],
    ],
  },
}

const ASKS: Both<Partial<Record<Role, { prompt: string; options: string[] }[]>>> = {
  zh: {
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
  },
  en: {
    intake: [{ prompt: 'The task gives no deadline. What should I aim for?', options: ['This week', 'The next release', 'No rush, quality first'] }],
    research: [
      { prompt: 'I found two ways that work. Which one should I dig into?', options: ['Change the existing component', 'Build a new section'] },
      { prompt: 'Should I compare competitors too?', options: ['Yes', 'No'] },
    ],
    dev: [
      { prompt: 'This change affects the old API. Keep it compatible?', options: ['Keep it compatible', 'Change it and ship a breaking change'] },
      { prompt: 'The test database is down. Carry on with fake data?', options: ['Use fake data', 'Wait until I fix the database'] },
    ],
    review: [{ prompt: 'One place does not match the existing style. Ask for a fix or let it through?', options: ['Ask for a fix', 'Let it through'] }],
  },
}

const MEMORY: Both<Record<Role, string[]>> = {
  zh: {
    intake: ['使用者的任務描述通常不寫期限，預設本週內。', '這間公司的驗收條件以「能在 staging 操作」為準。'],
    research: ['專案的 UI 元件都在 src/components，樣式用 CSS Modules。', 'web_search 對這個領域的結果品質不高，優先看官方文件。'],
    report: ['使用者偏好先看一句話結論，再看細節。', '報告放在 docs/reports/，檔名用英文 slug。'],
    dev: ['測試指令是 npm test，快照過期要先確認再用 -u 更新。', 'src/legacy/ 不要改，之後會整個移除。'],
    review: ['公司規定 PR 不能有 console.log。', '錯誤訊息要同時有中文與英文。'],
    docs: ['API 文件的範例統一用 curl。'],
    test: ['結帳流程的測試要 mock 金流 SDK。'],
    talk: ['使用者喜歡一次只回答一個問題。'],
    generic: ['交接內容放在 .team/ 資料夾。'],
  },
  en: {
    intake: ['The user\'s tasks rarely give a deadline; assume this week.', 'Here, done means it works on staging.'],
    research: ['UI components live in src/components and use CSS Modules.', 'web_search does poorly in this field; read the official docs first.'],
    report: ['The user likes a one-line conclusion first, then the details.', 'Reports go in docs/reports/, with an English slug as the file name.'],
    dev: ['Tests run with npm test; check an out-of-date snapshot before updating it with -u.', 'Leave src/legacy/ alone; it will be removed.'],
    review: ['Company rule: no console.log in a PR.', 'Error messages need both Chinese and English.'],
    docs: ['API doc examples always use curl.'],
    test: ['Checkout tests mock the payment SDK.'],
    talk: ['The user likes to answer one question at a time.'],
    generic: ['Handoffs go in the .team/ folder.'],
  },
}

const OUTPUTS: Record<Role, string[]> = {
  intake: ['.team/intake.md'],
  research: ['.team/research.md'],
  report: ['docs/reports/{slug}.md'],
  dev: ['src/components/Menu.tsx', 'src/components/Menu.test.tsx'],
  review: ['.team/review.md'],
  docs: ['docs/api.md'],
  test: ['tests/checkout.test.ts'],
  talk: ['.team/discussion.md'],
  generic: ['.team/output.md'],
}

const HEADLINE: Both<Record<Role, string[]>> = {
  zh: {
    intake: ['需求已整理好，目標和驗收條件都寫清楚了。'],
    research: ['建議改既有元件，風險較低，約兩天可完成。', '找到可行做法，主要風險是舊資料相容。'],
    report: ['報告完成，結論是值得做，建議分兩階段上線。'],
    dev: ['功能做好了，測試全部通過。', '改動完成，順便修了一個舊的空值錯誤。'],
    review: ['驗收通過，留了兩個不影響上線的建議。', '有一處必須修改，已直接修正並重新跑過測試。'],
    docs: ['文件已更新，補上新參數的說明。'],
    test: ['補上 6 個測試，覆蓋率從 71% 提升到 83%。'],
    talk: ['討論完成，結論已寫進交接。'],
    generic: ['這個步驟完成了。'],
  },
  en: {
    intake: ['Requirements are written up, with a clear goal and what counts as done.'],
    research: ['Changing the existing component is safer and takes about two days.', 'Found a way that works; the main risk is old data.'],
    report: ['Report done: worth doing, best shipped in two stages.'],
    dev: ['The feature is done and all tests pass.', 'Done, and fixed an old null error on the way.'],
    review: ['Passed, with two suggestions that need not hold up the release.', 'One thing had to change; fixed it and ran the tests again.'],
    docs: ['Docs updated with the new parameters.'],
    test: ['Added 6 tests; coverage went from 71% to 83%.'],
    talk: ['Discussion done; the conclusions are in the handoff.'],
    generic: ['This step is done.'],
  },
}

// a discussion: the employee's opening, then what they say back to each message from the user, in turn
const OPENINGS: Both<string[]> = {
  zh: [
    '「{t}」前面的步驟做完了，有幾件事想先和你確認：\n1. 這次的範圍要包含行動版嗎？\n2. 要先上一個基本版，還是一次做完整？',
    '我讀完前面的交接了。開始之前想問你：「{t}」最在意的是速度、品質，還是要和現有的做法一致？',
    '關於「{t}」，我整理出兩個方向：A 改既有的頁面，B 另外做一個新的。你比較傾向哪一個？',
  ],
  en: [
    'The steps before "{t}" are done. A few things to check with you first:\n1. Should this cover mobile too?\n2. Ship a basic version first, or all of it at once?',
    'I have read the handoffs. Before I start: for "{t}", what matters most: speed, quality, or matching how things are done now?',
    'For "{t}" I see two ways: A changes the existing page, B builds a new one. Which do you prefer?',
  ],
}
const REPLIES: Both<string[]> = {
  zh: [
    '了解，我會照這個方向。還有一點：要不要先給少數使用者試用？',
    '好，我記下來了。這樣做大概要多一天，可以嗎？',
    '收到，我把這些寫進討論紀錄。還有想調整的嗎？沒有的話可以結束討論。',
    '明白。那其他的部分我先照原本的計畫進行。',
  ],
  en: [
    'Got it, I will go that way. One more thing: should a few users try it first?',
    'Noted. That takes about one more day. Is that all right?',
    'Got it, it is in the discussion notes. Anything else to change? If not, you can end the discussion.',
    'Understood. The rest goes ahead as planned.',
  ],
}

// why a review does not pass, and why a step sent back sends it further back
const SEND_BACK: Both<Partial<Record<Role, string[]>>> = {
  zh: { review: ['少了錯誤處理的測試，補上再送審。', '空資料時畫面會出錯，修正後再送審。', '命名和既有程式不一致，必須修改。'] },
  en: { review: ['Tests for error handling are missing; add them and send it again.', 'The screen breaks with no data; fix it and send it again.', 'Names do not match the existing code; they must change.'] },
}
const SEND_BACK_UP: Both<string[]> = {
  zh: ['問題出在上一步的結論，需要重新確認。', '交接的資料不完整，請補齊再交過來。'],
  en: ['The problem is in the step before\'s conclusion; it needs checking again.', 'The handoff is incomplete; fill it in and hand it over again.'],
}

const fill = (s: string, task: Task) =>
  s.replaceAll('{t}', task.title).replaceAll('{slug}', `task-${task.number}`)

export function makeScript(w: World, role: Role, task: Task, override?: Partial<Script>): Script {
  const l = w.language
  // a discussion only gets ready and opens; the user decides the rest, so nothing goes wrong on its own
  if (role === 'talk') {
    const raw = LINES[l].talk
    return {
      lines: raw.map(([kind, text], i) => ({ p: (i + 0.5) / raw.length, kind, text: fill(text, task) })),
      duration: between(w, 6, 10),
      costRate: between(w, 0.012, 0.03),
      route: 0,
      talk: { opening: fill(pick(w, OPENINGS[l]), task), replies: sample(w, REPLIES[l], REPLIES[l].length) },
      ...override,
    }
  }
  const raw = LINES[l][role]
  const lines = raw.map(([kind, text], i) => ({
    p: Math.min(0.95, (i + 0.5) / raw.length + between(w, -0.03, 0.03)),
    kind,
    text: fill(text, task),
  }))
  const asks = ASKS[l][role]
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
  if (chance(w, 0.35)) script.memory = { p: between(w, 0.3, 0.8), text: pick(w, MEMORY[l][role]) }
  if (chance(w, 0.5)) script.retro = pick(w, MEMORY[l][role])
  script.sendBack = { roll: rand(w), reason: pick(w, SEND_BACK[l][role] ?? SEND_BACK_UP[l]) }
  return { ...script, ...override }
}

export function makeHandoff(w: World, role: Role, task: Task, node: WorkflowNode): Handoff {
  const en = w.language === 'en'
  const commit = hex(w)
  const outputs = OUTPUTS[role].map((o) => fill(o, task))
  const done = sample(w, LINES[w.language][role].filter(([k]) => k === 'say').map(([, t]) => fill(t, task)), 2)
  return {
    commit,
    agent: {
      goal: `${task.title}${en ? ' | ' : '｜'}${node.name}`,
      done: done.length ? done : [en ? `${node.name} done` : `${node.name}完成`],
      outputs: [...outputs, `commit ${commit} @ ${task.branch}`],
      decisions: chance(w, 0.6) ? [en ? 'Kept the existing components; no new dependencies' : '沿用既有元件，不新增相依套件'] : [],
      open: chance(w, 0.4) ? [en ? 'Mobile spacing not yet checked page by page' : '行動版的間距還沒有逐頁確認'] : [],
    },
    human: {
      headline: pick(w, HEADLINE[w.language][role]),
      did: done.length ? done : [en ? `Finished ${node.name}` : `完成${node.name}`],
      outputs,
    },
  }
}
