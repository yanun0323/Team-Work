// For tests: watching a crowd step by step for the two ways it can get stuck: two on top of each other for a while,
// and someone on their way somewhere going nowhere.

export interface Seen {
  x: number
  z: number
  /** Visible body, including seated people and fading figures. */
  solid: boolean
  /** On their way somewhere. */
  walking: boolean
}

export function stuckCheck(near: number, still: number) {
  const together = new Map<string, number>()
  const held = new Map<number, { x: number; z: number; t: number }>()
  let previous: Seen[] = []
  let minimum = Infinity
  let overlap = 0
  let frozen = 0
  return {
    /** Everyone, in the same order each step, `dt` seconds on. */
    step(people: Seen[], dt: number) {
      for (let i = 0; i < people.length; i++) {
        const a = people[i]
        for (let j = i + 1; j < people.length; j++) {
          const b = people[j]
          const key = `${i}-${j}`
          if (a.solid && b.solid) {
            let distance = Math.hypot(a.x - b.x, a.z - b.z)
            const pa = previous[i], pb = previous[j]
            if (pa?.solid && pb?.solid) {
              const rx = pa.x - pb.x, rz = pa.z - pb.z
              const dx = a.x - b.x - rx, dz = a.z - b.z - rz
              const t = Math.max(0, Math.min(1, -(rx * dx + rz * dz) / (dx * dx + dz * dz || 1)))
              distance = Math.min(distance, Math.hypot(rx + dx * t, rz + dz * t))
            }
            minimum = Math.min(minimum, distance)
          }
          if (!a.solid || !b.solid || Math.hypot(a.x - b.x, a.z - b.z) >= near) together.delete(key)
          else {
            const t = (together.get(key) ?? 0) + dt
            together.set(key, t)
            overlap = Math.max(overlap, t)
          }
        }
        const h = held.get(i)
        if (!a.walking) held.delete(i)
        else if (!h || Math.hypot(a.x - h.x, a.z - h.z) > still) held.set(i, { x: a.x, z: a.z, t: 0 })
        else frozen = Math.max(frozen, (h.t += dt))
      }
      previous = people.map((p) => ({ ...p }))
    },
    /** Closest visible body centres, including interpolation between frames. */
    get minimum() { return minimum },
    /** The longest any two stayed closer than `near`, in seconds. */
    get overlap() {
      return overlap
    },
    /** The longest anyone on their way somewhere stayed within `still` of one spot, in seconds. */
    get frozen() {
      return frozen
    },
  }
}
