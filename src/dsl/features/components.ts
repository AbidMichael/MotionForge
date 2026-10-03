/**
 * Stateful components and animated lists.
 *
 * {"type":"states", "id":"panel", "w":800, "h":480,
 *  "states": {"empty":[…], "loading":[…], "result":[…], "error":[…]},
 *  "seq": [{"at":0,"state":"empty"}, {"at":1.2,"state":"loading"}, {"at":2.6,"state":"result"}],
 *  "transition": "fade|up|slide|scale|blur|none", "td": 0.35}
 * Gestures can switch states too: {"do":"state","target":"#panel","to":"error"}.
 *
 * {"type":"list", "items":[{…}], "item":{template using {{item}}}, "itemW":600, "itemH":64, "gap":12,
 *  "dir":"column|row|grid", "cols":3,
 *  "steps":[{"at":1,"sort":"value desc"}, {"at":2.5,"filter":"item.value > 20"}, {"at":4,"order":["c","a","b"]}, {"at":5,"reset":true}],
 *  "d":0.6, "ease":"inOut"}
 */
import { isObj } from '../../core/util';
import type { IRLayer } from '../../ir/types';
import type { Session } from '../compile';
import { registerLayer, type NodeCtx } from '../registry';
import { evaluate } from '../expr';

const TRANS: Record<string, { in: Record<string, unknown>; out: Record<string, unknown> }> = {
  fade: { in: { opacity: [0, 1] }, out: { opacity: [1, 0] } },
  up: { in: { opacity: [0, 1], dy: [24, 0] }, out: { opacity: [1, 0], dy: [0, -24] } },
  slide: { in: { opacity: [0, 1], dx: [60, 0] }, out: { opacity: [1, 0], dx: [0, -60] } },
  scale: { in: { opacity: [0, 1], scale: [0.94, 1] }, out: { opacity: [1, 0], scale: [1, 1.04] } },
  blur: { in: { opacity: [0, 1], blur: [14, 0] }, out: { opacity: [1, 0], blur: [0, 14] } },
};

export function fullName(c: NodeCtx): string | undefined {
  const idp = c.scope.$idp as string | false | undefined;
  if (typeof c.node.id !== 'string' || idp === false) return undefined;
  return idp ? `${idp}.${c.node.id}` : c.node.id;
}

registerLayer('states', {
  keys: ['states', 'seq', 'initial', 'transition', 'td', 'radius', 'bg'],
  compile(S, c) {
    const n = c.node;
    const raw = c.raw;
    if (!isObj(raw.states) || !Object.keys(raw.states).length) {
      S.err(`${c.path}.states`, 'states needs {"name": [layers], …}');
      return [];
    }
    const names = Object.keys(raw.states);
    let seq: { at: number; state: string }[] = Array.isArray(n.seq) ? n.seq.map((x: any) => ({ at: Number(x.at ?? 0), state: String(x.state) })) : [];
    const injected = (S.scratch.stateEvents as Record<string, { at: number; state: string }[]> | undefined)?.[fullName(c) ?? ''] ?? [];
    seq = [...seq, ...injected];
    if (!seq.length || seq.every((s) => s.at > 0)) seq.unshift({ at: 0, state: typeof n.initial === 'string' ? n.initial : names[0] });
    seq.sort((a, b) => a.at - b.at);
    for (const s of seq) {
      if (!names.includes(s.state)) S.err(`${c.path}.seq`, `unknown state "${s.state}" (states: ${names.join(', ')})`);
    }
    const kind = typeof n.transition === 'string' ? n.transition : 'fade';
    if (kind !== 'none' && !TRANS[kind]) S.err(`${c.path}.transition`, `transition is one of ${Object.keys(TRANS).join(', ')}, none`);
    const td = Math.max(1, S.frames(Number(n.td ?? 0.35)));
    const W = c.base.w;
    const H = c.base.h;
    const children: IRLayer[] = [];
    seq.forEach((s, i) => {
      const a = S.frames(s.at);
      if (a >= c.lenFrames) return;
      const next = seq[i + 1] ? S.frames(seq[i + 1].at) : c.lenFrames;
      const end = Math.min(c.lenFrames, next + (seq[i + 1] && kind !== 'none' ? td : 0));
      const len = end - a;
      if (len <= 0) return;
      const kids = S.compileLayers(raw.states[s.state], { ...c.scope, dur: len / S.fps, state: s.state }, c.actx, len, `${c.path}.states.${s.state}`, c.slots, W !== undefined && H !== undefined ? [W / 2, H / 2] : [0, 0], `${c.id}.${i}`);
      const anims = [];
      const T = TRANS[kind];
      if (T && i > 0) {
        const tr = S.normTracks(T.in, c.scope, `${c.path}.transition`, 'inOut');
        if (tr) anims.push({ s: 0, e: td, tracks: tr, n: `state:${s.state}` });
      }
      if (T && seq[i + 1]) {
        const tr = S.normTracks(T.out, c.scope, `${c.path}.transition`, 'inOut');
        if (tr) anims.push({ s: len - td, e: len, tracks: tr, n: `state:${s.state}` });
      }
      children.push({
        id: `${c.id}.${i}`,
        type: 'group',
        from: a,
        to: end,
        x: 0,
        y: 0,
        w: W,
        h: H,
        anchor: [0, 0],
        style: {},
        anims,
        children: kids,
        name: undefined,
      });
      if (i > 0) S.mark({ t: a, kind: 'state', name: s.state });
    });
    const layer: IRLayer = { ...(c.base as IRLayer), type: 'group', style: {}, children, anims: [] };
    if (W === undefined || H === undefined) layer.anchor = [0, 0];
    if (n.bg !== undefined) layer.style.bg = String(n.bg);
    if (n.radius !== undefined) layer.style.radius = Number(n.radius);
    if (n.overflow === 'hidden' || n.bg !== undefined) layer.overflow = 'hidden';
    return [layer];
  },
});

function sortItems(S: Session, items: any[], spec: unknown, path: string): any[] {
  if (Array.isArray(spec)) {
    const order = spec.map(String);
    const byId = new Map(items.map((it, i) => [String(it?.id ?? i), it]));
    const out = order.map((id) => byId.get(id)).filter(Boolean);
    for (const it of items) if (!out.includes(it)) out.push(it);
    return out;
  }
  if (typeof spec !== 'string') {
    S.err(path, 'sort is "field asc|desc", "reverse", "shuffle" or an array of ids');
    return items;
  }
  if (spec === 'reverse') return [...items].reverse();
  if (spec.startsWith('shuffle')) {
    const seed = Number(spec.split(':')[1] ?? 7);
    return items
      .map((it, i) => ({ it, k: Math.sin((i + 1) * 12.9898 + seed * 78.233) * 43758.5453 }))
      .sort((a, b) => (a.k - Math.floor(a.k)) - (b.k - Math.floor(b.k)))
      .map((x) => x.it);
  }
  const [field, dirRaw] = spec.trim().split(/\s+/);
  const dir = dirRaw === 'desc' ? -1 : 1;
  return [...items].sort((a, b) => {
    const va = a?.[field];
    const vb = b?.[field];
    if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * dir;
    return String(va ?? '').localeCompare(String(vb ?? '')) * dir;
  });
}

registerLayer('list', {
  keys: ['items', 'item', 'itemW', 'itemH', 'gap', 'dir', 'cols', 'steps', 'd', 'ease', 'as'],
  compile(S, c) {
    const n = c.node;
    const raw = c.raw;
    const items = n.items;
    if (!Array.isArray(items)) {
      S.err(`${c.path}.items`, 'list needs "items": an array');
      return [];
    }
    if (!isObj(raw.item)) {
      S.err(`${c.path}.item`, 'list needs "item": a layer template (use {{item.field}}, {{index}})');
      return [];
    }
    const iw = Number(n.itemW ?? c.base.w ?? 400);
    const ih = Number(n.itemH ?? 64);
    const gap = Number(n.gap ?? 12);
    const dir = n.dir === 'row' ? 'row' : n.dir === 'grid' ? 'grid' : 'column';
    const cols = Math.max(1, Number(n.cols ?? 3));
    const as = typeof n.as === 'string' ? n.as : 'item';
    const slot = (i: number): [number, number] => {
      if (dir === 'row') return [i * (iw + gap) + iw / 2, ih / 2];
      if (dir === 'grid') return [(i % cols) * (iw + gap) + iw / 2, Math.floor(i / cols) * (ih + gap) + ih / 2];
      return [iw / 2, i * (ih + gap) + ih / 2];
    };
    const dSec = Number(n.d ?? 0.6);
    const ease = typeof n.ease === 'string' ? n.ease : 'inOut';
    // states over time: order of visible items
    type Frame = { at: number; order: any[] };
    const frames: Frame[] = [{ at: 0, order: [...items] }];
    let current = [...items];
    const steps: any[] = Array.isArray(raw.steps) ? raw.steps : [];
    steps.forEach((st, k) => {
      const p = `${c.path}.steps[${k}]`;
      if (!isObj(st) || typeof st.at !== 'number') return S.err(p, 'each step needs "at" (seconds) and one of sort, filter, order, reset');
      let next = current;
      if (st.reset) next = [...items];
      if (st.filter !== undefined) {
        const expr = String(st.filter).replace(/^\{\{|\}\}$/g, '');
        next = items.filter((it, i) => {
          try {
            return !!evaluate(expr, { ...c.scope, [as]: it, index: i });
          } catch (e) {
            S.err(`${p}.filter`, (e as Error).message);
            return true;
          }
        });
        // keep the current order of the survivors
        next = current.filter((it) => next.includes(it)).concat(next.filter((it) => !current.includes(it)));
      }
      if (st.sort !== undefined) next = sortItems(S, next, st.sort, `${p}.sort`);
      if (st.order !== undefined) next = sortItems(S, next, st.order, `${p}.order`);
      frames.push({ at: st.at, order: next });
      current = next;
    });
    const children: IRLayer[] = [];
    items.forEach((it, i) => {
      const kids = S.compileNode(raw.item, { ...c.scope, [as]: it, index: i, count: items.length }, c.actx, c.lenFrames, `${c.path}.item#${i}`, c.slots, [iw / 2, ih / 2], `${c.id}.i${i}`);
      const [x0, y0] = slot(0);
      const pos = (f: Frame) => {
        const k = f.order.indexOf(it);
        return k < 0 ? null : slot(k);
      };
      const keys: Record<string, any[]> = { dx: [], dy: [], opacity: [], scale: [] };
      let prev = pos(frames[0]);
      const start = prev ?? slot(i);
      keys.dx.push([0, start[0] - x0]);
      keys.dy.push([0, start[1] - y0]);
      keys.opacity.push([0, prev ? 1 : 0]);
      keys.scale.push([0, prev ? 1 : 0.9]);
      let last = start;
      for (const f of frames.slice(1)) {
        const p = pos(f);
        const t0 = f.at;
        const t1 = f.at + dSec;
        if (p) {
          keys.dx.push([t0, last[0] - x0], [t1, p[0] - x0, ease]);
          keys.dy.push([t0, last[1] - y0], [t1, p[1] - y0, ease]);
          if (!prev) {
            keys.opacity.push([t0, 0], [t1, 1, ease]);
            keys.scale.push([t0, 0.9], [t1, 1, ease]);
          }
          last = p;
        } else if (prev) {
          keys.opacity.push([t0, 1], [t0 + dSec * 0.6, 0, ease]);
          keys.scale.push([t0, 1], [t0 + dSec * 0.6, 0.9, ease]);
        }
        prev = p;
      }
      const wrap: IRLayer = {
        id: `${c.id}.w${i}`,
        type: 'group',
        from: 0,
        to: c.lenFrames,
        x: x0 - iw / 2,
        y: y0 - ih / 2,
        w: iw,
        h: ih,
        anchor: [0, 0],
        style: {},
        anims: [],
        children: kids,
      };
      const a = S.keysAnim(keys, c.lenFrames, c.scope, `${c.path}.steps`);
      if (a) wrap.anims.push(a);
      if (typeof it?.id === 'string') S.registerName(`${fullName(c) ?? 'list'}.${it.id}`, wrap, c.path);
      children.push(wrap);
    });
    const count = items.length;
    const totalW = dir === 'row' ? count * (iw + gap) - gap : dir === 'grid' ? Math.min(count, cols) * (iw + gap) - gap : iw;
    const totalH = dir === 'row' ? ih : dir === 'grid' ? Math.ceil(count / cols) * (ih + gap) - gap : count * (ih + gap) - gap;
    const layer: IRLayer = { ...(c.base as IRLayer), type: 'group', w: c.base.w ?? totalW, h: c.base.h ?? totalH, style: {}, children, anims: [] };
    for (const f of frames.slice(1)) S.mark({ t: S.frames(f.at), kind: 'state', name: 'list' });
    return [layer];
  },
});
