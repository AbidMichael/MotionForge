/**
 * Transitions with continuity (transition presets whose body has "continuity"):
 *  - "match"   : layers with the same id in both scenes fly from their place in A to their place in B
 *                (magic move); the rest crossfades.            → core:morph {"match": "auto" | [["a","b"], …]}
 *  - "expand"  : a card in scene A grows into the whole of scene B.   → core:expand {"from": "#card"}
 *  - "collapse": scene A shrinks into a card of scene B.               → core:collapse {"to": "#card"}
 */
import { isObj } from '../../core/util';
import type { IRAnim, IRLayer, Keyframe } from '../../ir/types';
import type { Rect } from '../../ir/geometry';
import type { Session, TransitionRun } from '../compile';
import { hooks } from '../registry';
import type { LBox } from '../layoutmap';
import type { SceneCtx } from '../registry';

/** Opacity switch at local frame s (value before → after), holding afterwards. */
function step(s: number, end: number, from: number, to: number): IRAnim {
  const len = Math.max(1, end - s);
  return { s: Math.max(0, s), e: Math.max(s + 1, end), tracks: { opacity: [[0, from], [Math.min(1, 1 / len), to]] }, n: 'continuity' };
}

function strip(l: IRLayer, suffix: string, keepAnims: boolean): IRLayer {
  const out: IRLayer = { ...l, id: l.id + suffix, name: undefined, ptr: undefined, textPtr: undefined, anims: keepAnims ? l.anims : [] };
  if (l.children) out.children = l.children.map((k) => strip(k, suffix, false));
  return out;
}

function radiusOf(b: LBox): number {
  const r = b.layer.style.radius;
  return typeof r === 'number' ? r : parseFloat(String(r ?? 0)) || 0;
}

/** A copy of a box's layer placed in frame coordinates (top-left anchored). */
function placedClone(b: LBox, suffix: string, len: number): IRLayer {
  const c = strip(b.layer, suffix, false);
  c.from = 0;
  c.to = len;
  c.x = b.rect.x;
  c.y = b.rect.y;
  c.anchor = [0, 0];
  c.scale = undefined;
  if (c.type === 'text' && c.w === undefined) c.w = b.rect.w;
  if (c.type === 'group' && (c.w === undefined || c.h === undefined)) {
    c.w = b.rect.w;
    c.h = b.rect.h;
  }
  if (c.type === 'line' && c.points) {
    const [x1, y1, x2, y2] = c.points;
    const ox = Math.min(x1, x2);
    const oy = Math.min(y1, y2);
    c.points = [x1 - ox + b.rect.x, y1 - oy + b.rect.y, x2 - ox + b.rect.x, y2 - oy + b.rect.y];
  }
  return c;
}

function overlayGroup(S: Session, run: TransitionRun, children: IRLayer[], tag: string, z = 900): IRLayer {
  return {
    id: `t${run.idx}.${tag}`,
    type: 'group',
    from: run.absStart,
    to: run.absStart + run.tdF,
    x: 0,
    y: 0,
    w: S.W,
    h: S.H,
    anchor: [0, 0],
    style: {},
    anims: [],
    children,
    z,
    src_preset: run.u.hit.id,
  };
}

function match(S: Session, run: TransitionRun) {
  const { A, B } = run;
  if (!A || !B) return S.err(run.path, 'morph needs a scene on both sides');
  const la = S.sceneLayout(A);
  const lb = S.sceneLayout(B);
  let pairs: [string, string][] = [];
  const spec = run.u.values.match;
  if (Array.isArray(spec)) pairs = spec.map((p: any) => (Array.isArray(p) ? [String(p[0]), String(p[1])] : [String(p), String(p)])) as [string, string][];
  else {
    for (const name of la.byName.keys()) if (lb.byName.has(name)) pairs.push([name, name]);
    if (!pairs.length) S.warn(run.path, 'morph found no layers with the same id in both scenes; give matching layers the same "id"');
  }
  const ease = typeof run.u.values.ease === 'string' ? run.u.values.ease : 'cubic(0.65,0,0.25,1)';
  const len = run.tdF;
  const kids: IRLayer[] = [];
  pairs.forEach(([na, nb], i) => {
    const a = la.find(na);
    const b = lb.find(nb);
    if (!a || !b) return S.warn(run.path, `morph: "${!a ? na : nb}" not found in scene ${!a ? A.index + 1 : B.index + 1}`);
    if (a.remapped || b.remapped) return;
    // hide the originals while the copy travels
    a.layer.anims.push(step(S.frames(0) + run.aStart - a.abs0, a.abs1 - a.abs0, 1, 0));
    b.layer.anims.push(step(len - b.abs0, b.abs1 - b.abs0, 0, 1));
    const ra = a.rect;
    const rb = b.rect;
    const dx: Keyframe[] = [[0, ra.x - rb.x], [1, 0, ease]];
    const dy: Keyframe[] = [[0, ra.y - rb.y], [1, 0, ease]];
    const boxy = ['rect', 'ellipse', 'image', 'video'].includes(b.layer.type);
    if (boxy) {
      const c = placedClone(b, `~m${i}`, len);
      const tracks: Record<string, Keyframe[]> = { dx, dy, bw: [[0, ra.w], [1, rb.w, ease]], bh: [[0, ra.h], [1, rb.h, ease]] };
      const fa = (a.layer.style.fill ?? a.layer.style.color) as string | undefined;
      const fb = (b.layer.style.fill ?? b.layer.style.color) as string | undefined;
      if (fa && fb && fa !== fb && /^(#|rgb)/.test(fa) && /^(#|rgb)/.test(fb)) tracks.color = [[0, fa], [1, fb, ease]];
      c.anims = [{ s: 0, e: len, tracks, n: 'morph' }];
      c.style = { ...c.style, radius: radiusOf(b) || c.style.radius };
      kids.push(c);
      return;
    }
    // text and groups: the B copy scales from A's box; for groups an A copy crossfades on top
    const uniform = b.layer.type === 'text';
    const sx = rb.w ? ra.w / rb.w : 1;
    const sy = rb.h ? ra.h / rb.h : 1;
    const s0 = uniform ? (rb.h ? ra.h / rb.h : 1) : 1;
    const cb = placedClone(b, `~mb${i}`, len);
    const tracksB: Record<string, Keyframe[]> = uniform
      ? { dx, dy, scale: [[0, s0], [1, 1, ease]] }
      : { dx, dy, scaleX: [[0, sx], [1, 1, ease]], scaleY: [[0, sy], [1, 1, ease]] };
    const ca = (a.layer.style.color as string) ?? undefined;
    const cbCol = (b.layer.style.color as string) ?? undefined;
    if (uniform && ca && cbCol && ca !== cbCol && /^(#|rgb)/.test(ca) && /^(#|rgb)/.test(cbCol)) tracksB.color = [[0, ca], [1, cbCol, ease]];
    cb.anims = [{ s: 0, e: len, tracks: tracksB, n: 'morph' }];
    if (!uniform) {
      cb.anims.push({ s: 0, e: len, tracks: { opacity: [[0, 0], [0.5, 1, 'inOut']] }, n: 'morph' });
      const cA = placedClone(a, `~ma${i}`, len);
      cA.anims = [
        { s: 0, e: len, tracks: { dx: [[0, 0], [1, rb.x - ra.x, ease]], dy: [[0, 0], [1, rb.y - ra.y, ease]], scaleX: [[0, 1], [1, ra.w ? rb.w / ra.w : 1, ease]], scaleY: [[0, 1], [1, ra.h ? rb.h / ra.h : 1, ease]] }, n: 'morph' },
        { s: 0, e: len, tracks: { opacity: [[0, 1], [0.55, 0, 'inOut']] }, n: 'morph' },
      ];
      kids.push(cA);
    }
    kids.push(cb);
  });
  if (kids.length) run.overlays.push(overlayGroup(S, run, kids, 'morph'));
}

function insetsOf(r: Rect, S: Session) {
  return { il: r.x, it: r.y, ir: S.W - (r.x + r.w), ib: S.H - (r.y + r.h) };
}

/** Wrap a scene's content in a full-frame group we can scale (the scene group keeps the clip). */
function contentWrapper(S: Session, sc: SceneCtx): IRLayer {
  const kids = sc.group.children ?? [];
  if (kids.length === 1 && kids[0].id === `${sc.group.id}.cw`) return kids[0];
  const w: IRLayer = { id: `${sc.group.id}.cw`, type: 'group', from: 0, to: sc.frames, x: S.W / 2, y: S.H / 2, w: S.W, h: S.H, anchor: [0.5, 0.5], style: {}, anims: [], children: kids };
  sc.group.children = [w];
  return w;
}

function grow(S: Session, run: TransitionRun, mode: 'expand' | 'collapse') {
  const { A, B } = run;
  if (!A || !B) return S.err(run.path, `${mode} needs a scene on both sides`);
  const ref = String(run.u.values[mode === 'expand' ? 'from' : 'to'] ?? '').replace(/^#/, '');
  const host = mode === 'expand' ? A : B;
  const big = mode === 'expand' ? B : A;
  const card = S.sceneLayout(host).find(ref);
  if (!card) return S.err(run.path, `${mode}: no layer "#${ref}" in scene ${host.index + 1} (ids: ${[...S.sceneLayout(host).byName.keys()].slice(0, 15).join(', ')})`);
  const ease = typeof run.u.values.ease === 'string' ? run.u.values.ease : 'cubic(0.7,0,0.2,1)';
  const len = run.tdF;
  const r = card.rect;
  const ins = insetsOf(r, S);
  const rad = radiusOf(card);
  const s0 = Math.max(r.w / S.W, r.h / S.H);
  const cx = r.x + r.w / 2 - S.W / 2;
  const cy = r.y + r.h / 2 - S.H / 2;
  const t0 = mode === 'expand' ? 0 : run.aStart; // where the move starts in the big scene's clock
  const at = (k: number) => k;
  const from = mode === 'expand' ? 0 : 1;
  const to = 1 - from;
  const v = (open: number, closed: number) => (k: number) => (k === from ? closed : open) as number;
  void v;
  const kf = (closed: number, open: number): Keyframe[] => (mode === 'expand' ? [[0, closed], [1, open, ease]] : [[0, open], [1, closed, ease]]);
  big.group.anims.push({
    s: t0,
    e: t0 + len,
    tracks: { il: kf(ins.il, 0), it: kf(ins.it, 0), ir: kf(ins.ir, 0), ib: kf(ins.ib, 0), rad: kf(rad, 0) },
    n: run.u.hit.id,
  });
  const cw = contentWrapper(S, big);
  cw.anims.push({ s: t0, e: t0 + len, tracks: { scale: kf(s0, 1), dx: kf(cx, 0), dy: kf(cy, 0) }, n: run.u.hit.id });
  void at;
  void to;
  if (mode === 'expand') {
    // the card disappears as the scene takes over; the old scene recedes
    card.layer.anims.push(step(run.aStart - card.abs0, card.abs1 - card.abs0, 1, 0));
    A.group.anims.push({ s: run.aStart, e: run.aStart + len, tracks: { brightness: [[0, 1], [1, 0.45, 'inOut']], scale: [[0, 1], [1, 0.96, 'inOut']] }, n: run.u.hit.id });
  } else {
    A.group.z = 5;
    card.layer.anims.push(step(len - card.abs0, card.abs1 - card.abs0, 0, 1));
    B.group.anims.push({ s: 0, e: len, tracks: { brightness: [[0, 0.45], [1, 1, 'inOut']], scale: [[0, 0.96], [1, 1, 'inOut']] }, n: run.u.hit.id });
  }
}

hooks.continuity = (S, run) => {
  const mode = run.u.body.continuity;
  if (mode === 'match') return match(S, run);
  if (mode === 'expand' || mode === 'collapse') return grow(S, run, mode);
  S.err(run.path, `unknown continuity "${mode}" (match, expand, collapse)`);
};

export { isObj };
