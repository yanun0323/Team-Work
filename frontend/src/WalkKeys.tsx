// W, A, S and D in the lower left corner while the user can walk their figure (walkByHand.ts): lit while held, on the
// keyboard or here, pressed and held with the pointer.

import { held, tap, useWalk, type WalkKey } from './walkByHand'

export function WalkKeys() {
  const walk = useWalk()
  const lit = (k: WalkKey) => held(walk, k)
  const key = (k: WalkKey) => (
    <button key={k} type="button" tabIndex={-1} className="fx-walk-key" data-lit={lit(k) || undefined}
      // held with the pointer, without taking the focus from wherever it is
      onPointerDown={(e) => {
        e.preventDefault()
        e.currentTarget.setPointerCapture(e.pointerId)
        tap(k, true)
      }}
      onPointerUp={() => tap(k, false)} onPointerCancel={() => tap(k, false)} onLostPointerCapture={() => tap(k, false)}>
      {k.toUpperCase()}
    </button>
  )
  return (
    // the keyboard's own keys do what these do
    <div className="fx-walk-keys" aria-hidden="true" data-idle={(['w', 'a', 's', 'd'] as const).some(lit) ? undefined : ''} data-typing={walk.typing ? '' : undefined}>
      <div>{key('w')}</div>
      <div>{key('a')}{key('s')}{key('d')}</div>
    </div>
  )
}
