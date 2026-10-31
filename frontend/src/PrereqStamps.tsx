// The stamps over a tab of the company file saying what its work is still missing.

import { useEffect, useState } from 'react'
import { request } from './core/backend'
import { MOCK } from './core/mode'
import { useStore } from './core/store'
import { prereqsOf, type Prereq, type PrereqTab, type ProjectHealth } from './prereqs'

/** The company's folder as it is now, asked again each time the window comes back, as it changes outside the app. */
function useProjectHealth(teamId: string) {
  const [health, setHealth] = useState<ProjectHealth | null>(null)
  // a target branch just picked may be the fix
  const target = useStore((s) => s.world.teams[teamId]?.targetBranch)
  useEffect(() => {
    if (MOCK) return
    const asking = new AbortController()
    // not knowing is not a problem to report: the connection has its own message
    const ask = () => void request<ProjectHealth>('GET', `/teams/${teamId}/health`, undefined, asking.signal).then(setHealth, () => {})
    ask()
    window.addEventListener('focus', ask)
    return () => {
      asking.abort()
      window.removeEventListener('focus', ask)
    }
  }, [teamId, target])
  return health
}

export function usePrereqs(teamId: string, tab: PrereqTab): Prereq[] {
  const health = useProjectHealth(teamId)
  const w = useStore((s) => s.world)
  return prereqsOf(w, teamId, tab, health)
}

export function Prereqs({ list }: { list: Prereq[] }) {
  return (
    <div role="status" className="fx-prereqs">
      {list.map((x) => <p key={x.id} className="fx-pill fx-prereq">{x.text}</p>)}
    </div>
  )
}
