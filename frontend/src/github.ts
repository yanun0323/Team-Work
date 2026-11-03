// Reading a GitHub repo out of what the user types or pastes: `owner/repo`, or any github.com address,
// which may also carry a branch, tag or commit.

const NAME = /^[\w.-]+$/

/**
 * `owner/repo`, the version named in the address and the folder in it (each empty when there is none), or null
 * when it is not a GitHub repo. A `/tree/` address can't tell a branch with slashes from a folder, so the first
 * part is the version and the rest the folder: `/tree/main/pstack` is `main` and `pstack`.
 */
export function parseGithub(input: string): { repo: string; ref: string; path: string; ssh: boolean } | null {
  let s = input.trim()
  const ssh = s.match(/^git@github\.com:(.+)$/)
  if (ssh) s = ssh[1]
  else if (/^(https?:\/\/)?(www\.)?github\.com\//i.test(s)) s = s.replace(/^(https?:\/\/)?(www\.)?github\.com\//i, '')
  else if (s.includes(':') || s.startsWith('/')) return null
  s = s.replace(/[?#].*$/, '').replace(/\/+$/, '')
  const [owner, rawRepo, kind, ...rest] = s.split('/')
  const repo = rawRepo?.replace(/\.git$/, '')
  if (!owner || !repo || !NAME.test(owner) || !NAME.test(repo)) return null
  let ref = ''
  let path = ''
  if (kind === 'tree' || kind === 'commit') {
    ref = rest[0] ?? ''
    path = rest.slice(1).join('/')
  }
  // a file: the version is the first part of its path (a branch with slashes can't be told apart here)
  else if (kind === 'blob') ref = rest[0] ?? ''
  else if (kind === 'releases' && rest[0] === 'tag') ref = rest.slice(1).join('/')
  else if (kind !== undefined) return null
  return { repo: `${owner}/${repo}`, ref: decodeURIComponent(ref), path: decodeURIComponent(path), ssh: !!ssh }
}

/** The version and folder of an address read as one version, for a place that has no folder. */
export const wholeRef = (g: { ref: string; path: string }) => [g.ref, g.path].filter(Boolean).join('/')

/** A folder in a repo as kept: no slashes around it, empty for the whole repo. */
export const repoPath = (text: string) => text.trim().replace(/^\/+|\/+$/g, '')

const HTTPS = 'https://github.com/'

/** The address Git reads: SSH only when an SSH address was pasted, HTTPS otherwise. */
export const githubAddress = (g: { repo: string; ssh: boolean }) => (g.ssh ? `git@github.com:${g.repo}` : `${HTTPS}${g.repo}`)

/** How an address is shown and typed: `owner/repo` for HTTPS, an SSH address in full so it stays SSH. */
export const shortRepo = (address: string) => (address.startsWith(HTTPS) ? address.slice(HTTPS.length) : address)
