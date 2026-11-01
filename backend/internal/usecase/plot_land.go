package usecase

// The logical land cells match layoutTown in frontend/src/layout.ts, including
// coastal notches, connecting strips and filled lakes. Rendering smooths these
// cells visually; placement uses the cells themselves in both clients and server.
import (
	"math"
	"sort"
)

const plotExpansion = 32
const landPadding = 6

var landSides = [][2]int{{1, 0}, {-1, 0}, {0, 1}, {0, -1}}

type plotLand struct {
	cols, rows int
	cells      []bool
	sums       []int
}

func landHash(values ...int) float64 {
	h := uint32(2166136261)
	for _, v := range values {
		h = (h ^ uint32(v*1000)) * 16777619
	}
	h = (h ^ (h >> 13)) * 1274126177
	return float64(h^(h>>16)) / 4294967296
}

func makePlotLand(plots []plotRect) plotLand {
	rects := append([]plotRect{airportRect}, plots...)
	hx, hz := plotCells/2+landPadding, plotCells/2+landPadding
	for _, r := range rects {
		hx = max(hx, -r.x+landPadding, r.x+r.w+landPadding)
		hz = max(hz, -r.z+landPadding, r.z+r.d+landPadding)
	}
	l := plotLand{cols: (hx + 1) * 2, rows: (hz + 1) * 2}
	l.cells = make([]bool, l.cols*l.rows)
	for _, r := range rects {
		for z := r.z - landPadding; z < r.z+r.d+landPadding; z++ {
			for x := r.x - landPadding; x < r.x+r.w+landPadding; x++ {
				l.cells[l.index(x, z)] = true
			}
		}
	}
	l.join()
	ring := make([]int, len(l.cells))
	for k := range ring {
		ring[k] = -1
	}
	var queue []int
	for k, land := range l.cells {
		if !land {
			continue
		}
		for _, n := range l.neighbors(k) {
			if !l.cells[n] {
				ring[k] = 0
				queue = append(queue, k)
				break
			}
		}
	}
	for head := 0; head < len(queue); head++ {
		k := queue[head]
		for _, n := range l.neighbors(k) {
			if l.cells[n] && ring[n] < 0 {
				ring[n] = ring[k] + 1
				queue = append(queue, n)
			}
		}
	}
	for k, distance := range ring {
		if distance > 1 {
			continue
		}
		x, z := k%l.cols-l.cols/2, k/l.cols-l.rows/2
		threshold := 0.2
		if distance == 0 {
			threshold = 0.55
		}
		if landHash(7331, int(math.Floor(float64(x)/3)), int(math.Floor(float64(z)/3)), distance) < threshold {
			l.cells[k] = false
		}
	}
	for k, distance := range ring {
		if distance != 1 || l.cells[k] {
			continue
		}
		open := false
		for _, n := range l.neighbors(k) {
			if ring[n] == 0 && !l.cells[n] {
				open = true
				break
			}
		}
		if !open {
			l.cells[k] = true
		}
	}
	l.join()
	l.fillLakes()
	for _, r := range rects {
		for z := r.z; z < r.z+r.d; z++ {
			for x := r.x; x < r.x+r.w; x++ {
				l.cells[l.index(x, z)] = true
			}
		}
	}
	stride := l.cols + 1
	sums := make([]int, stride*(l.rows+1))
	for z := 0; z < l.rows; z++ {
		for x := 0; x < l.cols; x++ {
			k := (z+1)*stride + x + 1
			value := 0
			if l.cells[z*l.cols+x] {
				value = 1
			}
			sums[k] = value + sums[k-1] + sums[k-stride] - sums[k-stride-1]
		}
	}
	l.sums = sums
	return l
}

func (l plotLand) index(x, z int) int { return (z+l.rows/2)*l.cols + x + l.cols/2 }

func (l plotLand) neighbors(k int) []int {
	x, z := k%l.cols, k/l.cols
	out := make([]int, 0, 4)
	for _, d := range landSides {
		nx, nz := x+d[0], z+d[1]
		if nx >= 0 && nz >= 0 && nx < l.cols && nz < l.rows {
			out = append(out, nz*l.cols+nx)
		}
	}
	return out
}

func (l plotLand) pieces() [][]int {
	seen := make([]bool, len(l.cells))
	var pieces [][]int
	for k, land := range l.cells {
		if !land || seen[k] {
			continue
		}
		seen[k] = true
		stack := []int{k}
		var piece []int
		for len(stack) > 0 {
			c := stack[len(stack)-1]
			stack = stack[:len(stack)-1]
			piece = append(piece, c)
			for _, n := range l.neighbors(c) {
				if l.cells[n] && !seen[n] {
					seen[n] = true
					stack = append(stack, n)
				}
			}
		}
		pieces = append(pieces, piece)
	}
	sort.SliceStable(pieces, func(i, j int) bool { return len(pieces[i]) > len(pieces[j]) })
	return pieces
}

func (l plotLand) join() {
	for guard := 0; guard < 64; guard++ {
		pieces := l.pieces()
		if len(pieces) < 2 {
			return
		}
		main := make([]bool, len(l.cells))
		from := make([]int, len(l.cells))
		for k := range from {
			from[k] = -2
		}
		queue := pieces[0]
		for _, k := range queue {
			main[k] = true
			from[k] = -1
		}
		hit := -1
		for head := 0; head < len(queue) && hit < 0; head++ {
			c := queue[head]
			for _, n := range l.neighbors(c) {
				if from[n] != -2 {
					continue
				}
				from[n] = c
				if l.cells[n] && !main[n] {
					hit = n
					break
				}
				queue = append(queue, n)
			}
		}
		if hit < 0 {
			return
		}
		for c := from[hit]; c >= 0 && !main[c]; c = from[c] {
			x, z := c%l.cols, c/l.cols
			for dz := -2; dz < 4; dz++ {
				for dx := -2; dx < 4; dx++ {
					nx, nz := x+dx, z+dz
					if nx > 0 && nz > 0 && nx < l.cols-1 && nz < l.rows-1 {
						l.cells[nz*l.cols+nx] = true
					}
				}
			}
		}
	}
}

func (l plotLand) fillLakes() {
	open := make([]bool, len(l.cells))
	var stack []int
	for x := 0; x < l.cols; x++ {
		stack = append(stack, x, (l.rows-1)*l.cols+x)
	}
	for z := 0; z < l.rows; z++ {
		stack = append(stack, z*l.cols, z*l.cols+l.cols-1)
	}
	for len(stack) > 0 {
		c := stack[len(stack)-1]
		stack = stack[:len(stack)-1]
		if open[c] || l.cells[c] {
			continue
		}
		open[c] = true
		stack = append(stack, l.neighbors(c)...)
	}
	for k := range l.cells {
		if !l.cells[k] && !open[k] {
			l.cells[k] = true
		}
	}
}

// A summed land mask checks whether each footprint cell is within the 32-cell
// square expansion, including connected land between companies, not just plots.
func (l plotLand) containsExpanded(r plotRect) bool {
	stride := l.cols + 1
	sums := l.sums
	for z := r.z; z < r.z+r.d; z++ {
		for x := r.x; x < r.x+r.w; x++ {
			x0 := max(0, min(l.cols, x+l.cols/2-plotExpansion))
			x1 := max(0, min(l.cols, x+l.cols/2+plotExpansion+1))
			z0 := max(0, min(l.rows, z+l.rows/2-plotExpansion))
			z1 := max(0, min(l.rows, z+l.rows/2+plotExpansion+1))
			if sums[z1*stride+x1]-sums[z0*stride+x1]-sums[z1*stride+x0]+sums[z0*stride+x0] == 0 {
				return false
			}
		}
	}
	return true
}
