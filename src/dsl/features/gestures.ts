/**
 * Animated gestures, targeting layers by id: a cursor that moves, clicks, types, scrolls and drags,
 * plus camera zooms, show/hide, highlights, key presses and state switches.
 *
 * Scene entry:
 *  "cursor": {"style": "arrow|hand|dot|none", "color", "size", "from": [x, y] | "#id"},
 *  "gestures": [
 *    {"do":"click", "on":"#signup"},
 *    {"do":"type", "into":"#email", "text":"ada@lovelace.dev", "cps": 14},
 *    {"do":"scroll", "target":"#feed", "by": 420},
 *    {"do":"drag", "from":"#card", "to":"#done"},
 *    {"do":"zoom", "on":"#chart", "scale": 1.6}, {"do":"zoom", "reset": true},
 *    {"do":"state", "target":"#panel", "to":"loading"},
 *    {"p":"core:fill-form", "field":"#email", "text":"…", "button":"#submit"}   ← a choreography preset
 *  ]
 * Actions run one after another (gap 0.2 s) unless they give "at" (seconds in the scene).
 */
import { isObj } from '../../core/util';
import type { IRAnim, IRLayer, Keyframe } from '../../ir/types';
import { center, type Rect } from '../../ir/geometry';
import type { Session } from '../compile';
import { ancestors, textStyleOf, type LBox } from '../layoutmap';
import { textWidth } from '../metrics';
import { registerScenePass, type SceneCtx } from '../registry';

interface Action {
  do: string;
  at: number; // seconds (scene)
  d: number; // seconds
  raw: Record<string, any>;
  path: string;
}

const DEFAULT_D: Record<string, number> = {
  move: 0.6,
  click: 0.35,
  hover: 0.5,
  type: 0,
  scroll: 0.8,
  drag: 1.0,
  wait: 0.5,
  show: 0.35,
  hide: 0.3,
  state: 0.05,
  highlight: 0.9,
  key: 0.7,
  zoom: 0.8,
  press: 0.25,
};

/** Expand choreographies and give every action its start time. */
function planActions(S: Session, entry: Record<string, any>, path: string, actx: any): Action[] {
  const list: Action[] = [];
  let t = typeof entry.cursor?.start === 'number' ? entry.cursor.start : 0.4;
  const walk = (items: unknown[], p: string, depth: number, base: number | null) => {
    if (depth > 5) return S.err(p, 'choreographies nested too deeply');
    items.forEach((raw, i) => {
      const ap = `${p}[${i}]`;
      if (!isObj(raw)) return S.err(ap, 'gesture must be {"do": …} or {"p": "<choreography preset>", …}');
      if (raw.p !== undefined) {
        const params: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(raw)) if (!['p', 'at', 'gap', 'speed'].includes(k)) params[k] = v;
        const u = S.expand(raw.p, params, actx, ap, ['choreography']);
        if (!u) return;
        if (!Array.isArray(u.body.steps)) return S.err(ap, `${u.hit.id} has no "steps"`);
        if (typeof raw.at === 'number') t = raw.at;
        const steps = S.bind(u.body.steps, { ...S.base(0), ...u.values }, `${ap}(${u.hit.id}).steps`) as unknown[];
        const speed = Number(raw.speed ?? 1) || 1;
        walk(
          steps.map((s: any) => (isObj(s) && speed !== 1 ? { ...s, d: s.d !== undefined ? s.d / speed : undefined, gap: (s.gap ?? 0.2) / speed, __speed: speed } : s)),
          `${ap}(${u.hit.id})`,
          depth + 1,
          null,
        );
        return;
      }
      if (typeof raw.do !== 'string' || !(raw.do in DEFAULT_D)) {
        return S.err(`${ap}.do`, `unknown gesture "${raw.do}" (known: ${Object.keys(DEFAULT_D).join(', ')})`);
      }
      const speed = Number(raw.__speed ?? 1);
      let d = raw.d !== undefined ? Number(raw.d) : DEFAULT_D[raw.do] / speed;
      if (raw.do === 'type') d = raw.d !== undefined ? Number(raw.d) : String(raw.text ?? '').length / Number(raw.cps ?? 14);
      if (raw.do === 'click' || raw.do === 'drag' || raw.do === 'hover' || raw.do === 'type') d += 0; // move time is added below
      const gap = Number(raw.gap ?? 0.2);
      const at = typeof raw.at === 'number' ? raw.at : base ?? t + (list.length ? gap : 0);
      // clicks, drags and hovers first travel to their target
      const travel = ['click', 'drag', 'hover'].includes(raw.do) || (raw.do === 'type' && raw.click !== false) ? Number(raw.move ?? 0.55) / speed : 0;
      list.push({ do: raw.do, at: at + 0, d: d + travel, raw: { ...raw, travel }, path: ap });
      t = at + d + travel;
    });
  };
  walk(entry.gestures as unknown[], `${path}.gestures`, 0, null);
  return list;
}

registerScenePass({
  name: 'gestures-plan',
  order: 10,
  pre(S, sc) {
    S.scratch.gestures = null;
    S.scratch.stateEvents = {};
    if (sc.entry.gestures === undefined) return;
    if (!Array.isArray(sc.entry.gestures)) return S.err(`${sc.path}.gestures`, 'gestures must be an array');
    const actions = planActions(S, sc.entry, sc.path, sc.actx);
    S.scratch.gestures = actions;
    const ev: Record<string, { at: number; state: string }[]> = {};
    for (const a of actions) {
      if (a.do !== 'state') continue;
      const tgt = String(a.raw.target ?? '').replace(/^#/, '');
      if (!tgt || typeof a.raw.to !== 'string') {
        S.err(`${a.path}`, 'state needs "target": "#id" (a states component) and "to": "<state>"');
        continue;
      }
      (ev[tgt] ??= []).push({ at: a.at, state: a.raw.to });
    }
    S.scratch.stateEvents = ev;
  },
});

// ---------- helpers ----------
const fr = (S: Session, sec: number) => S.frames(sec);

/** An anim on `layer` from scene time t0 to t1 (seconds), tracks given in scene seconds. */
function addAnim(S: Session, box: LBox, t0: number, t1: number, tracks: Record<string, [number, number | string, string?][]>, name: string) {
  const s = fr(S, t0) - box.abs0;
  const e = Math.max(s + 1, fr(S, t1) - box.abs0);
  const len = e - s;
  const norm: Record<string, Keyframe[]> = {};
  for (const [ch, kfs] of Object.entries(tracks)) {
    norm[ch] = kfs.map(([t, v, ez]) => {
      const k = Math.max(0, Math.min(1, (fr(S, t) - box.abs0 - s) / len));
      return ez ? ([k, v, ez] as Keyframe) : ([k, v] as Keyframe);
    });
  }
  const a: IRAnim = { s, e, tracks: norm, n: name };
  box.layer.anims.push(a);
}

function resolvePoint(S: Session, sc: SceneCtx, target: unknown, path: string): { pt: [number, number]; box?: LBox } | null {
  if (Array.isArray(target) && target.length === 2) return { pt: [Number(target[0]), Number(target[1])] };
  if (typeof target !== 'string') {
    S.err(path, 'target must be "#id" or [x, y]');
    return null;
  }
  const [name, where] = target.replace(/^#/, '').split(':');
  const box = S.sceneLayout(sc).find(name);
  if (!box) {
    const known = [...S.names.keys()].slice(0, 20);
    S.err(path, `no layer with id "${name}" in this scene${known.length ? ` (ids: ${known.join(', ')})` : ' (give layers an "id")'}`);
    return null;
  }
  const r = box.rect;
  const pts: Record<string, [number, number]> = {
    center: center(r),
    top: [r.x + r.w / 2, r.y],
    bottom: [r.x + r.w / 2, r.y + r.h],
    left: [r.x, r.y + r.h / 2],
    right: [r.x + r.w, r.y + r.h / 2],
    'top-left': [r.x, r.y],
    'bottom-right': [r.x + r.w, r.y + r.h],
    // for text fields: just after the existing text
    end: [r.x + Math.min(r.w, 24), r.y + r.h / 2],
  };
  return { pt: pts[where ?? 'center'] ?? pts.center, box };
}

/** Text layer to type into: the target itself or the first text inside it. */
function textTarget(box: LBox, all: LBox[]): LBox | null {
  if (box.layer.type === 'text') return box;
  const inside = all.filter((b) => b.layer.type === 'text' && ancestors(b).includes(box));
  return inside.find((b) => /value|input|field/.test(b.layer.name ?? '')) ?? inside[0] ?? null;
}

export const CURSORS: Record<string, (color: string) => string> = {
  arrow: (c) =>
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="100%" height="100%"><path d="M3 2 L3 19.5 L7.6 15.4 L10.6 22 L13.6 20.6 L10.7 14.2 L17 14.2 Z" fill="${c}" stroke="#fff" stroke-width="1.4" stroke-linejoin="round"/></svg>`,
  hand: (c) =>
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="100%" height="100%"><path d="M8 11V4.5a1.5 1.5 0 0 1 3 0V10m0-1V3.5a1.5 1.5 0 0 1 3 0V10m0-.5V5a1.5 1.5 0 0 1 3 0v8c0 4.5-2.6 8-7 8-3.2 0-4.6-1.7-6.4-4.8L2.7 13a1.6 1.6 0 0 1 2.6-1.8L8 14" fill="${c}" stroke="#fff" stroke-width="1.3" stroke-linejoin="round" stroke-linecap="round"/></svg>`,
  dot: (c) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="100%" height="100%"><circle cx="12" cy="12" r="9" fill="${c}" fill-opacity="0.85" stroke="#fff" stroke-width="2"/></svg>`,
};

registerScenePass({
  name: 'gestures',
  order: 50,
  post(S, sc) {
    const actions = S.scratch.gestures as Action[] | null;
    S.scratch.gestures = null;
    if (!actions?.length) return;
    const layout = S.sceneLayout(sc);
    const fps = S.fps;
    const cur = isObj(sc.entry.cursor) ? sc.entry.cursor : {};
    const style = typeof cur.style === 'string' ? cur.style : 'arrow';
    const size = Number(cur.size ?? 34 * Math.min(S.W, S.H) / 1080);
    const color = typeof cur.color === 'string' ? (S.bind(cur.color, sc.scope, `${sc.path}.cursor.color`) as string) : '#111111';
    const accent = (S.tokens as any)?.color?.accent ?? '#7c8cff';

    // cursor path
    let pos: [number, number] = [S.W * 0.62, S.H * 0.78];
    if (cur.from !== undefined) {
      const p = resolvePoint(S, sc, cur.from, `${sc.path}.cursor.from`);
      if (p) pos = p.pt;
    }
    const start = pos;
    const way: [number, number, number, string?][] = [[actions[0].at - 0.35, pos[0], pos[1]]]; // [t, x, y, ease]
    const extra: IRLayer[] = [];
    const camera: [number, number, number, number, string?][] = []; // t, scale, dx, dy
    let cam = { s: 1, dx: 0, dy: 0 };
    const scrollState = new Map<LBox, number>();
    const scrolls = new Map<LBox, [number, number, number, number][]>();
    const endSec = (b: LBox) => b.abs1 / fps;
    let cursorUsed = false;
    let lastT = 0;
    const move = (t0: number, t1: number, to: [number, number]) => {
      way.push([t0, pos[0], pos[1]]);
      way.push([t1, to[0], to[1], 'cubic(0.45,0,0.15,1)']);
      pos = to;
      cursorUsed = true;
    };
    const ripple = (t: number, at: [number, number]) => {
      const r = size * 2.2;
      extra.push({
        id: `${sc.group.id}.g.r${extra.length}`,
        type: 'ellipse',
        from: fr(S, t),
        to: fr(S, t + 0.5),
        x: at[0],
        y: at[1],
        w: r,
        h: r,
        anchor: [0.5, 0.5],
        style: { fill: 'transparent', stroke: accent, strokeWidth: Math.max(2, size * 0.09) },
        anims: [{ s: 0, e: fr(S, 0.5), tracks: { scale: [[0, 0.25], [1, 1.5, 'out']], opacity: [[0, 0.9], [1, 0, 'in']] }, n: 'click' }],
      });
    };
    const press = (box: LBox | undefined, t: number) => {
      if (!box || box.remapped) return;
      addAnim(S, box, t, t + 0.3, { scale: [[t, 1], [t + 0.1, 0.95, 'out'], [t + 0.3, 1, 'out']] }, 'press');
    };

    for (const a of actions) {
      const r = a.raw;
      const t0 = a.at;
      lastT = Math.max(lastT, t0 + a.d);
      const travel = Number(r.travel ?? 0);
      switch (a.do) {
        case 'move':
        case 'hover':
        case 'click': {
          const p = resolvePoint(S, sc, r.to ?? r.on ?? r.target, `${a.path}.on`);
          if (!p) break;
          const off: [number, number] = Array.isArray(r.offset) ? [Number(r.offset[0]), Number(r.offset[1])] : [0, 0];
          const dest: [number, number] = [p.pt[0] + off[0], p.pt[1] + off[1]];
          if (a.do === 'move') {
            move(t0, t0 + a.d, dest);
            break;
          }
          move(t0, t0 + travel, dest);
          if (a.do === 'click') {
            const tc = t0 + travel;
            ripple(tc, dest);
            press(p.box, tc);
            way.push([tc, dest[0], dest[1]]);
            S.mark({ t: fr(S, tc), kind: 'click', name: String(r.on ?? '') });
          } else if (p.box && !p.box.remapped) {
            const th = t0 + travel;
            addAnim(S, p.box, th, th + 1.2, { brightness: [[th, 1], [th + 0.25, 1.12, 'out'], [th + 0.9, 1.12], [th + 1.2, 1, 'inOut']], scale: [[th, 1], [th + 0.25, 1.03, 'out'], [th + 0.9, 1.03], [th + 1.2, 1, 'inOut']] }, 'hover');
          }
          break;
        }
        case 'type': {
          const p = resolvePoint(S, sc, r.into ?? r.on ?? r.target, `${a.path}.into`);
          if (!p?.box) break;
          let tStart = t0;
          if (r.click !== false) {
            const dest: [number, number] = p.pt;
            move(t0, t0 + travel, dest);
            ripple(t0 + travel, dest);
            S.mark({ t: fr(S, t0 + travel), kind: 'click', name: String(r.into ?? '') });
            tStart = t0 + travel + 0.1;
          }
          const tb = textTarget(p.box, layout.boxes);
          if (!tb) {
            S.err(`${a.path}.into`, 'type needs a text layer (or a group containing one)');
            break;
          }
          const text = String(r.text ?? '');
          const dur = Math.max(0.1, a.d - (tStart - t0));
          const host = tb.parent?.layer;
          if (!host?.children) break;
          const src = tb.layer;
          const typed: IRLayer = {
            ...src,
            id: `${src.id}~typed${extra.length}`,
            name: undefined,
            ptr: undefined,
            textPtr: undefined,
            text,
            counter: undefined,
            split: undefined,
            from: fr(S, tStart) - (tb.parent!.abs0),
            to: src.to,
            style: { ...src.style, color: typeof r.color === 'string' ? r.color : ((S.tokens as any)?.color?.fg ?? (src.style.color as string)) },
            anims: [{ s: 0, e: Math.max(1, fr(S, dur)), tracks: { chars: [[0, 0], [1, 1, 'linear']] }, n: 'type' }],
          };
          if (typed.from < typed.to) {
            host.children.splice(host.children.indexOf(src) + 1, 0, typed);
            // hide what was there (placeholder) from the moment typing starts
            addAnim(S, tb, tStart, endSec(tb), { opacity: [[tStart, 1], [tStart + 0.04, 0]] }, 'type');
            // caret
            if (r.caret !== false) {
              const st = textStyleOf(src);
              const w = textWidth(text, st);
              const h = st.size * 1.05;
              const [ax] = src.anchor;
              const left = src.x - ax * (src.w ?? w);
              const alignShift = src.w && src.style.align === 'center' ? (src.w - w) / 2 : src.w && src.style.align === 'right' ? src.w - w : 0;
              const caretFrom = Math.max(0, typed.from);
              const caretLen = src.to - caretFrom;
              host.children.splice(host.children.indexOf(typed) + 1, 0, {
                id: `${src.id}~caret${extra.length}`,
                type: 'rect',
                from: caretFrom,
                to: src.to,
                x: left + alignShift + 2,
                y: src.y,
                w: Math.max(2, st.size * 0.07),
                h,
                anchor: [0, src.anchor[1]],
                style: { fill: typeof r.color === 'string' ? r.color : ((S.tokens as any)?.color?.accent ?? '#fff') },
                anims: [
                  { s: 0, e: Math.max(1, fr(S, dur)), tracks: { dx: [[0, 0], [1, w, 'linear']] }, n: 'caret' },
                  { s: Math.max(1, fr(S, dur)), e: Math.max(1, fr(S, dur)) + fr(S, 1), loop: true, tracks: { opacity: [[0, 1], [0.5, 0, 'hold'], [1, 1, 'hold']] }, n: 'blink' },
                ],
              });
            }
          }
          S.mark({ t: fr(S, tStart), kind: 'type', d: fr(S, dur), name: text.slice(0, 20) });
          break;
        }
        case 'scroll': {
          const p = resolvePoint(S, sc, r.target ?? r.on, `${a.path}.target`);
          if (!p?.box) break;
          let by = Number(r.by ?? 0);
          if (r.to !== undefined) {
            const q = resolvePoint(S, sc, r.to, `${a.path}.to`);
            if (q?.box) by = q.box.rect.y - p.box.rect.y - (scrollState.get(p.box) ?? 0) - Number(r.margin ?? 24);
          }
          const prev = scrollState.get(p.box) ?? 0;
          const next = prev + by;
          scrollState.set(p.box, next);
          if (!scrolls.has(p.box)) scrolls.set(p.box, []);
          scrolls.get(p.box)!.push([t0, t0 + a.d, prev, next]);
          break;
        }
        case 'drag': {
          const from = resolvePoint(S, sc, r.from ?? r.target, `${a.path}.from`);
          const to = resolvePoint(S, sc, r.to, `${a.path}.to`);
          if (!from?.box || !to) break;
          const grab: [number, number] = from.pt;
          move(t0, t0 + travel, grab);
          const tp = t0 + travel + 0.12;
          const tr = t0 + a.d;
          way.push([tp, grab[0], grab[1]]);
          way.push([tr, to.pt[0], to.pt[1], 'cubic(0.45,0,0.2,1)']);
          pos = to.pt;
          const dx = to.pt[0] - grab[0];
          const dy = to.pt[1] - grab[1];
          if (!from.box.remapped) {
            addAnim(S, from.box, tp, endSec(from.box), { dx: [[tp, 0], [tr, dx, 'cubic(0.45,0,0.2,1)']], dy: [[tp, 0], [tr, dy, 'cubic(0.45,0,0.2,1)']], scale: [[tp, 1], [tp + 0.15, 1.04, 'out'], [tr - 0.1, 1.04], [tr, 1, 'out']] }, 'drag');
            if (from.box.layer.z === undefined) from.box.layer.z = 50;
          }
          S.mark({ t: fr(S, tp), kind: 'drag', d: fr(S, tr - tp), name: String(r.from ?? '') });
          break;
        }
        case 'show':
        case 'hide': {
          const p = resolvePoint(S, sc, r.target ?? r.on, `${a.path}.target`);
          if (!p?.box) break;
          const box = p.box;
          if (a.do === 'show') {
            addAnim(S, box, box.abs0 / fps, t0 + a.d, { opacity: [[box.abs0 / fps, 0], [t0, 0], [t0 + a.d, 1, 'out']], dy: [[box.abs0 / fps, 16], [t0, 16], [t0 + a.d, 0, 'out']] }, 'show');
          } else {
            addAnim(S, box, t0, endSec(box), { opacity: [[t0, 1], [t0 + a.d, 0, 'in']] }, 'hide');
          }
          break;
        }
        case 'highlight': {
          const p = resolvePoint(S, sc, r.target ?? r.on, `${a.path}.target`);
          if (!p?.box) break;
          const pad = Number(r.pad ?? 10);
          const rc = p.box.rect;
          extra.push({
            id: `${sc.group.id}.g.h${extra.length}`,
            type: 'rect',
            from: fr(S, t0),
            to: fr(S, t0 + a.d),
            x: rc.x - pad,
            y: rc.y - pad,
            w: rc.w + pad * 2,
            h: rc.h + pad * 2,
            anchor: [0, 0],
            style: { fill: 'transparent', stroke: (r.color as string) ?? accent, strokeWidth: 4, radius: Number(r.radius ?? 14), glow: (r.color as string) ?? accent },
            anims: [{ s: 0, e: fr(S, a.d), tracks: { opacity: [[0, 0], [0.2, 1, 'out'], [0.8, 1], [1, 0, 'in']], scale: [[0, 1.08], [0.25, 1, 'out']] }, n: 'highlight' }],
          });
          break;
        }
        case 'key': {
          const label = String(r.keys ?? r.text ?? '');
          extra.push({
            id: `${sc.group.id}.g.k${extra.length}`,
            type: 'text',
            from: fr(S, t0),
            to: fr(S, t0 + a.d),
            x: S.W / 2,
            y: S.H * 0.86,
            anchor: [0.5, 0.5],
            text: label,
            style: { size: Math.round(38 * Math.min(S.W, S.H) / 1080), weight: 600, color: '#fff', bg: 'rgba(20,22,30,0.88)', padding: '14px 26px', radius: 14, font: "'JetBrains Mono', Consolas, monospace", border: '1px solid rgba(255,255,255,0.18)' },
            anims: [{ s: 0, e: fr(S, a.d), tracks: { opacity: [[0, 0], [0.15, 1, 'out'], [0.85, 1], [1, 0, 'in']], dy: [[0, 20], [0.2, 0, 'out']] }, n: 'key' }],
          });
          S.mark({ t: fr(S, t0), kind: 'click', name: `key ${label}` });
          break;
        }
        case 'zoom': {
          if (r.reset) {
            camera.push([t0, cam.s, cam.dx, cam.dy], [t0 + a.d, 1, 0, 0, 'cubic(0.45,0,0.15,1)']);
            cam = { s: 1, dx: 0, dy: 0 };
            break;
          }
          const p = resolvePoint(S, sc, r.on ?? r.target, `${a.path}.on`);
          if (!p) break;
          const s = Number(r.scale ?? 1.6);
          const C: [number, number] = [S.W / 2, S.H / 2];
          const dx = -s * (p.pt[0] - C[0]);
          const dy = -s * (p.pt[1] - C[1]);
          // keep the frame filled
          const lim = (v: number, half: number) => Math.max(-(s - 1) * half, Math.min((s - 1) * half, v));
          const next = { s, dx: lim(dx, S.W / 2), dy: lim(dy, S.H / 2) };
          camera.push([t0, cam.s, cam.dx, cam.dy], [t0 + a.d, next.s, next.dx, next.dy, 'cubic(0.45,0,0.15,1)']);
          cam = next;
          break;
        }
        case 'press': {
          const p = resolvePoint(S, sc, r.target ?? r.on, `${a.path}.target`);
          press(p?.box, t0);
          break;
        }
        case 'wait':
        case 'state':
          break;
      }
    }

    for (const [box, list] of scrolls) {
      if (box.remapped) continue;
      const kf: [number, number, string?][] = [[box.abs0 / fps, 0]];
      for (const [a0, a1, from, to] of list) kf.push([a0, -from], [a1, -to, 'cubic(0.35,0,0.15,1)']);
      addAnim(S, box, box.abs0 / fps, endSec(box), { dy: kf }, 'scroll');
    }
    sc.group.children ??= [];
    sc.group.children.push(...extra);
    if (cursorUsed && style !== 'none') {
      const tEnd = Math.min(sc.frames / fps, Math.max(lastT, way[way.length - 1][0]) + Number(cur.linger ?? 0.8));
      const tShow = Math.max(0, way[0][0]);
      way.sort((a, b) => a[0] - b[0]);
      const keysX: [number, number, string?][] = way.map(([t, x, , e]) => [t, x - start[0], e]);
      const keysY: [number, number, string?][] = way.map(([t, , y, e]) => [t, y - start[1], e]);
      const lenSec = sc.frames / fps;
      const norm = (list: [number, number, string?][]) =>
        list.map(([t, v, e]) => (e ? [Math.max(0, Math.min(1, t / lenSec)), v, e] : [Math.max(0, Math.min(1, t / lenSec)), v]) as Keyframe);
      const clicks = way.length;
      void clicks;
      const cursor: IRLayer = {
        id: `${sc.group.id}.g.cursor`,
        type: 'svg',
        from: 0,
        to: sc.frames,
        x: start[0],
        y: start[1],
        w: size,
        h: size,
        anchor: style === 'dot' ? [0.5, 0.5] : style === 'hand' ? [0.38, 0.12] : [0.13, 0.08],
        svg: CURSORS[style]?.(color) ?? CURSORS.arrow(color),
        style: { filter: 'drop-shadow(0 4px 8px rgba(0,0,0,0.35))' },
        z: 2000,
        anims: [
          { s: 0, e: sc.frames, tracks: { dx: norm(keysX), dy: norm(keysY) }, n: 'cursor' },
          {
            s: 0,
            e: sc.frames,
            tracks: {
              opacity: norm([
                [Math.max(0, tShow - 0.25), 0],
                [tShow, 1, 'out'],
                [tEnd - 0.3, 1],
                [tEnd, cur.hide === false ? 1 : 0, 'in'],
              ]),
            },
            n: 'cursor',
          },
        ],
      };
      // a little dip of the cursor on every click
      for (const m of S.markers) {
        if (m.kind !== 'click') continue;
        cursor.anims.push({ s: m.t, e: m.t + fr(S, 0.22), tracks: { scale: [[0, 1], [0.4, 0.82, 'out'], [1, 1, 'out']] }, n: 'click' });
      }
      sc.group.children.push(cursor);
    }
    if (camera.length) {
      const lenSec = sc.frames / fps;
      const kfs = (i: number) => camera.map((c) => (c[4] ? [Math.max(0, Math.min(1, c[0] / lenSec)), c[i], c[4]] : [Math.max(0, Math.min(1, c[0] / lenSec)), c[i]]) as Keyframe);
      const camGroup: IRLayer = {
        id: `${sc.group.id}.cam`,
        type: 'group',
        from: 0,
        to: sc.frames,
        x: S.W / 2,
        y: S.H / 2,
        w: S.W,
        h: S.H,
        anchor: [0.5, 0.5],
        style: {},
        anims: [{ s: 0, e: sc.frames, tracks: { scale: kfs(1), dx: kfs(2), dy: kfs(3) }, n: 'camera' }],
        children: sc.group.children,
      };
      sc.group.children = [camGroup];
    }
    void (null as unknown as Rect);
  },
});
