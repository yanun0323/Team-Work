import { expect, it } from 'vitest'
import { githubAddress, parseGithub, shortRepo } from './github'

it('reads owner/repo and the version from what is typed or pasted', () => {
  const cases: [string, { repo: string; ref: string; path: string; ssh: boolean } | null][] = [
    ['acme/release-bot', { repo: 'acme/release-bot', ref: '', path: '', ssh: false }],
    ['  acme/release-bot.git ', { repo: 'acme/release-bot', ref: '', path: '', ssh: false }],
    ['https://github.com/acme/release-bot', { repo: 'acme/release-bot', ref: '', path: '', ssh: false }],
    ['github.com/acme/release-bot/', { repo: 'acme/release-bot', ref: '', path: '', ssh: false }],
    ['https://github.com/acme/release-bot.git', { repo: 'acme/release-bot', ref: '', path: '', ssh: false }],
    ['git@github.com:acme/release-bot.git', { repo: 'acme/release-bot', ref: '', path: '', ssh: true }],
    ['https://github.com/acme/release-bot/tree/develop', { repo: 'acme/release-bot', ref: 'develop', path: '', ssh: false }],
    ['https://github.com/acme/release-bot/tree/main/pstack?x=1#readme', { repo: 'acme/release-bot', ref: 'main', path: 'pstack', ssh: false }],
    ['https://github.com/cursor/plugins/tree/main/pstack/skills/', { repo: 'cursor/plugins', ref: 'main', path: 'pstack/skills', ssh: false }],
    ['https://github.com/acme/release-bot/commit/4f2a9c1e', { repo: 'acme/release-bot', ref: '4f2a9c1e', path: '', ssh: false }],
    ['https://github.com/acme/release-bot/blob/v1.2.0/AGENTS.md', { repo: 'acme/release-bot', ref: 'v1.2.0', path: '', ssh: false }],
    ['https://github.com/acme/release-bot/releases/tag/v2.0.0', { repo: 'acme/release-bot', ref: 'v2.0.0', path: '', ssh: false }],
    ['acme', null],
    ['https://gitlab.com/acme/release-bot', null],
    ['https://github.com/acme/release-bot/issues/3', null],
    ['acme/release bot', null],
    ['', null],
  ]
  for (const [input, want] of cases) expect(parseGithub(input), input).toEqual(want)
})

it('reads Git over HTTPS unless an SSH address was pasted', () => {
  const address = (input: string) => githubAddress(parseGithub(input)!)
  expect(address('mattpocock/skills')).toBe('https://github.com/mattpocock/skills')
  expect(address('https://github.com/mattpocock/skills/tree/main')).toBe('https://github.com/mattpocock/skills')
  expect(address('git@github.com:mattpocock/skills')).toBe('git@github.com:mattpocock/skills')
  // what the form shows keeps an SSH address whole, so saving it again stays SSH
  expect(shortRepo('https://github.com/mattpocock/skills')).toBe('mattpocock/skills')
  expect(shortRepo('git@github.com:mattpocock/skills')).toBe('git@github.com:mattpocock/skills')
})
