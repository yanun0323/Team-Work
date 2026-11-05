// Editing guide: only cells covered by at least one legal whole-company placement.
import { useEffect, useMemo } from 'react'
import * as THREE from 'three'
import { CELL, PLOT_CELLS, placementArea, type Town } from './layout'
import { NO_OUTLINE_LAYER } from './PixelPass'

type GridTown = Pick<Town, 'cols' | 'rows' | 'ground' | 'lots'>

/** Whether a cell, in placement-area cells, is under at least one legal plot. */
function coverOf(town: GridTown, moved?: string) {
  const { x0, z0, cols, rows, valid } = placementArea(town, moved)
  // Union of legal footprints, using rectangle differences instead of painting each plot 256 times.
  const stride = cols + 1
  const cover = new Int32Array(stride * (rows + 1))
  for (let z = 0; z < rows; z++) for (let x = 0; x < cols; x++) {
    if (!valid[z * cols + x]) continue
    cover[z * stride + x]++
    cover[z * stride + x + PLOT_CELLS]--
    cover[(z + PLOT_CELLS) * stride + x]--
    cover[(z + PLOT_CELLS) * stride + x + PLOT_CELLS]++
  }
  for (let z = 0; z < rows; z++) for (let x = 0; x < cols; x++) {
    const k = z * stride + x
    cover[k] += (x ? cover[k - 1] : 0) + (z ? cover[k - stride] : 0) - (x && z ? cover[k - stride - 1] : 0)
  }
  const has = (x: number, z: number) => x >= 0 && z >= 0 && x < cols && z < rows && cover[z * stride + x] > 0
  return { x0, z0, cols, rows, has }
}

export function mapGridPositions(town: GridTown, moved?: string): Float32Array {
  const { x0, z0, cols, rows, has } = coverOf(town, moved)
  const positions: number[] = []
  const edge = (x: number, z: number, dx: number, dz: number) => positions.push((x + x0) * CELL, 0, (z + z0) * CELL, (x + x0 + dx) * CELL, 0, (z + z0 + dz) * CELL)
  for (let z = 0; z <= rows; z++) for (let x = 0; x <= cols; x++) {
    if (has(x, z) || has(x, z - 1)) edge(x, z, 1, 0)
    if (has(x, z) || has(x - 1, z)) edge(x, z, 0, 1)
  }
  return new Float32Array(positions)
}

/** The same cells as triangles, one strip per run of covered cells along a row. */
export function mapGridFill(town: GridTown, moved?: string): Float32Array {
  const { x0, z0, cols, rows, has } = coverOf(town, moved)
  const positions: number[] = []
  for (let z = 0; z < rows; z++) for (let x = 0; x < cols; x++) {
    if (!has(x, z) || has(x - 1, z)) continue
    let end = x + 1
    while (has(end, z)) end++
    const [ax, bx, az, bz] = [(x + x0) * CELL, (end + x0) * CELL, (z + z0) * CELL, (z + 1 + z0) * CELL]
    positions.push(ax, 0, az, ax, 0, bz, bx, 0, bz, ax, 0, az, bx, 0, bz, bx, 0, az)
  }
  return new Float32Array(positions)
}

export function MapGrid({ town, moved }: { town: Town; moved?: string }) {
  const positions = useMemo(() => mapGridPositions(town, moved), [town, moved])
  const fill = useMemo(() => {
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(mapGridFill(town, moved), 3))
    return g
  }, [town, moved])
  useEffect(() => () => fill.dispose(), [fill])
  return (
    <>
      <mesh geometry={fill} position-y={0.12} layers={NO_OUTLINE_LAYER} renderOrder={1} raycast={() => null}>
        <meshBasicMaterial color="#ffffff" transparent opacity={0.14} depthWrite={false} toneMapped={false} />
      </mesh>
      <lineSegments position-y={0.14} layers={NO_OUTLINE_LAYER} renderOrder={2} raycast={() => null}>
        <bufferGeometry>
          <bufferAttribute attach="attributes-position" args={[positions, 3]} />
        </bufferGeometry>
        <lineBasicMaterial color="#ffffff" transparent opacity={0.35} depthWrite={false} toneMapped={false} />
      </lineSegments>
    </>
  )
}
