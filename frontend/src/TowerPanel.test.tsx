import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { clockOf, TowerBody, TowerTitle, updateWhich } from './TowerPanel'
import { IslandSlip } from './IslandBar'
import { useIsland } from './core/island'
import { MOCK_TOWERS, readTowers, type Peer, type Towers } from './core/towers'
import { AIRPORT, CELL, POWER_TOWER, canPlace, layoutTown, rectCenter } from './layout'
import { listFolders } from './FolderBrowser'
import { HELIPAD } from './Airport'

const refresh = async () => {}
const body = (towers: Towers | null, error = '') => renderToStaticMarkup(<TowerBody towers={towers} error={error} refresh={refresh} />)
const me = { id: 'a', name: 'MacBook', protocol: 1 }
const towers = (t: Partial<Towers> = {}): Towers => ({ me, pairing: null, outgoing: null, peers: [], visitors: [], ...t })

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  useIsland.setState({ island: null, notice: '' })
})


describe('the power tower panel', () => {
  it('says it is loading, and what went wrong with a way to try again', () => {
    expect(body(null)).toContain('載入中…')
    const failed = body(null, '連不上後端')
    expect(failed).toContain('role="alert"')
    expect(failed).toContain('連不上後端')
    expect(failed).toContain('重試')
  })

  it('with nothing paired, says so, and asks which side of a new pairing this computer takes', () => {
    const html = body(towers())
    expect(html).toContain('還沒有配對的電腦')
    expect(html).toContain('配對新電腦')
    // both sides as real radios, named by the section, the side being worked picked first
    expect(html).toMatch(/role="radiogroup" aria-labelledby="fx-tower-pair"/)
    expect(html.match(/<input type="radio"/g)).toHaveLength(2)
    expect(html).toMatch(/<input type="radio"[^>]*checked=""[^>]*\/><span>讓別台操作這台<\/span>/)
    expect(html).toContain('操作別台')
    expect(html).toMatch(/<button[^>]*>等待配對<\/button>/)
    // the address to enter shows only once that side is picked
    expect(html).not.toContain('placeholder="貼上對方的配對位址"')
    // the mock pairs with nothing, and says so
    expect(html).toContain('模擬模式不能配對')
  })

  it('lists each computer with its status in words, its switch and its actions, all named', () => {
    const html = body(towers({ peers: [
      { id: 'b', name: 'Studio', status: 'online', allowInbound: true, pairedAt: 1, access: 'operate' },
      { id: 'c', name: 'Mini', status: 'incompatible', allowInbound: false, pairedAt: 2, protocol: 2, access: 'view' },
      { id: 'd', name: 'Air', status: 'denied', allowInbound: false, pairedAt: 3, message: 'Air 沒有允許這台操作它', access: 'view' },
    ] }))
    expect(html).toContain('Studio')
    expect(html).toContain('在線')
    expect(html).toContain('版本不相容：這台的 Team Work 太舊，請更新這台')
    expect(html).toContain('Air 沒有允許這台操作它')
    // a real checkbox inside its label, so it is reached with Tab and toggled with Space
    expect(html.match(/<label class="fx-tower-allow"><input type="checkbox"[^>]*>允許它操作我<\/label>/g)).toHaveLength(3)
    expect(html.match(/type="checkbox"[^>]*checked=""/g)).toHaveLength(1)
    expect(html.match(/<button[^>]*>前往<\/button>/g)).toHaveLength(3)
    // Go is the dark button only where it can be gone to; elsewhere still pressable, as it checks again first
    expect(html.match(/class="fx-save fx-tower-go"/g)).toHaveLength(1)
    expect(html.match(/class="fx-save fx-save-quiet fx-tower-go"/g)).toHaveLength(2)
    expect(html.match(/<button[^>]*>解除配對<\/button>/g)).toHaveLength(3)
    // never colour alone
    expect(html).toContain('data-status="denied"')
  })

  it('shows a computer whose access is missing or unknown as view only', () => {
    for (const access of [undefined, 'admin']) {
      const peer = { id: 'b', name: 'Studio', status: 'online', allowInbound: true, pairedAt: 1, access } as unknown as Peer
      const html = body(towers({ peers: [peer] }))
      expect(html).toMatch(/<input type="radio"[^>]*checked=""[^>]*><span>檢視<\/span>/)
      expect(html).toMatch(/<input type="radio"[^>]*><span>操作<\/span>/)
      expect(html).not.toMatch(/<input type="radio"[^>]*checked=""[^>]*><span>操作<\/span>/)
    }
  })

  it("marks the island shown instead of offering to go there", () => {
    const html = renderToStaticMarkup(<TowerBody towers={towers({ peers: [{ id: 'b', name: 'Studio', status: 'online', allowInbound: true, pairedAt: 1, access: 'operate' }] })}
      error="" refresh={refresh} here="b" />)
    expect(html).toContain('目前所在')
    expect(html).not.toContain('>前往<')
  })

  it('shows the address to hand over, the time left, and a request to answer', () => {
    const now = Date.now() / 1000
    const waiting = body(towers({ pairing: { address: 'tc0123456789abcdef', expiresAt: now + 600, request: null } }))
    expect(waiting).toContain('value="tc0123456789abcdef"')
    expect(waiting).toContain('readOnly=""')
    expect(waiting).toContain('在另一台選「操作別台」，貼上這串位址')
    expect(waiting).toContain('複製')
    // under way, there is no choosing a side until it is stopped
    expect(waiting).not.toContain('role="radiogroup"')
    expect(waiting).toContain('停止等待')
    expect(waiting).toMatch(/剩下 (10:00|9:59)/)
    const asked = body(towers({ pairing: { address: 'tc0', expiresAt: now + 60, request: { id: 'r', name: 'Studio', protocol: 1, compatible: true } } }))
    expect(asked).toContain('Studio 想要配對')
    expect(asked).toContain('>同意<')
    expect(asked).toContain('>拒絕<')
    const old = body(towers({ pairing: { address: 'tc0', expiresAt: now + 60, request: { id: 'r', name: 'Studio', protocol: 0, compatible: false } } }))
    expect(old).toContain('Studio 的 Team Work 太舊，請更新那台')
    expect(old).not.toContain('>同意<')
  })

  it('follows a pairing it asked for: connecting, waiting, paired, or why it failed', () => {
    expect(body(towers({ outgoing: { state: 'connecting' } }))).toContain('正在連線…')
    expect(body(towers({ outgoing: { state: 'waiting', name: 'Studio' } }))).toContain('等待 Studio 同意…')
    expect(body(towers({ outgoing: { state: 'waiting' } }))).toContain('等待對方同意…')
    expect(body(towers({ outgoing: { state: 'paired', name: 'Studio', peerId: 'b' } }))).toContain('已和 Studio 配對')
    const failed = body(towers({ outgoing: { state: 'failed', code: 'pair_rejected', message: '對方拒絕了配對' } }))
    expect(failed).toContain('role="alert"')
    expect(failed).toContain('對方拒絕了配對')
    // while one is under way there is no second address to enter, nor a side to pick
    expect(body(towers({ outgoing: { state: 'waiting' } }))).not.toContain('placeholder="貼上對方的配對位址"')
    expect(body(towers({ outgoing: { state: 'waiting' } }))).not.toContain('role="radiogroup"')
    // after a pairing it asked for, the side picked is still to enter an address
    expect(body(towers({ outgoing: { state: 'paired', name: 'Studio' } }))).toContain('>關閉<')
  })

  it('writes which computer to update, and the time left as m:ss', () => {
    expect(updateWhich(1, 2, 'Studio')).toBe('這台的 Team Work 太舊，請更新這台')
    expect(updateWhich(2, 1, 'Studio')).toBe('Studio 的 Team Work 太舊，請更新那台')
    expect(clockOf(600)).toBe('10:00')
    expect(clockOf(61.2)).toBe('1:02')
    expect(clockOf(-3)).toBe('0:00')
  })

  it('reads nothing from a backend under the mock', async () => {
    const f = vi.fn()
    vi.stubGlobal('fetch', f)
    await expect(readTowers()).resolves.toEqual(MOCK_TOWERS)
    expect(f).not.toHaveBeenCalled()
  })
})

describe('which island is shown', () => {
  it("says nothing at home, and away names the computer, how the connection is, and the way back", () => {
    const slip = (p: Partial<Parameters<typeof IslandSlip>[0]>) =>
      renderToStaticMarkup(<IslandSlip island={null} notice="" arriving={false} offline={false} {...p} />)
    expect(slip({})).toBe('')
    const studio = { id: 'b', name: 'Studio' }
    let html = slip({ island: studio, arriving: true })
    expect(html).toContain('正在操作：Studio')
    expect(html).toContain('載入中…')
    expect(html).toMatch(/<button[^>]*>回到自己的島<\/button>/)
    // the square the slip folds to over an open sheet is only a picture; loading is not a lost connection
    expect(html).toMatch(/<span class="fx-island-fold" aria-hidden="true"><svg class="fx-island-arrow"/)
    expect(html).not.toContain('fx-island-alert')
    html = slip({ island: studio, offline: true })
    expect(html).toContain('和 Studio 的連線中斷，正在重新連線')
    expect(html).toContain('回到自己的島')
    // folded, the square shows the lost connection with a red warning beside the arrow
    expect(html).toMatch(/<span class="fx-island-fold" aria-hidden="true"><svg class="fx-island-alert"/)
    expect(slip({ island: studio })).not.toContain('連線中斷')
    expect(slip({ island: studio })).not.toContain('fx-island-alert')
  })

  it('back home on its own, says why until put away', () => {
    const html = renderToStaticMarkup(<IslandSlip island={null} notice="Studio 已解除配對" arriving={false} offline={false} />)
    expect(html).toContain('role="alert"')
    expect(html).toContain('Studio 已解除配對')
    expect(html).toContain('aria-label="關閉"')
  })
})

describe('the people on this island, from the tower', () => {
  it("shows this computer's name to edit", () => {
    const html = body(towers())
    expect(html).toMatch(/<label for="[^"]+">這台的名稱<\/label>/)
    expect(html).toContain('value="MacBook"')
    expect(html).not.toContain('連線版本')
    expect(html).toContain('目前沒有其他電腦')
  })

  it('puts the link version in the head, after the title, once the tower is read', () => {
    const html = renderToStaticMarkup(<TowerTitle me={me} />)
    expect(html).toMatch(/<h1[^>]*>基地台<\/h1>.*<p class="fx-tower-version">連線版本 1<\/p>/)
    expect(renderToStaticMarkup(<TowerTitle me={null} />)).not.toContain('連線版本')
  })

  it('lists each visitor once with where it is, and ways to send it away or keep it out', () => {
    const html = body(towers({ visitors: [{ id: 'b', name: 'Studio', places: ['airport'] }] }))
    expect(html).toContain('Studio')
    expect(html).toContain('機場')
    for (const act of ['踢出', '封鎖 1 小時', '封鎖']) expect(html).toMatch(new RegExp(`<button[^>]*>${act}</button>`))
  })

  it('switches between looking and working for a computer let in, and lifts a block', () => {
    const html = body(towers({ peers: [
      { id: 'b', name: 'Studio', status: 'online', allowInbound: true, pairedAt: 1, access: 'view', blockedUntil: -1 },
      { id: 'c', name: 'Mini', status: 'online', allowInbound: false, pairedAt: 2, access: 'view' },
    ] }))
    expect(html.match(/<input type="radio"[^>]*checked=""[^>]*\/><span>檢視<\/span>/g)).toHaveLength(1)
    expect(html).toContain('<span>操作</span>')
    expect(html).toContain('已封鎖')
    expect(html.match(/<button[^>]*>解除封鎖<\/button>/g)).toHaveLength(1)
  })
})

describe('where the power tower stands', () => {
  it("is in the airfield's corner, so no company can be placed on it", () => {
    const half = { x: AIRPORT.w * CELL / 2, z: AIRPORT.d * CELL / 2 }
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      const x = POWER_TOWER.x + sx * POWER_TOWER.w / 2, z = POWER_TOWER.z + sz * POWER_TOWER.d / 2
      expect(Math.abs(x)).toBeLessThan(half.x)
      expect(Math.abs(z)).toBeLessThan(half.z)
    }
    // its pad stays at least two cells off the helipad's paving (Airport.tsx: a square of side 2r + 1)
    const pad = HELIPAD.r + 0.5 + 2 * CELL
    const apart = Math.abs(POWER_TOWER.x - HELIPAD.x) >= POWER_TOWER.w / 2 + pad || Math.abs(POWER_TOWER.z - HELIPAD.z) >= POWER_TOWER.d / 2 + pad
    expect(apart).toBe(true)
    const town = layoutTown([])
    const [ax, az] = rectCenter(town, town.airport)
    // the tower's cell, in town cells as a spot is
    const cell = (v: number, mid: number) => Math.floor((mid + v) / CELL)
    const spot: [number, number] = [cell(POWER_TOWER.x, ax) - 2, cell(POWER_TOWER.z, az) - 2]
    expect(canPlace(town, spot)).toBe(false)
  })
})

describe('folders on another computer', () => {
  it('asks for home with no path, and for a folder by its path', async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ path: '/Users/b', parent: '/Users', home: '/Users/b', folders: [] }), { status: 200 }))
    vi.stubGlobal('fetch', f)
    await listFolders('')
    await listFolders('/Users/b/code a')
    expect((f.mock.calls as unknown as Array<[string]>).map((c) => c[0])).toEqual(['/api/v1/folders', '/api/v1/folders?path=%2FUsers%2Fb%2Fcode%20a'])
    useIsland.setState({ island: { id: 'b', name: 'Studio' } })
    await listFolders('')
    expect((f.mock.calls as unknown as Array<[string]>).at(-1)![0]).toBe('/api/v1/remote/b/folders')
  })
})
