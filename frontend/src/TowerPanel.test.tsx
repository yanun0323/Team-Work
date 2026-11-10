import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { clockOf, TowerBody, updateWhich } from './TowerPanel'
import { IslandSlip } from './IslandBar'
import { useIsland } from './core/island'
import { MOCK_TOWERS, readTowers, type Towers } from './core/towers'
import { AIRPORT, CELL, POWER_TOWER, canPlace, layoutTown, rectCenter } from './layout'
import { listFolders } from './FolderBrowser'
import { HELIPAD } from './Airport'

const refresh = async () => {}
const body = (towers: Towers | null, error = '') => renderToStaticMarkup(<TowerBody towers={towers} error={error} refresh={refresh} />)
const me = { id: 'a', name: 'MacBook', protocol: 1 }
const towers = (t: Partial<Towers> = {}): Towers => ({ me, pairing: null, outgoing: null, peers: [], ...t })

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

  it('with nothing paired, says how to pair, and offers both ways to', () => {
    const html = body(towers())
    expect(html).toContain('還沒有配對的電腦')
    expect(html).toContain('等待配對')
    expect(html).toContain('連到別台')
    expect(html).toContain('<textarea')
    // the mock pairs with nothing, and says so
    expect(html).toContain('模擬模式不能配對')
  })

  it('lists each computer with its status in words, its switch and its actions, all named', () => {
    const html = body(towers({ peers: [
      { id: 'b', name: 'Studio', status: 'online', allowInbound: true, pairedAt: 1 },
      { id: 'c', name: 'Mini', status: 'incompatible', allowInbound: false, pairedAt: 2, protocol: 2 },
      { id: 'd', name: 'Air', status: 'denied', allowInbound: false, pairedAt: 3, message: 'Air 沒有允許這台操作它' },
    ] }))
    expect(html).toContain('Studio')
    expect(html).toContain('在線')
    expect(html).toContain('版本不相容：這台的 Team Work 太舊，請更新這台')
    expect(html).toContain('Air 沒有允許這台操作它')
    // a real checkbox inside its label, so it is reached with Tab and toggled with Space
    expect(html.match(/<label class="fx-tower-allow"><input type="checkbox"[^>]*>允許它操作我<\/label>/g)).toHaveLength(3)
    expect(html.match(/type="checkbox"[^>]*checked=""/g)).toHaveLength(1)
    expect(html.match(/<button[^>]*>前往<\/button>/g)).toHaveLength(3)
    expect(html.match(/<button[^>]*>解除配對<\/button>/g)).toHaveLength(3)
    // never colour alone
    expect(html).toContain('data-status="denied"')
  })

  it("marks the island shown instead of offering to go there", () => {
    const html = renderToStaticMarkup(<TowerBody towers={towers({ peers: [{ id: 'b', name: 'Studio', status: 'online', allowInbound: true, pairedAt: 1 }] })}
      error="" refresh={refresh} here="b" />)
    expect(html).toContain('目前所在')
    expect(html).not.toContain('>前往<')
  })

  it('shows the address to hand over, the time left, and a request to answer', () => {
    const now = Date.now() / 1000
    const waiting = body(towers({ pairing: { address: 'tc0123456789abcdef', expiresAt: now + 600, request: null } }))
    expect(waiting).toContain('tc0123456789abcdef')
    expect(waiting).toContain('複製')
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
    // while one is under way there is no second address to enter
    expect(body(towers({ outgoing: { state: 'waiting' } }))).not.toContain('placeholder="貼上對方的配對位址"')
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
    html = slip({ island: studio, offline: true })
    expect(html).toContain('和 Studio 的連線中斷，正在重新連線')
    expect(html).toContain('回到自己的島')
    expect(slip({ island: studio })).not.toContain('連線中斷')
  })

  it('back home on its own, says why until put away', () => {
    const html = renderToStaticMarkup(<IslandSlip island={null} notice="Studio 已解除配對" arriving={false} offline={false} />)
    expect(html).toContain('role="alert"')
    expect(html).toContain('Studio 已解除配對')
    expect(html).toContain('aria-label="關閉"')
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
    // its pad stays off the helipad's paving (Airport.tsx: a square of side 2r + 1)
    const pad = HELIPAD.r + 0.5
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
