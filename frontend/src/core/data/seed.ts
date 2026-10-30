// Fake starting world. Tasks are pre-run so the board opens with something in every column.

import { autoLayout } from '../domain/graph'
import {
  createTask, createTeam, END_PROMPT, TALK_PROMPT, hire, mergeTask, pauseTask, remember, REPLY_TIME, sayInTalk, START_PROMPT, tick,
} from '../domain/sim'
import type { Blueprint, GitSource, Look, ModelProvider, Workflow, WorkflowNode, World } from '../domain/types'

const look = (shirt: string, pants: string, extra: Look['extra']): Look => ({
  skin: '#f2c9a0', hair: '#2b1d14', shirt, pants, extra,
})

/** A public GitHub repo at a version, reached and up to date unless `extra` says otherwise. */
const git = (repo: string, ref: string, commit: string, extra: Partial<GitSource> = {}): GitSource => ({
  kind: 'git', repo: `git@github.com:${repo}`, ref, commit, latestRef: ref, latest: commit, private: false,
  upstream: true, ...extra,
})

const PROVIDERS: ModelProvider[] = [
  { id: 'mp-anthropic', name: 'Claude 訂閱', kind: 'anthropic', auth: { kind: 'subscription' }, baseUrl: '', models: ['claude-opus-5-5', 'claude-sonnet-5', 'claude-haiku-5'] },
  { id: 'mp-openai', name: 'OpenAI', kind: 'openai', baseUrl: '', auth: { kind: 'apiKey', keyHint: 'x9Lm' }, models: ['gpt-5.5', 'gpt-5.5-codex'] },
  { id: 'mp-google', name: 'Google', kind: 'google', baseUrl: '', auth: { kind: 'apiKey', keyHint: 'c3Vd' }, models: ['gemini-3-pro'] },
  { id: 'mp-deepseek', name: 'DeepSeek', kind: 'compatible', baseUrl: 'https://api.deepseek.com/v1', auth: { kind: 'apiKey', keyHint: '0f4e' }, models: ['deepseek-v4'] },
]

const BLUEPRINTS: Blueprint[] = [
  {
    id: 'bp-researcher', name: 'Researcher', autoUpdate: true,
    source: git('acme/agent-blueprints', 'v1.4.0', '3f9a2c1', { update: { at: 0, ok: true } }),
    prompt: '你是研究員。先讀現有資料，再比較方案，結論要附來源。',
    comment: '適合長篇閱讀，建議用上下文長的模型。',
    skills: [
      { source: null, include: ['literature-review'], exclude: [] },
      { source: git('anthropics/skills', 'main', '8d21f7a', { update: { at: 0, ok: true } }), include: ['web-search', 'summarize'], exclude: [] },
    ],
    tools: ['readFile', 'webSearch'],
    look: look('#4f7cff', '#2d3550', 'glasses'),
  },
  {
    id: 'bp-developer', name: 'Developer', autoUpdate: false,
    // a newer version is out and has not been taken yet
    source: git('acme/agent-blueprints', 'v2.1.0', 'a71c09e', { latestRef: 'v2.2.0', latest: 'c04d5b8' }),
    prompt: '你是工程師。小步提交，每次提交前跑測試。',
    comment: '',
    skills: [
      { source: null, include: ['tdd'], exclude: [] },
      // the last update failed, so the older version is still in use
      { source: git('acme/go-skills', 'v1.2.0', '51be0d3', { latestRef: 'v1.3.0', latest: 'e9a4c27', update: { at: 0, ok: false, error: '新版本缺少 SKILL.md' } }), include: null, exclude: [] },
      // the repo was renamed or deleted
      { source: git('frontend-guild/react-skills', 'v0.8.0', '7c3e912', { upstream: false, update: { at: 0, ok: false, error: '找不到上游' } }), include: ['react'], exclude: [] },
    ],
    tools: ['readFile', 'writeFile', 'runCommand'],
    look: look('#2fb37a', '#30343c', 'headset'),
  },
  {
    id: 'bp-writer', name: 'Writer', autoUpdate: false,
    // written by hand; the fields below are what this says
    source: {
      kind: 'yaml',
      text: [
        'name: Writer',
        'prompt: 你是寫作者。先寫一句話結論，避免術語。',
        'comment: 中文長文建議搭配 Claude 系列模型。',
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
    prompt: '你是寫作者。先寫一句話結論，避免術語。',
    comment: '中文長文建議搭配 Claude 系列模型。',
    skills: [
      { source: { kind: 'local', path: '~/.agents/skills/' }, include: ['writing-for-agents'], exclude: [] },
      { source: git('mho-dev/readme-skills', 'v0.3.1', '2aa90f4'), include: null, exclude: ['readme-badges'] },
    ],
    tools: ['readFile', 'writeFile'],
    look: look('#f2a23a', '#5a4632', 'none'),
  },
  {
    id: 'bp-reviewer', name: 'Reviewer', autoUpdate: true,
    source: git('acme/private-blueprints', 'v0.9.2', '9b2e441', { private: true, update: { at: 0, ok: true } }),
    prompt: '你是審查者。先找會出錯的地方，風格問題列為建議。',
    comment: '建議搭配 GPT 系列模型。',
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
    id, kind, name, prompt, replicaIds, assignment: 'firstAvailable', handoff: 'all', join: 'all',
    pos: { x: 0, y: 0 }, ...extra,
  }
}

export function seedWorld(): World {
  const w: World = {
    now: 0, seq: 100, teams: {}, providers: {}, blueprints: {}, replicas: {}, workflows: {}, tasks: {}, subTasks: {},
    nextDriftAt: 75, rng: 20261028, events: [],
  }
  for (const p of PROVIDERS) w.providers[p.id] = structuredClone(p)
  for (const bp of BLUEPRINTS) w.blueprints[bp.id] = structuredClone(bp)

  // ---------- team 1: web shop ----------
  const shop = createTeam(w, {
    name: 'Acme 網路商店', folder: '~/code/acme-shop', targetBranch: 'main',
    branches: ['main', 'develop', 'release/2.3'], initializedGit: false,
  })
  shop.prompt = '這是 Acme 的線上商店，前端用 React，後端用 Node.js。\n- 改動要附測試。\n- 介面文字用繁體中文。\n- 不要動 release/ 開頭的分支。'
  const mira = hire(w, shop.id, 'bp-researcher', 'Mira', { ...BLUEPRINTS[0].look, hair: '#8a3b2a' }, { model: 'claude-opus-5-5' })
  const theo = hire(w, shop.id, 'bp-researcher', 'Theo', { ...BLUEPRINTS[0].look, skin: '#c68a5a', hair: '#1c1c1c' }, { model: 'claude-opus-5-5' })
  const kai = hire(w, shop.id, 'bp-developer', 'Kai', { ...BLUEPRINTS[1].look, skin: '#e0ac7e' }, { model: 'gpt-5.5-codex' })
  const juno = hire(w, shop.id, 'bp-developer', 'Juno', { ...BLUEPRINTS[1].look, hair: '#c99a4a' }, { model: 'gpt-5.5-codex' })
  const ivy = hire(w, shop.id, 'bp-writer', 'Ivy', { ...BLUEPRINTS[2].look, skin: '#8d5a3b', hair: '#1c1c1c' }, { model: 'claude-sonnet-5' })
  const rex = hire(w, shop.id, 'bp-reviewer', 'Rex', { ...BLUEPRINTS[3].look, hair: '#5a3a22' }, { model: 'gpt-5.5' })
  remember(w, mira.id, '使用者偏好先看一句話結論，再看細節。', 'review')
  remember(w, mira.id, '專案的 UI 元件都在 src/components，樣式用 CSS Modules。', 'retro')
  remember(w, kai.id, 'src/legacy/ 不要改，之後會整個移除。', 'user')
  remember(w, kai.id, '測試指令是 npm test，快照過期要先確認再用 -u 更新。', 'work')
  remember(w, rex.id, '公司規定 PR 不能有 console.log。', 'user')

  // The workflow from the hand-drawn sketch: task → research → report / dev, plus a review join.
  const main = w.workflows[shop.defaultWorkflowId]
  main.name = '研究後開發'
  const [start, review] = main.nodes
  review.join = 'any'
  main.nodes.push(
    node('n-research', 'work', '研究', '調查現有程式與做法，比較方案並給出建議。', [mira.id, theo.id], { handoff: 'pickOne' }),
    node('n-report', 'work', '報告', '把研究結果寫成給人看的報告，放在 docs/reports/。', [ivy.id]),
    node('n-dev', 'work', '開發', '依研究結論實作，附測試，小步提交。', [kai.id, juno.id], { assignment: 'firstAvailable' }),
  )
  main.edges = [
    { id: 'e1', from: start.id, to: 'n-research', condition: '' },
    { id: 'e2', from: 'n-research', to: 'n-report', condition: '只需要結論或建議，不需要改程式' },
    { id: 'e3', from: 'n-research', to: 'n-dev', condition: '需要修改程式' },
    { id: 'e4', from: 'n-report', to: review.id, condition: '' },
    { id: 'e5', from: 'n-dev', to: review.id, condition: '' },
  ]
  autoLayout(main)

  const bugfix: Workflow = {
    id: 'wf-bugfix', teamId: shop.id, name: '修 Bug',
    nodes: [
      node('b-start', 'task', '整理需求', START_PROMPT, []),
      node('b-repro', 'work', '重現', '寫一個會失敗的測試重現 bug。', [juno.id]),
      node('b-logs', 'work', '查紀錄', '查錯誤紀錄與最近的 commit，找出可能原因。', [theo.id]),
      node('b-fix', 'work', '修正', '讓失敗的測試通過，不改無關的程式。', [kai.id, juno.id], { join: 'all', assignment: 'everyone' }),
      node('b-review', 'work', '驗收', END_PROMPT, []),
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
    name: '產品文件網站', folder: '~/code/docs-site', targetBranch: 'master', branches: ['master'], initializedGit: true,
  })
  const ada = hire(w, docs.id, 'bp-writer', 'Ada', { ...BLUEPRINTS[2].look, hair: '#d9d4c7' }, { model: 'claude-sonnet-5' })
  const leo = hire(w, docs.id, 'bp-reviewer', 'Leo', { ...BLUEPRINTS[3].look, skin: '#e0ac7e' }, { model: 'gpt-5.5' })
  const dwf = w.workflows[docs.defaultWorkflowId]
  dwf.name = '寫文件'
  const [dstart, dreview] = dwf.nodes
  dwf.nodes.push(
    node('d-talk', 'talk', '討論大綱', TALK_PROMPT, [ada.id]),
    node('d-write', 'work', '撰寫文件', '依需求撰寫或更新文件頁面。', [ada.id]),
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
  const quick = { ...calm, duration: 14 }

  const done = createTask(w, {
    teamId: shop.id, title: '首頁加上季節活動橫幅', description: '首頁頂部放活動橫幅，可以關閉。',
    workflowId: main.id, ownerId: rex.id,
    // the review sends 開發 back once, and 開發 sends it on back to 研究
    overrides: {
      '*': { ...quick, route: 1, costRate: 0.01 },
      [review.id]: { sendBack: { roll: 0.2, reason: '空購物車時橫幅位置會跑掉，修正後再送審。' } },
      'n-dev': { sendBack: { roll: 0.1, reason: '研究結論沒提到可以關閉橫幅，要重新確認做法。' } },
    },
  })
  const report = createTask(w, {
    teamId: shop.id, title: '評估結帳頁改版', description: '評估把結帳改成單頁的成本與風險，先不要動程式。',
    workflowId: main.id, ownerId: ivy.id, overrides: { '*': { ...quick, route: 0 } },
  })
  run(170)
  mergeTask(w, done.id)
  run(30)

  createTask(w, {
    teamId: shop.id, title: '購物車數量不會更新', description: '加入商品後，右上角的數量要重新整理才會變。',
    workflowId: bugfix.id, ownerId: rex.id,
    overrides: {
      '*': { ...calm, duration: 26 },
      'b-review': { sendBack: { roll: 0.2, reason: '少了數量為 0 時的測試，補上再送審。' } },
    },
  })
  createTask(w, {
    teamId: shop.id, title: '商品頁加上評論區', description: '商品頁下方顯示評論與星等，可以分頁。',
    workflowId: main.id, ownerId: mira.id,
    overrides: {
      '*': { ...calm, route: 1, duration: 20 },
      [start.id]: { ...calm, duration: 8, ask: { p: 0.5, prompt: '任務沒有寫完成期限，要以什麼為準？', options: ['本週內', '下個版本', '不急，品質優先'] } },
    },
    mergeConflict: true,
  })
  const quickstart = createTask(w, {
    teamId: docs.id, title: '新增快速開始頁', description: '五分鐘內跑起第一個範例。',
    workflowId: dwf.id, ownerId: leo.id,
    overrides: { '*': { ...calm, duration: 30 }, [dstart.id]: { ...calm, duration: 8 }, 'd-talk': { duration: 6 } },
  })
  const paused = createTask(w, {
    teamId: shop.id, title: '整理 API 錯誤訊息', description: '所有錯誤訊息統一格式，並補上英文。',
    workflowId: main.id, ownerId: ivy.id, overrides: { '*': { ...calm, route: 1 } },
  })
  run(16)
  pauseTask(w, paused.id)
  // the question about a deadline stays open: it waits on the user's reply
  run(6)
  const talkSub = Object.values(w.subTasks).find((s) => s.taskId === quickstart.id && s.review?.kind === 'talk')

  createTask(w, {
    teamId: shop.id, title: '搜尋支援注音輸入', description: '輸入注音時不要觸發搜尋，等選字完成。',
    workflowId: main.id, ownerId: juno.id, overrides: { '*': { ...calm, route: 1 } },
  })
  // the outline is talked over with the user: Ada opens it, the user has answered once, and she has replied
  run(4)
  if (talkSub) sayInTalk(w, talkSub.id, '主要讀者是第一次用的開發者，只要涵蓋安裝和第一個範例。')
  run(REPLY_TIME + 1)
  void report

  w.events = []
  return w
}
