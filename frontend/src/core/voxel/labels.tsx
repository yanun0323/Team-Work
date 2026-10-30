// HTML labels pinned to 3D points. One DOM layer outside the canvas, moved every frame,
// instead of a React root per label.

import { useFrame, useThree } from '@react-three/fiber'
import { useMemo, type ReactNode } from 'react'
import * as THREE from 'three'

type V3 = [number, number, number]

/** Moving things (Replicas, boxes) write their current position here every frame. */
export const anchors = new Map<string, V3>()
const els = new Map<string, HTMLElement>()
const fixed = new Map<string, V3>()

export interface LabelSpec {
  id: string
  /** Fixed world position, or omit to follow `anchors.get(id)`. */
  at?: V3
  /** Styling hook; each design styles `.label-<tone>`. */
  tone: string
  text: ReactNode
  onClick?: () => void
}

export function LabelLayer({ labels }: { labels: LabelSpec[] }) {
  return (
    <div className="labels" aria-hidden={false}>
      {labels.map((l) => {
        const ref = (el: HTMLElement | null) => {
          if (el) {
            els.set(l.id, el)
            if (l.at) fixed.set(l.id, l.at)
            else fixed.delete(l.id)
          } else {
            els.delete(l.id)
            fixed.delete(l.id)
          }
        }
        const cls = `label-${l.tone}`
        return l.onClick ? (
          <button key={l.id} ref={ref} type="button" className={`label ${cls}`} onClick={l.onClick}>{l.text}</button>
        ) : (
          <div key={l.id} ref={ref} className={`label ${cls}`}>{l.text}</div>
        )
      })}
    </div>
  )
}

/** Lives inside the canvas and moves every label to its projected screen point. */
export function LabelProjector() {
  const { camera, size } = useThree()
  const v = useMemo(() => new THREE.Vector3(), [])
  useFrame(() => {
    for (const [id, el] of els) {
      const p = fixed.get(id) ?? anchors.get(id)
      if (!p) {
        el.style.visibility = 'hidden'
        continue
      }
      v.set(p[0], p[1], p[2]).project(camera)
      if (v.z > 1) {
        el.style.visibility = 'hidden'
        continue
      }
      const x = ((v.x + 1) / 2) * size.width
      const y = ((1 - v.y) / 2) * size.height
      el.style.visibility = 'visible'
      el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) translate(-50%, -50%)`
    }
  })
  return null
}
