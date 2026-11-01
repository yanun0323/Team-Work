// Editing guide: only cells covered by at least one legal whole-company placement.
import { useMemo } from 'react'
import { CELL, PLOT_CELLS, placementArea, type Town } from './layout'
import { NO_OUTLINE_LAYER } from './PixelPass'

export function mapGridPositions(town: Pick<Town, 'cols' | 'rows' | 'ground' | 'lots'>, moved?: string): Float32Array {
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
  const positions: number[] = []
  const edge = (x: number, z: number, dx: number, dz: number) => positions.push((x + x0) * CELL, 0, (z + z0) * CELL, (x + x0 + dx) * CELL, 0, (z + z0 + dz) * CELL)
  for (let z = 0; z <= rows; z++) for (let x = 0; x <= cols; x++) {
    if (has(x, z) || has(x, z - 1)) edge(x, z, 1, 0)
    if (has(x, z) || has(x - 1, z)) edge(x, z, 0, 1)
  }
  return new Float32Array(positions)
}

export function MapGrid({ town, moved }: { town: Town; moved?: string }) {
  const positions = useMemo(() => mapGridPositions(town, moved), [town, moved])
  return (
    <lineSegments position-y={0.14} layers={NO_OUTLINE_LAYER} renderOrder={2} raycast={() => null}>
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" args={[positions, 3]} />
      </bufferGeometry>
      <lineBasicMaterial color="#ffffff" transparent opacity={0.15} depthWrite={false} toneMapped={false} />
    </lineSegments>
  )
}
