// Reading a GitHub repo out of what the user types or pastes: `owner/repo`, or any github.com address,
// which may also carry a branch, tag or commit.

const NAME = /^[\w.-]+$/

/**
 * `owner/repo` and the version named in the address (empty when there is none), or null when it is not a
 * GitHub repo. Branches with slashes in them are kept whole: `/tree/feature/login` is `feature/login`.
 */
export function parseGithub(input: string): { repo: string; ref: string } | null {
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
  if (kind === 'tree' || kind === 'commit') ref = rest.join('/')
  // a file: the version is the first part of its path (a branch with slashes can't be told apart here)
  else if (kind === 'blob') ref = rest[0] ?? ''
  else if (kind === 'releases' && rest[0] === 'tag') ref = rest.slice(1).join('/')
  else if (kind !== undefined) return null
  return { repo: `${owner}/${repo}`, ref: decodeURIComponent(ref) }
}
