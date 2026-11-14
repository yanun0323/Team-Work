import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AddFriendBody, clockOf, PeerSheet, stayOf, TowerBody, TowerTitle, updateWhich } from './TowerPanel'
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
const adding = (t: Partial<Towers> = {}) => renderToStaticMarkup(<AddFriendBody towers={towers(t)} refresh={refresh} />)
const sheet = (peer: Peer) => renderToStaticMarkup(<PeerSheet peer={peer} me={1} refresh={refresh} />)
const checked = (html: string) => html.match(/<input type="radio"[^>]*checked=""[^>]*\/?><span>([^<]*)<\/span>/g)?.map((m) => m.replace(/.*<span>|<\/span>/g, ''))

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

  it('with no friend islands, says so, with one way to add one and nothing to pick first', () => {
    const html = body(towers())
    expect(html).toContain('還沒有好友小島')
    expect(html).toMatch(/<button type="button" class="fx-task fx-task-new fx-flow-new fx-hit" aria-expanded="false">＋ 新增好友小島<\/button>/)
    expect(html).not.toContain('role="radiogroup"')
    expect(html).not.toContain('fx-tower-code')
    // the mock pairs with nothing, and says so
    expect(html).toContain('模擬模式不能配對')
  })

  it('lists each friend island with its status in words and Go; what it may do here is on its sheet', () => {
    const html = body(towers({ peers: [
      { id: 'b', name: 'Studio', status: 'online', allowInbound: true, pairedAt: 1, access: 'operate' },
      { id: 'c', name: 'Mini', status: 'incompatible', allowInbound: false, pairedAt: 2, protocol: 2, access: 'view' },
      { id: 'd', name: 'Air', status: 'denied', allowInbound: false, pairedAt: 3, message: 'Air 沒有允許這座島操作它', access: 'view' },
    ] }))
    expect(html).toContain('Studio')
    expect(html).toContain('在線')
    expect(html).toContain('版本不相容：這座島的 Team Work 太舊，請更新')
    expect(html).toContain('Air 沒有允許這座島操作它')
    // the row opens the sheet, so the switch beside Go can't be read as Go's
    expect(html).not.toContain('role="radiogroup"')
    expect(html).not.toContain('移除好友')
    expect(html.match(/<button type="button" class="fx-row fx-hit fx-tower-row" aria-expanded="false"/g)).toHaveLength(3)
    expect(html.match(/<button[^>]*>前往<\/button>/g)).toHaveLength(3)
    // Go is the dark button only where it can be gone to; elsewhere still pressable, as it checks again first
    expect(html.match(/class="fx-save fx-tower-go"/g)).toHaveLength(1)
    expect(html.match(/class="fx-save fx-save-quiet fx-tower-go"/g)).toHaveLength(2)
    // never colour alone
    expect(html).toContain('data-status="denied"')
  })

  it('marks what its open sheet is about', () => {
    const peers: Peer[] = [{ id: 'b', name: 'Studio', status: 'online', allowInbound: true, pairedAt: 1, access: 'view' }]
    const row = renderToStaticMarkup(<TowerBody towers={towers({ peers })} error="" refresh={refresh} open={{ kind: 'peer', id: 'b' }} />)
    expect(row).toContain('class="fx-row fx-hit fx-tower-row" aria-expanded="true"')
    const add = renderToStaticMarkup(<TowerBody towers={towers({ peers })} error="" refresh={refresh} open={{ kind: 'add' }} />)
    expect(add).toMatch(/<button[^>]*aria-expanded="true"[^>]*>＋ 新增好友小島<\/button>/)
    expect(add).toContain('aria-expanded="false"')
  })

  it("on a friend island's sheet: who it is, one line asking whether to open my island to it, and a bin to remove it", () => {
    const html = sheet({ id: 'b', name: 'Studio', status: 'online', allowInbound: true, pairedAt: 1, access: 'operate' })
    expect(html).toMatch(/<h2 id="fx-tower-sheet-title" tabindex="-1">Studio<\/h2>/)
    // the question and its switch on one line, the switch named by the question
    expect(html).toMatch(/<div class="fx-tower-access-row"><span id="([^"]+)" class="fx-tower-access-label">是否對 Studio 開放我的小島<\/span><div class="fx-switcher fx-tower-access" role="radiogroup" aria-labelledby="\1"/)
    expect(html).not.toContain('type="checkbox"')
    expect(checked(html)).toEqual(['可操作'])
    expect(html).toContain('<span>不開放</span>')
    expect(html).toContain('<span>僅檢視</span>')
    // removing is the bin among the sheet's tools, not a word at its foot
    expect(html).toMatch(/<div class="fx-tools"><button type="button" class="fx-tool fx-hit" aria-label="移除好友" title="移除好友"><svg/)
    expect(checked(sheet({ id: 'c', name: 'Mini', status: 'offline', allowInbound: false, pairedAt: 2, access: 'operate' }))).toEqual(['不開放'])
  })

  it('writes the times it shows on a 24-hour clock', () => {
    const at = new Date(2026, 10, 15, 15, 9).getTime() / 1000
    const html = sheet({ id: 'b', name: 'Studio', status: 'online', allowInbound: true, pairedAt: 1, access: 'view', blockedUntil: at })
    expect(html).toContain('封鎖到 15:09')
    expect(html).not.toMatch(/AM|PM/)
  })

  it('shows a friend island whose access is missing or unknown as view only', () => {
    for (const access of [undefined, 'admin']) {
      const peer = { id: 'b', name: 'Studio', status: 'online', allowInbound: true, pairedAt: 1, access } as unknown as Peer
      expect(checked(sheet(peer))).toEqual(['僅檢視'])
    }
  })

  it("marks the island shown instead of offering to go there", () => {
    const html = renderToStaticMarkup(<TowerBody towers={towers({ peers: [{ id: 'b', name: 'Studio', status: 'online', allowInbound: true, pairedAt: 1, access: 'operate' }] })}
      error="" refresh={refresh} here="b" />)
    expect(html).toContain('目前所在')
    expect(html).not.toContain('>前往<')
  })

  it('adding one: this island\'s code to copy with the time left, and the other\'s to paste, with no side to pick', () => {
    const now = Date.now() / 1000
    const waiting = adding({ pairing: { address: 'tc0123456789abcdef', expiresAt: now + 600, request: null } })
    expect(waiting).toMatch(/<h2 id="fx-tower-sheet-title" tabindex="-1">新增好友小島<\/h2>/)
    expect(waiting).toContain('我的配對碼')
    expect(waiting).toContain('value="tc0123456789abcdef"')
    expect(waiting).toContain('readOnly=""')
    expect(waiting).toContain('複製')
    expect(waiting).toMatch(/剩下 (10:00|9:59)/)
    expect(waiting).toContain('或貼上對方的配對碼')
    expect(waiting).toMatch(/<button type="submit"[^>]*>加入<\/button>/)
    expect(waiting).not.toContain('role="radiogroup"')
    // closing the sheet stops waiting, so there is no button for it
    expect(waiting).not.toContain('停止等待')
    // before the code is ready, after it ran out or was used: a way to make one
    expect(adding()).toMatch(/<button[^>]*>產生配對碼<\/button>/)
  })

  it('answers a request to be friends, unless the versions do not match', () => {
    const now = Date.now() / 1000
    const asked = adding({ pairing: { address: 'tc0', expiresAt: now + 60, request: { id: 'r', name: 'Studio', protocol: 1, compatible: true } } })
    expect(asked).toContain('Studio 想加你為好友')
    expect(asked).toContain('>同意<')
    expect(asked).toContain('>拒絕<')
    const old = adding({ pairing: { address: 'tc0', expiresAt: now + 60, request: { id: 'r', name: 'Studio', protocol: 0, compatible: false } } })
    expect(old).toContain('Studio 的 Team Work 太舊，請對方更新')
    expect(old).not.toContain('>同意<')
  })

  it('follows a code it pasted: connecting, waiting, friends, or why it failed', () => {
    expect(adding({ outgoing: { state: 'connecting' } })).toContain('正在連線…')
    expect(adding({ outgoing: { state: 'waiting', name: 'Studio' } })).toContain('等待 Studio 同意…')
    expect(adding({ outgoing: { state: 'waiting' } })).toContain('等待對方同意…')
    expect(adding({ outgoing: { state: 'paired', name: 'Studio', peerId: 'b' } })).toContain('已和 Studio 成為好友')
    const failed = adding({ outgoing: { state: 'failed', code: 'pair_rejected', message: '對方拒絕了配對' } })
    expect(failed).toContain('role="alert"')
    expect(failed).toContain('對方拒絕了配對')
    // while one is under way there is no second code to paste; this island's own code stays
    const going = adding({ outgoing: { state: 'waiting' } })
    expect(going).not.toContain('type="submit"')
    expect(going).toContain('>取消<')
    expect(going).toContain('產生配對碼')
    expect(adding({ outgoing: { state: 'paired', name: 'Studio' } })).toContain('>關閉<')
  })

  it('writes which computer to update, and the time left as m:ss', () => {
    expect(updateWhich(1, 2, 'Studio')).toBe('這座島的 Team Work 太舊，請更新')
    expect(updateWhich(2, 1, 'Studio')).toBe('Studio 的 Team Work 太舊，請對方更新')
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
  it("has no field for this computer's name: the profile sets it", () => {
    const html = body(towers())
    expect(html).not.toContain('這台的名稱')
    expect(html).not.toContain('value="MacBook"')
    expect(html).not.toContain('連線版本')
    // who is here is told on the friend islands' rows, not in a list of its own
    expect(html).not.toContain('正在這座島上')
  })

  it("shows this computer's name under the title, as a way to the profile when there is one", () => {
    expect(renderToStaticMarkup(<TowerTitle me={me} />)).toMatch(/<p class="fx-where">MacBook<\/p>/)
    const linked = renderToStaticMarkup(<TowerTitle me={me} onProfile={() => {}} />)
    expect(linked).toMatch(/<button type="button" class="fx-tower-me" title="在個人檔案修改">.*MacBook<\/button>/)
  })

  it('puts the link version in the head, after the title, once the tower is read', () => {
    const html = renderToStaticMarkup(<TowerTitle me={me} />)
    expect(html).toMatch(/<h1[^>]*>基地台<\/h1>.*<p class="fx-tower-version">連線版本 1<\/p>/)
    expect(renderToStaticMarkup(<TowerTitle me={null} />)).not.toContain('連線版本')
  })

  it("shows each person's face at the start of its row, or a black block with a question mark until it has said how it looks", () => {
    const look = { skin: '#f2c9a0', hair: '#2b1d14', shirt: '#3f7fbf', pants: '#2f3542', extra: 'none', style: 1, wardrobe: 3 } as const
    const html = body(towers({
      peers: [
        { id: 'b', name: 'Studio', status: 'online', allowInbound: true, pairedAt: 1, access: 'operate', look },
        { id: 'c', name: 'Mini', status: 'offline', allowInbound: false, pairedAt: 2, access: 'view' },
      ],
    }))
    expect(html).toMatch(/fx-tower-row" aria-expanded="false"><span class="fx-tower-face" aria-hidden="true"><svg class="pixel-face"[^]*?<\/span><span class="fx-row-main"><b[^>]*>Studio<\/b>/)
    expect(html).toMatch(/fx-tower-row" aria-expanded="false"><span class="fx-tower-face" aria-hidden="true"><svg class="fx-tower-unknown"[^]*?<\/span><span class="fx-row-main"><b[^>]*>Mini<\/b>/)
  })

  it('lays a friend island out in one line: face, name over status, then Go', () => {
    const html = body(towers({ peers: [{ id: 'b', name: 'Studio', status: 'online', allowInbound: true, pairedAt: 1, access: 'operate' }] }))
    const order = ['fx-tower-face', 'fx-row-main', 'fx-tower-go'].map((c) => html.search(new RegExp(`class="[^"]*\\b${c}\\b`)))
    expect(order.every((n) => n >= 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
  })

  it('says on a friend island\'s row that it is on this island, since when and for how long, and lists those first', () => {
    vi.useFakeTimers({ now: new Date(2026, 10, 15, 15, 30) })
    try {
      const since = new Date(2026, 10, 15, 14, 5).getTime() / 1000
      const html = body(towers({
        peers: [
          { id: 'b', name: 'Studio', status: 'online', allowInbound: true, pairedAt: 1, access: 'view' },
          { id: 'c', name: 'Mini', status: 'online', allowInbound: true, pairedAt: 2, access: 'view' },
        ],
        visitors: [{ id: 'c', name: 'Mini', places: ['airport'], since }],
      }))
      expect(html).toContain('data-status="visiting"><span class="fx-tower-dot" aria-hidden="true"></span>正在我的小島 · 14:05 登島 · 待了 1 小時 25 分鐘</span>')
      expect(html.indexOf('>Mini<')).toBeLessThan(html.indexOf('>Studio<'))
      // the one not here stays online, after
      expect(html).toContain('data-status="online"')
      // an older backend says nothing of when
      const old = body(towers({ peers: [{ id: 'b', name: 'Studio', status: 'online', allowInbound: true, pairedAt: 1, access: 'view' }], visitors: [{ id: 'b', name: 'Studio', places: [] }] }))
      expect(old).toContain('正在我的小島</span>')
      expect(old).not.toContain('登島')
    } finally {
      vi.useRealTimers()
    }
  })

  it('says how long a visitor has stayed in minutes, then hours', () => {
    expect(stayOf(30)).toBe('剛到')
    expect(stayOf(25 * 60 + 59)).toBe('待了 25 分鐘')
    expect(stayOf(2 * 3600)).toBe('待了 2 小時')
    expect(stayOf(2 * 3600 + 5 * 60)).toBe('待了 2 小時 5 分鐘')
  })

  it('shows a block left from before on the sheet, with a way to lift it', () => {
    const html = sheet({ id: 'b', name: 'Studio', status: 'online', allowInbound: true, pairedAt: 1, access: 'view', blockedUntil: -1 })
    expect(html).toContain('已封鎖')
    expect(html.match(/<button[^>]*>解除封鎖<\/button>/g)).toHaveLength(1)
    expect(sheet({ id: 'c', name: 'Mini', status: 'online', allowInbound: true, pairedAt: 2, access: 'view' })).not.toContain('解除封鎖')
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
