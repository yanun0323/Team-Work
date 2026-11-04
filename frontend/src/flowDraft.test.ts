import { describe, expect, it } from 'vitest'
import { outEdges } from './core/domain/graph'
import { addStep, blankFlow, branchStep, canLink, insertStep, link, nextChoices, removeStep, unlink } from './flowDraft'

const fresh = () => {
  const wf = blankFlow()
  return { wf, first: wf.nodes[0].id }
}
const nodeIn = (wf: ReturnType<typeof blankFlow>, id: string) => wf.nodes.find((n) => n.id === id)!

describe('flow draft', () => {
  it('starts with one blank step, which may not be removed while it is the only one', () => {
    const { wf, first } = fresh()
    expect(wf.nodes.map((n) => n.name)).toEqual(['新步驟1'])
    expect(wf.edges).toEqual([])
    expect(removeStep(wf, first)).toBe(wf)
  })

  it('adds a step after the only last step, and removing it leaves the rest as it was', () => {
    const { wf: blank, first } = fresh()
    const [wf, id] = addStep(blank)
    expect(outEdges(wf, first).map((e) => e.to)).toEqual([id])
    const back = removeStep(wf, id)
    expect(back.nodes.map((n) => n.id)).toEqual([first])
    expect(back.edges).toEqual([])
  })

  it('adds a step on its own, a new start, when the flow has several last steps', () => {
    const { wf: blank, first } = fresh()
    const [a] = addStep(blank)
    const [b] = branchStep(a, first)
    const [wf, id] = addStep(b)
    expect(wf.edges.some((e) => e.to === id || e.from === id)).toBe(false)
    expect(nodeIn(wf, id).sendBack).toBeUndefined()
  })

  it('numbers new steps 新步驟1, 新步驟2…, taking the first number not in use', () => {
    const { wf: blank, first } = fresh()
    const [a, x] = addStep(blank)
    const [b, y] = branchStep(a, first)
    const [c] = insertStep(b, b.edges[0].id)
    expect([nodeIn(c, x).name, nodeIn(c, y).name, c.nodes.at(-1)!.name]).toEqual(['新步驟2', '新步驟3', '新步驟4'])
    // removed, a number is free again
    const [d, z] = addStep(removeStep(c, y))
    expect(nodeIn(d, z).name).toBe('新步驟3')
  })

  it('switches send-back on for a new last step that may send back, and off for one in the middle', () => {
    const { wf: blank, first } = fresh()
    const [a, x] = addStep(blank)
    expect(nodeIn(a, x).sendBack).toBe(true)
    const [b, y] = insertStep(a, outEdges(a, first)[0].id)
    expect(nodeIn(b, y).sendBack).toBe(false)
    // first hands on to two, so neither may send back to it
    const [c, z] = branchStep(a, first)
    expect(nodeIn(c, z).sendBack).toBe(false)
  })

  it('draws arrows only where they may go, and takes them away', () => {
    const { wf: blank, first } = fresh()
    const [a, x] = addStep(blank)
    const [wf, y] = addStep(a)
    // first → x → y
    expect(canLink(wf, first, y)).toBe(true)
    expect(canLink(wf, y, first)).toBe(false) // a loop
    expect(canLink(wf, x, x)).toBe(false) // itself
    expect(canLink(wf, first, x)).toBe(false) // already there
    expect(nextChoices(wf, y).map((n) => n.id)).not.toContain(x)
    const both = link(wf, first, y)
    expect(outEdges(both, first).map((e) => e.to).sort()).toEqual([x, y].sort())
    expect(link(wf, y, first)).toBe(wf)
    const cut = unlink(both, outEdges(both, x)[0].id)
    expect(outEdges(cut, x)).toEqual([])
  })
})
