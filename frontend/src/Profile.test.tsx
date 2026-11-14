import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it } from 'vitest'
import { useStore } from './core/store'
import { defaultLook, lookOf, mockProfileStats, type ProfileStats } from './core/profile'
import { setProfile, useMe } from './core/towers'
import { LookEditor, pinnedParts } from './LookEditor'
import { daysSince, MilestoneList } from './Profile'
import { styleOf } from './figureStyle'

const me = { id: 'mac', name: '小安', protocol: 2 }
const usage = { calls: 0, input: 0, output: 0, cacheRead: 0, tokens: 0, costUsd: 0, unpriced: 0 }

afterEach(() => useMe.setState({ me: null }))

describe("the user's look", () => {
  it('is steady for the computer before it is picked, and as picked after', () => {
    expect(defaultLook('mac')).toEqual(defaultLook('mac'))
    expect(lookOf(me)).toEqual(defaultLook('mac'))
    const look = { ...defaultLook('mac'), extra: 'cap' as const }
    expect(lookOf({ ...me, look })).toBe(look)
  })

  it('pins every part as worn now, so changing one keeps the rest', () => {
    const look = defaultLook('mac')
    expect(pinnedParts(look, me.id)).toEqual(styleOf(look.style!, look.wardrobe))
    const parts = { ...pinnedParts(look, me.id), hair: 'braid' as const }
    expect(pinnedParts({ ...look, parts }, me.id)).toEqual(parts)
  })

  it('names each part and colour, with the name to change and the die', () => {
    const html = renderToStaticMarkup(<LookEditor me={me} />)
    for (const label of ['名字', '髮型', '髮色', '膚色', '鬍子', '配件', '上衣', '上衣顏色', '配色', '下半身', '下身顏色', '鞋子', '鞋子顏色']) {
      expect(html).toContain(`>${label}<`)
    }
    expect(html).toContain('value="小安"')
    expect(html).toContain('aria-label="隨機外型"')
    // every part a real radio group, each colour row ending in the system's picker
    expect(html.match(/role="radiogroup"/g)).toHaveLength(12)
    expect(html.match(/<input type="color"/g)).toHaveLength(6)
    // nothing worn on the head yet
    expect(html).toMatch(/<input type="radio" aria-label="無" name="[^"]+" checked=""\/>/)
  })

  it('has no colour row for bare feet', () => {
    const look = defaultLook('mac')
    const barefoot = { ...me, look: { ...look, parts: { ...pinnedParts(look, 'mac'), shoes: 'barefoot' as const } } }
    const html = renderToStaticMarkup(<LookEditor me={barefoot} />)
    expect(html).toMatch(/<input type="radio" name="[^"]+" checked=""\/><span>光腳<\/span>/)
    expect(html).not.toContain('>鞋子顏色<')
  })

  it('is kept as saved, the mock without a tower too', async () => {
    useMe.setState({ me })
    const look = { ...defaultLook('mac'), parts: { ...pinnedParts(defaultLook('mac'), 'mac'), top: 'hoodie' as const } }
    await setProfile(' 阿安 ', look)
    expect(useMe.getState().me).toMatchObject({ id: 'mac', name: '阿安', look })
  })
})

describe("the user's milestones", () => {
  const stats = (s: Partial<ProfileStats> = {}): ProfileStats => ({ since: 0, tasksDone: 0, chats: 0, messages: 0, usage, ...s })

  it('says there are none on a new island', () => {
    expect(renderToStaticMarkup(<MilestoneList stats={stats()} />)).toContain('還沒有使用紀錄')
  })

  it('counts the days from the first, the first included', () => {
    expect(daysSince(0, 1000)).toBe(0)
    expect(daysSince(1000, 1000)).toBe(1)
    expect(daysSince(1000, 1000 + 86400 * 9 + 5)).toBe(10)
  })

  it('shows the big numbers and who the user works with most', () => {
    const look = defaultLook('ivy')
    const html = renderToStaticMarkup(<MilestoneList now={1 + 86400 * 3} stats={stats({
      since: 1, tasksDone: 12, chats: 34, messages: 560, usage: { ...usage, calls: 3, tokens: 12_345, costUsd: 1.5 },
      partner: { id: 'ivy', name: 'Ivy', look, count: 7 },
    })} />)
    for (const [label, value] of [['使用天數', '4'], ['完成任務', '12'], ['對話', '34'], ['你說的話', '560'], ['Token', '12.3K'], ['費用', '$1.50']]) {
      expect(html).toContain(`<dt>${label}</dt><dd>${value}</dd>`)
    }
    expect(html).toContain('最常合作')
    expect(html).toMatch(/<b>Ivy<\/b><span>一起 7 次<\/span>/)
  })

  it("are summed from the simulator's world", () => {
    const w = useStore.getState().world
    const s = mockProfileStats(w)
    expect(s.chats).toBe(Object.keys(w.chats).length)
    expect(s.tasksDone).toBe(Object.values(w.tasks).filter((t) => t.stage === 'done').length)
    if (s.partner) expect(w.replicas[s.partner.id]?.name).toBe(s.partner.name)
  })
})
