import { afterEach, describe, expect, it } from 'vitest'
import { allKeysForTest, colon, listOf, setAppLanguage, tr } from './i18n'

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

  it('answers in Simplified Chinese, Japanese and Korean, without the tag', () => {
    setAppLanguage('zh-Hans')
    expect(tr('編輯 {name}', { name: 'Ada' })).toBe('编辑 Ada')
    expect(tr('完成#button')).toBe('完成')
    setAppLanguage('ja')
    expect(tr('取消')).toBe('キャンセル')
    expect(tr('任務#tab')).toBe('タスク')
    setAppLanguage('ko')
    expect(tr('取消')).toBe('취소')
    expect(tr('{attempts} 次', { attempts: 3 })).toBe('3회')
  })

  it('has every key in every language, with every value filled in', () => {
    for (const language of ['zh-Hans', 'ja', 'ko'] as const) {
      setAppLanguage(language)
      for (const key of allKeysForTest()) {
        const args = Object.fromEntries(holes(key).map((h) => [h.slice(1, -1), `<${h.slice(1, -1)}>`]))
        const text = tr(key, args)
        expect(text.trim(), `${language} ${key}`).not.toBe('')
        expect(text, `${language} ${key}`).not.toMatch(/#[a-z]+$/)
        if (language === 'ko') expect(text, key).not.toMatch(/[一-鿿]/)
        for (const name of Object.keys(args)) expect(text, `${language} ${key}`).toContain(`<${name}>`)
      }
    }
  })

  it('writes lists and colons as each language does', () => {
    for (const [language, list, colonMark] of [['zh', '甲、乙', '：'], ['zh-Hans', '甲、乙', '：'], ['ja', '甲、乙', '：'], ['en', '甲, 乙', ': '], ['ko', '甲, 乙', ': ']] as const) {
      setAppLanguage(language)
      expect(listOf(['甲', '乙'])).toBe(list)
      expect(colon()).toBe(colonMark)
    }
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
