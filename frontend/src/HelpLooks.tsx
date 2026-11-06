// The help's galleries of looks: every building style, every piece of office furniture and every part a person is
// put together from, each on a sticky note with its picture and name. Pressing a note tapes a sheet over the help with it large and a line on what it is, as a
// drawer's detail sheets stack; a click on the help under it, Esc or a click on the map puts it away.
//
// The pictures are drawn by the same code as the map: one hidden canvas takes them one after another, in the
// map's pixel-art look, and they are kept for the rest of the session. The canvas goes away once all are taken.

import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { useEffect, useLayoutEffect, useMemo, useRef, useSyncExternalStore, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import * as THREE from 'three'
import { BuildingSample, FURNITURE, FurnitureSample, type Furniture } from './Building'
import { ISO_DIR, SCREEN_RIGHT, SCREEN_UP } from './camera'
import { tr, type Key } from './core/i18n'
import { lightAt } from './daylight'
import { BUILDING_STYLES, type BuildingStyle } from './layout'
import { STYLE_NAMES } from './NewCompany'
import { PixelPass } from './PixelPass'
import { usePrefs } from './prefs'
import { Figure, newRig } from './People'
import { BOTTOMS, HAIR_CUTS, styleOf, SWIMWEAR, TOPS, WARDROBE, type Bottom, type Facial, type Hair, type Style, type Top } from './figureStyle'
import type { Look } from './core/domain/types'

export const GALLERIES = ['buildings', 'furniture', 'characters'] as const
export type Gallery = (typeof GALLERIES)[number]
export const GALLERY_NAMES: Record<Gallery, Key> = { buildings: '建築', furniture: '家具', characters: '角色#figure' }

type V3 = [number, number, number]

interface Item {
  id: string
  name: Key
  note: Key
  /** The heading it is listed under, in a gallery split into parts. */
  group?: Key
  /** What the picture is framed on, in the sample's own units, when not the whole of it. */
  frame?: [V3, V3]
  draw: () => ReactNode
}

const BUILDING_NOTES: Record<BuildingStyle, Key> = {
  tower: '藍灰色的玻璃帷幕，屋頂有機房、冷氣和天線。',
  brick: '每層都有細細的線腳，屋頂有木水塔和花槽。',
  studio: '屋頂花園，有兩棵小樹和一排太陽能板。',
  loft: '鋸齒狀的屋頂天窗，加一根排氣管。',
  timber: '整片斜屋頂，煙囪從中間穿出。',
  classic: '屋頂有圓頂和尖頂飾。',
  tech: '屋頂有直升機坪和亮燈的桅桿。',
  pagoda: '每層都有飛簷，兩層屋頂加金色寶頂。',
  deco: '階梯狀的屋頂、金色線條和尖塔。',
  eco: '每層陽台都種綠籬，屋頂有草地、小樹和風車。',
  villa: '二樓正面有陽台，紅陶屋頂加白色煙囪。',
  lighthouse: '白色塔身配紅帶和圓窗，屋頂的小燈塔入夜會亮。',
  hut: '竹編牆配竹簾，厚茅草屋頂旁有一棵椰子樹。',
  castle: '灰石牆配拱窗，屋頂一圈城垛，四角尖塔插著旗。',
  canal: '窄高的白框窗，正面是階梯山牆，後面紅瓦屋頂。',
  glasshouse: '滿版玻璃看得到裡面的植物，屋頂是拱形玻璃。',
  sweets: '粉彩條紋牆配遮陽篷，屋頂放著大杯子蛋糕。',
}

const MEETING: Key = '辦公室夠大時，後面角落放其中一種。'
const CORNER: Key = '辦公室夠大時，前面角落放其中一種。'
const BACK: Key = '辦公室夠大時，後牆放其中一種。'
const FURNITURE_TEXT: Record<Furniture, [Key, Key]> = {
  desk: ['辦公桌', '每位員工一張，有人在工作時螢幕會亮。'],
  reception: ['接待櫃台', '在門口旁邊，辦公室太窄時沒有。'],
  nook: ['茶水角', '每間辦公室都有，靠著後牆：咖啡機和雙人沙發。'],
  cooler: ['飲水機', '接待櫃台旁有空間時才有。'],
  plants: ['盆栽', '放在角落，共五種；關掉「細節」時不顯示。'],
  long: ['長會議桌', MEETING],
  round: ['圓桌', MEETING],
  standing: ['站立會議桌', MEETING],
  tatami: ['和室茶席', MEETING],
  sofa: ['沙發區', CORNER],
  games: ['桌球桌', CORNER],
  cafe: ['咖啡座', CORNER],
  arcade: ['遊戲機', CORNER],
  foosball: ['手足球台', CORNER],
  tv: ['電視遊戲區', CORNER],
  gym: ['健身角', CORNER],
  books: ['書櫃', BACK],
  coffee: ['咖啡吧', BACK],
  whiteboard: ['白板', BACK],
  lockers: ['置物櫃', BACK],
  aquarium: ['魚缸', BACK],
  server: ['伺服器機櫃', BACK],
  trophies: ['獎盃櫃', BACK],
  vending: ['自動販賣機', BACK],
  greenwall: ['植生牆', BACK],
  records: ['唱片牆', BACK],
}


// ---------------------------------------------------------------- people

/** Everyone in the gallery shares these colours, so only the part shown differs. */
const MODEL: Look = { skin: '#f1c7a5', hair: '#5a3a24', shirt: '#3f7fd0', pants: '#34405a', extra: 'none', wardrobe: WARDROBE }
/** What everyone wears when another part is shown. */
const PLAIN: Pick<Style, 'hair' | 'top' | 'bottom' | 'facial'> = { hair: 'short', top: 'tee', bottom: 'pants', facial: 'none' }

/** The first seed that dresses someone as asked from the newest wardrobe; the parts not asked for are plain. */
function seedFor(want: Partial<Pick<Style, 'hair' | 'top' | 'bottom' | 'facial'>>) {
  const goal = { ...PLAIN, ...want }
  for (let seed = 0; ; seed++) {
    const st = styleOf(seed, WARDROBE)
    if (st.hair === goal.hair && st.top === goal.top && st.bottom === goal.bottom && st.facial === goal.facial) return seed
  }
}

/** Heads framed close: the tallest hair and hats, the widest cut, a cap's brim. Bodies whole. */
const HEAD: [V3, V3] = [[-0.27, 0.7, -0.3], [0.27, 1.32, 0.3]]
const BODY: [V3, V3] = [[-0.33, 0, -0.3], [0.33, 1.32, 0.3]]
/** Turned three-quarters to the camera, as on the hire sheet (Standee.tsx); a ponytail is shown from behind. */
const FACING = Math.PI
const FROM_BEHIND = Math.PI / 2

/** Someone standing still. */
function Person({ look, seed, turn }: { look: Look; seed: number; turn: number }) {
  const rig = useMemo(newRig, [])
  useLayoutEffect(() => {
    if (!rig.root || !rig.seated || !rig.standing) return
    rig.seated.visible = false
    rig.standing.visible = true
    rig.root.rotation.y = turn
  }, [rig, turn])
  return <Figure look={look} rig={rig} seed={seed} />
}

const HAIR_NAMES: Record<Hair, Key> = {
  short: '短髮', long: '長髮', bun: '包頭', fringe: '瀏海', buzz: '平頭', spiky: '刺蝟頭',
  ponytail: '馬尾', bob: '鮑伯頭', afro: '爆炸頭', mohawk: '莫霍克頭', bald: '光頭', side: '旁分',
  twintails: '雙馬尾', sidetail: '側馬尾', waves: '大波浪', buns: '雙丸子頭', braid: '麻花辮', halfup: '公主頭', curly: '捲髮', quiff: '油頭',
}
/** Cuts whose shape shows best from behind. */
const SEEN_FROM_BEHIND = new Set<Hair>(['ponytail', 'halfup'])
const TOP_NAMES: Record<Top, Key> = {
  tee: 'T 恤', hoodie: '帽 T', jacket: '西裝外套', tie: '襯衫領帶', sweater: '毛衣', polo: 'Polo 衫', vest: '背心', stripes: '條紋衫',
  cardigan: '針織開襟衫', bowshirt: '領結襯衫', plaid: '格子襯衫', labcoat: '實驗袍', turtleneck: '高領毛衣',
}
const BOTTOM_NAMES: Record<Bottom, Key> = { pants: '長褲', skirt: '短裙', longskirt: '長裙', dress: '連身裙', trunks: '泳褲', bikini: '比基尼' }
const FACIALS: Array<[Exclude<Facial, 'none'>, Key]> = [['mustache', '八字鬍'], ['beard', '落腮鬍'], ['stubble', '鬍渣'], ['goatee', '山羊鬍']]
const EXTRAS: Array<[Exclude<Look['extra'], 'none'>, Key]> = [
  ['glasses', '眼鏡'], ['sunglasses', '墨鏡'], ['cap', '棒球帽'], ['beanie', '毛帽'], ['headset', '耳機麥克風'], ['bow', '蝴蝶結'],
  ['strawhat', '草帽'], ['beret', '貝雷帽'], ['bandana', '頭巾'], ['headband', '髮箍'], ['hairclip', '髮夾'], ['flower', '花朵髮飾'],
]

const person = (id: string, name: Key, group: Key, note: Key, frame: [V3, V3], seed: number, look = MODEL, turn = FACING): Item => ({
  id, name, group, note, frame, draw: () => <Person look={look} seed={seed} turn={turn} />,
})

const CHARACTERS: Item[] = [
  ...HAIR_CUTS.map((h) => person(`hair-${h}`, HAIR_NAMES[h], '髮型', '髮色因人而異；戴帽子時，頭頂的頭髮會被蓋住。', HEAD,
    seedFor({ hair: h }), MODEL, SEEN_FROM_BEHIND.has(h) ? FROM_BEHIND : FACING)),
  ...TOPS.map((t) => person(`top-${t}`, TOP_NAMES[t], '上衣', '衣服顏色因人而異；外套、背心、領帶、格子和條紋這類另外挑一個顏色。', BODY, seedFor({ top: t }))),
  ...BOTTOMS.map((b) => person(`bottom-${b}`, BOTTOM_NAMES[b], '下半身', '長褲和裙子用褲子的顏色，連身裙和上衣同色。', BODY, seedFor({ bottom: b }))),
  ...SWIMWEAR.map((b) => person(`swim-${b}`, BOTTOM_NAMES[b], '泳裝', '泳褲用褲子的顏色，比基尼用上衣的顏色，都配夾腳拖。島上的路人比較常穿。', BODY, seedFor({ bottom: b }))),
  ...FACIALS.map(([f, name]) => person(`facial-${f}`, name, '鬍子', '和頭髮同色，鬍渣是深一點的膚色。大部分的人沒有鬍子。', HEAD, seedFor({ facial: f }))),
  ...EXTRAS.map(([x, name]) => person(`extra-${x}`, name, '配件', '每人最多一件，也常常沒有。', HEAD, seedFor({}), { ...MODEL, extra: x })),
]

const ITEMS: Record<Gallery, Item[]> = {
  buildings: BUILDING_STYLES.map((style) => ({
    id: style, name: STYLE_NAMES[style], note: BUILDING_NOTES[style], draw: () => <BuildingSample style={style} />,
  })),
  furniture: FURNITURE.map((kind) => ({
    id: kind, name: FURNITURE_TEXT[kind][0], note: FURNITURE_TEXT[kind][1], draw: () => <FurnitureSample kind={kind} />,
  })),
  characters: CHARACTERS,
}

export const galleryItemsForTest = (g: Gallery) => ITEMS[g].map((i) => i.id)

/** Each picture is 240 pixels square (fx-sample-studio): shown whole when opened, at half on its note, where every pixel-art texel is one pixel. */
/** Drawn on this, then made see-through: nothing in the samples is this colour. */
const KEY_COLOUR = '#ff00ff'

/** Pictures taken so far, by gallery and item, and who to tell when one is added. */
const shots = new Map<string, string>()
const shotKey = (g: Gallery, id: string) => `${g}/${id}`
const shotWatchers = new Set<() => void>()
let shotCount = 0
const watchShots = (f: () => void) => {
  shotWatchers.add(f)
  return () => void shotWatchers.delete(f)
}
const useShots = () => useSyncExternalStore(watchShots, () => shotCount)
function addShot(g: Gallery, id: string, url: string) {
  shots.set(shotKey(g, id), url)
  shotCount++
  for (const f of shotWatchers) f()
}

/** A sample's picture, or an empty box while it is still being taken. */
function Picture({ gallery, id, className }: { gallery: Gallery; id: string; className: string }) {
  useShots()
  const url = shots.get(shotKey(gallery, id))
  return url ? <img className={className} src={url} alt="" /> : <span className={`${className} fx-sample-wait`} />
}

/** What is open on the sheet over the help: a gallery and one of its items. */
export interface Sample { gallery: Gallery; id: string }

/** The grid of sticky notes; pressing one opens it on a sheet over the help (see SampleSheet). */
export function Looks({ gallery, open, onOpen }: { gallery: Gallery; open: string | null; onOpen: (id: string) => void }) {
  useShots()
  const items = ITEMS[gallery]
  const todo = items.filter((i) => !shots.has(shotKey(gallery, i.id)))
  const grid = (list: Item[], label?: string) => (
    <ul className="fx-sample-grid" aria-label={label} aria-busy={list.some((i) => todo.includes(i)) || undefined}>
      {list.map((i) => (
        <li key={i.id}>
          <button type="button" className="fx-sample" aria-expanded={open === i.id} aria-haspopup="dialog" onClick={() => onOpen(i.id)}>
            <Picture gallery={gallery} id={i.id} className="fx-sample-pic" />
            <span>{tr(i.name)}</span>
          </button>
        </li>
      ))}
    </ul>
  )
  // in the order their first item comes
  const groups = [...new Set(items.map((i) => i.group))]
  return (
    <div className="fx-samples">
      {groups.length === 1 && !groups[0] ? grid(items) : groups.map((g) => (
        <section key={g} className="fx-sample-group">
          <h3>{g && tr(g)}</h3>
          {grid(items.filter((i) => i.group === g), g && tr(g))}
        </section>
      ))}
      {todo.length > 0 && <Studio item={todo[0]} onShot={(url) => addShot(gallery, todo[0].id, url)} />}
    </div>
  )
}

// a click on the map with the sheet open puts the sheet away first, as it does a drawer's detail sheets
let sheetAway: (() => void) | null = null

/** A click on the map puts away the sheet over the help, unless the preference has the click close the help at once; false when it should close the help. */
export function putAwaySampleSheet() {
  if (!sheetAway || usePrefs.getState().mapClick !== 'sheets') return false
  sheetAway()
  return true
}

/**
 * One sample, large, on a sheet taped over the help a step lower, as a drawer's detail sheets stack: the help under
 * it is covered, and a click on what shows of it, Esc or a click on the map puts this sheet away.
 */
export function SampleSheet({ sample, leaving, onBack, onGone }: { sample: Sample; leaving: boolean; onBack: () => void; onGone: () => void }) {
  const item = ITEMS[sample.gallery].find((i) => i.id === sample.id)
  const title = useRef<HTMLHeadingElement>(null)
  useEffect(() => title.current?.focus({ preventScroll: true }), [])
  // Esc puts away this sheet, not the help; this runs before the map's own Esc handler
  useEffect(() => {
    if (leaving) return
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      onBack()
    }
    window.addEventListener('keydown', onKey, true)
    sheetAway = onBack
    return () => {
      window.removeEventListener('keydown', onKey, true)
      if (sheetAway === onBack) sheetAway = null
    }
  }, [leaving, onBack])
  if (!item) return null
  return (
    <aside className={`fx-detail fx-sample-sheet${leaving ? ' leaving' : ''}`} role="dialog" aria-labelledby="fx-sample-title"
      aria-hidden={leaving || undefined} inert={leaving || undefined}
      onAnimationEnd={(e) => { if (leaving && e.target === e.currentTarget) onGone() }}>
      <span className="fx-tape fx-tape-l" aria-hidden="true" />
      <div className="fx-sheet">
        <div className="fx-detail-body">
          <header className="fx-d-head">
            <h2 id="fx-sample-title" ref={title} tabIndex={-1}>{tr(item.name)}</h2>
            {item.group && <p className="fx-d-meta">{tr(item.group)}</p>}
          </header>
          <Picture gallery={sample.gallery} id={item.id} className="fx-sample-big" />
          <p className="fx-d-text">{tr(item.note)}</p>
        </div>
      </div>
    </aside>
  )
}

/**
 * The hidden canvas the pictures are taken in, lit as the map is at noon. It hangs off the page's body: inside the
 * help, the sheet's tilt would skew how the canvas measures itself.
 */
function Studio({ item, onShot }: { item: Item; onShot: (url: string) => void }) {
  const noon = lightAt(0.5)
  const reach = 14
  return createPortal(
    <div className="fx-sample-studio" aria-hidden="true">
      <Canvas orthographic dpr={1} shadows="basic" gl={{ antialias: false, preserveDrawingBuffer: true }}
        camera={{ position: ISO_DIR.clone().multiplyScalar(200).toArray(), zoom: 10, near: 1, far: 600 }}
        onCreated={({ gl }) => void (gl.toneMapping = THREE.NoToneMapping)}>
        <color attach="background" args={[KEY_COLOUR]} />
        <hemisphereLight args={[noon.above, noon.below, noon.fill]} />
        <directionalLight position={noon.toSun.clone().multiplyScalar(60).toArray()} intensity={noon.strength} color={noon.sun} castShadow
          shadow-mapSize={[1024, 1024]} shadow-bias={-0.0007} shadow-normalBias={0.02}
          shadow-camera-left={-reach} shadow-camera-right={reach} shadow-camera-top={reach} shadow-camera-bottom={-reach}
          shadow-camera-near={1} shadow-camera-far={120} />
        <Shot key={item.id} item={item} onShot={onShot} />
        <PixelPass pixel={2} />
      </Canvas>
    </div>,
    document.body,
  )
}

const box = new THREE.Box3()
const corner = new THREE.Vector3()

/** One sample: framed to fill the picture, drawn for a few frames so its textures and shadows are in, then taken. */
function Shot({ item, onShot }: { item: Item; onShot: (url: string) => void }) {
  const group = useRef<THREE.Group>(null)
  const frames = useRef(0)
  const { camera, gl, size } = useThree()
  // before PixelPass draws
  useFrame(() => {
    const g = group.current
    if (!g || frames.current > 0) return
    g.updateWorldMatrix(true, true)
    if (item.frame) box.set(corner.fromArray(item.frame[0]), new THREE.Vector3().fromArray(item.frame[1]))
    // from the vertices: a turned pyramid roof's bounding box is far wider than the roof
    else box.setFromObject(g, true)
    let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity
    for (let k = 0; k < 8; k++) {
      corner.set(k & 1 ? box.max.x : box.min.x, k & 2 ? box.max.y : box.min.y, k & 4 ? box.max.z : box.min.z)
      const u = corner.dot(SCREEN_RIGHT), v = corner.dot(SCREEN_UP)
      u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v)
    }
    const target = SCREEN_RIGHT.clone().multiplyScalar((u0 + u1) / 2).addScaledVector(SCREEN_UP, (v0 + v1) / 2)
    const cam = camera as THREE.OrthographicCamera
    cam.position.copy(target).addScaledVector(ISO_DIR, 200)
    cam.lookAt(target)
    cam.zoom = (0.88 * Math.min(size.width, size.height)) / Math.max(u1 - u0, v1 - v0, 0.01)
    cam.updateProjectionMatrix()
  })
  // after PixelPass has drawn
  useFrame(() => {
    if (++frames.current !== 4) return
    onShot(keyedOut(gl.domElement))
  }, 2)
  return <group ref={group}>{item.draw()}</group>
}

/** The canvas as a PNG, the key colour around the sample made see-through. */
function keyedOut(from: HTMLCanvasElement): string {
  const out = document.createElement('canvas')
  out.width = from.width
  out.height = from.height
  const g = out.getContext('2d')
  if (!g) return from.toDataURL('image/png')
  g.drawImage(from, 0, 0)
  const img = g.getImageData(0, 0, out.width, out.height)
  const px = img.data
  for (let i = 0; i < px.length; i += 4) if (px[i] > 240 && px[i + 1] < 16 && px[i + 2] > 240) px[i + 3] = 0
  g.putImageData(img, 0, 0)
  return out.toDataURL('image/png')
}
