import { afterEach, describe, expect, it } from 'vitest'
import { allKeysForTest, setAppLanguage, tr } from './i18n'

afterEach(() => setAppLanguage('zh'))

const holes = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort()

describe('tr', () => {
  it('answers in the language set, and shows a tagged key without its tag in Chinese', () => {
    expect(tr('取消')).toBe('取消')
    expect(tr('編輯 {name}', { name: 'Ada' })).toBe('編輯 Ada')
    expect(tr('完成#button')).toBe('完成')
    expect(tr('編輯 #{number}', { number: 7 })).toBe('編輯 #7')
    expect(tr('# 選檔案')).toBe('# 選檔案')
    setAppLanguage('en')
    expect(tr('取消')).toBe('Cancel')
    expect(tr('編輯 {name}', { name: 'Ada' })).toBe('Edit Ada')
    expect(tr('完成#button')).toBe('Done')
  })

  it('counts in English', () => {
    setAppLanguage('en')
    expect(tr('{length} 個步驟', { length: 1 })).toBe('1 step')
    expect(tr('{length} 個步驟', { length: 2 })).toBe('2 steps')
  })

  it('has English for every key, with every value filled in', () => {
    setAppLanguage('en')
    for (const key of allKeysForTest()) {
      const args = Object.fromEntries(holes(key).map((h) => [h.slice(1, -1), `<${h.slice(1, -1)}>`]))
      const text = tr(key, args)
      expect(text, key).not.toMatch(/[一-鿿]/)
      for (const name of Object.keys(args)) expect(text, key).toContain(`<${name}>`)
    }
  })
})
