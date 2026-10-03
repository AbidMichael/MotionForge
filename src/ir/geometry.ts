/**
 * Geometry shared by the player (cursor, connectors, morphs) and the checks (QA):
 * rects, side anchors, connector routing (straight / curve / elbow / auto with obstacle avoidance),
 * rounded polylines and point-at-length sampling.
 */

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}
export type Pt = [number, number];
export type Side = 'top' | 'right' | 'bottom' | 'left';

export const center = (r: Rect): Pt => [r.x + r.w / 2, r.y + r.h / 2];
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const lerpRect = (a: Rect, b: Rect, t: number): Rect => ({ x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t), w: lerp(a.w, b.w, t), h: lerp(a.h, b.h, t) });
export const inflate = (r: Rect, m: number): Rect => ({ x: r.x - m, y: r.y - m, w: r.w + 2 * m, h: r.h + 2 * m });
export const intersects = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
export const area = (r: Rect) => Math.max(0, r.w) * Math.max(0, r.h);
export function intersection(a: Rect, b: Rect): Rect | null {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w);
  const y2 = Math.min(a.y + a.h, b.y + b.h);
  return x2 > x && y2 > y ? { x, y, w: x2 - x, h: y2 - y } : null;
}

const NORMAL: Record<Side, Pt> = { top: [0, -1], right: [1, 0], bottom: [0, 1], left: [-1, 0] };

export function sideAnchor(r: Rect, side: Side, gap = 0): Pt {
  const [cx, cy] = center(r);
  const [nx, ny] = NORMAL[side];
  return [cx + nx * (r.w / 2 + gap), cy + ny * (r.h / 2 + gap)];
}

/** Pick the facing sides of two boxes. */
export function autoSides(a: Rect, b: Rect): [Side, Side] {
  const [ax, ay] = center(a);
  const [bx, by] = center(b);
  const dx = bx - ax;
  const dy = by - ay;
  // normalise by box sizes so wide boxes prefer vertical connections when stacked
  const hx = Math.abs(dx) - (a.w + b.w) / 2;
  const hy = Math.abs(dy) - (a.h + b.h) / 2;
  if (hx >= hy) return dx >= 0 ? ['right', 'left'] : ['left', 'right'];
  return dy >= 0 ? ['bottom', 'top'] : ['top', 'bottom'];
}

/** Where the line from the box centre towards `toward` leaves the box (plus a gap). */
export function boxExit(r: Rect, toward: Pt, gap = 0): Pt {
  const [cx, cy] = center(r);
  const dx = toward[0] - cx;
  const dy = toward[1] - cy;
  if (!dx && !dy) return [cx, cy];
  const tx = dx ? (r.w / 2 + gap) / Math.abs(dx) : Infinity;
  const ty = dy ? (r.h / 2 + gap) / Math.abs(dy) : Infinity;
  const t = Math.min(tx, ty);
  return [cx + dx * t, cy + dy * t];
}

// ---------- polylines ----------
export function simplify(pts: Pt[]): Pt[] {
  const out: Pt[] = [];
  for (const p of pts) {
    const last = out[out.length - 1];
    if (last && Math.abs(last[0] - p[0]) < 0.01 && Math.abs(last[1] - p[1]) < 0.01) continue;
    if (out.length >= 2) {
      const a = out[out.length - 2];
      const b = out[out.length - 1];
      const cross = (b[0] - a[0]) * (p[1] - b[1]) - (b[1] - a[1]) * (p[0] - b[0]);
      if (Math.abs(cross) < 0.01) {
        out[out.length - 1] = p;
        continue;
      }
    }
    out.push(p);
  }
  return out;
}

/** Polyline with rounded corners as an SVG path, plus a dense sample for length/point queries. */
export function roundedPath(pts: Pt[], radius: number): { d: string; samples: Pt[] } {
  if (pts.length < 2) return { d: '', samples: pts };
  const samples: Pt[] = [pts[0]];
  let d = `M${f(pts[0][0])} ${f(pts[0][1])}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const p0 = pts[i - 1];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const l1 = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]);
    const l2 = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]);
    const r = Math.min(radius, l1 / 2, l2 / 2);
    const a: Pt = [p1[0] - ((p1[0] - p0[0]) / (l1 || 1)) * r, p1[1] - ((p1[1] - p0[1]) / (l1 || 1)) * r];
    const b: Pt = [p1[0] + ((p2[0] - p1[0]) / (l2 || 1)) * r, p1[1] + ((p2[1] - p1[1]) / (l2 || 1)) * r];
    d += ` L${f(a[0])} ${f(a[1])} Q${f(p1[0])} ${f(p1[1])} ${f(b[0])} ${f(b[1])}`;
    samples.push(a);
    for (let k = 1; k <= 6; k++) {
      const t = k / 6;
      samples.push([(1 - t) * (1 - t) * a[0] + 2 * (1 - t) * t * p1[0] + t * t * b[0], (1 - t) * (1 - t) * a[1] + 2 * (1 - t) * t * p1[1] + t * t * b[1]]);
    }
  }
  const last = pts[pts.length - 1];
  d += ` L${f(last[0])} ${f(last[1])}`;
  samples.push(last);
  return { d, samples };
}

export function cubicPath(p0: Pt, c1: Pt, c2: Pt, p1: Pt): { d: string; samples: Pt[] } {
  const samples: Pt[] = [];
  for (let k = 0; k <= 40; k++) {
    const t = k / 40;
    const u = 1 - t;
    samples.push([
      u * u * u * p0[0] + 3 * u * u * t * c1[0] + 3 * u * t * t * c2[0] + t * t * t * p1[0],
      u * u * u * p0[1] + 3 * u * u * t * c1[1] + 3 * u * t * t * c2[1] + t * t * t * p1[1],
    ]);
  }
  return { d: `M${f(p0[0])} ${f(p0[1])} C${f(c1[0])} ${f(c1[1])} ${f(c2[0])} ${f(c2[1])} ${f(p1[0])} ${f(p1[1])}`, samples };
}

const f = (n: number) => (Math.round(n * 10) / 10).toString();

export interface Sampled {
  pts: Pt[];
  cum: number[];
  length: number;
}

export function sample(pts: Pt[]): Sampled {
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  return { pts, cum, length: cum[cum.length - 1] ?? 0 };
}

/** Point and tangent angle (degrees) at fraction t of the path length. */
export function pointAt(s: Sampled, t: number): { x: number; y: number; angle: number } {
  if (s.pts.length === 0) return { x: 0, y: 0, angle: 0 };
  if (s.pts.length === 1) return { x: s.pts[0][0], y: s.pts[0][1], angle: 0 };
  const L = Math.max(0, Math.min(1, t)) * s.length;
  let i = 1;
  while (i < s.cum.length - 1 && s.cum[i] < L) i++;
  const seg = s.cum[i] - s.cum[i - 1] || 1;
  const k = (L - s.cum[i - 1]) / seg;
  const a = s.pts[i - 1];
  const b = s.pts[i];
  return { x: lerp(a[0], b[0], k), y: lerp(a[1], b[1], k), angle: (Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI };
}

/** Sub-polyline between fractions t0..t1 (for signal trails). */
export function slice(s: Sampled, t0: number, t1: number): Pt[] {
  const a = Math.max(0, Math.min(1, t0)) * s.length;
  const b = Math.max(0, Math.min(1, t1)) * s.length;
  if (b <= a) return [];
  const out: Pt[] = [];
  const p0 = pointAt(s, a / (s.length || 1));
  out.push([p0.x, p0.y]);
  for (let i = 0; i < s.pts.length; i++) if (s.cum[i] > a && s.cum[i] < b) out.push(s.pts[i]);
  const p1 = pointAt(s, b / (s.length || 1));
  out.push([p1.x, p1.y]);
  return out;
}

// ---------- routing ----------
export interface RouteInput {
  a: Rect | Pt;
  b: Rect | Pt;
  route: 'straight' | 'curve' | 'elbow' | 'auto';
  fromSide: Side | 'auto';
  toSide: Side | 'auto';
  gap: number;
  radius: number;
  curvature: number;
  obstacles: Rect[];
}

const isPt = (v: Rect | Pt): v is Pt => Array.isArray(v);
const asRect = (v: Rect | Pt): Rect => (isPt(v) ? { x: v[0], y: v[1], w: 0, h: 0 } : v);

export function routeConnector(inp: RouteInput): { d: string; samples: Pt[] } {
  const A = asRect(inp.a);
  const B = asRect(inp.b);
  const [autoA, autoB] = autoSides(A, B);
  const sa: Side = inp.fromSide === 'auto' ? autoA : inp.fromSide;
  const sb: Side = inp.toSide === 'auto' ? autoB : inp.toSide;
  if (inp.route === 'straight') {
    const pa = isPt(inp.a) ? inp.a : boxExit(A, center(B), inp.gap);
    const pb = isPt(inp.b) ? inp.b : boxExit(B, center(A), inp.gap);
    return { d: `M${f(pa[0])} ${f(pa[1])} L${f(pb[0])} ${f(pb[1])}`, samples: [pa, pb] };
  }
  const pa = isPt(inp.a) ? inp.a : sideAnchor(A, sa, inp.gap);
  const pb = isPt(inp.b) ? inp.b : sideAnchor(B, sb, inp.gap);
  if (inp.route === 'curve') {
    const dist = Math.hypot(pb[0] - pa[0], pb[1] - pa[1]);
    const k = Math.max(30, dist * inp.curvature);
    const na = NORMAL[sa];
    const nb = NORMAL[sb];
    return cubicPath(pa, [pa[0] + na[0] * k, pa[1] + na[1] * k], [pb[0] + nb[0] * k, pb[1] + nb[1] * k], pb);
  }
  let pts: Pt[] | null = null;
  if (inp.route === 'auto' && inp.obstacles.length) pts = astar(pa, sa, pb, sb, inp.obstacles, A, B, inp.gap);
  if (!pts) pts = elbow(pa, sa, pb, sb, inp.gap);
  return roundedPath(simplify(pts), inp.radius);
}

function elbow(pa: Pt, sa: Side, pb: Pt, sb: Side, gap: number): Pt[] {
  const na = NORMAL[sa];
  const nb = NORMAL[sb];
  const lead = Math.max(16, gap * 2);
  const a1: Pt = [pa[0] + na[0] * lead, pa[1] + na[1] * lead];
  const b1: Pt = [pb[0] + nb[0] * lead, pb[1] + nb[1] * lead];
  const ha = na[0] !== 0;
  const hb = nb[0] !== 0;
  let mid: Pt[];
  if (ha && hb) {
    const mx = (a1[0] + b1[0]) / 2;
    // facing each other in the right order → one vertical run in the middle
    mid = (na[0] > 0 && a1[0] <= b1[0]) || (na[0] < 0 && a1[0] >= b1[0]) ? [[mx, pa[1]], [mx, pb[1]]] : [a1, [a1[0], (a1[1] + b1[1]) / 2], [b1[0], (a1[1] + b1[1]) / 2], b1];
  } else if (!ha && !hb) {
    const my = (a1[1] + b1[1]) / 2;
    mid = (na[1] > 0 && a1[1] <= b1[1]) || (na[1] < 0 && a1[1] >= b1[1]) ? [[pa[0], my], [pb[0], my]] : [a1, [(a1[0] + b1[0]) / 2, a1[1]], [(a1[0] + b1[0]) / 2, b1[1]], b1];
  } else if (ha) {
    mid = [[pb[0], pa[1]]];
    if ((na[0] > 0 && pb[0] < a1[0]) || (na[0] < 0 && pb[0] > a1[0])) mid = [a1, [a1[0], b1[1]], b1];
  } else {
    mid = [[pa[0], pb[1]]];
    if ((na[1] > 0 && pb[1] < a1[1]) || (na[1] < 0 && pb[1] > a1[1])) mid = [a1, [b1[0], a1[1]], b1];
  }
  return [pa, ...mid, pb];
}

const routeCache = new Map<string, Pt[] | null>();

/** Orthogonal A* on a grid around obstacles, with a turn penalty (few bends). */
function astar(pa: Pt, sa: Side, pb: Pt, sb: Side, obstacles: Rect[], A: Rect, B: Rect, gap: number): Pt[] | null {
  const key = [pa, pb, sa, sb, ...obstacles.map((o) => [o.x, o.y, o.w, o.h])].flat(2).map((n) => (typeof n === 'number' ? Math.round(n) : n)).join(',');
  if (routeCache.has(key)) return routeCache.get(key)!;
  const margin = 80;
  const all = [A, B, ...obstacles, { x: pa[0], y: pa[1], w: 0, h: 0 }, { x: pb[0], y: pb[1], w: 0, h: 0 }];
  const minX = Math.min(...all.map((r) => r.x)) - margin;
  const minY = Math.min(...all.map((r) => r.y)) - margin;
  const maxX = Math.max(...all.map((r) => r.x + r.w)) + margin;
  const maxY = Math.max(...all.map((r) => r.y + r.h)) + margin;
  const cell = Math.max(8, Math.ceil(Math.max(maxX - minX, maxY - minY) / 180));
  const cols = Math.ceil((maxX - minX) / cell) + 1;
  const rows = Math.ceil((maxY - minY) / cell) + 1;
  const blocked = new Uint8Array(cols * rows);
  const block = (r: Rect) => {
    const x0 = Math.max(0, Math.floor((r.x - minX) / cell));
    const y0 = Math.max(0, Math.floor((r.y - minY) / cell));
    const x1 = Math.min(cols - 1, Math.ceil((r.x + r.w - minX) / cell));
    const y1 = Math.min(rows - 1, Math.ceil((r.y + r.h - minY) / cell));
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) blocked[y * cols + x] = 1;
  };
  for (const o of obstacles) block(inflate(o, gap));
  block(inflate(A, gap * 0.5));
  block(inflate(B, gap * 0.5));
  const toCell = (p: Pt) => [Math.round((p[0] - minX) / cell), Math.round((p[1] - minY) / cell)];
  const na = NORMAL[sa];
  const nb = NORMAL[sb];
  const lead = Math.max(gap, cell) + cell;
  const sp: Pt = [pa[0] + na[0] * lead, pa[1] + na[1] * lead];
  const ep: Pt = [pb[0] + nb[0] * lead, pb[1] + nb[1] * lead];
  const [sx, sy] = toCell(sp);
  const [ex, ey] = toCell(ep);
  if (sx < 0 || sy < 0 || ex < 0 || ey < 0 || sx >= cols || ex >= cols || sy >= rows || ey >= rows) return null;
  blocked[sy * cols + sx] = 0;
  blocked[ey * cols + ex] = 0;
  const DIRS = [
    [1, 0],
    [0, 1],
    [-1, 0],
    [0, -1],
  ];
  const startDir = DIRS.findIndex((d) => d[0] === na[0] && d[1] === na[1]);
  const N = cols * rows * 4;
  const g = new Float32Array(N).fill(Infinity);
  const prev = new Int32Array(N).fill(-1);
  // binary heap of [f, state]
  const heap: [number, number][] = [];
  const push = (fv: number, s: number) => {
    heap.push([fv, s]);
    let i = heap.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (heap[p][0] <= heap[i][0]) break;
      [heap[p], heap[i]] = [heap[i], heap[p]];
      i = p;
    }
  };
  const pop = () => {
    const top = heap[0];
    const last = heap.pop()!;
    if (heap.length) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let m = i;
        if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
        if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
        if (m === i) break;
        [heap[m], heap[i]] = [heap[i], heap[m]];
        i = m;
      }
    }
    return top;
  };
  const h = (x: number, y: number) => Math.abs(x - ex) + Math.abs(y - ey);
  const s0 = (sy * cols + sx) * 4 + Math.max(0, startDir);
  g[s0] = 0;
  push(h(sx, sy), s0);
  const TURN = 4;
  let found = -1;
  let iter = 0;
  while (heap.length && iter++ < 120000) {
    const [, s] = pop();
    const d = s & 3;
    const c = s >> 2;
    const x = c % cols;
    const y = (c / cols) | 0;
    if (x === ex && y === ey) {
      found = s;
      break;
    }
    for (let nd = 0; nd < 4; nd++) {
      if ((nd + 2) % 4 === d) continue;
      const nx = x + DIRS[nd][0];
      const ny = y + DIRS[nd][1];
      if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
      const nc = ny * cols + nx;
      if (blocked[nc]) continue;
      const ns = nc * 4 + nd;
      const ng = g[s] + 1 + (nd !== d ? TURN : 0);
      if (ng < g[ns]) {
        g[ns] = ng;
        prev[ns] = s;
        push(ng + h(nx, ny), ns);
      }
    }
  }
  if (found < 0) {
    routeCache.set(key, null);
    return null;
  }
  const cells: Pt[] = [];
  for (let s = found; s >= 0; s = prev[s]) {
    const c = s >> 2;
    cells.push([minX + (c % cols) * cell, minY + ((c / cols) | 0) * cell]);
  }
  cells.reverse();
  // snap the grid path onto the exact anchors
  const pts: Pt[] = [pa];
  const first = cells[0];
  pts.push(na[0] !== 0 ? [first[0], pa[1]] : [pa[0], first[1]]);
  pts.push(...cells);
  const lastC = cells[cells.length - 1];
  pts.push(nb[0] !== 0 ? [lastC[0], pb[1]] : [pb[0], lastC[1]]);
  pts.push(pb);
  // re-orthogonalise the snapped joints
  const ortho: Pt[] = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const p = ortho[ortho.length - 1];
    const q = pts[i];
    if (Math.abs(p[0] - q[0]) > 0.5 && Math.abs(p[1] - q[1]) > 0.5) ortho.push([q[0], p[1]]);
    ortho.push(q);
  }
  const out = simplify(ortho);
  if (routeCache.size > 2000) routeCache.clear();
  routeCache.set(key, out);
  return out;
}
