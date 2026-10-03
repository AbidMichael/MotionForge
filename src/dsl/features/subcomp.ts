/**
 * Sub-compositions: {"type":"comp", "src": "cmp_x" | "lib:preset" | {…composition}, "props": {…},
 *   "w", "h", "fit": "cover|contain|fill|none", "focus": [fx, fy], "zoom", "radius", "mask",
 *   "time": {"start", "end", "speed", "loop", "pauses": [{"at", "d"}], "hold": "last|first|none", "delay"},
 *   "cache": true}
 * The child is compiled on its own (its own format, theme, params) and embedded as a group with a
 * time map, so it keeps its own clock: trimmed, sped up, looped, paused or frozen on its last frame.
 */
import { sha256, stableStringify, isObj } from '../../core/util';
import type { IRLayer, IRMarker } from '../../ir/types';
import { compileChild, maskCss, parseFormat, type CompileResult, type Session } from '../compile';
import { registerLayer, type NodeCtx } from '../registry';
import { toPx } from '../bind';

const memo = new Map<string, CompileResult>();

function memoCompile(S: Session, key: unknown, run: () => CompileResult): CompileResult {
  const k = sha256(stableStringify(key));
  const hit = memo.get(k);
  if (hit) {
    memo.delete(k);
    memo.set(k, hit);
    return hit;
  }
  const r = run();
  memo.set(k, r);
  if (memo.size > 60) memo.delete(memo.keys().next().value!);
  return r;
}

export interface TimeSpec {
  start?: number;
  end?: number;
  speed?: number;
  loop?: boolean | number;
  pauses?: { at: number; d: number }[];
  hold?: 'last' | 'first' | 'none';
  delay?: number;
}

/**
 * Build time-map segments (parent frames → child frames).
 * Returns the segments and how many parent frames the playback lasts (Infinity when it loops forever).
 */
export function buildTimeMap(spec: TimeSpec, childFrames: number, childFps: number, parentFps: number, layerFrames: number) {
  const speed = spec.speed ?? 1;
  const rate = (childFps / parentFps) * speed;
  const cs = Math.max(0, Math.min(childFrames, Math.round((spec.start ?? 0) * childFps)));
  const ce = Math.max(cs + 1, Math.min(childFrames, spec.end !== undefined ? Math.round(spec.end * childFps) : childFrames));
  const pauses = (spec.pauses ?? [])
    .map((p) => ({ at: Math.round(p.at * childFps), d: Math.max(0, p.d * parentFps) }))
    .filter((p) => p.at >= cs && p.at <= ce)
    .sort((a, b) => a.at - b.at);
  const segs: [number, number, number, number][] = [];
  let t = 0;
  const delay = Math.max(0, (spec.delay ?? 0) * parentFps);
  if (delay > 0) {
    segs.push([0, delay, cs, cs]);
    t = delay;
  }
  const loops = spec.loop === true ? Infinity : typeof spec.loop === 'number' ? Math.max(1, spec.loop) : 1;
  let n = 0;
  while (n < loops && t < layerFrames && segs.length < 2000) {
    let c = cs;
    for (const p of [...pauses, { at: ce, d: 0 }]) {
      if (p.at > c) {
        const len = (p.at - c) / rate;
        segs.push([t, t + len, c, p.at]);
        t += len;
        c = p.at;
      }
      if (p.d > 0) {
        segs.push([t, t + p.d, c, c]);
        t += p.d;
      }
      if (t >= layerFrames) break;
    }
    n++;
  }
  // last frame of the child is ce - 1 (frames are [0, duration))
  const last = segs[segs.length - 1];
  if (last && last[3] >= ce) last[3] = ce - 1e-3;
  return { segs, playFrames: t, cs, ce };
}

/** Parent-local frame where the child reaches a frame (first time), or null. */
export function childToParent(segs: [number, number, number, number][], cf: number): number | null {
  for (const [a, b, c, d] of segs) {
    if (c === d) continue;
    if (cf >= c && cf <= d) return a + ((cf - c) / (d - c)) * (b - a);
  }
  return null;
}

function resolveSource(S: Session, c: NodeCtx): { composition: Record<string, any>; lock?: Record<string, string>; label: string } | null {
  const src = c.node.src;
  if (isObj(src)) return { composition: src, label: 'inline' };
  if (typeof src !== 'string' || !src) {
    S.err(`${c.path}.src`, 'comp needs "src": a composition id (cmp_…), a scene/template preset ("lib:slug"), or an inline composition');
    return null;
  }
  if (/^cmp_[a-f0-9]+$/.test(src)) {
    const got = S.opts.loadComposition?.(src, c.node.rev);
    if (!got) {
      S.err(`${c.path}.src`, `composition ${src} not found`);
      return null;
    }
    return { composition: got.composition as Record<string, any>, lock: got.lock, label: src };
  }
  // a preset used as a one-scene composition: props are its params
  const hit = S.lookup(src, c.actx, `${c.path}.src`, ['scene', 'template', 'element']);
  if (!hit) return null;
  const use = hit.lib.name === '@core/base' ? [] : [`${hit.lib.name}@${hit.lib.version} as ${hit.lib.alias}`];
  const props = isObj(c.node.props) ? c.node.props : {};
  const scene =
    hit.preset.kind === 'element'
      ? { d: c.node.d ?? 3, layers: [{ use: `${hit.lib.alias}:${hit.preset.slug}`, ...props }] }
      : { p: `${hit.lib.alias}:${hit.preset.slug}`, ...props, ...(c.node.d !== undefined ? { d: c.node.d } : {}) };
  return { composition: { use, scenes: [scene] }, label: hit.id, propsAreParams: true } as any;
}

registerLayer('comp', {
  keys: ['src', 'rev', 'props', 'fit', 'focus', 'zoom', 'radius', 'mask', 'time', 'format', 'cache', 'bg', 'd'],
  compile(S, c) {
    if (S.depthLevel >= 4) {
      S.err(c.path, 'sub-compositions nested more than 4 levels (a composition that includes itself?)');
      return [];
    }
    const srcInfo = resolveSource(S, c);
    if (!srcInfo) return [];
    const n = c.node;
    // child format: its own, else the box size at the parent's frame rate
    const boxW0 = c.base.w;
    const boxH0 = c.base.h;
    let format: string | undefined;
    if (typeof n.format === 'string') format = n.format;
    else if (!srcInfo.composition.format) {
      const w = Math.round((boxW0 ?? S.W) / 2) * 2;
      const h = Math.round((boxH0 ?? S.H) / 2) * 2;
      format = `${w}x${h}@${S.fps}`;
    }
    const propsAreParams = (srcInfo as any).propsAreParams;
    const props = !propsAreParams && isObj(n.props) ? n.props : undefined;
    const inherit = !srcInfo.composition.theme && !srcInfo.composition.direction ? { tokens: S.tokens, fonts: S.fonts } : undefined;
    const r = memoCompile(S, { c: srcInfo.composition, props, format, lock: srcInfo.lock, inherit: inherit ? sha256(stableStringify(inherit)) : null, agent: S.agent.id, d: S.depthLevel }, () =>
      compileChild(S, { composition: srcInfo.composition, lock: srcInfo.lock, props, format, inheritTheme: inherit }),
    );
    if (!r.ok || !r.ir) {
      for (const e of r.errors.slice(0, 8)) S.err(`${c.path}(${srcInfo.label})${e.path ? '.' + e.path : ''}`, e.msg);
      return [];
    }
    const child = r.ir;
    for (const f of child.fonts) if (!S.fonts.some((g) => g.family === f.family)) S.fonts.push(f);
    for (const w of r.warnings.slice(0, 5)) S.warn(`${c.path}(${srcInfo.label})${w.path ? '.' + w.path : ''}`, w.msg);

    const cw = child.width;
    const ch = child.height;
    let Wb = boxW0;
    let Hb = boxH0;
    if (Wb === undefined && Hb === undefined) (Wb = cw), (Hb = ch);
    else if (Wb === undefined) Wb = (Hb! * cw) / ch;
    else if (Hb === undefined) Hb = (Wb * ch) / cw;
    const fit = typeof n.fit === 'string' ? n.fit : 'cover';
    const zoom = Number(n.zoom ?? 1) || 1;
    let sx = Wb! / cw;
    let sy = Hb! / ch;
    if (fit === 'cover') sx = sy = Math.max(sx, sy);
    else if (fit === 'contain') sx = sy = Math.min(sx, sy);
    else if (fit === 'none') sx = sy = 1;
    sx *= zoom;
    sy *= zoom;
    const [fx, fy] = Array.isArray(n.focus) ? [Number(n.focus[0]), Number(n.focus[1])] : [0.5, 0.5];
    const place = (box: number, content: number, f: number) => {
      const centred = box / 2 - f * content;
      if (content <= box) return (box - content) / 2;
      return Math.max(box - content, Math.min(0, centred));
    };
    const ix = place(Wb!, cw * sx, fx);
    const iy = place(Hb!, ch * sy, fy);

    // time
    const spec: TimeSpec = isObj(n.time) ? (n.time as TimeSpec) : {};
    for (const k of ['start', 'end', 'speed', 'delay'] as const) {
      if (spec[k] !== undefined && typeof spec[k] !== 'number') S.err(`${c.path}.time.${k}`, 'must be a number (seconds; speed is a multiplier)');
    }
    if (spec.speed !== undefined && !(spec.speed > 0)) S.err(`${c.path}.time.speed`, 'speed must be > 0');
    const tm = buildTimeMap(spec, child.duration, child.fps, S.fps, c.lenFrames);
    let to = c.base.to!;
    if (spec.hold === 'none' && Number.isFinite(tm.playFrames)) to = Math.min(to, c.base.from! + Math.ceil(tm.playFrames));
    if (spec.hold === 'first') {
      const last = tm.segs[tm.segs.length - 1];
      if (last) tm.segs.push([last[1], last[1] + 1, tm.cs, tm.cs]);
    }

    const bg = n.bg !== undefined ? n.bg : child.bg;
    const content: IRLayer[] = [];
    if (bg && bg !== 'transparent') {
      content.push({ id: `${c.id}.bg`, type: 'rect', from: 0, to: child.duration, x: 0, y: 0, w: cw, h: ch, anchor: [0, 0], style: { fill: String(bg) }, anims: [] });
    }
    content.push(...child.layers.map((l) => prefixIds(l, `${c.id}~`)));
    const inner: IRLayer = {
      id: `${c.id}.in`,
      type: 'group',
      from: 0,
      to: to - c.base.from!,
      x: ix,
      y: iy,
      w: cw,
      h: ch,
      anchor: [0, 0],
      style: {},
      overflow: 'hidden',
      anims: sx !== sy ? [{ s: 0, e: to - c.base.from!, tracks: { scaleX: [[0, sx]], scaleY: [[0, sy]] } }] : [],
      children: content,
      time: { segs: tm.segs },
    };
    if (sx === sy && sx !== 1) inner.scale = sx;
    const outer: IRLayer = {
      ...(c.base as IRLayer),
      to,
      type: 'group',
      w: Wb,
      h: Hb,
      style: {},
      overflow: 'hidden',
      anims: [],
      children: [inner],
      src_preset: `comp:${srcInfo.label}`,
    };
    if (n.radius !== undefined) outer.style.radius = toPx(n.radius, 'min', S.W, S.H) ?? Number(n.radius);
    const m = maskCss(n.mask);
    if (m) outer.mask = m;
    // "cache": rendered once to a transparent video (keyed by content) and reused by every render
    if (n.cache) outer.data = { prerender: { w: cw, h: ch, fps: child.fps, duration: child.duration, prefix: `${c.id}~` } };
    // markers of the child (clicks, transitions…) land on the parent's timeline for sound sync
    for (const mk of child.markers ?? []) {
      if (mk.kind === 'scene') continue;
      const lf = childToParent(tm.segs, mk.t);
      if (lf === null) continue;
      S.mark({ ...mk, t: Math.round(c.base.from! + lf) } as IRMarker);
    }
    for (const a of child.audio ?? []) {
      const lf = childToParent(tm.segs, a.from) ?? 0;
      S.mark({ t: Math.round(c.base.from! + lf), kind: 'sfx', sfx: a.src, gain: a.volume, name: 'sub-composition audio' });
    }
    return [outer];
  },
});

/** Child layer ids are prefixed so they stay unique next to the parent's layers. */
function prefixIds(l: IRLayer, p: string): IRLayer {
  const out: IRLayer = { ...l, id: p + l.id };
  if (l.children) out.children = l.children.map((k) => prefixIds(k, p));
  if (l.conn) {
    const fix = (e: any) => (e.follow ? { ...e, follow: e.follow.map((f: any) => ({ ...f, id: p + f.id })) } : e);
    out.conn = { ...l.conn, a: fix(l.conn.a), b: fix(l.conn.b) };
  }
  return out;
}

export { parseFormat };
