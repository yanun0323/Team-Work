// Who a chat is with, in the room one face takes. A meeting fans out its first three like a hand of cards held at the
// bottom: the chair in front, upright, the next two behind, turned one each way about the same bottom middle, so
// their tops peek out; the deeper, the darker. How many more there are is not told: only that it is more than one.

import type { Look } from './core/domain/types'
import { PixelFace } from './core/voxel/PixelFace'

/** How far the cards behind the chair are turned from it, the nearest first. */
const UNDER = [-12, 12]

/**
 * Each card is as big as one face alone would be. Where one alone sits on a paper card (`card`: the list and the
 * chat's head), so does the chair, lying as one alone does.
 */
export function ChatFaces({ people, size, card }: { people: { id: string; name: string; look: Look }[]; size: number; card?: boolean }) {
  const [chair] = people
  if (!chair) return null
  if (people.length < 2) return <PixelFace look={chair.look} name={chair.name} size={size} />
  const box = card ? size + 6 : size
  return (
    <span className={`fx-faces-stack${card ? ' fx-faces-card' : ''}`} style={{ width: box, height: box }}
      role="img" aria-label={people.map((p) => p.name).join('、')}>
      {/* the deepest first, so the nearest lies over it */}
      {people.slice(1, 1 + UNDER.length).map((p, i) => (
        <span key={p.id} className={`fx-faces-one fx-faces-under fx-faces-under-${i + 1}`} style={{ ['--turn' as string]: `${UNDER[i]}deg` }} aria-hidden="true">
          <PixelFace look={p.look} name={p.name} size={size} />
        </span>
      )).reverse()}
      <span className="fx-faces-one fx-faces-chair" aria-hidden="true"><PixelFace look={chair.look} name={chair.name} size={size} /></span>
    </span>
  )
}
