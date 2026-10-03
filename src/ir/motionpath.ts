/**
 * Motion paths: a layer travels along an SVG path (lines, Béziers, arcs) at constant speed.
 * Pure maths, shared by the compiler (Node) and the player (browser). Paths are flattened once
 * into a polyline with cumulative lengths and cached by their "d" string.
 */

export interface FlatPath {
  /** x0, y0, x1, y1, … */
  pts: number[];
  /** Cumulative length at each point. */
  len: number[];
  total: number;
}

type P = [number, number];

const cache = new Map<string, FlatPath>();

const TOKEN = /[MmLlHhVvCcSsQqTtAaZz]|[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g;

function steps(approxLen: number): number {
  return Math.max(8, Math.min(96, Math.ceil(approxLen / 6)));
}

function cubic(out: number[], p0: P, p1: P, p2: P, p3: P) {
  const n = steps(Math.hypot(p1[0] - p0[0], p1[1] - p0[1]) + Math.hypot(p2[0] - p1[0], p2[1] - p1[1]) + Math.hypot(p3[0] - p2[0], p3[1] - p2[1]));
  for (let i = 1; i <= n; i++) {
    const t = i / n;
    const u = 1 - t;
    const a = u * u * u;
    const b = 3 * u * u * t;
    const c = 3 * u * t * t;
    const d = t * t * t;
    out.push(a * p0[0] + b * p1[0] + c * p2[0] + d * p3[0], a * p0[1] + b * p1[1] + c * p2[1] + d * p3[1]);
  }
}

function quad(out: number[], p0: P, p1: P, p2: P) {
  cubic(out, p0, [p0[0] + (2 / 3) * (p1[0] - p0[0]), p0[1] + (2 / 3) * (p1[1] - p0[1])], [p2[0] + (2 / 3) * (p1[0] - p2[0]), p2[1] + (2 / 3) * (p1[1] - p2[1])], p2);
}

/** SVG elliptical arc (endpoint parameterisation → centre parameterisation), sampled. */
function arc(out: number[], p0: P, rx: number, ry: number, phiDeg: number, large: boolean, sweep: boolean, p1: P) {
  if (!rx || !ry) {
    out.push(p1[0], p1[1]);
    return;
  }
  rx = Math.abs(rx);
  ry = Math.abs(ry);
  const phi = (phiDeg * Math.PI) / 180;
  const cos = Math.cos(phi);
  const sin = Math.sin(phi);
  const dx = (p0[0] - p1[0]) / 2;
  const dy = (p0[1] - p1[1]) / 2;
  const x1 = cos * dx + sin * dy;
  const y1 = -sin * dx + cos * dy;
  const lam = (x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry);
  if (lam > 1) {
    rx *= Math.sqrt(lam);
    ry *= Math.sqrt(lam);
  }
  const num = rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1;
  const den = rx * rx * y1 * y1 + ry * ry * x1 * x1;
  let k = Math.sqrt(Math.max(0, num / den));
  if (large === sweep) k = -k;
  const cx1 = (k * rx * y1) / ry;
  const cy1 = (-k * ry * x1) / rx;
  const cx = cos * cx1 - sin * cy1 + (p0[0] + p1[0]) / 2;
  const cy = sin * cx1 + cos * cy1 + (p0[1] + p1[1]) / 2;
  const ang = (ux: number, uy: number, vx: number, vy: number) => {
    const a = Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
    return a;
  };
  const t1 = ang(1, 0, (x1 - cx1) / rx, (y1 - cy1) / ry);
  let dt = ang((x1 - cx1) / rx, (y1 - cy1) / ry, (-x1 - cx1) / rx, (-y1 - cy1) / ry);
  if (!sweep && dt > 0) dt -= 2 * Math.PI;
  if (sweep && dt < 0) dt += 2 * Math.PI;
  const n = steps(Math.abs(dt) * Math.max(rx, ry));
  for (let i = 1; i <= n; i++) {
    const t = t1 + (dt * i) / n;
    const ex = rx * Math.cos(t);
    const ey = ry * Math.sin(t);
    out.push(cos * ex - sin * ey + cx, sin * ex + cos * ey + cy);
  }
}

/** Parse and flatten an SVG path "d". Throws on malformed input. */
export function flattenPath(d: string): FlatPath {
  const hit = cache.get(d);
  if (hit) return hit;
  const toks = d.match(TOKEN) ?? [];
  const pts: number[] = [];
  let i = 0;
  let cmd = '';
  let cur: P = [0, 0];
  let start: P = [0, 0];
  let lastCtrl: P | null = null;
  let lastQ: P | null = null;
  const num = () => {
    const t = toks[i++];
    const n = Number(t);
    if (t === undefined || Number.isNaN(n)) throw new Error(`bad path near "${toks.slice(Math.max(0, i - 3), i + 2).join(' ')}"`);
    return n;
  };
  while (i < toks.length) {
    if (/^[A-Za-z]$/.test(toks[i])) cmd = toks[i++];
    else if (!cmd) throw new Error('path must start with M');
    const rel = cmd === cmd.toLowerCase();
    const C = cmd.toUpperCase();
    const ox = rel ? cur[0] : 0;
    const oy = rel ? cur[1] : 0;
    if (C === 'Z') {
      pts.push(start[0], start[1]);
      cur = [...start] as P;
      lastCtrl = lastQ = null;
      continue;
    }
    switch (C) {
      case 'M': {
        cur = [num() + ox, num() + oy];
        start = [...cur] as P;
        if (!pts.length) pts.push(cur[0], cur[1]);
        else pts.push(cur[0], cur[1]); // a jump: travelled as a straight line
        cmd = rel ? 'l' : 'L';
        lastCtrl = lastQ = null;
        break;
      }
      case 'L':
        cur = [num() + ox, num() + oy];
        pts.push(cur[0], cur[1]);
        lastCtrl = lastQ = null;
        break;
      case 'H':
        cur = [num() + ox, cur[1]];
        pts.push(cur[0], cur[1]);
        lastCtrl = lastQ = null;
        break;
      case 'V':
        cur = [cur[0], num() + oy];
        pts.push(cur[0], cur[1]);
        lastCtrl = lastQ = null;
        break;
      case 'C': {
        const c1: P = [num() + ox, num() + oy];
        const c2: P = [num() + ox, num() + oy];
        const e: P = [num() + ox, num() + oy];
        cubic(pts, cur, c1, c2, e);
        lastCtrl = c2;
        lastQ = null;
        cur = e;
        break;
      }
      case 'S': {
        const c1: P = lastCtrl ? [2 * cur[0] - lastCtrl[0], 2 * cur[1] - lastCtrl[1]] : [...cur];
        const c2: P = [num() + ox, num() + oy];
        const e: P = [num() + ox, num() + oy];
        cubic(pts, cur, c1, c2, e);
        lastCtrl = c2;
        lastQ = null;
        cur = e;
        break;
      }
      case 'Q': {
        const c: P = [num() + ox, num() + oy];
        const e: P = [num() + ox, num() + oy];
        quad(pts, cur, c, e);
        lastQ = c;
        lastCtrl = null;
        cur = e;
        break;
      }
      case 'T': {
        const c: P = lastQ ? [2 * cur[0] - lastQ[0], 2 * cur[1] - lastQ[1]] : [...cur];
        const e: P = [num() + ox, num() + oy];
        quad(pts, cur, c, e);
        lastQ = c;
        lastCtrl = null;
        cur = e;
        break;
      }
      case 'A': {
        const rx = num();
        const ry = num();
        const rotation = num();
        const large = num() !== 0;
        const sweep = num() !== 0;
        const e: P = [num() + ox, num() + oy];
        arc(pts, cur, rx, ry, rotation, large, sweep, e);
        lastCtrl = lastQ = null;
        cur = e;
        break;
      }
      default:
        throw new Error(`unsupported path command "${cmd}"`);
    }
  }
  if (pts.length < 4) throw new Error('a motion path needs at least two points');
  const len = [0];
  for (let k = 2; k < pts.length; k += 2) len.push(len[len.length - 1] + Math.hypot(pts[k] - pts[k - 2], pts[k + 1] - pts[k - 1]));
  const flat = { pts, len, total: len[len.length - 1] };
  if (cache.size > 500) cache.delete(cache.keys().next().value!);
  cache.set(d, flat);
  return flat;
}

/** Point and tangent angle (degrees) at a fraction (0..1) of the path's length. */
export function pointAt(f: FlatPath, frac: number): { x: number; y: number; angle: number } {
  const n = f.len.length;
  const target = Math.max(0, Math.min(1, frac)) * f.total;
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (f.len[mid] < target) lo = mid;
    else hi = mid;
  }
  // skip zero-length segments for the tangent
  let a = lo;
  let b = Math.max(hi, lo + 1);
  while (b < n - 1 && f.len[b] - f.len[a] < 1e-6) b++;
  while (a > 0 && f.len[b] - f.len[a] < 1e-6) a--;
  const seg = f.len[hi] - f.len[lo];
  const t = seg > 1e-9 ? (target - f.len[lo]) / seg : 0;
  const x = f.pts[lo * 2] + (f.pts[hi * 2] - f.pts[lo * 2]) * t;
  const y = f.pts[lo * 2 + 1] + (f.pts[hi * 2 + 1] - f.pts[lo * 2 + 1]) * t;
  const angle = (Math.atan2(f.pts[b * 2 + 1] - f.pts[a * 2 + 1], f.pts[b * 2] - f.pts[a * 2]) * 180) / Math.PI;
  return { x, y, angle };
}

/** An ellipse (or circle) as a path of cubic Béziers, starting at `startDeg`, `turns` times round. 0° = right, 90° = down. */
export function ellipsePath(cx: number, cy: number, rx: number, ry: number, startDeg = 0, turns = 1, clockwise = true): string {
  const total = Math.max(1e-3, Math.abs(turns)) * 2 * Math.PI * (clockwise ? 1 : -1);
  const segs = Math.max(1, Math.ceil(Math.abs(total) / (Math.PI / 2)));
  const step = total / segs;
  const k = (4 / 3) * Math.tan(step / 4);
  const at = (t: number): P => [cx + rx * Math.cos(t), cy + ry * Math.sin(t)];
  const dv = (t: number): P => [-rx * Math.sin(t), ry * Math.cos(t)];
  const r = (n: number) => +n.toFixed(2);
  let t0 = (startDeg * Math.PI) / 180;
  const p0 = at(t0);
  let d = `M${r(p0[0])} ${r(p0[1])}`;
  for (let s = 0; s < segs; s++) {
    const t1 = t0 + step;
    const a = at(t0);
    const b = at(t1);
    const da = dv(t0);
    const db = dv(t1);
    d += ` C${r(a[0] + k * da[0])} ${r(a[1] + k * da[1])} ${r(b[0] - k * db[0])} ${r(b[1] - k * db[1])} ${r(b[0])} ${r(b[1])}`;
    t0 = t1;
  }
  return d;
}

/** A smooth curve through points (Catmull-Rom → cubic Béziers). tension 0..1 (0.5 = classic). */
export function throughPath(points: [number, number][], tension = 0.5, closed = false): string {
  const r = (n: number) => +n.toFixed(2);
  if (points.length < 2) throw new Error('"through" needs at least two points');
  const pts = closed ? [...points, points[0]] : points;
  const get = (i: number): P => {
    if (closed) return points[((i % points.length) + points.length) % points.length];
    return pts[Math.max(0, Math.min(pts.length - 1, i))];
  };
  const k = tension / 3 * 2;
  let d = `M${r(pts[0][0])} ${r(pts[0][1])}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = get(i - 1);
    const p1 = get(i);
    const p2 = get(i + 1);
    const p3 = get(i + 2);
    const c1: P = [p1[0] + (p2[0] - p0[0]) * k / 2, p1[1] + (p2[1] - p0[1]) * k / 2];
    const c2: P = [p2[0] - (p3[0] - p1[0]) * k / 2, p2[1] - (p3[1] - p1[1]) * k / 2];
    d += ` C${r(c1[0])} ${r(c1[1])} ${r(c2[0])} ${r(c2[1])} ${r(p2[0])} ${r(p2[1])}`;
  }
  return d;
}
