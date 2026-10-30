import { describe, expect, it } from 'vitest'
import { outEdges, taskNodeOf } from './core/domain/graph'
import { addStep, blankFlow, branchStep, canLink, insertStep, endOf, isMiddle, link, loose, nextChoices, putStep, removeStep, unlink } from './flowDraft'

const fresh = () => {
  const wf = blankFlow('t')
  return { wf, end: endOf(wf)!.id, start: taskNodeOf(wf).id }
}

describe('flow draft', () => {
  it('starts with 整理需求 and ends with 驗收', () => {
    const { wf, end } = fresh()
    expect(wf.nodes.map((n) => n.name)).toEqual(['整理需求', '驗收'])
    expect(loose(wf, end)).toEqual([])
  })

  it('adds a step just before the end, and removing it joins the flow back up', () => {
    const { wf: blank, end, start } = fresh()
    const [wf, id] = addStep(blank, end)
    expect(outEdges(wf, start).map((e) => e.to)).toEqual([id])
    expect(outEdges(wf, id).map((e) => e.to)).toEqual([end])
    const back = removeStep(wf, id)
    expect(outEdges(back, start).map((e) => e.to)).toEqual([end])
    expect(loose(back, end)).toEqual([])
  })

  it('numbers new steps 新步驟1, 新步驟2…, taking the first number not in use', () => {
    const { wf: blank, end, start } = fresh()
    const [a, x] = addStep(blank, end)
    const [b, y] = branchStep(a, end, start)
    const [c] = insertStep(b, b.edges[0].id)
    const name = (wf: typeof c, id: string) => wf.nodes.find((n) => n.id === id)!.name
    expect([name(c, x), name(c, y), c.nodes.at(-1)!.name]).toEqual(['新步驟1', '新步驟2', '新步驟3'])
    // renamed or removed, a number is free again
    const [d, z] = addStep(removeStep(c, y), end)
    expect(name(d, z)).toBe('新步驟2')
  })

  it('branches a new step off another, leading on to the end', () => {
    const { wf: blank, end, start } = fresh()
    const [a, x] = addStep(blank, end)
    const [wf, y] = branchStep(a, end, start)
    expect(outEdges(wf, start).map((e) => e.to)).toEqual([x, y])
    expect(outEdges(wf, y).map((e) => e.to)).toEqual([end])
    expect(loose(wf, end)).toEqual([])
  })

  it('inserts a step into an arrow, keeping the flow whole', () => {
    const { wf: blank, end, start } = fresh()
    const [wf, y] = insertStep(blank, outEdges(blank, start)[0].id)
    expect(outEdges(wf, start).map((e) => e.to)).toEqual([y])
    expect(outEdges(wf, y).map((e) => e.to)).toEqual([end])
    expect(wf.edges).toHaveLength(2)
    expect(loose(wf, end)).toEqual([])
  })

  it('offers no next step that would loop, and finds steps cut off', () => {
    const { wf: blank, end } = fresh()
    const [a, x] = addStep(blank, end)
    const [wf, y] = addStep(a, end)
    expect(nextChoices(wf, end, y).map((n) => n.id)).not.toContain(x)
    const cut = putStep(wf, wf.nodes.find((n) => n.id === x)!, [])
    expect(loose(cut, end).map((n) => n.id)).toContain(x)
  })

  it('draws arrows only where they may go, and takes them away', () => {
    const { wf: blank, end, start } = fresh()
    const [a, x] = addStep(blank, end)
    const [wf, y] = addStep(a, end)
    // start → x → y → end; x may also hand straight to the end
    expect(canLink(wf, end, x, end)).toBe(true)
    expect(canLink(wf, end, y, x)).toBe(false) // a loop
    expect(canLink(wf, end, end, x)).toBe(false) // out of the end
    expect(canLink(wf, end, x, start)).toBe(false) // into the start
    expect(canLink(wf, end, start, x)).toBe(false) // already there
    const both = link(wf, end, x, end)
    expect(outEdges(both, x).map((e) => e.to).sort()).toEqual([end, y].sort())
    expect(link(wf, end, y, x)).toBe(wf)
    // cutting x → y leaves y unreached
    const cut = unlink(both, outEdges(both, x).find((e) => e.to === y)!.id)
    expect(loose(cut, end).map((n) => n.id)).toEqual([y])
  })

  it('keeps the end it was given, even when a middle step loses its last arrow', () => {
    const { wf: blank, end } = fresh()
    const [wf, x] = addStep(blank, end)
    const cut = unlink(wf, outEdges(wf, x)[0].id)
    expect(isMiddle(cut, end, x)).toBe(true)
    expect(loose(cut, end).map((n) => n.id)).toContain(x)
  })
})
