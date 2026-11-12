import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { seedWorld } from './core/data/seed'
import * as sim from './core/domain/sim'
import { STAFFING_ID, worksIn, type World } from './core/domain/types'
import { crewOf, heirsOf, lastOfTeam, leavesAlone, teamReplicas } from './core/model'
import { copyReplica } from './core/ops'
import { useStore } from './core/store'
import { Detail, type Item } from './DrawerDetail'
import { lastStaff } from './draft'
import { HELIPAD } from './Airport'
import { AIRPORT, CELL, POWER_TOWER, STAFFING, canPlace, layoutTown, rectCenter } from './layout'
import { CopyForm, copyLevel, packLine } from './StaffingSheets'
import type { CopyPreview } from './core/ops'

const world = (): World => structuredClone(seedWorld('zh'))
const teamOf = (w: World) => Object.values(w.teams).sort((a, b) => a.createdAt - b.createdAt)[0]
const shared = (w: World, name = 'Hal') => sim.hire(w, STAFFING_ID, Object.values(w.blueprints).find((b) => !b.owner)!.id, name, undefined, { model: 'fake', effort: 'default' })

describe('the staffing agency in the simulator', () => {
  it("is picked by every company and kept out of no company's tasks", () => {
    const w = world()
    const [a, b] = Object.values(w.teams)
    const hal = shared(w)
    expect(worksIn(hal, a.id) && worksIn(hal, b.id)).toBe(true)
    expect(worksIn(hal, STAFFING_ID)).toBe(false)
    expect(crewOf(w, a.id).map((r) => r.id)).toContain(hal.id)
    expect(crewOf(w, b.id).map((r) => r.id)).toContain(hal.id)
    // a company's own come first; the agency's own list is only theirs
    expect(crewOf(w, a.id)[0].teamId).toBe(a.id)
    expect(crewOf(w, STAFFING_ID).map((r) => r.id)).toEqual([hal.id])
    const flow = Object.values(w.workflows)[0]
    for (const n of flow.nodes) n.replicaIds = [hal.id]
    const t = sim.createTask(w, { teamId: a.id, title: 't', description: '', workflowId: flow.id, images: [], ownerId: hal.id })
    expect(t.workflow.nodes.every((n) => n.replicaIds.includes(hal.id))).toBe(true)
    expect(lastStaff(w, a.id, flow.id).ownerId).toBe(hal.id)
  })

  it('moves someone into the agency as a new employee with no memory, once', () => {
    const w = world()
    const team = teamOf(w)
    const [bo, heir] = teamReplicas(w, team.id)
    bo.memory = [{ id: 'm', text: 'x', source: 'user', at: 0 }]
    const moved = sim.moveReplica(w, bo.id, STAFFING_ID, heir.id)
    expect(w.replicas[bo.id]).toBeUndefined()
    expect(moved.id).not.toBe(bo.id)
    expect(w.replicas[moved.id]).toMatchObject({ teamId: STAFFING_ID, name: bo.name, model: bo.model, effort: bo.effort, memory: [] })
    expect(() => sim.moveReplica(w, bo.id, STAFFING_ID, heir.id)).toThrow()
    expect(Object.values(w.replicas).filter((r) => r.name === bo.name)).toHaveLength(1)
  })

  it('keeps a company one employee of its own, and lets the agency go empty', () => {
    const w = world()
    const team = teamOf(w)
    const hal = shared(w)
    const own = teamReplicas(w, team.id)
    for (const r of own.slice(1)) sim.fire(w, r.id, own[0].id)
    expect(lastOfTeam(w, own[0].id)).toBe(true)
    const before = JSON.stringify(w)
    expect(() => sim.fire(w, own[0].id, hal.id)).toThrow()
    expect(() => sim.moveReplica(w, own[0].id, STAFFING_ID, hal.id)).toThrow()
    expect(JSON.stringify(w)).toBe(before)
    expect(leavesAlone(w, hal.id)).toBe(true)
    sim.fire(w, hal.id, '')
    expect(teamReplicas(w, STAFFING_ID)).toEqual([])
  })

  it('hands work over only to someone who can work where it is', () => {
    const w = world()
    const [a, b] = Object.values(w.teams)
    const hal = shared(w)
    const flow = Object.values(w.workflows)[0]
    sim.createTask(w, { teamId: a.id, title: 't', description: '', workflowId: flow.id, images: [], ownerId: hal.id })
    expect(leavesAlone(w, hal.id)).toBe(false)
    const heirs = heirsOf(w, hal.id).map((r) => r.id)
    const ofB = teamReplicas(w, b.id)[0]
    const ofA = teamReplicas(w, a.id)[0]
    expect(heirs).toContain(ofA.id)
    expect(heirs).not.toContain(ofB.id)
    expect(() => sim.fire(w, hal.id, '')).toThrow()
    expect(() => sim.moveReplica(w, hal.id, b.id, ofB.id)).toThrow()
    const moved = sim.moveReplica(w, hal.id, b.id, ofA.id)
    expect(w.replicas[moved.id].teamId).toBe(b.id)
  })
})

const sheet = (item: Item, teamId: string) => {
  Object.assign(useStore.getInitialState(), useStore.getState())
  const noop = () => {}
  return renderToStaticMarkup(<Detail item={item} teamId={teamId} depth={0} covered={false} leaving={false}
    onGone={noop} onBack={noop} onDone={noop} onClear={noop} onPush={noop} onOpen={noop} />)
}

describe('the sheets', () => {
  it('warns that a move clears memory, and waits for an heir', () => {
    const w = useStore.getState().world
    const team = teamOf(w)
    const r = teamReplicas(w, team.id)[0]
    const html = sheet({ kind: 'move', id: r.id }, team.id)
    expect(html).toContain('移動後是新的員工：記憶會清空，也不會帶走以前的對話')
    expect(html).toContain('交接給')
    expect(html).toMatch(/<button type="submit" class="fx-save" disabled="">移動<\/button>/)
  })

  it("lets an agency employee with no work go without an heir, and offers the move to a company", () => {
    useStore.setState((s) => { shared(s.world, 'Quinn') })
    const w = useStore.getState().world
    const hal = Object.values(w.replicas).find((r) => r.name === 'Quinn')!
    try {
      const fire = sheet({ kind: 'fire', id: hal.id }, STAFFING_ID)
      expect(fire).not.toContain('交接給')
      expect(fire).toMatch(/<button type="submit" class="fx-save">解僱<\/button>/)
      const detail = sheet({ kind: 'crew', id: hal.id }, STAFFING_ID)
      expect(detail).toContain('aria-label="移到公司"')
      const move = sheet({ kind: 'move', id: hal.id }, STAFFING_ID)
      expect(move).toContain('移到')
      expect(move).toMatch(/<button type="submit" class="fx-save">移動<\/button>/)
    } finally {
      useStore.setState((s) => { delete s.world.replicas[hal.id] })
    }
  })
})

const preview = (p: Partial<CopyPreview> = {}): CopyPreview => ({
  name: 'Bo', look: { skin: '', hair: '', shirt: '', pants: '', extra: 'none' }, model: 'claude-x', effort: 'high',
  blueprint: { name: 'Dev', prompt: '', tools: [] }, models: ['gpt-y'], thinking: { 'gpt-y': ['default', 'low'] },
  packs: [
    { kind: 'git', repo: 'https://github.com/a/skills', skills: ['tdd'] },
    { kind: 'local', path: '/Users/b/.agents/skills', skills: ['lint'] },
    { kind: 'missing', skills: null },
  ],
  modelOk: false, effortOk: false, presetOk: false, ...p,
})

describe('copying from another island', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('starts on skill sources only, and has the model picked rather than put in its place', () => {
    const html = renderToStaticMarkup(<CopyForm preview={preview()} send={() => new Promise(() => {})} />)
    expect(html).toMatch(/<input type="radio"[^>]*checked=""[^>]*\/><span>只複製技能來源設定<\/span>/)
    expect(html).toContain('這座島沒有 claude-x，請選擇要用的模型')
    expect(html).toContain('選擇模型')
    expect(html).toMatch(/<button type="submit" class="fx-save" disabled="">複製<\/button>/)
    // a folder there is to pick again, and what the other computer could not read is not offered as working
    expect(html).toContain('對方電腦上的資料夾，複製後要重新指定')
    expect(html).toContain('對方也讀不到，不會複製')
  })

  it('keeps their model when this island has it', () => {
    const html = renderToStaticMarkup(<CopyForm preview={preview({ models: ['claude-x'], thinking: { 'claude-x': ['default', 'high'] }, modelOk: true, effortOk: true })} send={() => new Promise(() => {})} />)
    expect(html).not.toContain('請選擇要用的模型')
    expect(html).toMatch(/<button type="submit" class="fx-save">複製<\/button>/)
  })

  it('has a thinking level their model does not take picked, not put in its place', () => {
    const html = renderToStaticMarkup(<CopyForm preview={preview({ models: ['claude-x'], thinking: { 'claude-x': ['default', 'low'] }, modelOk: true, effortOk: false })} send={() => new Promise(() => {})} />)
    expect(html).toContain('claude-x 沒有思考等級 high，請重新選擇')
    expect(html).toContain('選擇思考等級')
    expect(html).toMatch(/<button type="submit" class="fx-save" disabled="">複製<\/button>/)
  })

  it('keeps a level only while the model picked takes it', () => {
    const p = preview({ models: ['claude-x', 'gpt-y'], thinking: { 'claude-x': ['default', 'high'], 'gpt-y': ['default', 'low'] }, modelOk: true, effortOk: true })
    expect(copyLevel(p, 'claude-x', 'high')).toBe('high')
    // another model without it: picked again, never turned into default
    expect(copyLevel(p, 'gpt-y', 'high')).toBe('')
    expect(copyLevel(p, 'gpt-y', 'low')).toBe('low')
    expect(copyLevel(p, 'claude-x', 'low')).toBe('')
    expect(copyLevel(p, '', 'high')).toBe('')
  })

  it('says what each source becomes in either mode', () => {
    const [git, local, missing] = preview().packs
    expect(packLine(git, 'source')).toMatchObject({ state: 'ok', note: '在這台重新取得：tdd' })
    expect(packLine(local, 'source').state).toBe('missing')
    expect(packLine(local, 'files')).toMatchObject({ state: 'ok', note: '複製檔案：lint' })
    expect(packLine(missing, 'files').state).toBe('missing')
  })

  it("goes to this computer's backend with the action's own key, the same on a retry", async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ replica: { id: 'rep-9', name: 'Bo' }, missing: [] }), { status: 201 }))
    vi.stubGlobal('fetch', f)
    await copyReplica('peer 1', 'rep-1', { skills: 'source', model: 'm', effort: 'default' }, 'key-1')
    await copyReplica('peer 1', 'rep-1', { skills: 'source', model: 'm', effort: 'default' }, 'key-1')
    const calls = f.mock.calls as unknown as Array<[string, RequestInit]>
    expect(calls.map((c) => c[0])).toEqual(['/api/v1/towers/peers/peer%201/employees/rep-1/copy', '/api/v1/towers/peers/peer%201/employees/rep-1/copy'])
    expect(calls.map((c) => (c[1].headers as Record<string, string>)['Idempotency-Key'])).toEqual(['key-1', 'key-1'])
  })
})

describe('where the staffing agency stands', () => {
  it('is on the airfield, clear of the power tower, the helipad and the runway, and no company goes on it', () => {
    const half = { x: AIRPORT.w * CELL / 2, z: AIRPORT.d * CELL / 2 }
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      expect(Math.abs(STAFFING.x + sx * STAFFING.w / 2)).toBeLessThan(half.x)
      expect(Math.abs(STAFFING.z + sz * STAFFING.d / 2)).toBeLessThan(half.z)
    }
    const apart = (x: number, z: number, w: number, d: number) =>
      Math.abs(STAFFING.x - x) >= (STAFFING.w + w) / 2 || Math.abs(STAFFING.z - z) >= (STAFFING.d + d) / 2
    expect(apart(POWER_TOWER.x, POWER_TOWER.z, POWER_TOWER.w, POWER_TOWER.d)).toBe(true)
    expect(apart(HELIPAD.x, HELIPAD.z, HELIPAD.r * 2 + 1, HELIPAD.r * 2 + 1)).toBe(true)
    // the runway runs along x, three cells wide, its line RUNWAY_LINE cells from the far edge (Airport.tsx)
    expect(STAFFING.z + STAFFING.d / 2).toBeLessThan((16 - AIRPORT.d / 2) * CELL - 3 * CELL / 2)
    const town = layoutTown([])
    const [ax, az] = rectCenter(town, town.airport)
    const cell = (v: number, mid: number) => Math.floor((mid + v) / CELL)
    expect(canPlace(town, [cell(STAFFING.x, ax) - 2, cell(STAFFING.z, az) - 2])).toBe(false)
  })
})
