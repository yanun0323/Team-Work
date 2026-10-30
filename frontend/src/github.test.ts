import { expect, it } from 'vitest'
import { parseGithub } from './github'

it('reads owner/repo and the version from what is typed or pasted', () => {
  const cases: [string, { repo: string; ref: string } | null][] = [
    ['acme/release-bot', { repo: 'acme/release-bot', ref: '' }],
    ['  acme/release-bot.git ', { repo: 'acme/release-bot', ref: '' }],
    ['https://github.com/acme/release-bot', { repo: 'acme/release-bot', ref: '' }],
    ['github.com/acme/release-bot/', { repo: 'acme/release-bot', ref: '' }],
    ['https://github.com/acme/release-bot.git', { repo: 'acme/release-bot', ref: '' }],
    ['git@github.com:acme/release-bot.git', { repo: 'acme/release-bot', ref: '' }],
    ['https://github.com/acme/release-bot/tree/develop', { repo: 'acme/release-bot', ref: 'develop' }],
    ['https://github.com/acme/release-bot/tree/feature/login?x=1#readme', { repo: 'acme/release-bot', ref: 'feature/login' }],
    ['https://github.com/acme/release-bot/commit/4f2a9c1e', { repo: 'acme/release-bot', ref: '4f2a9c1e' }],
    ['https://github.com/acme/release-bot/blob/v1.2.0/AGENTS.md', { repo: 'acme/release-bot', ref: 'v1.2.0' }],
    ['https://github.com/acme/release-bot/releases/tag/v2.0.0', { repo: 'acme/release-bot', ref: 'v2.0.0' }],
    ['acme', null],
    ['https://gitlab.com/acme/release-bot', null],
    ['https://github.com/acme/release-bot/issues/3', null],
    ['acme/release bot', null],
    ['', null],
  ]
  for (const [input, want] of cases) expect(parseGithub(input), input).toEqual(want)
})
