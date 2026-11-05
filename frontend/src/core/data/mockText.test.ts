import { expect, it } from 'vitest'
import { hasMockText, missedForTest, mockText } from './mockText'
import { seedWorld } from './seed'
import { tick } from '../domain/sim'
import CONTENT from '../domain/content.ts?raw'
import SIM from '../domain/sim.ts?raw'
import SEED from './seed.ts?raw'

const FILES = { 'content.ts': CONTENT, 'sim.ts': SIM, 'seed.ts': SEED }

it('has every Chinese text the sample world writes in the other languages', () => {
  for (const [file, src] of Object.entries(FILES)) {
    for (const [, text] of src.matchAll(/'((?:[^'\\\n]|\\.)*)'/g)) {
      const zh = text.replace(/\\n/g, '\n').replace(/\\'/g, "'")
      if (/\p{Script=Han}/u.test(zh)) expect(hasMockText(zh), `${file}: ${zh}`).toBe(true)
    }
  }
})

it('writes the sample world in each language with nothing left untranslated', () => {
  for (const language of ['zh-Hans', 'ja', 'ko'] as const) {
    const w = seedWorld(language)
    for (let i = 0; i < 400; i++) tick(w, 1)
    if (language === 'ko') expect(Object.values(w.tasks).map((t) => t.title).join(' ')).not.toMatch(/\p{Script=Han}/u)
  }
  expect(missedForTest()).toEqual([])
})

it('keeps text with no Chinese and falls back to English for one it does not know', () => {
  expect(mockText('ja', ['tool', '本週內'], ['tool', 'This week'])).toEqual(['tool', '今週中'])
  expect(mockText('ko', '不在表裡的字', 'Not in the table')).toBe('Not in the table')
  expect(mockText('en', '本週內', 'This week')).toBe('This week')
  expect(mockText('zh', '本週內', 'This week')).toBe('本週內')
})
