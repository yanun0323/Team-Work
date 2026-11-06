import { describe, expect, it } from 'vitest'
import { folded, numbered, paired, tally, type DiffLine } from './diffView'

const same = (text: string): DiffLine => ({ op: 'same', text })
const add = (text: string): DiffLine => ({ op: 'add', text })
const del = (text: string): DiffLine => ({ op: 'del', text })
const many = (n: number, from = 0) => Array.from({ length: n }, (_, i) => same(`s${from + i}`))

describe('diffView', () => {
  it('counts what was added and removed', () => {
    expect(tally([same('a'), del('b'), add('B'), add('c')])).toEqual({ added: 2, removed: 1 })
  })

  it('numbers each line in the old file and the new one', () => {
    const got = numbered([same('a'), del('b'), add('B'), add('c'), same('d')])
    expect(got.map((l) => [l.old, l.new])).toEqual([[1, 1], [2, undefined], [undefined, 2], [undefined, 3], [3, 4]])
  })

  it('folds long unchanged runs, keeping three lines next to each change', () => {
    const lines = numbered([...many(10), add('x'), ...many(10, 10), del('y'), ...many(10, 20)])
    const pieces = folded(lines)
    expect(pieces.map((p) => [p.fold, p.lines.length])).toEqual([[true, 7], [false, 7], [true, 4], [false, 7], [true, 7]])
    // nothing is lost: the pieces put back together are the file
    expect(pieces.flatMap((p) => p.lines)).toEqual(lines)
  })

  it('leaves a run that would hide only a few lines open', () => {
    const pieces = folded(numbered([...many(3), add('x'), ...many(9), del('y')]))
    expect(pieces).toHaveLength(1)
    expect(pieces[0].fold).toBe(false)
  })

  it('folds a file with no change into one piece', () => {
    expect(folded(numbered(many(20))).map((p) => [p.fold, p.lines.length])).toEqual([[true, 20]])
  })

  it('pairs each run of deletions with the additions after it', () => {
    const rows = paired(numbered([same('a'), del('b'), del('c'), add('B'), same('d'), add('e')]))
    expect(rows.map((r) => [r.left?.text, r.right?.text])).toEqual([
      ['a', 'a'], ['b', 'B'], ['c', undefined], ['d', 'd'], [undefined, 'e'],
    ])
  })
})
