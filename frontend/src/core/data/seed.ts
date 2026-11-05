// Fake starting world. Tasks are pre-run so the board opens with something in every column.

import { autoLayout } from '../domain/graph'
import { mockThinking } from '../../providers'
import { fixedSteps, installPresets } from './presets'
import {
  adoptSources, AIRPORT_STAFF_LOOK, createTask, createTeam, hire, mergeTask, newWorkflow, pauseTask, remember, resumeTask, REPLY_TIME, sayInTalk, tick,
} from '../domain/sim'
import type { Blueprint, GitSource, Locale, Look, ModelProvider, Workflow, WorkflowNode, World } from '../domain/types'

const look = (shirt: string, pants: string, extra: Look['extra']): Look => ({
  skin: '#f2c9a0', hair: '#2b1d14', shirt, pants, extra,
})

/** A public GitHub repo at a version, reached and up to date unless `extra` says otherwise. */
const git = (repo: string, ref: string, commit: string, extra: Partial<GitSource> = {}): GitSource => ({
  kind: 'git', repo: `https://github.com/${repo}`, ref, commit, latestRef: ref, latest: commit, private: false,
  upstream: true, ...extra,
})

/** The sample world's words in one of its languages: every text below comes in both. */
type Pick = <T>(zh: T, en: T) => T
const inLanguage = (language: Locale): Pick => (zh, en) => (language === 'en' ? en : zh)

const providers = (L: Pick): ModelProvider[] => ([
  { id: 'mp-anthropic', name: L('Claude 訂閱', 'Claude subscription'), kind: 'anthropic', auth: { kind: 'subscription', signedIn: true }, baseUrl: '', models: ['claude-opus-5-5', 'claude-sonnet-5', 'claude-haiku-5'] },
  { id: 'mp-openai', name: 'OpenAI', kind: 'openai', baseUrl: '', auth: { kind: 'apiKey', keyHint: 'x9Lm' }, models: ['gpt-5.5', 'gpt-5.5-codex'] },
  { id: 'mp-google', name: 'Google', kind: 'google', baseUrl: '', auth: { kind: 'apiKey', keyHint: 'c3Vd' }, models: ['gemini-3-pro'] },
  { id: 'mp-deepseek', name: 'DeepSeek', kind: 'compatible', baseUrl: 'https://api.deepseek.com/v1', auth: { kind: 'apiKey', keyHint: '0f4e' }, models: ['deepseek-v4'] },
] as ModelProvider[]).map((p) => ({ ...p, thinking: mockThinking(p.kind, p.models) }))

const blueprints = (L: Pick): Blueprint[] => [
  {
    id: 'bp-researcher', name: 'Researcher',
    source: git('acme/agent-blueprints', 'v1.4.0', '3f9a2c1', { update: { at: 0, ok: true } }),
    prompt: L('你是研究員。先讀現有資料，再比較方案，結論要附來源。', 'You are a researcher. Read what exists first, then compare options; cite sources for your conclusions.'),
    comment: L('適合長篇閱讀，建議用上下文長的模型。', 'Suited to long reading; a model with a long context works best.'),
    skills: [
      { source: null, include: ['literature-review'], exclude: [] },
      { source: git('anthropics/skills', 'main', '8d21f7a', { update: { at: 0, ok: true } }), include: ['web-search', 'summarize'], exclude: [] },
    ],
    tools: ['readFile', 'webSearch'],
    look: look('#4f7cff', '#2d3550', 'glasses'),
  },
  {
    id: 'bp-developer', name: 'Developer',
    // a newer version is out and has not been taken yet
    source: git('acme/agent-blueprints', 'v2.1.0', 'a71c09e', { latestRef: 'v2.2.0', latest: 'c04d5b8' }),
    prompt: L('你是工程師。小步提交，每次提交前跑測試。', 'You are an engineer. Commit in small steps and run the tests before each commit.'),
    comment: '',
    skills: [
      { source: null, include: ['tdd'], exclude: [] },
      // the last update failed, so the older version is still in use
      { source: git('acme/go-skills', 'v1.2.0', '51be0d3', { latestRef: 'v1.3.0', latest: 'e9a4c27', update: { at: 0, ok: false, error: L('新版本缺少 SKILL.md', 'The new version has no SKILL.md') } }), include: null, exclude: [] },
      // the repo was renamed or deleted
      { source: git('frontend-guild/react-skills', 'v0.8.0', '7c3e912', { upstream: false, update: { at: 0, ok: false, error: L('找不到上游', 'Upstream not found') } }), include: ['react'], exclude: [] },
    ],
    tools: ['readFile', 'writeFile', 'runCommand'],
    look: look('#2fb37a', '#30343c', 'headset'),
  },
  {
    id: 'bp-writer', name: 'Writer',
    // written by hand; the fields below are what this says
    source: {
      kind: 'yaml',
      text: [
        'name: Writer',
        L('prompt: 你是寫作者。先寫一句話結論，避免術語。', 'prompt: You are a writer. Lead with a one-line conclusion and avoid jargon.'),
        L('comment: 中文長文建議搭配 Claude 系列模型。', 'comment: Claude models suit long Chinese writing.'),
        'skills:',
        '  - path: ~/.agents/skills/',
        '    include: [writing-for-agents]',
        '  - repo: mho-dev/readme-skills',
        '    ref: v0.3.1',
        '    exclude: [readme-badges]',
        'tools: [read_file, write_file]',
        '',
      ].join('\n'),
    },
    prompt: L('你是寫作者。先寫一句話結論，避免術語。', 'You are a writer. Lead with a one-line conclusion and avoid jargon.'),
    comment: L('中文長文建議搭配 Claude 系列模型。', 'Claude models suit long Chinese writing.'),
    skills: [
      { source: { kind: 'local', path: '~/.agents/skills/' }, include: ['writing-for-agents'], exclude: [] },
      { source: git('mho-dev/readme-skills', 'v0.3.1', '2aa90f4'), include: null, exclude: ['readme-badges'] },
    ],
    tools: ['readFile', 'writeFile'],
    look: look('#f2a23a', '#5a4632', 'none'),
  },
  {
    id: 'bp-reviewer', name: 'Reviewer',
    source: git('acme/private-blueprints', 'v0.9.2', '9b2e441', { private: true, update: { at: 0, ok: true } }),
    prompt: L('你是審查者。先找會出錯的地方，風格問題列為建議。', 'You are a reviewer. Look for what will break first; list style issues as suggestions.'),
    comment: L('建議搭配 GPT 系列模型。', 'GPT models work best.'),
    skills: [
      { source: null, include: ['ponytail-review'], exclude: [] },
      { source: git('a11y-collective/skills', 'v3.0.0', 'f01b6d2', { update: { at: 0, ok: true } }), include: ['better-accessibility'], exclude: [] },
    ],
    tools: ['readFile', 'runCommand'],
    look: look('#d9534f', '#2b2b2b', 'cap'),
  },
]

function node(
  id: string, kind: WorkflowNode['kind'], name: string, prompt: string, replicaIds: string[],
  extra: Partial<WorkflowNode> = {},
): WorkflowNode {
  return {
    id, kind, name, prompt, replicaIds, handoff: 'all', join: 'all',
    pos: { x: 0, y: 0 }, ...extra,
  }
}

/** The sample world, written in `language`; both run the same, with the same random draws. */
export function seedWorld(language: Locale = 'zh'): World {
  const L = inLanguage(language)
  const { startName, startPrompt: START_PROMPT, endName, endPrompt: END_PROMPT, talkPrompt: TALK_PROMPT } = fixedSteps(language)
  const BLUEPRINTS = blueprints(L)
  const w: World = {
    now: 0, seq: 100, language, teams: {}, providers: {}, blueprints: {}, sources: {}, replicas: {}, workflows: {}, tasks: {}, subTasks: {}, chats: {},
    nextDriftAt: 75, rng: 20261028, events: [],
  }
  for (const p of providers(L)) w.providers[p.id] = structuredClone(p)
  for (const bp of BLUEPRINTS) w.blueprints[bp.id] = structuredClone(bp)
  adoptSources(w)

  // ---------- team 1: web shop ----------
  const shop = createTeam(w, {
    name: L('Acme 網路商店', 'Acme Store'), folder: '~/code/acme-shop', targetBranch: 'main',
    branches: ['main', 'develop', 'release/2.3'], initializedGit: false,
  })
  shop.prompt = L(
    '這是 Acme 的線上商店，前端用 React，後端用 Node.js。\n- 改動要附測試。\n- 介面文字用繁體中文。\n- 不要動 release/ 開頭的分支。',
    'This is Acme\'s online store: React on the frontend, Node.js on the backend.\n- Changes come with tests.\n- Interface text is in English.\n- Leave branches starting with release/ alone.',
  )
  const mira = hire(w, shop.id, 'bp-researcher', 'Mira', { ...BLUEPRINTS[0].look, hair: '#8a3b2a' }, { model: 'claude-opus-5-5' })
  const theo = hire(w, shop.id, 'bp-researcher', 'Theo', { ...BLUEPRINTS[0].look, skin: '#c68a5a', hair: '#1c1c1c' }, { model: 'claude-opus-5-5' })
  const kai = hire(w, shop.id, 'bp-developer', 'Kai', { ...BLUEPRINTS[1].look, skin: '#e0ac7e' }, { model: 'gpt-5.5-codex' })
  const juno = hire(w, shop.id, 'bp-developer', 'Juno', { ...BLUEPRINTS[1].look, hair: '#c99a4a' }, { model: 'gpt-5.5-codex' })
  const ivy = hire(w, shop.id, 'bp-writer', 'Ivy', { ...BLUEPRINTS[2].look, skin: '#8d5a3b', hair: '#1c1c1c' }, { model: 'claude-sonnet-5' })
  const rex = hire(w, shop.id, 'bp-reviewer', 'Rex', { ...BLUEPRINTS[3].look, hair: '#5a3a22' }, { model: 'gpt-5.5' })
  remember(w, mira.id, L('使用者偏好先看一句話結論，再看細節。', 'The user likes a one-line conclusion first, then the details.'), 'review')
  remember(w, mira.id, L('專案的 UI 元件都在 src/components，樣式用 CSS Modules。', 'UI components live in src/components and use CSS Modules.'), 'retro')
  remember(w, kai.id, L('src/legacy/ 不要改，之後會整個移除。', 'Leave src/legacy/ alone; it will be removed.'), 'user')
  remember(w, kai.id, L('測試指令是 npm test，快照過期要先確認再用 -u 更新。', 'Tests run with npm test; check an out-of-date snapshot before updating it with -u.'), 'work')
  remember(w, rex.id, L('公司規定 PR 不能有 console.log。', 'Company rule: no console.log in a PR.'), 'user')

  // The workflow from the hand-drawn sketch: task → research → report / dev, plus a review join.
  const main = newWorkflow(w, L('研究後開發', 'Research, then build'))
  const start = node('n-start', 'work', startName, START_PROMPT, [mira.id])
  const review = node('n-review', 'work', endName, END_PROMPT, [rex.id], { join: 'any' })
  main.nodes = [start, review]
  main.nodes.push(
    node('n-research', 'work', L('研究', 'Research'), L('調查現有程式與做法，比較方案並給出建議。', 'Look into the code and how things are done, compare options and recommend one.'), [mira.id], { handoff: 'pickOne' }),
    node('n-report', 'work', L('報告', 'Report'), L('把研究結果寫成給人看的報告，放在 docs/reports/。', 'Write the research up as a report people can read, in docs/reports/.'), [ivy.id]),
    node('n-dev', 'work', L('開發', 'Develop'), L('依研究結論實作，附測試，小步提交。', 'Build what the research concluded, with tests, in small commits.'), [kai.id]),
  )
  main.edges = [
    { id: 'e1', from: start.id, to: 'n-research', condition: '' },
    { id: 'e2', from: 'n-research', to: 'n-report', condition: L('只需要結論或建議，不需要改程式', 'Only a conclusion or advice is needed; no code changes') },
    { id: 'e3', from: 'n-research', to: 'n-dev', condition: L('需要修改程式', 'The code needs to change') },
    { id: 'e4', from: 'n-report', to: review.id, condition: '' },
    { id: 'e5', from: 'n-dev', to: review.id, condition: '' },
  ]
  autoLayout(main)

  const bugfix: Workflow = {
    id: 'wf-bugfix', name: L('修 Bug', 'Fix a bug'),
    nodes: [
      node('b-start', 'work', startName, START_PROMPT, [juno.id]),
      node('b-repro', 'work', L('重現', 'Reproduce'), L('寫一個會失敗的測試重現 bug。', 'Write a failing test that reproduces the bug.'), [juno.id]),
      node('b-logs', 'work', L('查紀錄', 'Check logs'), L('查錯誤紀錄與最近的 commit，找出可能原因。', 'Check the error logs and recent commits for likely causes.'), [theo.id]),
      node('b-fix', 'work', L('修正', 'Fix'), L('讓失敗的測試通過，不改無關的程式。', 'Make the failing test pass without touching unrelated code.'), [kai.id], { join: 'all' }),
      node('b-review', 'work', endName, END_PROMPT, [rex.id]),
    ],
    edges: [
      { id: 'be1', from: 'b-start', to: 'b-repro', condition: '' },
      { id: 'be2', from: 'b-start', to: 'b-logs', condition: '' },
      { id: 'be3', from: 'b-repro', to: 'b-fix', condition: '' },
      { id: 'be4', from: 'b-logs', to: 'b-fix', condition: '' },
      { id: 'be5', from: 'b-fix', to: 'b-review', condition: '' },
    ],
  }
  autoLayout(bugfix)
  w.workflows[bugfix.id] = bugfix

  // ---------- team 2: docs site ----------
  const docs = createTeam(w, {
    name: L('產品文件網站', 'Product Docs'), folder: '~/code/docs-site', targetBranch: 'master', branches: ['master'], initializedGit: true,
  })
  const ada = hire(w, docs.id, 'bp-writer', 'Ada', { ...BLUEPRINTS[2].look, hair: '#d9d4c7' }, { model: 'claude-sonnet-5' })
  const leo = hire(w, docs.id, 'bp-reviewer', 'Leo', { ...BLUEPRINTS[3].look, skin: '#e0ac7e' }, { model: 'gpt-5.5' })
  const dwf = newWorkflow(w, L('寫文件', 'Write docs'))
  const dstart = node('d-start', 'work', startName, START_PROMPT, [leo.id])
  const dreview = node('d-review', 'work', endName, END_PROMPT, [leo.id])
  dwf.nodes = [dstart, dreview]
  dwf.nodes.push(
    node('d-talk', 'talk', L('討論大綱', 'Discuss the outline'), TALK_PROMPT, [ada.id, leo.id]),
    node('d-write', 'work', L('撰寫文件', 'Write docs'), L('依需求撰寫或更新文件頁面。', 'Write or update the doc pages the task asks for.'), [ada.id]),
  )
  dwf.edges = [
    { id: 'de1', from: dstart.id, to: 'd-talk', condition: '' },
    { id: 'de3', from: 'd-talk', to: 'd-write', condition: '' },
    { id: 'de2', from: 'd-write', to: dreview.id, condition: '' },
  ]
  autoLayout(dwf)

  // ---------- tasks at different stages ----------
  const run = (seconds: number) => {
    for (let i = 0; i < seconds * 2; i++) tick(w, 0.5)
  }
  const calm = { ask: undefined, fail: undefined, sendBack: undefined }
  // a new task waits in 待辦; the demo's tasks are already under way
  const begin = (input: Parameters<typeof createTask>[1]) => {
    const t = createTask(w, input)
    resumeTask(w, t.id)
    return t
  }
  const quick = { ...calm, duration: 14 }

  const done = begin({
    teamId: shop.id, title: L('首頁加上季節活動橫幅', 'Add a seasonal banner to the home page'), description: L('首頁頂部放活動橫幅，可以關閉。', 'Put a promotion banner at the top of the home page, one people can close.'),
    workflowId: main.id, ownerId: rex.id,
    // the review sends 開發 back once, and 開發 sends it on back to 研究
    overrides: {
      '*': { ...quick, route: 1, costRate: 0.01 },
      [review.id]: { sendBack: { roll: 0.2, reason: L('空購物車時橫幅位置會跑掉，修正後再送審。', 'The banner moves out of place when the cart is empty; fix it and send it again.') } },
      'n-dev': { sendBack: { roll: 0.1, reason: L('研究結論沒提到可以關閉橫幅，要重新確認做法。', 'The research never said the banner can be closed; the approach needs checking again.') } },
    },
  })
  const report = begin({
    teamId: shop.id, title: L('評估結帳頁改版', 'Assess a checkout redesign'), description: L('評估把結帳改成單頁的成本與風險，先不要動程式。', 'Weigh the cost and risk of a one-page checkout; no code changes yet.'),
    workflowId: main.id, ownerId: ivy.id, overrides: { '*': { ...quick, route: 0 } },
  })
  run(170)
  mergeTask(w, done.id)
  run(30)

  begin({
    teamId: shop.id, title: L('購物車數量不會更新', 'Cart count does not update'), description: L('加入商品後，右上角的數量要重新整理才會變。', 'After adding an item, the count at the top right only changes after a reload.'),
    workflowId: bugfix.id, ownerId: rex.id,
    overrides: {
      '*': { ...calm, duration: 26 },
      'b-review': { sendBack: { roll: 0.2, reason: L('少了數量為 0 時的測試，補上再送審。', 'No test for a count of 0; add one and send it again.') } },
    },
  })
  begin({
    teamId: shop.id, title: L('商品頁加上評論區', 'Add reviews to product pages'), description: L('商品頁下方顯示評論與星等，可以分頁。', 'Show reviews and star ratings under each product, with pages.'),
    workflowId: main.id, ownerId: mira.id,
    overrides: {
      '*': { ...calm, route: 1, duration: 20 },
      [start.id]: { ...calm, duration: 8, ask: { p: 0.5, prompt: L('任務沒有寫完成期限，要以什麼為準？', 'The task gives no deadline. What should I aim for?'), options: L(['本週內', '下個版本', '不急，品質優先'], ['This week', 'The next release', 'No rush, quality first']) } },
    },
    mergeConflict: true,
  })
  const quickstart = begin({
    teamId: docs.id, title: L('新增快速開始頁', 'Add a quick start page'), description: L('五分鐘內跑起第一個範例。', 'Get the first example running in five minutes.'),
    workflowId: dwf.id, ownerId: leo.id,
    overrides: { '*': { ...calm, duration: 30 }, [dstart.id]: { ...calm, duration: 8 }, 'd-talk': { duration: 6 } },
  })
  const paused = begin({
    teamId: shop.id, title: L('整理 API 錯誤訊息', 'Tidy up API error messages'), description: L('所有錯誤訊息統一格式，並補上英文。', 'Give every error message one format, and add translations.'),
    workflowId: main.id, ownerId: ivy.id, overrides: { '*': { ...calm, route: 1 } },
  })
  run(16)
  pauseTask(w, paused.id)
  // the question about a deadline stays open: it waits on the user's reply
  run(6)
  const talkSub = Object.values(w.subTasks).find((s) => s.taskId === quickstart.id && s.review?.kind === 'talk')

  begin({
    teamId: shop.id, title: L('搜尋支援注音輸入', 'Support IME input in search'), description: L('輸入注音時不要觸發搜尋，等選字完成。', 'Do not search while an IME is composing; wait until the word is picked.'),
    workflowId: main.id, ownerId: juno.id, overrides: { '*': { ...calm, route: 1 } },
  })
  // the outline is talked over with the user and Leo: Ada opens it as chair, the user has asked them both, and both have replied
  run(4)
  if (talkSub) sayInTalk(w, talkSub.id, L('@All 主要讀者是第一次用的開發者，只要涵蓋安裝和第一個範例。', '@All The readers are developers new to it; just cover installing and the first example.'), [leo.id, ada.id])
  run(2 * REPLY_TIME + 1)
  void report

  // a meeting under way: @All, the chair alone, someone mentioned in, and the chair's question waiting on the user
  const said = (by: string, text: string) => ({ at: w.now, from: 'agent' as const, by, text })
  const asked = (text: string, mentions?: string[]) => ({ at: w.now, from: 'user' as const, text, ...(mentions ? { mentions } : {}) })
  const guest = (r: typeof kai) => ({ replicaId: r.id, name: r.name, look: r.look, model: r.model })
  w.chats['chat-meeting'] = {
    id: 'chat-meeting', teamId: shop.id, replicaId: mira.id, name: mira.name, look: mira.look, model: mira.model,
    title: L('結帳頁改版討論', 'Checkout redesign'), tokens: 18400, createdAt: w.now, unread: true,
    guests: [guest(kai), guest(ivy), guest(rex)],
    joins: [{ before: 6, replicaId: rex.id, name: rex.name }],
    messages: [
      asked(L('@All 結帳頁想改成單頁，大家怎麼看？', '@All We want checkout on one page. What do you all think?'), [kai.id, ivy.id, mira.id]),
      said(kai.id, L('前端可以做，地址和付款拆成兩個區塊，同一頁展開就好。大約三天。', 'The frontend can do it: address and payment as two sections that open on one page. About three days.')),
      said(ivy.id, L('文案要重寫，錯誤訊息也要跟著改，我可以同步進行。', 'The copy needs rewriting, and the error messages too. I can do that alongside.')),
      said(mira.id, L('整理一下：前端三天，文案同步。風險在付款失敗的流程，要先確認。', 'To sum up: three days of frontend, copy alongside. The risk is a failed payment; check that first.')),
      asked(L('付款失敗現在會怎樣？', 'What happens now when a payment fails?')),
      said(mira.id, L('目前會跳回購物車，填過的地址會不見。單頁之後可以留在原地重試。', 'It goes back to the cart and the address is lost. On one page you could retry where you are.')),
      asked(L('@Rex 你也看一下風險', '@Rex Take a look at the risk too'), [rex.id]),
      said(rex.id, L('付款重試要防重複扣款，後端要加冪等鍵（同一筆請求只處理一次）。', 'A retry must not charge twice: the backend needs an idempotency key (each request handled only once).')),
      asked(L('那要先做哪一個？', 'So which comes first?')),
      said(mira.id, L('你想先做哪一個？', 'Which do you want first?')),
    ],
    speaker: mira.id,
    question: { options: L(['先做前端', '先做後端的冪等鍵'], ['The frontend first', 'The backend idempotency key first']) },
  }

  // the airport staff, asked how to set something up
  w.chats['chat-airport'] = {
    id: 'chat-airport', teamId: '', replicaId: '', name: '', look: AIRPORT_STAFF_LOOK, model: mira.model,
    title: L('新增測試員工', 'A tester for the shop'), tokens: 6200, createdAt: w.now,
    messages: [
      asked(L('我想在 Acme 網路商店加一個專門寫測試的員工，要怎麼做？', 'I want an employee at Acme Store who only writes tests. How do I do that?')),
      said('', L(
        '先有一份員工藍圖，再用它新增員工：\n1. 機場的「員工藍圖」已經有「測試工程師」，可以直接用。\n2. 打開 Acme 網路商店的「員工」頁籤，按新增員工，選這份藍圖。\n\n要我幫你把「每次改動都要附測試」寫進藍圖嗎？',
        'First there is a blueprint, then you hire from it:\n1. The airport\'s Blueprints already has a QA Engineer you can use.\n2. Open Acme Store\'s Employees tab, press New employee and pick that blueprint.\n\nShall I add "every change comes with tests" to the blueprint for you?',
      )),
    ],
  }

  installPresets(w)
  // the tasks above took their staff from the flows; shared flows name nobody
  for (const wf of Object.values(w.workflows)) for (const n of wf.nodes) n.replicaIds = []

  w.events = []
  return w
}
