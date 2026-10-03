/**
 * Explanatory simulations: {"type":"sim", "kind": …, "w", "h", …}
 *  algorithms (stepped, deterministic):
 *   - "sort":     {"algorithm":"bubble|insertion|selection|quick|merge", "values":[5,2,8…] | "n":16, "speed": steps per second}
 *   - "search":   {"values":[sorted…], "target": 42}                 (binary search)
 *   - "pathfind": {"algorithm":"bfs|dijkstra|astar|dfs", "grid":["S..#....","..##..G."] | {"cols","rows","walls","start","goal"}}
 *  physics (integrated at compile time, every parameter can be keyframed: "gravity": [[0, 9.8], [3, 2]]):
 *   - "pendulum": {"length":1.2, "angle":40, "gravity":9.81, "damping":0.05, "count":1}
 *   - "spring":   {"k":20, "mass":1, "damping":0.4, "x0":1}
 *   - "projectile": {"speed":18, "angle":55, "gravity":9.81, "drag":0, "count":1, "spread":10}
 *   - "orbit":    {"bodies":[{"r":1,"v":1,"mass":…}], "gm":1, "trail":true}
 *   - "particles":{"n":80, "temperature":1, "gravity":0, "walls":true}     (gas / Brownian motion)
 *   - "wave":     {"frequency":1, "amplitude":1, "wavelength":1, "damping":0, "sources":1}
 * "speed" scales time, "start" delays the run (seconds), "labels" toggles the readouts.
 */
import { isObj } from '../../core/util';
import type { IRLayer } from '../../ir/types';
import type { Session } from '../compile';
import { registerLayer } from '../registry';
import { dropEmpty, palette, vizStyle } from './data';

export interface SimIR {
  kind: string;
  w: number;
  h: number;
  start: number;
  style: ReturnType<typeof vizStyle>;
  colors: string[];
  labels: boolean;
  /** Readout words, e.g. {"comparisons": "comparaisons"}. */
  words: Record<string, string>;
  /** Algorithms: list of steps and frames per step. */
  values?: number[];
  steps?: any[];
  stepFrames?: number;
  algorithm?: string;
  target?: number;
  grid?: { cols: number; rows: number; walls: number[]; start: number; goal: number };
  /** Physics: per-frame state (rounded) and static info. */
  states?: number[][];
  info?: Record<string, any>;
}

function param(S: Session, v: unknown, def: number, path: string): (t: number) => number {
  if (v === undefined) return () => def;
  if (typeof v === 'number') return () => v;
  if (Array.isArray(v) && v.every((k) => Array.isArray(k) && k.length >= 2)) {
    const ks = (v as [number, number][]).map((k) => [Number(k[0]), Number(k[1])] as [number, number]).sort((a, b) => a[0] - b[0]);
    return (t) => {
      if (t <= ks[0][0]) return ks[0][1];
      for (let i = 1; i < ks.length; i++) if (t <= ks[i][0]) {
        const u = (t - ks[i - 1][0]) / (ks[i][0] - ks[i - 1][0] || 1);
        const s = u * u * (3 - 2 * u);
        return ks[i - 1][1] + (ks[i][1] - ks[i - 1][1]) * s;
      }
      return ks[ks.length - 1][1];
    };
  }
  const n = Number(v);
  if (Number.isFinite(n)) return () => n;
  S.err(path, 'a simulation parameter is a number or keyframes [[seconds, value], …]');
  return () => def;
}

function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

// ---------- algorithms ----------
function sortSteps(algo: string, input: number[]) {
  const a = [...input];
  const steps: any[] = [];
  const cmp = (i: number, j: number) => steps.push({ op: 'cmp', i, j });
  const swap = (i: number, j: number) => {
    if (i === j) return;
    [a[i], a[j]] = [a[j], a[i]];
    steps.push({ op: 'swap', i, j });
  };
  const done = (i: number) => steps.push({ op: 'done', i });
  const n = a.length;
  if (algo === 'bubble') {
    for (let end = n - 1; end > 0; end--) {
      let swapped = false;
      for (let i = 0; i < end; i++) {
        cmp(i, i + 1);
        if (a[i] > a[i + 1]) {
          swap(i, i + 1);
          swapped = true;
        }
      }
      done(end);
      if (!swapped) {
        for (let k = end - 1; k >= 0; k--) done(k);
        break;
      }
    }
    done(0);
  } else if (algo === 'insertion') {
    for (let i = 1; i < n; i++) {
      let j = i;
      while (j > 0) {
        cmp(j - 1, j);
        if (a[j - 1] > a[j]) {
          swap(j - 1, j);
          j--;
        } else break;
      }
    }
    for (let i = 0; i < n; i++) done(i);
  } else if (algo === 'selection') {
    for (let i = 0; i < n; i++) {
      let m = i;
      for (let j = i + 1; j < n; j++) {
        cmp(m, j);
        if (a[j] < a[m]) m = j;
      }
      swap(i, m);
      done(i);
    }
  } else if (algo === 'quick') {
    const qs = (lo: number, hi: number) => {
      if (lo > hi) return;
      if (lo === hi) return done(lo);
      steps.push({ op: 'pivot', i: hi });
      let p = lo;
      for (let j = lo; j < hi; j++) {
        cmp(j, hi);
        if (a[j] < a[hi]) {
          swap(p, j);
          p++;
        }
      }
      swap(p, hi);
      done(p);
      qs(lo, p - 1);
      qs(p + 1, hi);
    };
    qs(0, n - 1);
  } else if (algo === 'merge') {
    // in-place style merge (rotations as a series of swaps keeps the bars continuous)
    const ms = (lo: number, hi: number) => {
      if (hi - lo < 1) return;
      let mid = Math.floor((lo + hi) / 2);
      ms(lo, mid);
      ms(mid + 1, hi);
      let i = lo;
      let j = mid + 1;
      while (i <= mid && j <= hi) {
        cmp(i, j);
        if (a[i] <= a[j]) i++;
        else {
          for (let k = j; k > i; k--) swap(k - 1, k);
          i++;
          mid++;
          j++;
        }
      }
    };
    ms(0, n - 1);
    for (let i = 0; i < n; i++) done(i);
  }
  return steps;
}

function binarySearchSteps(values: number[], target: number) {
  const steps: any[] = [];
  let lo = 0;
  let hi = values.length - 1;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    steps.push({ op: 'range', lo, hi, mid });
    if (values[mid] === target) {
      steps.push({ op: 'found', mid });
      return steps;
    }
    if (values[mid] < target) lo = mid + 1;
    else hi = mid - 1;
  }
  steps.push({ op: 'missing' });
  return steps;
}

function parseGrid(S: Session, g: unknown, path: string) {
  if (Array.isArray(g) && g.every((r) => typeof r === 'string')) {
    const rows = g as string[];
    const cols = Math.max(...rows.map((r) => r.length));
    const walls: number[] = [];
    let start = 0;
    let goal = cols * rows.length - 1;
    rows.forEach((r, y) =>
      [...r.padEnd(cols, '.')].forEach((ch, x) => {
        const i = y * cols + x;
        if (ch === '#') walls.push(i);
        if (ch === 'S') start = i;
        if (ch === 'G') goal = i;
      }),
    );
    return { cols, rows: rows.length, walls, start, goal };
  }
  if (isObj(g)) {
    const cols = Number(g.cols ?? 20);
    const rows = Number(g.rows ?? 12);
    const at = (p: any) => (Array.isArray(p) ? Number(p[1]) * cols + Number(p[0]) : Number(p));
    let walls: number[] = Array.isArray(g.walls) ? g.walls.map(at) : [];
    if (g.random) {
      const r = rng(Number(g.seed ?? 3));
      walls = [];
      for (let i = 0; i < cols * rows; i++) if (r() < Number(g.random)) walls.push(i);
    }
    const start = g.start !== undefined ? at(g.start) : 0;
    const goal = g.goal !== undefined ? at(g.goal) : cols * rows - 1;
    walls = walls.filter((w) => w !== start && w !== goal);
    return { cols, rows, walls, start, goal };
  }
  S.err(path, 'grid is ["S..#", "..#G"] (S start, G goal, # wall) or {"cols", "rows", "walls":[[x,y]…], "random":0.25, "start":[x,y], "goal":[x,y]}');
  return null;
}

function pathfindSteps(algo: string, g: { cols: number; rows: number; walls: number[]; start: number; goal: number }) {
  const wall = new Set(g.walls);
  const N = g.cols * g.rows;
  const prev = new Int32Array(N).fill(-1);
  const dist = new Float64Array(N).fill(Infinity);
  const seen = new Uint8Array(N);
  const visits: number[] = [];
  const nb = (i: number) => {
    const x = i % g.cols;
    const y = Math.floor(i / g.cols);
    const out: number[] = [];
    if (x > 0) out.push(i - 1);
    if (x < g.cols - 1) out.push(i + 1);
    if (y > 0) out.push(i - g.cols);
    if (y < g.rows - 1) out.push(i + g.cols);
    return out.filter((k) => !wall.has(k));
  };
  const hdist = (i: number) => Math.abs((i % g.cols) - (g.goal % g.cols)) + Math.abs(Math.floor(i / g.cols) - Math.floor(g.goal / g.cols));
  dist[g.start] = 0;
  if (algo === 'dfs') {
    const stack = [g.start];
    while (stack.length) {
      const i = stack.pop()!;
      if (seen[i]) continue;
      seen[i] = 1;
      visits.push(i);
      if (i === g.goal) break;
      for (const k of nb(i).reverse()) if (!seen[k]) {
        prev[k] = i;
        stack.push(k);
      }
    }
  } else {
    // bfs = dijkstra on unit weights; astar adds the heuristic
    const open: number[] = [g.start];
    while (open.length) {
      let bi = 0;
      for (let k = 1; k < open.length; k++) {
        const f = (x: number) => dist[x] + (algo === 'astar' ? hdist(x) : 0);
        if (f(open[k]) < f(open[bi])) bi = k;
      }
      const i = algo === 'bfs' ? open.shift()! : open.splice(bi, 1)[0];
      if (seen[i]) continue;
      seen[i] = 1;
      visits.push(i);
      if (i === g.goal) break;
      for (const k of nb(i)) if (!seen[k] && dist[i] + 1 < dist[k]) {
        dist[k] = dist[i] + 1;
        prev[k] = i;
        open.push(k);
      }
    }
  }
  const path: number[] = [];
  if (seen[g.goal]) for (let k = g.goal; k >= 0; k = prev[k]) path.unshift(k);
  return { visits, path };
}

// ---------- physics ----------
const r1 = (v: number) => Math.round(v * 1000) / 1000;

function physics(S: Session, kind: string, n: Record<string, any>, frames: number, path: string): { states: number[][]; info: Record<string, any> } | null {
  const fps = S.fps;
  const sub = 8;
  const dt = 1 / fps / sub;
  const speed = Number(n.speed ?? 1);
  const P = (k: string, d: number) => param(S, n[k], d, `${path}.${k}`);
  const states: number[][] = [];
  if (kind === 'pendulum') {
    const L = P('length', 1.2);
    const g = P('gravity', 9.81);
    const damp = P('damping', 0.02);
    const count = Math.max(1, Math.min(12, Number(n.count ?? 1)));
    // count > 1: pendulum wave (lengths chosen so they drift in and out of phase)
    const th = Array.from({ length: count }, () => (Number(n.angle ?? 40) * Math.PI) / 180);
    const om = new Array(count).fill(0);
    const lens = Array.from({ length: count }, (_, i) => (count === 1 ? 1 : 1 / Math.pow((51 + i) / 51, 2)));
    let t = 0;
    for (let f = 0; f < frames; f++) {
      states.push(th.map(r1));
      for (let s = 0; s < sub; s++) {
        for (let i = 0; i < count; i++) {
          const l = L(t) * lens[i];
          const acc = (-g(t) / l) * Math.sin(th[i]) - damp(t) * om[i];
          om[i] += acc * dt * speed;
          th[i] += om[i] * dt * speed;
        }
        t += dt * speed;
      }
    }
    return { states, info: { count, lens: lens.map(r1), length: L(0) } };
  }
  if (kind === 'spring') {
    const k = P('k', 20);
    const m = P('mass', 1);
    const c = P('damping', 0.4);
    let x = Number(n.x0 ?? 1);
    let v = 0;
    let t = 0;
    for (let f = 0; f < frames; f++) {
      states.push([r1(x), r1(v)]);
      for (let s = 0; s < sub; s++) {
        const a = (-k(t) * x - c(t) * v) / m(t);
        v += a * dt * speed;
        x += v * dt * speed;
        t += dt * speed;
      }
    }
    return { states, info: { x0: Number(n.x0 ?? 1) } };
  }
  if (kind === 'projectile') {
    const g = P('gravity', 9.81);
    const drag = P('drag', 0);
    const count = Math.max(1, Math.min(9, Number(n.count ?? 1)));
    const spread = Number(n.spread ?? 10);
    const v0 = Number(n.speed0 ?? n.velocity ?? 18);
    const bodies = Array.from({ length: count }, (_, i) => {
      const ang = ((Number(n.angle ?? 55) + (count > 1 ? (i - (count - 1) / 2) * spread : 0)) * Math.PI) / 180;
      return { x: 0, y: 0, vx: v0 * Math.cos(ang), vy: v0 * Math.sin(ang), landed: false };
    });
    let t = 0;
    let maxX = 1;
    let maxY = 1;
    for (let f = 0; f < frames; f++) {
      states.push(bodies.flatMap((b) => [r1(b.x), r1(b.y)]));
      for (let s = 0; s < sub; s++) {
        for (const b of bodies) {
          if (b.landed) continue;
          const sp = Math.hypot(b.vx, b.vy);
          b.vx += -drag(t) * sp * b.vx * dt * speed;
          b.vy += (-g(t) - drag(t) * sp * b.vy) * dt * speed;
          b.x += b.vx * dt * speed;
          b.y += b.vy * dt * speed;
          if (b.y < 0) {
            b.y = 0;
            b.landed = true;
          }
          maxX = Math.max(maxX, b.x);
          maxY = Math.max(maxY, b.y);
        }
        t += dt * speed;
      }
    }
    return { states, info: { count, maxX: r1(maxX), maxY: r1(maxY) } };
  }
  if (kind === 'orbit') {
    const gm = P('gm', 1);
    const bodies = (Array.isArray(n.bodies) ? n.bodies : [{ r: 1, v: 1 }, { r: 1.8, v: 0.9 }]).map((b: any) => {
      const r = Number(b.r ?? 1);
      const vCirc = Math.sqrt(1 / r);
      return { x: r, y: 0, vx: 0, vy: vCirc * Number(b.v ?? 1) };
    });
    let t = 0;
    const tscale = Number(n.timescale ?? 2.5);
    for (let f = 0; f < frames; f++) {
      states.push(bodies.flatMap((b: any) => [r1(b.x), r1(b.y)]));
      for (let s = 0; s < sub; s++) {
        for (const b of bodies) {
          const d = Math.hypot(b.x, b.y);
          const a = gm(t) / (d * d * d);
          b.vx -= a * b.x * dt * speed * tscale;
          b.vy -= a * b.y * dt * speed * tscale;
          b.x += b.vx * dt * speed * tscale;
          b.y += b.vy * dt * speed * tscale;
        }
        t += dt * speed;
      }
    }
    const maxR = Math.max(1, ...states.flatMap((st) => st.map(Math.abs)));
    return { states, info: { count: bodies.length, maxR: r1(maxR), trail: n.trail !== false } };
  }
  if (kind === 'particles') {
    const N = Math.max(2, Math.min(400, Number(n.n ?? 80)));
    const temp = P('temperature', 1);
    const g = P('gravity', 0);
    const r = rng(Number(n.seed ?? 5));
    const ps = Array.from({ length: N }, () => ({ x: r(), y: r(), vx: (r() - 0.5) * 0.6, vy: (r() - 0.5) * 0.6 }));
    let t = 0;
    for (let f = 0; f < frames; f++) {
      states.push(ps.flatMap((p) => [r1(p.x), r1(p.y)]));
      for (let s = 0; s < sub; s++) {
        const T = Math.sqrt(Math.max(0, temp(t)));
        for (const p of ps) {
          // thermostat: nudge speeds towards the temperature, plus Brownian kicks
          const sp = Math.hypot(p.vx, p.vy) || 1e-6;
          const target = 0.35 * T;
          p.vx += (p.vx / sp) * (target - sp) * 0.02 + (r() - 0.5) * 0.02 * T;
          p.vy += (p.vy / sp) * (target - sp) * 0.02 + (r() - 0.5) * 0.02 * T - g(t) * dt;
          p.x += p.vx * dt * speed;
          p.y += p.vy * dt * speed;
          if (p.x < 0 || p.x > 1) {
            p.vx *= -1;
            p.x = Math.max(0, Math.min(1, p.x));
          }
          if (p.y < 0 || p.y > 1) {
            p.vy *= -1;
            p.y = Math.max(0, Math.min(1, p.y));
          }
        }
        t += dt * speed;
      }
    }
    return { states, info: { count: N } };
  }
  if (kind === 'wave') {
    const fq = P('frequency', 1);
    const amp = P('amplitude', 1);
    const wl = P('wavelength', 1);
    const damp = P('damping', 0);
    const sources = Math.max(1, Math.min(3, Number(n.sources ?? 1)));
    // phase accumulates so frequency changes stay continuous
    let ph = 0;
    for (let f = 0; f < frames; f++) {
      const t = (f / fps) * speed;
      states.push([r1(ph), r1(amp(t)), r1(wl(t)), r1(damp(t))]);
      ph += 2 * Math.PI * fq(t) * (speed / fps);
    }
    return { states, info: { sources } };
  }
  return null;
}

const ALGO_KINDS = ['sort', 'search', 'pathfind'];
const PHYS_KINDS = ['pendulum', 'spring', 'projectile', 'orbit', 'particles', 'wave'];

registerLayer('sim', {
  keys: ['kind', 'settings', 'words', 'algorithm', 'values', 'n', 'seed', 'target', 'grid', 'speed', 'start', 'labels', 'colors', 'length', 'angle', 'gravity', 'damping', 'count', 'k', 'mass', 'x0', 'velocity', 'speed0', 'drag', 'spread', 'bodies', 'gm', 'trail', 'timescale', 'temperature', 'walls', 'frequency', 'amplitude', 'wavelength', 'sources', 'labelSize', 'color', 'muted', 'font'],
  compile(S, c) {
    const n0 = dropEmpty(c.node);
    // "settings": {…} lets presets pass any parameter set through one param
    const n = isObj(n0.settings) ? { ...n0.settings, ...n0, settings: undefined } : n0;
    const kind = String(n.kind ?? '');
    if (![...ALGO_KINDS, ...PHYS_KINDS].includes(kind)) {
      S.err(`${c.path}.kind`, `kind is one of ${[...ALGO_KINDS, ...PHYS_KINDS].join(', ')}`);
      return [];
    }
    const w = Number(c.base.w ?? Math.round(S.W * 0.7));
    const h = Number(c.base.h ?? Math.round(S.H * 0.65));
    const start = S.frames(Number(n.start ?? 0.4));
    const ir: SimIR = { kind, w, h, start, style: vizStyle(S, n), colors: palette(S, n), labels: n.labels !== false, words: isObj(n.words) ? Object.fromEntries(Object.entries(n.words).map(([k, v]) => [k, String(v)])) : {} };
    const runFrames = Math.max(1, c.lenFrames - start);
    if (kind === 'sort' || kind === 'search') {
      let values: number[] = Array.isArray(n.values) ? n.values.map(Number) : [];
      if (!values.length) {
        const r = rng(Number(n.seed ?? 7));
        const N = Math.max(4, Math.min(80, Number(n.n ?? 16)));
        values = Array.from({ length: N }, (_, i) => i + 1);
        for (let i = N - 1; i > 0; i--) {
          const j = Math.floor(r() * (i + 1));
          [values[i], values[j]] = [values[j], values[i]];
        }
        if (kind === 'search') values.sort((a, b) => a - b);
      }
      ir.values = values;
      if (kind === 'sort') {
        const algo = String(n.algorithm ?? 'bubble');
        if (!['bubble', 'insertion', 'selection', 'quick', 'merge'].includes(algo)) S.err(`${c.path}.algorithm`, 'algorithm is bubble, insertion, selection, quick or merge');
        ir.algorithm = algo;
        ir.steps = sortSteps(algo, values);
      } else {
        const sorted = [...values].sort((a, b) => a - b);
        if (sorted.join() !== values.join()) S.warn(`${c.path}.values`, 'binary search needs sorted values; they were sorted');
        ir.values = sorted;
        ir.target = Number(n.target ?? sorted[Math.floor(sorted.length * 0.7)]);
        ir.steps = binarySearchSteps(sorted, ir.target);
      }
      // fit the run into the layer unless "speed" (steps per second) is given
      ir.stepFrames = n.speed !== undefined ? Math.max(0.05, S.fps / Number(n.speed)) : Math.max(0.05, (runFrames * 0.85) / Math.max(1, ir.steps.length));
      if (kind === 'search') ir.stepFrames = Math.max(ir.stepFrames, S.fps * 0.5);
    } else if (kind === 'pathfind') {
      const g = parseGrid(S, n.grid ?? { cols: 24, rows: 13, random: 0.22 }, `${c.path}.grid`);
      if (!g) return [];
      const algo = String(n.algorithm ?? 'astar');
      if (!['bfs', 'dijkstra', 'astar', 'dfs'].includes(algo)) S.err(`${c.path}.algorithm`, 'algorithm is bfs, dijkstra, astar or dfs');
      const r = pathfindSteps(algo, g);
      if (!r.path.length) S.warn(c.path, 'the goal cannot be reached on this grid');
      ir.grid = g;
      ir.algorithm = algo;
      ir.steps = [r.visits, r.path];
      const total = r.visits.length + r.path.length * 0.6;
      ir.stepFrames = n.speed !== undefined ? S.fps / Number(n.speed) : Math.max(0.05, (runFrames * 0.85) / Math.max(1, total));
    } else {
      const ph = physics(S, kind, n, runFrames, c.path);
      if (!ph) return [];
      ir.states = ph.states;
      ir.info = ph.info;
    }
    const layer: IRLayer = { ...(c.base as IRLayer), type: 'sim', w, h, style: {}, anims: [], data: ir };
    return [layer];
  },
});
