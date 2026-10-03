import { ease } from './easing';
import { flattenPath, pointAt } from './motionpath';
import type { IRAnim, IRCounter, Keyframe, ClipDir } from './types';

/** Channels that multiply together (identity 1) and channels that add (identity 0). */
export const MUL_CHANNELS = ['opacity', 'scale', 'scaleX', 'scaleY', 'clip', 'draw', 'chars', 'brightness'] as const;
export const ADD_CHANNELS = ['dx', 'dy', 'rotate', 'blur', 'skewX', 'letterSpacing', 'hue', 'il', 'it', 'ir', 'ib', 'rad', 'rotX', 'rotY'] as const;
/** color overrides; bw/bh override the box size in px (morphs). */
export const OVERRIDE_CHANNELS = ['color', 'bw', 'bh'] as const;
export const ALL_CHANNELS: string[] = [...MUL_CHANNELS, ...ADD_CHANNELS, ...OVERRIDE_CHANNELS];

export interface ChannelState {
  opacity: number;
  scale: number;
  scaleX: number;
  scaleY: number;
  clip: number;
  draw: number;
  chars: number;
  brightness: number;
  dx: number;
  dy: number;
  rotate: number;
  blur: number;
  skewX: number;
  letterSpacing: number;
  hue: number;
  /** Clip insets in px (top, right, bottom, left) and the clip's corner radius. */
  il: number;
  it: number;
  ir: number;
  ib: number;
  rad: number;
  rotX: number;
  rotY: number;
  color?: string;
  bw?: number;
  bh?: number;
  clipDir?: ClipDir;
}

export const identityState = (): ChannelState => ({
  opacity: 1,
  scale: 1,
  scaleX: 1,
  scaleY: 1,
  clip: 1,
  draw: 1,
  chars: 1,
  brightness: 1,
  dx: 0,
  dy: 0,
  rotate: 0,
  blur: 0,
  skewX: 0,
  letterSpacing: 0,
  hue: 0,
  il: 0,
  it: 0,
  ir: 0,
  ib: 0,
  rad: 0,
  rotX: 0,
  rotY: 0,
});

// ---------- colours ----------
type RGBA = [number, number, number, number];

export function parseColor(c: string): RGBA | null {
  const s = c.trim().toLowerCase();
  if (s === 'transparent') return [0, 0, 0, 0];
  let m = /^#([0-9a-f]{3,8})$/.exec(s);
  if (m) {
    const h = m[1];
    if (h.length === 3 || h.length === 4) {
      const r = parseInt(h[0] + h[0], 16);
      const g = parseInt(h[1] + h[1], 16);
      const b = parseInt(h[2] + h[2], 16);
      const a = h.length === 4 ? parseInt(h[3] + h[3], 16) / 255 : 1;
      return [r, g, b, a];
    }
    if (h.length === 6 || h.length === 8) {
      const r = parseInt(h.slice(0, 2), 16);
      const g = parseInt(h.slice(2, 4), 16);
      const b = parseInt(h.slice(4, 6), 16);
      const a = h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
      return [r, g, b, a];
    }
    return null;
  }
  m = /^rgba?\(([^)]+)\)$/.exec(s);
  if (m) {
    const p = m[1].split(/[,\s/]+/).filter(Boolean).map(Number);
    if (p.length < 3 || p.some((n) => Number.isNaN(n))) return null;
    return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1];
  }
  return null;
}

const rgbaStr = (c: RGBA) => `rgba(${Math.round(c[0])},${Math.round(c[1])},${Math.round(c[2])},${+c[3].toFixed(3)})`;

export function mixColor(a: string, b: string, t: number): string {
  const ca = parseColor(a);
  const cb = parseColor(b);
  if (!ca || !cb) return t < 0.5 ? a : b;
  return rgbaStr([0, 1, 2, 3].map((i) => ca[i] + (cb[i] - ca[i]) * t) as RGBA);
}

/** Apply alpha (0..1) to a colour string. */
export function withAlpha(c: string, alpha: number): string {
  const p = parseColor(c);
  if (!p) return c;
  return rgbaStr([p[0], p[1], p[2], p[3] * alpha]);
}

// ---------- keyframes ----------
export function sampleTrack(track: Keyframe[], t: number): number | string {
  if (track.length === 0) return 0;
  if (t <= track[0][0]) return track[0][1];
  const last = track[track.length - 1];
  if (t >= last[0]) return last[1];
  for (let i = 0; i < track.length - 1; i++) {
    const a = track[i];
    const b = track[i + 1];
    if (t >= a[0] && t <= b[0]) {
      const span = b[0] - a[0];
      const p = span <= 0 ? 1 : (t - a[0]) / span;
      const k = ease(b[2], p);
      if (typeof a[1] === 'number' && typeof b[1] === 'number') return a[1] + (b[1] - a[1]) * k;
      return mixColor(String(a[1]), String(b[1]), k);
    }
  }
  return last[1];
}

function animProgress(anim: IRAnim, localFrame: number): number {
  const len = Math.max(1, anim.e - anim.s);
  if (anim.loop) {
    if (localFrame < anim.s) return 0;
    return ((localFrame - anim.s) % len) / len;
  }
  const t = (localFrame - anim.s) / len;
  return t < 0 ? 0 : t > 1 ? 1 : t;
}

/**
 * Combine every anim on a layer at a given local frame.
 * `unitOffset` shifts unit anims (stagger) — pass 0 for the whole layer and skip unit anims via `which`.
 */
export function evaluateAnims(
  anims: IRAnim[],
  localFrame: number,
  which: 'all' | 'layer' | 'unit' = 'all',
  unitOffset = 0,
): ChannelState {
  const st = identityState();
  for (const anim of anims) {
    if (which === 'layer' && anim.unit) continue;
    if (which === 'unit' && !anim.unit) continue;
    const t = animProgress(anim, localFrame - (anim.unit ? unitOffset : 0));
    if (anim.clipDir) st.clipDir = anim.clipDir;
    for (const ch in anim.tracks) {
      const v = sampleTrack(anim.tracks[ch], t);
      if (ch === 'color') {
        st.color = String(v);
        continue;
      }
      const n = typeof v === 'number' ? v : parseFloat(v);
      if (Number.isNaN(n)) continue;
      if (ch === 'bw' || ch === 'bh') {
        if (t > 0 || anim.s <= localFrame) st[ch] = n;
        continue;
      }
      if ((MUL_CHANNELS as readonly string[]).includes(ch)) (st as any)[ch] *= n;
      else if ((ADD_CHANNELS as readonly string[]).includes(ch)) (st as any)[ch] += n;
    }
    if (anim.path) {
      try {
        const f = flattenPath(anim.path.d);
        const a = anim.path.from ?? 0;
        const b = anim.path.to ?? 1;
        const p0 = pointAt(f, a);
        const p = pointAt(f, a + (b - a) * ease(anim.path.ease ?? 'linear', t));
        st.dx += p.x - p0.x;
        st.dy += p.y - p0.y;
        if (anim.path.orient !== undefined) {
          let da = p.angle - p0.angle;
          while (da > 180) da -= 360;
          while (da < -180) da += 360;
          st.rotate += da;
        }
      } catch {
        /* invalid paths are reported by the compiler */
      }
    }
  }
  return st;
}

export function formatNumber(v: number, decimals = 0, sep = ','): string {
  const fixed = Math.abs(v).toFixed(decimals);
  const [int, dec] = fixed.split('.');
  const grouped = sep ? int.replace(/\B(?=(\d{3})+(?!\d))/g, sep) : int;
  return (v < 0 ? '-' : '') + grouped + (dec ? '.' + dec : '');
}

export function counterText(c: IRCounter, localFrame: number): string {
  const len = Math.max(1, c.e - c.s);
  const p = ease(c.ease ?? 'outExpo', (localFrame - c.s) / len);
  const v = c.from + (c.to - c.from) * p;
  return (c.prefix ?? '') + formatNumber(v, c.decimals ?? 0, c.sep ?? ',') + (c.suffix ?? '');
}

export function clipPath(clip: number, dir: ClipDir = 'left'): string | undefined {
  if (clip >= 0.9999) return undefined;
  const r = Math.max(0, 1 - clip) * 100;
  switch (dir) {
    case 'left':
      return `inset(0 ${r}% 0 0)`;
    case 'right':
      return `inset(0 0 0 ${r}%)`;
    case 'top':
      return `inset(0 0 ${r}% 0)`;
    case 'bottom':
      return `inset(${r}% 0 0 0)`;
    case 'center':
      return `inset(0 ${r / 2}% 0 ${r / 2}%)`;
    case 'circle':
      return `circle(${Math.max(0, clip) * 75}% at 50% 50%)`;
  }
}

/** Inset clip from the inset channels, or undefined. */
export function insetClip(st: ChannelState): string | undefined {
  if (!st.il && !st.it && !st.ir && !st.ib && !st.rad) return undefined;
  const f = (n: number) => `${Math.max(0, n).toFixed(1)}px`;
  return `inset(${f(st.it)} ${f(st.ir)} ${f(st.ib)} ${f(st.il)}${st.rad ? ` round ${f(st.rad)}` : ''})`;
}

/** Map a layer-local frame through a time map to the child's frame. */
export function mapTime(segs: [number, number, number, number][], lf: number): number {
  if (!segs.length) return lf;
  if (lf <= segs[0][0]) return segs[0][2];
  for (const [a, b, c, d] of segs) {
    if (lf >= a && lf < b) return c + ((lf - a) / Math.max(1e-9, b - a)) * (d - c);
  }
  return segs[segs.length - 1][3];
}
