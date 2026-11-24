import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('./core/mode', () => ({ MOCK: false }))

import * as THREE from 'three'
import { emptyWorld } from './core/backend'
import type { Ghost, World } from './core/domain/types'
import { useFeeds } from './core/ghosts'
import { usePeers, type Peer } from './core/towers'
import { ghostPalette, paletteOf } from './Building'
import { GhostDrawer, whyNot } from './Ghost'
import { IslandSlip } from './IslandBar'
import { GhostTag } from './World'

const ghost: Ghost = { id: 'ghost-1', peerId: 'b', teamId: 'team-9', name: 'Acme', plot: { at: [20, -8], style: 'castle', seed: 3 }, createdAt: 5 }
const peer = (p: Partial<Peer> = {}): Peer => ({ id: 'b', name: 'Studio', status: 'online', allowInbound: false, pairedAt: 1, access: 'view', ...p })
const there = (): World => {
  const w: World = { ...emptyWorld(), teams: { 'team-9': { id: 'team-9', name: 'Acme' } as never } }
  w.chats.c1 = { id: 'c1', teamId: 'team-9', unread: true, messages: [] } as never
  return w
}
const tag = (p: Partial<Parameters<typeof GhostTag>[0]>) =>
  renderToStaticMarkup(<GhostTag name="Acme" right ghost={ghost} state="online" there={there()} owner="Studio" {...p} />)

afterEach(() => {
  usePeers.setState({ peers: null })
  useFeeds.setState({}, true)
})

describe("a ghost company's name tag", () => {
  it("puts its owner's face before its name, and what waits there after it", () => {
    const html = tag({})
    expect(html).toContain('fx-tag fx-tag-ghost fx-tag-right')
    expect(html).not.toContain('fx-tag-ghost-off')
    expect(html).toMatch(/fx-tower-face.*Acme/)
    expect(html).toContain('Studio 的公司')
    expect(html).toContain('1 則對話待處理')
    expect(html).not.toContain('fx-tag-lock')
  })

  it('shows a lock when it can only be looked at', () => {
    const html = tag({ state: 'view' })
    expect(html).toContain('fx-tag-lock')
    expect(html).toContain('只能檢視')
  })

  it("greys out, without what waits there, while it can't be reached, and says why to a reader", () => {
    for (const [state, said] of [['offline', '連不上'], ['lost', '不能使用'], ['gone', '已關閉']] as const) {
      const html = tag({ state })
      expect(html).toContain('fx-tag-ghost-off')
      expect(html).toContain(said)
      expect(html).not.toContain('待處理')
    }
  })
})

it("leaves out the bar that says another island is worked while a ghost company is open: the map is still this island's", () => {
  const island = { id: 'b', name: 'Studio', ghost: { id: 'ghost-1', teamId: 'team-9' } }
  expect(renderToStaticMarkup(<IslandSlip island={island} notice="" arriving={false} offline={false} />)).toBe('')
  expect(renderToStaticMarkup(<IslandSlip island={{ id: 'b', name: 'Studio' }} notice="" arriving={false} offline={false} />)).toContain('正在操作：Studio')
  // why it closed on its own is still said
  expect(renderToStaticMarkup(<IslandSlip island={null} notice="Studio 沒有對你開放小島" arriving={false} offline={false} />)).toContain('Studio 沒有對你開放小島')
})

it("paints a ghost company's building in a cool blue, keeping light and dark apart, and greyer while out of reach", () => {
  const own = paletteOf({ style: 'brick', seed: 1 })
  const hsl = { h: 0, s: 0, l: 0 }
  const of = (hex: string) => ({ ...new THREE.Color(hex).getHSL(hsl) })
  for (const on of [true, false]) {
    const p = ghostPalette(own, on)
    for (const c of Object.values(p)) {
      const { h, s } = of(c)
      expect(h).toBeCloseTo(0.6, 1)
      expect(s).toBeCloseTo(on ? 0.38 : 0.12, 1)
    }
    // a light wall stays lighter than its dark trim
    expect(of(p.inside).l).toBeGreaterThan(of(p.glass).l)
  }
  expect(ghostPalette(own, true)).toBe(ghostPalette(own, true))
})

describe("a ghost company that can't be worked from here", () => {
  it('has a sheet with its name and the way to take it off this island', () => {
    const html = renderToStaticMarkup(<GhostDrawer ghost={ghost} look={ghost.plot} leaving={false} onGone={() => {}} />)
    expect(html).toContain('<h1 id="fx-ghost-title" tabindex="-1">Acme</h1>')
    expect(html).toContain('role="status"')
    expect(html).toContain('移除投影')
  })

  it('says why: its computer out of reach, the company closed there, shut out, or no longer paired', () => {
    expect(whyNot('offline', peer({ status: 'offline' }))).toBe('連不上 Studio，對方打開 Team Work 後就會恢復')
    expect(whyNot('gone', peer())).toBe('Studio 已經關閉這間公司')
    expect(whyNot('lost', peer({ status: 'denied', message: '對方已封鎖這座島，暫時不能前往' }))).toBe('對方已封鎖這座島，暫時不能前往')
    expect(whyNot('lost', peer({ status: 'denied' }))).toBe('Studio 沒有對你開放小島')
    expect(whyNot('lost', undefined)).toBe('已經和這座好友小島解除配對')
  })
})
