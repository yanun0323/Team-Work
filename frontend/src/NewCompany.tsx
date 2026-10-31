// Founding a company: the player first puts a plot anywhere on the map (out at sea too: the land grows to
// it), then fills in the company on a sheet over the right half, like a company file. Its building stands
// on the plot meanwhile, in a look rolled at random; the die on the sheet rolls another. Spots the player
// picked are pinned here, so the town keeps its shape as it grows.

import { useFrame, useThree } from '@react-three/fiber'
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import * as THREE from 'three'
import { create } from 'zustand'
import { createTeam } from './core/domain/sim'
import { Select } from './Controls'
import { BuildingIcon } from './Drawer'
import { Reroll } from './DrawerDetail'
import { persist } from 'zustand/middleware'
import { MOCK } from './core/mode'
import { branchesOf } from './core/ops'
import { canPlace, CELL, landGained, PLOT_CELLS, spotCenter, spotUnder, type BuildingLook, type BuildingStyle, type Spot, type Town } from './layout'
import { NO_OUTLINE_LAYER } from './PixelPass'
import { pickFolder } from './pickFolder'
import { useStore } from './core/store'

/** Fake file system: these folders already have a git repo, with these branches. */
const KNOWN_REPOS: Record<string, string[]> = {
  '~/code/mobile-app': ['main', 'develop'],
  '~/code/landing-page': ['main'],
  '~/code/acme-shop': ['main', 'develop', 'release/2.3'],
}

/** Company id → its spot in town cells and its building's look, for companies whose place is settled. */
type Plots = Record<string, { at: Spot; style: BuildingStyle; seed: number }>
// the map is this browser's, not the backend's, so with real companies it is kept here
export const usePlots = MOCK ? create<Plots>(() => ({})) : create<Plots>()(persist(() => ({}), { name: 'mho-plots' }))

/** A press that moved further than this, in pixels, was a pan, not a click. */
const CLICK_SLOP = 5
const GROUND = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0)

/**
 * A plot outline that follows the pointer over the map, snapped to the cells; a click puts it there. Where it
 * can't go (too close to another plot, or too far out at sea) it turns red. Once `picked`, it stays there.
 */
export function Placer({ town, picked, onPick, moved, can = (s) => canPlace(town, s) }: {
  town: Town
  picked: Spot | null
  onPick: (s: Spot) => void
  /** The company being moved, whose old land won't count. */
  moved?: string
  /** Whether a plot may go there; a new company's rules unless given (moving one has its own). */
  can?: (s: Spot) => boolean
}) {
  const camera = useThree((s) => s.camera)
  const gl = useThree((s) => s.gl)
  const [spot, setSpot] = useState<Spot | null>(null)
  // the pointer, in canvas pixels; the spot under it is worked out every frame, as the map pans under it too
  const pointer = useRef<[number, number] | null>(null)
  const ray = useMemo(() => new THREE.Raycaster(), [])
  const under = (cx: number, cy: number): Spot | null => {
    const r = gl.domElement.getBoundingClientRect()
    ray.setFromCamera(new THREE.Vector2(((cx - r.left) / r.width) * 2 - 1, -((cy - r.top) / r.height) * 2 + 1), camera)
    const hit = ray.ray.intersectPlane(GROUND, new THREE.Vector3())
    return hit ? spotUnder(hit.x, hit.z) : null
  }
  const pick = useRef(onPick)
  pick.current = onPick
  const allowed = useRef(can)
  allowed.current = can

  useEffect(() => {
    if (picked) return
    const el = gl.domElement
    let down: [number, number] | null = null
    const move = (e: PointerEvent) => void (pointer.current = [e.clientX, e.clientY])
    const leave = () => void (pointer.current = null)
    const press = (e: PointerEvent) => void (down = [e.clientX, e.clientY])
    // a click that picks is used up here, before the map takes it as a click on nothing, which closes things
    const click = (e: MouseEvent) => {
      if (!down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > CLICK_SLOP || e.target !== el) return
      down = null
      const s = under(e.clientX, e.clientY)
      if (!s || !allowed.current(s)) return
      e.stopPropagation()
      pick.current(s)
    }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerleave', leave)
    el.addEventListener('pointerdown', press)
    window.addEventListener('click', click, true)
    return () => {
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerleave', leave)
      el.removeEventListener('pointerdown', press)
      window.removeEventListener('click', click, true)
      pointer.current = null
      document.body.style.cursor = ''
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [picked, gl, camera, town])

  const shown = picked ?? spot
  const ok = !!picked || (!!shown && can(shown))
  useFrame(() => {
    if (picked) return
    const s = pointer.current ? under(...pointer.current) : null
    if (`${s}` !== `${spot}`) setSpot(s)
    // buildings set their own cursor on hover; this one wins while placing
    const cursor = s ? (can(s) ? 'pointer' : 'not-allowed') : ''
    if (document.body.style.cursor !== cursor) document.body.style.cursor = cursor
  })
  if (!shown) return null
  const [x, z] = spotCenter(shown)
  return (
    <>
      {ok && <LandPreview town={town} at={shown} moved={moved} />}
      <PlotOutline x={x} z={z} size={PLOT_CELLS * CELL} on={!!picked} bad={!ok} />
    </>
  )
}

/** The land a plot here would add out at sea, as a see-through sheet at ground level. */
function LandPreview({ town, at, moved }: { town: Town; at: Spot; moved?: string }) {
  const fill = useRef<THREE.MeshBasicMaterial>(null)
  const [ax, az] = at
  const geometry = useMemo(() => {
    const cells = landGained(town, [ax, az], moved)
    if (!cells.length) return null
    const position = new Float32Array(cells.length * 12)
    const index = new Uint32Array(cells.length * 6)
    cells.forEach(([x, z], i) => {
      const [x0, x1, z0, z1] = [x * CELL, (x + 1) * CELL, z * CELL, (z + 1) * CELL]
      position.set([x0, 0, z0, x0, 0, z1, x1, 0, z1, x1, 0, z0], i * 12)
      index.set([0, 1, 2, 0, 2, 3].map((v) => v + i * 4), i * 6)
    })
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(position, 3))
    g.setIndex(new THREE.BufferAttribute(index, 1))
    return g
  }, [town, ax, az, moved])
  useEffect(() => () => geometry?.dispose(), [geometry])
  useFrame(({ clock }) => {
    if (fill.current) fill.current.opacity = 0.55 + Math.sin(clock.elapsedTime * 3) * 0.08
  })
  if (!geometry) return null
  return (
    <mesh geometry={geometry} position-y={0.1} layers={NO_OUTLINE_LAYER} renderOrder={1} raycast={() => null}>
      <meshBasicMaterial ref={fill} color="#8fd16f" transparent opacity={0.55} depthWrite={false} />
    </mesh>
  )
}

const PAPER = '#f4efe2'
const INK = '#1f1d2b'
/** Dash length and gap along the outline, in world units. */
const DASH = 1.6

const BAD = '#e5484d'

function PlotOutline({ x, z, size, on, bad }: { x: number; z: number; size: number; on: boolean; bad: boolean }) {
  const fill = useRef<THREE.MeshBasicMaterial>(null)
  const dashes = useMemo(() => {
    const out: Array<{ p: [number, number, number]; s: [number, number, number] }> = []
    const h = size / 2 - 0.4
    for (let t = -h; t < h; t += DASH * 2) {
      const len = Math.min(DASH, h - t)
      const m = t + len / 2
      out.push({ p: [m, 0, -h], s: [len, 0.12, 0.5] }, { p: [m, 0, h], s: [len, 0.12, 0.5] })
      out.push({ p: [-h, 0, m], s: [0.5, 0.12, len] }, { p: [h, 0, m], s: [0.5, 0.12, len] })
    }
    return out
  }, [size])
  // the fill breathes a little until the plot is picked
  useFrame(({ clock }) => {
    if (!fill.current) return
    fill.current.opacity = on ? 0.62 : 0.4 + Math.sin(clock.elapsedTime * 3) * 0.08
  })
  return (
    <group position={[x, 0.2, z]}>
      <mesh rotation-x={-Math.PI / 2} layers={NO_OUTLINE_LAYER} renderOrder={2} raycast={() => null}>
        <planeGeometry args={[size - 0.4, size - 0.4]} />
        <meshBasicMaterial ref={fill} color={bad ? BAD : PAPER} transparent opacity={0.4} depthWrite={false} />
      </mesh>
      {dashes.map((d, i) => (
        <mesh key={i} position={d.p} layers={NO_OUTLINE_LAYER} renderOrder={3} raycast={() => null}>
          <boxGeometry args={d.s} />
          <meshBasicMaterial color={bad ? BAD : INK} />
        </mesh>
      ))}
    </group>
  )
}

const basename = (path: string) => path.split(/[/\\]/).filter(Boolean).pop() ?? ''

const STYLE_NAMES: Record<BuildingStyle, string> = {
  tower: '玻璃大樓', brick: '紅磚樓', studio: '工作室', loft: '工業倉庫', timber: '木屋', classic: '石造', tech: '科技大樓',
  pagoda: '東方樓閣', deco: '裝飾藝術', eco: '垂直森林', villa: '地中海別墅',
}

/** The sheet for the company itself: name, folder and target branch. Founding it hands back its id. */
export function NewCompanySheet({ leaving, onGone, onCreate, look, onReroll }: {
  leaving: boolean
  /** The building's look, shown on the plot; `onReroll` rolls another. */
  look: BuildingLook
  onReroll: () => void
  /** Called when the page has turned away. */
  onGone: () => void
  onCreate: (input: Parameters<typeof createTeam>[1]) => void
}) {
  const title = useRef<HTMLHeadingElement>(null)
  useEffect(() => title.current?.focus({ preventScroll: true }), [])
  const [name, setName] = useState('')
  const [named, setNamed] = useState(false)
  const [folder, setFolder] = useState('')
  const [branch, setBranch] = useState('main')
  const takeFolder = (path: string) => {
    setFolder(path)
    if (!named) setName(basename(path))
  }
  const [browsing, setBrowsing] = useState(false)
  const browse = async () => {
    setBrowsing(true)
    try {
      const picked = await pickFolder(folder)
      if (picked) takeFolder(picked)
    } catch (e) {
      useStore.getState().setFailure((e as Error).message)
    } finally {
      setBrowsing(false)
    }
  }
  // the real repo's branches, or the prototype's made-up ones; a folder without a repo starts on master
  const [found, setFound] = useState<string[] | null>(null)
  useEffect(() => {
    if (MOCK) return
    const ctl = new AbortController()
    const wait = window.setTimeout(() => {
      branchesOf(folder.trim(), ctl.signal).then((r) => setFound(r.repo && r.branches.length ? r.branches : null)).catch(() => setFound(null))
    }, 300)
    return () => { window.clearTimeout(wait); ctl.abort() }
  }, [folder])
  const known = MOCK ? KNOWN_REPOS[folder.trim()] : found ?? undefined
  const target = known ? (known.includes(branch) ? branch : known[0]) : branch.trim()
  const save = (e: FormEvent) => {
    e.preventDefault()
    onCreate({
      name: name.trim(), folder: folder.trim(), targetBranch: target,
      branches: known ?? [target], initializedGit: !known,
    })
  }
  return (
    <aside className={leaving ? 'fx-drawer leaving' : 'fx-drawer'} aria-labelledby="fx-new-company-title"
      aria-hidden={leaving || undefined} inert={leaving || undefined}
      onAnimationEnd={(e) => { if (leaving && e.target === e.currentTarget) onGone() }}>
      <span className="fx-tape fx-tape-l" aria-hidden="true" />
      <span className="fx-tape fx-tape-r" aria-hidden="true" />
      <div className="fx-sheet">
        <header className="fx-head fx-head-rule">
          <div className="fx-title fx-title-plain">
            <h1 id="fx-new-company-title" ref={title} tabIndex={-1}>新公司</h1>
          </div>
        </header>
        <form className="fx-page fx-d-form" onSubmit={save}>
          <div className="fx-fields">
            <div className="fx-field">
              <span>外觀</span>
              <div className="fx-look fx-look-building">
                <BuildingIcon look={look} />
                <span aria-live="polite">{STYLE_NAMES[look.style]}</span>
                <Reroll onClick={onReroll} label="隨機外觀" />
              </div>
            </div>
            <label className="fx-field">
              <span>專案位置</span>
              <span className="fx-path">
                <input className="fx-control" value={folder} required pattern=".*\S.*" title="專案位置不可為空"
                  placeholder="~/code/my-app" spellCheck={false} autoComplete="off"
                  onChange={(e) => takeFolder(e.target.value)} />
                <button type="button" className="fx-control fx-browse fx-hit" onClick={browse} disabled={browsing} aria-label="選擇資料夾" title="選擇資料夾">
                  <svg viewBox="0 0 16 16" width="18" height="18" aria-hidden="true">
                    <path d="M1.75 4.25v8.5h12.5v-7h-6.5l-1.5-1.5z" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
                  </svg>
                </button>
              </span>
            </label>
            <label className="fx-field">
              <span>名稱</span>
              <input className="fx-control" value={name} required pattern=".*\S.*" title="名稱不可為空"
                onChange={(e) => { setName(e.target.value); setNamed(true) }} />
            </label>
            {known ? (
              <Select label="目標分支" value={target} options={known} onChange={setBranch} />
            ) : (
              <label className="fx-field">
                <span>目標分支</span>
                <input className="fx-control" value={branch} required pattern=".*\S.*" title="目標分支不可為空"
                  spellCheck={false} autoComplete="off" onChange={(e) => setBranch(e.target.value)} />
              </label>
            )}
          </div>
          <button type="submit" className="fx-save">建立</button>
        </form>
      </div>
    </aside>
  )
}
