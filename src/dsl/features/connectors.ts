/**
 * Dynamic connections:
 * {"type":"connector", "from":"#a", "to":"#b", "route":"auto|elbow|curve|straight",
 *  "fromSide":"auto|top|right|bottom|left", "toSide":…, "gap":10, "radius":16, "curvature":0.5,
 *  "stroke":"$color.accent", "width":3, "dash":"8 6", "arrow":"end|start|both|none", "arrowSize":14,
 *  "signal": {"color", "size":10, "every":0.6, "travel":1.2, "count":40, "at":1, "until":6, "trail":0.15, "glow":true, "reverse":false},
 *  "label":"HTTP"}
 * The arrow is attached to the boxes: it follows them when they move (drags, keys, entrances),
 * routes around the other named boxes ("auto") and draws itself in unless "in" says otherwise.
 */
import { isObj } from '../../core/util';
import type { IRConnector, IREnd, IRLayer } from '../../ir/types';
import type { Rect } from '../../ir/geometry';
import { ancestors, type LBox } from '../layoutmap';
import { registerLayer, registerScenePass, type SceneCtx } from '../registry';
import type { Session } from '../compile';

const SIDES = ['auto', 'top', 'right', 'bottom', 'left'];

registerLayer('connector', {
  keys: ['from', 'to', 'route', 'fromSide', 'toSide', 'gap', 'radius', 'curvature', 'stroke', 'width', 'dash', 'arrow', 'arrowSize', 'signal', 'label', 'labelColor', 'labelSize', 'labelBg'],
  compile(S, c) {
    const n = c.node;
    if (n.from === undefined || n.to === undefined) {
      S.err(c.path, 'connector needs "from" and "to" ("#id" or [x, y])');
      return [];
    }
    const layer: IRLayer = { ...(c.base as IRLayer), type: 'connector', x: 0, y: 0, anchor: [0, 0], style: {}, anims: [], data: { spec: n, path: c.path } };
    const hasIn = n.in !== undefined || n.anim !== undefined;
    if (!hasIn) {
      const a = S.normTracks({ draw: [0, 1] }, c.scope, c.path, 'inOut');
      if (a) layer.anims.push({ s: 0, e: S.frames(0.7), tracks: a, n: 'draw' });
    }
    return [layer];
  },
});

function endpoint(S: Session, sc: SceneCtx, v: unknown, path: string): { end: IREnd; box?: LBox } | null {
  if (Array.isArray(v) && v.length === 2) return { end: { rect: { x: Number(v[0]), y: Number(v[1]), w: 0, h: 0 } } };
  if (typeof v !== 'string') {
    S.err(path, 'expected "#id" or [x, y]');
    return null;
  }
  const box = S.sceneLayout(sc).find(v.replace(/^#/, ''));
  if (!box) {
    S.err(path, `no layer with id "${v.replace(/^#/, '')}" in this scene (ids: ${[...S.names.keys()].slice(0, 20).join(', ') || 'none'})`);
    return null;
  }
  const follow = [box, ...ancestors(box)].filter((b) => !b.remapped).map((b) => ({ id: b.layer.id, at: b.abs0 }));
  return { end: { rect: { ...box.rect }, follow }, box };
}

registerScenePass({
  name: 'connectors',
  order: 30,
  post(S, sc) {
    // find connector placeholders with their parents
    const found: { layer: IRLayer; parent: IRLayer; top: IRLayer }[] = [];
    const walk = (l: IRLayer, top: IRLayer | null) => {
      for (const k of l.children ?? []) {
        if (k.type === 'connector' && k.data?.spec) found.push({ layer: k, parent: l, top: top ?? k });
        else walk(k, top ?? k);
      }
    };
    walk(sc.group, null);
    if (!found.length) return;
    const layout = S.sceneLayout(sc);
    const named = layout.boxes.filter((b) => b.layer.name && b.depth > 0 && !b.remapped && b.rect.w > 0 && b.rect.h > 0);
    const accent = (S.tokens as any)?.color?.accent ?? '#7c8cff';
    const fg = (S.tokens as any)?.color?.fg ?? '#ffffff';
    const font = (S.tokens as any)?.font?.body ?? 'Inter, sans-serif';
    for (const f of found) {
      const n = f.layer.data.spec as Record<string, any>;
      const path = f.layer.data.path as string;
      const a = endpoint(S, sc, n.from, `${path}.from`);
      const b = endpoint(S, sc, n.to, `${path}.to`);
      // move to the scene root, keeping the original order
      const pBox = layout.byLayer.get(f.parent);
      const atRoot = f.parent === sc.group;
      if (!atRoot) f.parent.children = f.parent.children!.filter((x) => x !== f.layer);
      if (!a || !b) {
        if (atRoot) sc.group.children = sc.group.children!.filter((x) => x !== f.layer);
        continue;
      }
      const route = SIDES.includes(n.fromSide ?? 'auto') ? n.route ?? 'auto' : 'auto';
      if (!['auto', 'elbow', 'curve', 'straight'].includes(route)) S.err(`${path}.route`, 'route is auto, elbow, curve or straight');
      for (const k of ['fromSide', 'toSide']) if (n[k] !== undefined && !SIDES.includes(n[k])) S.err(`${path}.${k}`, `${k} is ${SIDES.join(', ')}`);
      const exclude = new Set<LBox>([a.box, b.box, ...(a.box ? ancestors(a.box) : []), ...(b.box ? ancestors(b.box) : [])].filter(Boolean) as LBox[]);
      const obstacles: Rect[] =
        route === 'auto'
          ? named
              .filter((x) => !exclude.has(x) && !(a.box && ancestors(x).includes(a.box)) && !(b.box && ancestors(x).includes(b.box)))
              .filter((x) => x.rect.w < S.W * 0.9 && x.rect.h < S.H * 0.9)
              .map((x) => ({ ...x.rect }))
          : [];
      const off = pBox?.abs0 ?? 0;
      const sig = isObj(n.signal) ? n.signal : n.signal === true ? {} : null;
      const conn: IRConnector = {
        a: a.end,
        b: b.end,
        route,
        fromSide: n.fromSide ?? 'auto',
        toSide: n.toSide ?? 'auto',
        gap: Number(n.gap ?? 10),
        radius: Number(n.radius ?? 18),
        curvature: Number(n.curvature ?? 0.5),
        obstacles,
        stroke: typeof n.stroke === 'string' ? n.stroke : accent,
        width: Number(n.width ?? 3),
        dash: typeof n.dash === 'string' ? n.dash : undefined,
        arrow: ['end', 'start', 'both', 'none'].includes(n.arrow) ? n.arrow : 'end',
        arrowSize: Number(n.arrowSize ?? 12 + Number(n.width ?? 3) * 1.5),
      };
      if (sig) {
        const len = f.layer.to - f.layer.from;
        conn.signal = {
          color: typeof sig.color === 'string' ? sig.color : fg,
          size: Number(sig.size ?? 10),
          every: Math.max(1, S.frames(Number(sig.every ?? 0.6))),
          travel: Math.max(1, S.frames(Number(sig.travel ?? 1.2))),
          count: Number(sig.count ?? 999),
          s: S.frames(Number(sig.at ?? 0.8)),
          e: sig.until !== undefined ? S.frames(Number(sig.until)) : len,
          trail: Number(sig.trail ?? 0.12),
          glow: sig.glow === false ? undefined : typeof sig.color === 'string' ? sig.color : fg,
          dir: sig.reverse ? -1 : 1,
        };
      }
      if (n.label !== undefined) {
        conn.label = { text: String(n.label), color: typeof n.labelColor === 'string' ? n.labelColor : fg, size: Number(n.labelSize ?? 22), font, bg: typeof n.labelBg === 'string' ? n.labelBg : undefined };
      }
      const moved: IRLayer = { ...f.layer, from: f.layer.from + off, to: f.layer.to + off, conn, data: undefined };
      // follow offsets are relative to the connector's own start
      for (const e of [conn.a, conn.b]) for (const fl of e.follow ?? []) fl.at -= moved.from;
      const kids = sc.group.children!;
      if (atRoot) kids[kids.indexOf(f.layer)] = moved;
      else {
        // drawn just above the container it came from (a window, a card…), not hidden behind it
        const idx = kids.indexOf(f.top);
        kids.splice(idx >= 0 ? idx + 1 : kids.length, 0, moved);
      }
    }
  },
});
