/**
 * Real interfaces in the edit: {"type":"capture", "src":"cap_xxx", "w":1400, "frame":"browser|none",
 *  "cursor": true | {"style":"arrow|hand|dot", "color"}, "cps": 14, "hold": 0.8, "fit": true, "zoom": true,
 *  "radius": 16, "shadow": true}
 * The screenshots recorded by mf_capture are cut together in order; a synthetic cursor travels to
 * each clicked/typed element (positions recorded during the capture), clicks with a ripple, typing
 * shows progressively, scrolls slide. With "zoom": true the view pushes in on the element being used.
 * Click / type markers are emitted so sounds (audio "on": "clicks") stay in sync.
 */
import { isObj } from '../../core/util';
import type { IRAnim, IRLayer, Keyframe } from '../../ir/types';
import type { Session } from '../compile';
import { lookupToken } from '../bind';
import { registerLayer } from '../registry';
import { CURSORS } from './gestures';

interface Seg {
  shot: number;
  at: number; // seconds
  how: 'cut' | 'fade' | 'slide';
}

registerLayer('capture', {
  keys: ['src', 'frame', 'cursor', 'cps', 'hold', 'fit', 'zoom', 'radius', 'shadow', 'url'],
  compile(S, c) {
    const n = c.node;
    const id = String(n.src ?? '');
    const rec = S.opts.loadCapture?.(id);
    if (!rec) {
      S.err(`${c.path}.src`, `unknown capture "${id}" — record one with mf_capture {url, steps}`);
      return [];
    }
    const frame = n.frame === undefined ? 'browser' : String(n.frame);
    const bar = frame === 'browser' ? 46 : 0;
    const w = Number(c.base.w ?? Math.min(S.W * 0.82, rec.width));
    const k = w / rec.width;
    const vh = rec.height * k;
    const h = vh + bar;
    const cps = Number(n.cps ?? 14);
    const hold = Number(n.hold ?? 0.8);
    const fps = S.fps;
    // ---- timeline (seconds) ----
    const segs: Seg[] = [{ shot: 0, at: 0, how: 'cut' }];
    const moves: { s: number; e: number; to: [number, number] }[] = [];
    const clicks: number[] = [];
    const typing: { s: number; d: number }[] = [];
    const focus: { s: number; e: number; rect: { x: number; y: number; w: number; h: number } }[] = [];
    let t = hold;
    let shotIdx = 0;
    const shotsFor = (step: number) => rec.shots.map((s: any, i: number) => ({ ...s, i })).filter((s: any) => s.step === step);
    rec.steps.forEach((st: any, i: number) => {
      const shots = shotsFor(i);
      const center = st.rect ? ([(st.rect.x + st.rect.w / 2) * k, (st.rect.y + st.rect.h / 2) * k + bar] as [number, number]) : null;
      if ((st.do === 'click' || st.do === 'hover' || st.do === 'select') && center) {
        moves.push({ s: t, e: t + 0.6, to: center });
        t += 0.6;
        if (st.do !== 'hover') {
          clicks.push(t);
          focus.push({ s: t - 0.6, e: t + 0.9, rect: st.rect });
        }
        t += 0.15;
        for (const sh of shots) segs.push({ shot: sh.i, at: t, how: 'fade' });
        t += hold;
      } else if (st.do === 'type' && center) {
        moves.push({ s: t, e: t + 0.5, to: center });
        t += 0.5;
        clicks.push(t);
        t += 0.15;
        const text = String(st.text ?? '');
        const d = Math.max(0.3, text.length / cps);
        typing.push({ s: t, d });
        focus.push({ s: t - 0.65, e: t + d + 0.4, rect: st.rect });
        shots.forEach((sh: any, j: number) => segs.push({ shot: sh.i, at: t + ((j + 1) / shots.length) * d - 0.02, how: 'cut' }));
        t += d + hold * 0.6;
      } else if (st.do === 'scroll') {
        for (const sh of shots) segs.push({ shot: sh.i, at: t, how: 'slide' });
        t += 0.7 + hold * 0.5;
      } else if (st.do === 'wait' && !shots.length) {
        t += Math.min(2, Number(st.ms ?? 600) / 1000);
      } else {
        for (const sh of shots) segs.push({ shot: sh.i, at: t, how: 'fade' });
        t += hold;
      }
      if (st.error) S.warn(`${c.path}`, `capture step ${i + 1} (${st.do}) failed when recorded: ${st.error}`);
      shotIdx += shots.length;
    });
    void shotIdx;
    const natural = t + 0.4;
    const lenSec = c.lenSec;
    const scale = n.fit !== false && natural > lenSec ? lenSec / natural : 1;
    const F = (sec: number) => Math.round(sec * scale * fps);
    // ---- layers ----
    const kids: IRLayer[] = [];
    const radius = Number(n.radius ?? 16);
    const surface = String(lookupToken(S.tokens, 'color.surface') ?? '#1b2131');
    const muted = String(lookupToken(S.tokens, 'color.muted') ?? '#8892a6');
    const base = (o: Partial<IRLayer>): IRLayer => ({ id: '', type: 'rect', from: 0, to: c.lenFrames, x: 0, y: 0, anchor: [0, 0], style: {}, anims: [], ...o }) as IRLayer;
    kids.push(base({ id: `${c.id}.bg`, type: 'rect', w, h, style: { fill: surface, radius, ...(n.shadow !== false ? { boxShadow: '0 40px 120px rgba(0,0,0,0.45)' } : {}) } }));
    if (bar) {
      kids.push(base({ id: `${c.id}.dot0`, type: 'ellipse', x: 26, y: bar / 2, anchor: [0.5, 0.5], w: 14, h: 14, style: { fill: '#ff5f57' } }));
      kids.push(base({ id: `${c.id}.dot1`, type: 'ellipse', x: 48, y: bar / 2, anchor: [0.5, 0.5], w: 14, h: 14, style: { fill: '#febc2e' } }));
      kids.push(base({ id: `${c.id}.dot2`, type: 'ellipse', x: 70, y: bar / 2, anchor: [0.5, 0.5], w: 14, h: 14, style: { fill: '#28c840' } }));
      const url = String(n.url ?? rec.url).replace(/^https?:\/\//, '').replace(/^inline:html$/, rec.title ?? '');
      kids.push(base({ id: `${c.id}.url`, type: 'text', x: w / 2, y: bar / 2, anchor: [0.5, 0.5], text: url.length > 60 ? url.slice(0, 57) + '…' : url, style: { size: 18, color: muted, font: lookupToken(S.tokens, 'font.body') as string } }));
    }
    // viewport group (clipped) with the screenshots
    const shotsLayers: IRLayer[] = [];
    segs.forEach((sg, i) => {
      const next = segs[i + 1];
      const from = F(sg.at);
      const to = next ? F(next.at) + (next.how === 'fade' ? Math.round(0.25 * fps) : next.how === 'slide' ? Math.round(0.6 * fps) : 0) : c.lenFrames;
      if (to <= from) return;
      const src = S.assetSrc(`asset:${rec.shots[sg.shot].asset}`, `${c.path}.src`);
      if (!src) return;
      const anims: IRAnim[] = [];
      if (sg.how === 'fade') anims.push({ s: 0, e: Math.round(0.25 * fps), tracks: { opacity: [[0, 0], [1, 1, 'inOut']] }, n: 'capture' });
      if (sg.how === 'slide') {
        const prevY = rec.shots[segs[i - 1]?.shot ?? 0].scrollY;
        const dy = (rec.shots[sg.shot].scrollY - prevY) * k;
        anims.push({ s: 0, e: Math.round(0.6 * fps), tracks: { dy: [[0, Math.max(-vh, Math.min(vh, dy))], [1, 0, 'inOut']] }, n: 'capture' });
        // the previous shot leaves upwards
        const prev = shotsLayers[shotsLayers.length - 1];
        if (prev) prev.anims.push({ s: from - prev.from, e: from - prev.from + Math.round(0.6 * fps), tracks: { dy: [[0, 0], [1, -Math.max(-vh, Math.min(vh, dy)), 'inOut']] }, n: 'capture' });
      }
      shotsLayers.push(base({ id: `${c.id}.shot${i}`, type: 'image', from, to, w, h: vh, src, style: { fit: 'cover' }, anims }));
    });
    const view: IRLayer = base({ id: `${c.id}.view`, type: 'group', y: bar, w, h: vh, overflow: 'hidden', children: shotsLayers } as any);
    kids.push(view);
    // cursor
    const curSpec = isObj(n.cursor) ? n.cursor : {};
    if (n.cursor !== false && moves.length) {
      const size = Number(curSpec.size ?? 34);
      const style = String(curSpec.style ?? 'arrow');
      const color = String(curSpec.color ?? '#111111');
      const start: [number, number] = [w * 0.62, h * 0.86];
      const anims: IRAnim[] = [];
      let cur = start;
      for (const m of moves) {
        const s = F(m.s);
        const e = Math.max(s + 1, F(m.e));
        anims.push({ s, e, tracks: { dx: [[0, 0], [1, m.to[0] - cur[0], 'inOutCubic']], dy: [[0, 0], [1, m.to[1] - cur[1], 'inOutCubic']] }, n: 'cursor' });
        cur = m.to;
      }
      for (const ck of clicks) {
        const s = F(ck);
        anims.push({ s, e: s + Math.round(0.25 * fps), tracks: { scale: [[0, 1], [0.35, 0.82, 'out'], [1, 1, 'out']] as Keyframe[] }, n: 'click' });
      }
      anims.push({ s: 0, e: Math.round(0.3 * fps), tracks: { opacity: [[0, 0], [1, 1]] }, n: 'cursor' });
      kids.push(base({ id: `${c.id}.cursor`, type: 'svg', x: start[0], y: start[1], anchor: [0.13, 0.08], w: size, h: size, z: 50, svg: (CURSORS[style] ?? CURSORS.arrow)(color), anims } as any));
      // ripples
      const accent = String(lookupToken(S.tokens, 'color.accent') ?? '#4f8cff');
      clicks.forEach((ck, i) => {
        const m = [...moves].reverse().find((mv) => mv.e <= ck + 1e-6);
        if (!m) return;
        const s = F(ck);
        kids.push(base({ id: `${c.id}.ripple${i}`, type: 'ellipse', from: s, to: s + Math.round(0.5 * fps), x: m.to[0], y: m.to[1], anchor: [0.5, 0.5], w: size * 2.2, h: size * 2.2, z: 49, style: { fill: 'transparent', stroke: accent, strokeWidth: 3 }, anims: [{ s: 0, e: Math.round(0.5 * fps), tracks: { scale: [[0, 0.25], [1, 1.5, 'out']], opacity: [[0, 0.9], [1, 0, 'in']] }, n: 'click' }] }));
      });
    }
    // markers (scene-local)
    const off = c.base.from ?? 0;
    for (const ck of clicks) S.mark({ t: off + F(ck), kind: 'click', name: id });
    for (const ty of typing) S.mark({ t: off + F(ty.s), kind: 'type', d: F(ty.d), name: id });
    const group: IRLayer = { ...(c.base as IRLayer), type: 'group', w, h, style: {}, anims: [...(c.base.anims ?? [])], children: kids };
    // zoom: push in on the element being used, then back out
    if (n.zoom) {
      const z = Number(typeof n.zoom === 'number' ? n.zoom : 1.6);
      for (const f of focus) {
        const cx = (f.rect.x + f.rect.w / 2) * k;
        const cy = (f.rect.y + f.rect.h / 2) * k + bar;
        const s = F(f.s);
        const e = Math.max(s + 2, F(f.e));
        const tx = (w / 2 - cx) * (z - 1);
        const ty = (h / 2 - cy) * (z - 1);
        group.anims.push({ s, e: e + Math.round(0.5 * fps), tracks: { scale: [[0, 1], [0.3, z, 'inOutCubic'], [0.75, z], [1, 1, 'inOutCubic']], dx: [[0, 0], [0.3, tx, 'inOutCubic'], [0.75, tx], [1, 0, 'inOutCubic']], dy: [[0, 0], [0.3, ty, 'inOutCubic'], [0.75, ty], [1, 0, 'inOutCubic']] }, n: 'capture-zoom' });
      }
    }
    if (natural * scale < lenSec - 0.05 && natural > lenSec) S.warn(c.path, 'capture sped up to fit the layer');
    if (scale < 0.7) S.warn(c.path, `the capture needs ${natural.toFixed(1)} s; it was sped up ×${(1 / scale).toFixed(2)} to fit — give the scene a longer "d"`);
    return [group];
  },
});
