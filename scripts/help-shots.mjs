// Takes the help page's screenshots, frontend/src/help/{zh,en}/<topic>.jpg, from the mock build served at the URL given
// (scripts/help-shots.sh builds and serves it). Every shot is the whole 1280x800 window, at noon, in the language of its
// folder. A topic's name after the URL takes only that one, in both languages.
//
//   node scripts/help-shots.mjs http://localhost:5199/ [topic...]

import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(join(process.env.SHOTS_TOOLS, 'package.json'))
const { chromium } = require('playwright-core')

const [url, ...only] = process.argv.slice(2)
const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'frontend', 'src', 'help')

// the map's labels: the airport, Acme Store, Product Docs
const label = (n) => `button.label >> nth=${n}`
// a drawer's tabs, by place: the airport's are chats, providers, blueprints, flows, sources, usage, settings, about;
// a company's are chats, tasks, employees, files, terminal, settings
const tab = (n) => `.fx-tabs button >> nth=${n}`
const airport = (n) => [label(0), tab(n)]
const acme = (n) => [label(1), tab(n)]

/** Each topic: what to click, in turn; a step may instead type, leave the pointer somewhere, or scroll what is under it. */
const SCENES = {
  start: [],
  map: ['.fx-corner-text >> nth=1', label(1), { move: [300, 560] }],
  airport: [label(0)],
  company: acme(1),
  airchat: [...airport(0), '.fx-row >> nth=0', { wheel: [300, 300, -2000] }],
  provider: [...airport(1), '.fx-row >> nth=0'],
  blueprint: [...airport(2), '.fx-row >> nth=0'],
  flow: [...airport(3), '.fx-flow-open >> nth=1', '.fx-tool >> nth=0'],
  sources: [...airport(4), '.fx-row >> nth=1'],
  stats: airport(5),
  settings: airport(6),
  about: airport(7),
  chat: [...acme(0), '.fx-row >> nth=0', { wheel: [300, 300, -2000] }],
  // #2, its steps done and waiting to be merged
  task: [...acme(1), '.fx-lane >> nth=2 >> .fx-task >> nth=1'],
  reply: [label(2), tab(1), '.fx-lane .fx-task >> nth=1', '.fx-row >> nth=1'],
  crew: acme(2),
  files: [...acme(3), 'text=src', 'text=components', 'text=Menu.tsx'],
  terminal: [...acme(4), '.fx-terminal-xterm', { type: 'git status\n' }, { type: 'ls\n' }],
  teamset: acme(5),
}

const browser = await chromium.launch({ args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] })
const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2, timezoneId: 'Asia/Taipei' })
const scratch = mkdtempSync(join(tmpdir(), 'help-shots-'))
let failed = 0
try {
  for (const language of ['zh', 'en']) {
    for (const [topic, steps] of Object.entries(SCENES)) {
      if (only.length && !only.includes(topic)) continue
      const page = await context.newPage()
      try {
        // noon by the default daylight, a Minecraft day, and the same clock on every shot
        await page.clock.setFixedTime(new Date('2026-11-05T10:05:00+08:00'))
        await page.goto(url)
        // the plane that brings the camera in has landed, and the controls it took off the screen are back
        await page.waitForSelector('.fusion-stage:not([data-away])', { timeout: 30000 })
        await page.waitForTimeout(3000)
        if (language === 'en') {
          await page.click('[aria-label="語言"]')
          await page.click('button:has-text("English")')
          await page.waitForTimeout(1500)
        }
        await page.mouse.move(1279, 799)
        for (const step of steps) {
          if (typeof step === 'string') await page.locator(step).first().click()
          else if (step.type) await page.keyboard.type(step.type)
          if (step.wheel) {
            const [x, y, dy] = step.wheel
            await page.mouse.move(x, y)
            await page.mouse.wheel(0, dy)
          }
          if (step.move) await page.mouse.move(...step.move, { steps: 5 })
          else if (typeof step === 'string') await page.mouse.move(1279, 799)
          await page.waitForTimeout(1500)
        }
        await page.waitForTimeout(1000)
        const png = join(scratch, `${language}-${topic}.png`)
        await page.screenshot({ path: png })
        const jpg = join(out, language, `${topic}.jpg`)
        execFileSync('sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', '70', '--resampleWidth', '1280', png, '--out', jpg], { stdio: 'ignore' })
        console.log(`${language}/${topic}.jpg`)
      } catch (e) {
        failed++
        console.error(`${language}/${topic}: ${e.message.split('\n')[0]}`)
      } finally {
        await page.close()
      }
    }
  }
} finally {
  await browser.close()
  rmSync(scratch, { recursive: true, force: true })
}
process.exit(failed ? 1 : 0)
