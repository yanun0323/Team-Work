// Fake starting world. Tasks are pre-run so the board opens with something in every column.

import { autoLayout } from '../domain/graph'
import { mockThinking } from '../../providers'
import { fixedSteps, installPresets } from './presets'
import { mockText } from './mockText'
import {
  adoptSources, AIRPORT_STAFF_LOOK, controlOwnerTask, createTask, createTeam, hire, mergeTask, newWorkflow, ownerSeed, pauseTask, postActivity, remember, resumeTask, REPLY_TIME, sayInTalk, sayToOwner, subsOf, tick,
} from '../domain/sim'
import { makeHandoff, roleOf } from '../domain/content'
import { nodeOf } from '../domain/graph'
import type { Blueprint, GitSource, Locale, Look, ModelProvider, Replica, Workflow, WorkflowNode, World } from '../domain/types'

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
const inLanguage = (language: Locale): Pick => (zh, en) => mockText(language, zh, en)

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
      asked(L('我想在 Acme 網路商店加一個專門檢查改動、跑測試的員工，要怎麼做？', 'I want an employee at Acme Store who only checks changes and runs the tests. How do I do that?')),
      said('', L(
        '先有一份員工藍圖，再用它新增員工：\n1. 機場的「員工藍圖」已經有「審查與測試」，可以直接用。\n2. 打開 Acme 網路商店的「員工」頁籤，按新增員工，選這份藍圖。\n\n要我幫你把「每次改動都要附測試」寫進藍圖嗎？',
        'First there is a blueprint, then you hire from it:\n1. The airport\'s Blueprints already has Review & QA, which you can use.\n2. Open Acme Store\'s Employees tab, press New employee and pick that blueprint.\n\nShall I add "every change comes with tests" to the blueprint for you?',
      )),
    ],
  }

  // a task its owner runs, written partway: Mira took in two steps and gave Kai the third; the user set a limit, and
  // Mira asks the user whether someone outside the task may join
  const coupon = createTask(w, {
    teamId: shop.id, title: L('結帳頁加上優惠碼', 'Add promo codes to checkout'), description: L('結帳頁可以輸入優惠碼，折扣即時反映在總額。', 'Let people enter a promo code at checkout, with the discount in the total at once.'),
    workflowId: main.id, ownerId: mira.id, orchestration: 'owner', overrides: { '*': { ...calm, route: 1, duration: 40 } },
  })
  const c = coupon.coordination!
  const { dispatchStep, handBack, ownerSays, taskEvent, holdMeeting, endMeeting } = ownerSeed
  const step = (id: string) => nodeOf(coupon.workflow, id)!
  let clock = w.now - 1500
  // each line a minute or two after the last
  const stamp = <T extends { at: number }>(x: T, gap = 90) => { clock += gap; x.at = clock; return x }
  const last = () => stamp(w.mockActivity![coupon.id].at(-1)!)
  controlOwnerTask(w, coupon.id, { requestId: 'seed-start', action: 'resume', planVersion: c.planVersion, controlVersion: c.controlVersion })
  c.startedAt = stamp({ at: 0 }).at
  for (const a of w.mockActivity![coupon.id]) a.at = clock
  stamp(ownerSays(w, coupon, L('我先請自己整理需求，確認優惠碼的規則後再決定怎麼做。', 'I will sort out the requirements myself first, then decide how to go about the promo code rules.')), 30)
  const finish = (nodeId: string) => {
    const s = subsOf(w, coupon.id).find((x) => x.nodeId === nodeId)!
    last()
    s.startedAt = clock
    s.status = 'complete'
    s.progress = 1
    s.attempts = 1
    s.costUsd = 0.21
    s.tokens = 21400
    s.routed = true
    s.endedAt = (clock += 240)
    s.handoff = makeHandoff(w, roleOf(step(nodeId)), coupon, step(nodeId))
    delete s.executionState
    handBack(w, coupon, s)
    last()
    s.ownerReview = 'accepted'
    taskEvent(w, coupon, 'accepted', L('{owner} 接受「{step}」的交付', '{owner} accepted "{step}"'), { owner: mira.name, step: step(nodeId).name }, { subId: s.id, nodeId })
    last()
    return s
  }
  dispatchStep(w, coupon, start.id, [])
  const scoped = finish(start.id)
  dispatchStep(w, coupon, 'n-research', [scoped])
  const researched = finish('n-research')
  stamp(ownerSays(w, coupon, L('研究結論是要改程式，報告這步略過，我派 Kai 開發。', 'The research says the code has to change, so the report step is left out; Kai develops it.')))
  // Mira holds a meeting in the conversation: the words in it, said in turn, the user's too
  type Said = [by: Replica | null, zh: string, en: string, mentions?: Replica[]]
  const meet = (id: string, topic: string, guests: Replica[], words: Said[]) => {
    coupon.workflow.nodes.push({ id, kind: 'talk', name: topic, prompt: '', replicaIds: guests.map((g) => g.id), handoff: 'all', join: 'any', pos: { x: 0, y: 0 } })
    const s = holdMeeting(w, coupon, id, topic, guests.map((g) => g.id))
    last()
    delete w.mockMeetingQueue![s.id]
    for (const [by, zh, en, mentions] of words) {
      postActivity(w, coupon, {
        kind: 'meeting', from: by ? 'agent' : 'user', text: L(zh, en), meetingVersion: 2, meetingPart: 'speech', meetingId: s.id, subId: s.id, nodeId: id,
        ...(by ? { by: by.id, name: by.name, look: { ...by.look } } : {}), ...(mentions ? { mentions: mentions.map((r) => r.id) } : {}),
      })
      last()
      if (by) { s.meeting!.callsInBatch++; s.meeting!.callsTotal++; s.costUsd += 0.01; s.tokens += 1200 }
    }
    s.meeting!.speakerId = undefined
    return s
  }
  const rules = meet('n-meet-rules', L('優惠碼規則', 'Promo code rules'), [kai, rex], [
    [mira, '要先定下優惠碼能不能疊加，Kai、Rex 各說一下看法。', 'We need to settle whether promo codes stack. Kai, Rex, your views?'],
    [kai, '不疊加比較好做，總額計算只要處理一個折扣。', 'Not stacking is simpler: the total handles one discount.'],
    [rex, '同意，但要測試同時輸入兩組碼時的錯誤訊息。', 'Agreed, but test the error when two codes are entered.'],
  ])
  const ruled = stamp(postActivity(w, coupon, {
    kind: 'meeting', from: 'agent', text: L('結論：一次只能用一組優惠碼；輸入第二組時取代第一組並提示。', 'Conclusion: one promo code at a time; a second replaces the first, with a notice.'),
    meetingVersion: 2, meetingPart: 'summary', meetingId: rules.id, subId: rules.id, nodeId: rules.nodeId, by: mira.id, name: mira.name, look: { ...mira.look },
  }))
  endMeeting(w, coupon, rules as typeof rules & { meeting: NonNullable<typeof rules.meeting> }, ruled.text, ruled.id)
  last()
  rules.ownerReview = 'accepted'
  rules.routed = true
  dispatchStep(w, coupon, 'n-dev', [researched])
  last()
  const told = sayToOwner(w, coupon.id, { requestId: 'seed-limit', text: L('優惠碼不要分大小寫，過期的要說明原因。', 'Promo codes ignore case, and an expired one says why.') })
  stamp(told.activity, 200)
  for (const op of c.operations) op.status = 'applied'
  stamp(ownerSays(w, coupon, L('收到，已記成這個任務的限制，也轉告 Kai。', 'Got it. That is now a limit on this task, and I have told Kai.')), 40)
  c.facts.push({ id: 'fact-case', kind: 'constraint', text: told.activity.text, sourceActivityIds: [told.activity.id] })
  const prompt = L('Kai 想請 Theo 一起補付款流程的測試，但 Theo 不在這個任務的人員名單。要讓 Theo 加入嗎？', 'Kai would like Theo to help test the payment flow, but Theo is not on this task. May Theo join?')
  const ask = stamp(postActivity(w, coupon, { kind: 'question', from: 'agent', text: prompt, by: mira.id, name: mira.name, look: { ...mira.look }, questionId: 'q-theo' }), 60)
  c.questions.push({
    id: 'q-theo', activityId: ask.id, prompt, options: [{ id: 'approve' }, { id: 'reject' }], kind: 'approval', audience: 'user', planVersion: c.planVersion, createdAt: ask.at,
  })
  // a meeting under way now, which Mira chairs: the user asked Ivy, who answered, and Mira went on
  meet('n-meet-errors', L('過期優惠碼的錯誤訊息', 'The error for an expired code'), [ivy, kai], [
    [mira, '過期的優惠碼要說明原因，我們來定錯誤訊息怎麼寫。', 'An expired code says why. Let us settle how the error reads.'],
    [null, '@Ivy 你覺得要不要寫出過期日期？', '@Ivy Should it show the date it expired?', [ivy]],
    [ivy, '要，寫「這組優惠碼已在 3 月 1 日到期」，比只說無效清楚。', 'Yes: "This code expired on 1 March" says more than "invalid".'],
    [mira, '好，Kai 確認一下日期格式能跟著語言走嗎？', 'Good. Kai, can the date follow the language?'],
  ])
  c.ownerCostUsd = 0.09
  c.ownerTokens = 11800
  c.ownerState = 'idle'
  // the sample clock has run only a few minutes: fit the times written above into them, the last a moment ago
  const first = c.startedAt!
  const fit = (t: number) => Math.round(w.now * 0.15 + ((t - first) / Math.max(1, clock - first)) * (w.now * 0.85 - 20))
  for (const a of w.mockActivity![coupon.id]) a.at = fit(a.at)
  for (const s of subsOf(w, coupon.id)) {
    if (s.startedAt !== undefined && s.status === 'complete') s.startedAt = fit(s.startedAt)
    if (s.endedAt !== undefined) s.endedAt = fit(s.endedAt)
  }
  c.startedAt = fit(first)
  for (const q of c.questions) q.createdAt = fit(q.createdAt)

  installPresets(w)
  // the tasks above took their staff from the flows; shared flows name nobody
  for (const wf of Object.values(w.workflows)) for (const n of wf.nodes) n.replicaIds = []

  w.events = []
  return w
}
