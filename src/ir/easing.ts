/** Easing functions shared by the compiler (validation) and the IRPlayer (evaluation). */

export type EaseFn = (t: number) => number;

const clamp01 = (t: number) => (t < 0 ? 0 : t > 1 ? 1 : t);

export function cubicBezier(x1: number, y1: number, x2: number, y2: number): EaseFn {
  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;
  const sampleX = (t: number) => ((ax * t + bx) * t + cx) * t;
  const sampleY = (t: number) => ((ay * t + by) * t + cy) * t;
  const sampleDX = (t: number) => (3 * ax * t + 2 * bx) * t + cx;
  const solveX = (x: number) => {
    let t = x;
    for (let i = 0; i < 8; i++) {
      const err = sampleX(t) - x;
      if (Math.abs(err) < 1e-6) return t;
      const d = sampleDX(t);
      if (Math.abs(d) < 1e-6) break;
      t -= err / d;
    }
    let lo = 0;
    let hi = 1;
    t = x;
    for (let i = 0; i < 30; i++) {
      const v = sampleX(t);
      if (Math.abs(v - x) < 1e-6) return t;
      if (x > v) lo = t;
      else hi = t;
      t = (lo + hi) / 2;
    }
    return t;
  };
  return (t: number) => {
    if (t <= 0) return 0;
    if (t >= 1) return 1;
    return sampleY(solveX(t));
  };
}

function spring(bounce: number): EaseFn {
  const b = Math.max(0, Math.min(0.95, bounce));
  const zeta = 1 - b;
  if (zeta >= 0.999) {
    const w = 9;
    return (t) => (t >= 1 ? 1 : 1 - Math.exp(-w * t) * (1 + w * t));
  }
  const w0 = 6.5 / zeta;
  const wd = w0 * Math.sqrt(1 - zeta * zeta);
  return (t) => {
    if (t <= 0) return 0;
    if (t >= 1) return 1;
    const env = Math.exp(-zeta * w0 * t);
    return 1 - env * (Math.cos(wd * t) + ((zeta * w0) / wd) * Math.sin(wd * t));
  };
}

const c1 = 1.70158;
const c3 = c1 + 1;
const c2 = c1 * 1.525;

const NAMED: Record<string, EaseFn> = {
  linear: (t) => t,
  ease: cubicBezier(0.25, 0.1, 0.25, 1),
  in: (t) => t * t * t,
  out: (t) => 1 - Math.pow(1 - t, 3),
  inOut: (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
  inQuad: (t) => t * t,
  outQuad: (t) => 1 - (1 - t) * (1 - t),
  inOutQuad: (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2),
  inExpo: (t) => (t === 0 ? 0 : Math.pow(2, 10 * t - 10)),
  outExpo: (t) => (t === 1 ? 1 : 1 - Math.pow(2, -10 * t)),
  inOutExpo: (t) =>
    t === 0 ? 0 : t === 1 ? 1 : t < 0.5 ? Math.pow(2, 20 * t - 10) / 2 : (2 - Math.pow(2, -20 * t + 10)) / 2,
  inBack: (t) => c3 * t * t * t - c1 * t * t,
  outBack: (t) => 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2),
  inOutBack: (t) =>
    t < 0.5
      ? (Math.pow(2 * t, 2) * ((c2 + 1) * 2 * t - c2)) / 2
      : (Math.pow(2 * t - 2, 2) * ((c2 + 1) * (t * 2 - 2) + c2) + 2) / 2,
  outElastic: (t) =>
    t === 0 ? 0 : t === 1 ? 1 : Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * ((2 * Math.PI) / 3)) + 1,
  outBounce: (t) => {
    const n1 = 7.5625;
    const d1 = 2.75;
    if (t < 1 / d1) return n1 * t * t;
    if (t < 2 / d1) return n1 * (t -= 1.5 / d1) * t + 0.75;
    if (t < 2.5 / d1) return n1 * (t -= 2.25 / d1) * t + 0.9375;
    return n1 * (t -= 2.625 / d1) * t + 0.984375;
  },
  snap: cubicBezier(0.2, 0.9, 0.1, 1),
  smooth: cubicBezier(0.45, 0, 0.2, 1),
  hold: (t) => (t >= 1 ? 1 : 0),
  inSine: (t) => 1 - Math.cos((t * Math.PI) / 2),
  outSine: (t) => Math.sin((t * Math.PI) / 2),
  inOutSine: (t) => -(Math.cos(Math.PI * t) - 1) / 2,
  inQuart: (t) => t * t * t * t,
  outQuart: (t) => 1 - Math.pow(1 - t, 4),
  inOutQuart: (t) => (t < 0.5 ? 8 * t * t * t * t : 1 - Math.pow(-2 * t + 2, 4) / 2),
  inQuint: (t) => t * t * t * t * t,
  outQuint: (t) => 1 - Math.pow(1 - t, 5),
  inOutQuint: (t) => (t < 0.5 ? 16 * t * t * t * t * t : 1 - Math.pow(-2 * t + 2, 5) / 2),
  inCirc: (t) => 1 - Math.sqrt(1 - t * t),
  outCirc: (t) => Math.sqrt(1 - Math.pow(t - 1, 2)),
  inOutCirc: (t) => (t < 0.5 ? (1 - Math.sqrt(1 - Math.pow(2 * t, 2))) / 2 : (Math.sqrt(1 - Math.pow(-2 * t + 2, 2)) + 1) / 2),
};
// common long names (CSS / GSAP / easings.net) for the cubic family
NAMED.inCubic = NAMED.in;
NAMED.outCubic = NAMED.out;
NAMED.inOutCubic = NAMED.inOut;
NAMED.easeIn = NAMED.in;
NAMED.easeOut = NAMED.out;
NAMED.easeInOut = NAMED.inOut;

export const EASING_NAMES = Object.keys(NAMED);

const cache = new Map<string, EaseFn>();

/** Parse an easing string. Returns null when invalid (the compiler reports it). */
export function parseEasing(spec: string | undefined | null): EaseFn | null {
  if (!spec) return NAMED.linear;
  const hit = cache.get(spec);
  if (hit) return hit;
  let fn: EaseFn | null = NAMED[spec] ?? null;
  if (!fn) {
    const m = /^(cubic|spring|steps)\(([^)]*)\)$/.exec(spec.replace(/\s+/g, ''));
    if (m) {
      const args = m[2].split(',').filter(Boolean).map(Number);
      if (args.some((n) => Number.isNaN(n))) return null;
      if (m[1] === 'cubic' && args.length === 4) fn = cubicBezier(args[0], args[1], args[2], args[3]);
      else if (m[1] === 'spring') fn = spring(args.length ? args[0] : 0.3);
      else if (m[1] === 'steps' && args.length >= 1 && args[0] >= 1) {
        const n = Math.round(args[0]);
        fn = (t) => (t >= 1 ? 1 : Math.floor(t * n) / n);
      }
    }
  }
  if (fn) cache.set(spec, fn);
  return fn;
}

export function ease(spec: string | undefined, t: number): number {
  const fn = parseEasing(spec) ?? NAMED.linear;
  return fn(clamp01(t));
}
