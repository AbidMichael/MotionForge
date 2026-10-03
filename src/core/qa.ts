/**
 * Visual quality checks.
 * Static (from the compiled IR and real font metrics): clipped or overflowing text, elements out of
 * frame or too close to the edges, overlapping text, reading speed, very short/long shots.
 * From rendered frames: low contrast between text and what is actually behind it, empty frames,
 * and consecutive shots that look nearly identical.
 */
import sharp from 'sharp';
import type { IRDoc, IRLayer } from '../ir/types';
import { evaluateAnims, parseColor } from '../ir/evaluate';
import { intersection, area, type Rect } from '../ir/geometry';
import { LayoutMap, type LBox } from '../dsl/layoutmap';

export interface QAIssue {
  severity: 'error' | 'warning' | 'info';
  kind: 'text-overflow' | 'out-of-frame' | 'edge' | 'overlap' | 'contrast' | 'reading-speed' | 'short-shot' | 'long-shot' | 'empty-frame' | 'near-duplicate' | 'tiny-text';
  scene: number;
  t: number;
  layer?: string;
  ptr?: string;
  msg: string;
  fix?: string;
  rect?: Rect;
}

const luminance = (c: [number, number, number]) => {
  const f = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
};
const ratio = (a: number, b: number) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);

const label = (b: LBox) => b.layer.name ?? (b.layer.text ? `"${b.layer.text.replace(/\s+/g, ' ').slice(0, 28)}"` : b.layer.id);

/** Scene layers of an IR doc with their layout. */
export function sceneLayouts(ir: IRDoc): { index: number; layer: IRLayer; layout: LayoutMap }[] {
  return ir.scenes.map((s) => {
    const layer = ir.layers.find((l) => l.id === s.id)!;
    return { index: s.index, layer, layout: new LayoutMap(layer, { x: 0, y: 0, w: ir.width, h: ir.height }) };
  });
}

const isBackdrop = (b: LBox) => {
  for (let p: LBox | undefined = b; p; p = p.parent) if (p.layer.src_preset === 'core:backdrop' || p.layer.src_preset === 'core:dots-field') return true;
  return false;
};
const insideRemapped = (b: LBox) => !!b.remapped;
/** Hidden by design (cursor, typed clones, overlays added by passes). */
const technical = (b: LBox) => /~|\.g\.|\.cw$|\.cam$/.test(b.layer.id);

/** Does this layer (or one of its parents) move: motion path or position keyframes? */
const moves = (b: LBox) => {
  for (let p: LBox | undefined = b; p; p = p.parent) if (p.layer.anims.some((a) => a.path || a.tracks.dx || a.tracks.dy)) return true;
  return false;
};

/**
 * Where a box really is at a frame (relative to the scene root): its resting rect shifted by the dx/dy
 * (motion paths included) of the layer and its parents, clipped by "overflow: hidden" parents, with the
 * combined opacity. null when it is not on screen at that frame (outside its time, clipped away).
 */
function boxAt(b: LBox, f: number): { rect: Rect; opacity: number } | null {
  if (f < b.abs0 || f >= b.abs1) return null;
  let dx = 0;
  let dy = 0;
  let opacity = 1;
  const chain: LBox[] = [];
  for (let p: LBox | undefined = b; p && p.depth > 0; p = p.parent) chain.push(p);
  // offsets of ancestors move everything below them; clips are applied with the ancestor's own offset
  const offs = chain.map((p) => {
    const st = evaluateAnims(p.layer.anims, f - p.abs0, 'layer');
    return { p, st };
  });
  for (const { p, st } of offs) {
    dx += st.dx;
    dy += st.dy;
    opacity *= st.opacity * (p.layer.opacity ?? 1);
  }
  let rect: Rect | null = { x: b.rect.x + dx, y: b.rect.y + dy, w: b.rect.w, h: b.rect.h };
  let acc = { dx: 0, dy: 0 };
  for (let i = offs.length - 1; i >= 1; i--) {
    acc = { dx: acc.dx + offs[i].st.dx, dy: acc.dy + offs[i].st.dy };
    const p = offs[i].p;
    if (p.layer.overflow === 'hidden' && rect) {
      rect = intersection(rect, { x: p.rect.x + acc.dx, y: p.rect.y + acc.dy, w: p.rect.w, h: p.rect.h });
    }
  }
  if (!rect || rect.w < 1 || rect.h < 1) return null;
  return { rect, opacity };
}

/** Sample frames across a box's life (or a shared interval). */
const samples = (a0: number, a1: number, n = 9) => {
  const out: number[] = [];
  const len = Math.max(1, a1 - a0);
  for (let i = 0; i < n; i++) out.push(Math.min(a1 - 1, Math.round(a0 + ((i + 0.5) / n) * len)));
  return [...new Set(out)];
};

const sameText = (a: LBox, b: LBox) => (a.layer.text ?? '').trim().toLowerCase() === (b.layer.text ?? '').trim().toLowerCase() && !!(a.layer.text ?? '').trim();

export function staticChecks(ir: IRDoc): QAIssue[] {
  const out: QAIssue[] = [];
  const W = ir.width;
  const H = ir.height;
  const margin = Math.round(Math.min(W, H) * 0.025);
  for (const sc of sceneLayouts(ir)) {
    const info = ir.scenes[sc.index];
    const sec = (info.end - info.start) / ir.fps;
    const tMid = +((info.start + (info.end - info.start) * 0.7) / ir.fps).toFixed(2);
    const texts = sc.layout.boxes.filter((b) => b.layer.type === 'text' && b.depth > 0 && !insideRemapped(b) && !technical(b) && (b.layer.opacity ?? 1) > 0.05);
    let words = 0;
    const tiny: { b: LBox; size: number }[] = [];
    for (const b of texts) {
      const txt = b.layer.text ?? '';
      words += txt.trim().split(/\s+/).filter(Boolean).length;
      if (b.text?.overflowX) {
        out.push({ severity: 'error', kind: 'text-overflow', scene: sc.index, t: tMid, layer: label(b), ptr: b.layer.textPtr ?? b.layer.ptr, rect: b.rect, msg: `a word is wider than its box (${Math.round(b.rect.w)} px) and will be cut or overflow`, fix: 'shorten the text, widen "w", or add "fit":"shrink"' });
      }
      if (b.layer.h !== undefined && b.text) {
        const need = b.text.lines.length * b.text.size * Number(b.layer.style.lineHeight ?? 1.1);
        if (need > b.layer.h + 2) out.push({ severity: 'error', kind: 'text-overflow', scene: sc.index, t: tMid, layer: label(b), ptr: b.layer.textPtr ?? b.layer.ptr, rect: b.rect, msg: `text needs ${b.text.lines.length} lines (${Math.round(need)} px) but the box is ${b.layer.h} px tall`, fix: 'add "fit":"shrink" or "maxLines", or shorten it' });
      }
      const size = b.text?.size ?? 0;
      if (size && size < Math.min(W, H) * 0.018) tiny.push({ b, size });
    }
    if (tiny.length) {
      // one issue per scene: many small labels (HUD, captions, timecodes) are usually one design choice
      tiny.sort((x, y) => x.size - y.size);
      const names = [...new Set(tiny.map((x) => label(x.b)))];
      out.push({
        severity: 'warning',
        kind: 'tiny-text',
        scene: sc.index,
        t: tMid,
        layer: names.slice(0, 3).join(', ') + (names.length > 3 ? ` +${names.length - 3}` : ''),
        ptr: tiny[0].b.layer.ptr,
        rect: tiny[0].b.rect,
        msg: tiny.length === 1 ? `text is ${Math.round(tiny[0].size)} px — hard to read on a phone` : `${tiny.length} texts are ${Math.round(tiny[0].size)}–${Math.round(tiny[tiny.length - 1].size)} px — hard to read on a phone`,
        fix: `use at least ${Math.round(Math.min(W, H) * 0.022)} px (fine for decorative HUD details)`,
      });
    }
    // out of frame / edges (resting positions)
    for (const b of sc.layout.boxes) {
      if (b.depth === 0 || insideRemapped(b) || technical(b) || isBackdrop(b)) continue;
      if (!['text', 'rect', 'ellipse', 'image', 'video', 'svg', 'group', 'chart', 'three', 'sim'].includes(b.layer.type)) continue;
      const r = b.rect;
      if (r.w <= 1 || r.h <= 1) continue;
      if (r.w >= W * 0.98 && r.h >= H * 0.98) continue; // full-frame layers
      if (b.layer.type === 'group' && b.layer.children?.length && !b.layer.style.bg && !b.layer.style.fill) continue; // judged by its children
      const frame = { x: 0, y: 0, w: W, h: H };
      const visibleIn = (rr: Rect) => {
        const inside = intersection(rr, frame);
        return inside ? area(inside) / area(rr) : 0;
      };
      if (moves(b)) {
        // moving layers (motion paths, dx/dy): judge where it actually goes, not where it starts
        let best = 0;
        let bestRect = r;
        for (const f of samples(b.abs0, b.abs1, 15)) {
          const at = boxAt(b, f);
          if (!at || at.opacity < 0.05) continue;
          const v = visibleIn(at.rect);
          if (v > best) (best = v), (bestRect = at.rect);
        }
        if (best < 0.05) out.push({ severity: 'error', kind: 'out-of-frame', scene: sc.index, t: tMid, layer: label(b), ptr: b.layer.ptr, rect: bestRect, msg: 'it moves but never enters the frame', fix: 'check its motion path / keyframes and position' });
        continue;
      }
      const visible = visibleIn(r);
      if (visible < 0.999) {
        const sev = visible < 0.6 ? 'error' : 'warning';
        if (b.layer.type === 'text' || visible < 0.9) out.push({ severity: sev, kind: 'out-of-frame', scene: sc.index, t: tMid, layer: label(b), ptr: b.layer.ptr, rect: r, msg: `${Math.round((1 - visible) * 100)}% of it is outside the frame at rest`, fix: 'move it in, or reduce its size' });
      } else if (b.layer.type === 'text' && (r.x < margin || r.y < margin || r.x + r.w > W - margin || r.y + r.h > H - margin)) {
        out.push({ severity: 'info', kind: 'edge', scene: sc.index, t: tMid, layer: label(b), ptr: b.layer.ptr, rect: r, msg: 'text touches the safe margin (2.5% of the frame)', fix: 'keep text inside the title-safe area' });
      }
    }
    const overlapSeen = new Map<string, QAIssue>();
    // overlapping text: both visible at the same time, at their real positions, for a good part of that time
    for (let i = 0; i < texts.length; i++) {
      for (let j = i + 1; j < texts.length; j++) {
        const a = texts[i];
        const b = texts[j];
        const s0 = Math.max(a.abs0, b.abs0);
        const s1 = Math.min(a.abs1, b.abs1);
        if (s1 <= s0) continue;
        // the same words drawn twice on top of each other are an effect (glitch, RGB split, shadow, echo, outline)
        if (sameText(a, b)) continue;
        let hits = 0;
        let seen = 0;
        let worst = 0;
        let worstRect: Rect | null = null;
        let worstF = s0;
        for (const f of samples(s0, s1, 9)) {
          const pa = boxAt(a, f);
          const pb = boxAt(b, f);
          if (!pa || !pb || pa.opacity < 0.15 || pb.opacity < 0.15) continue;
          seen++;
          const x = intersection(pa.rect, pb.rect);
          if (!x) continue;
          const frac = area(x) / Math.min(area(pa.rect), area(pb.rect));
          if (frac > 0.15) hits++;
          if (frac > worst) (worst = frac), (worstRect = x), (worstF = f);
        }
        // a crossing or a brief flash is fine; a lasting overlap (or a static one) is not
        if (!seen || hits / seen < 0.5 || !worstRect) continue;
        const issue: QAIssue = { severity: worst > 0.4 ? 'error' : 'warning', kind: 'overlap', scene: sc.index, t: +((info.start + worstF) / ir.fps).toFixed(2), layer: `${label(a)} / ${label(b)}`, ptr: a.layer.ptr, rect: worstRect, msg: `two texts overlap (${Math.round(worst * 100)}%)`, fix: 'move one, or show them at different times' };
        // copies of the same text (effects) against the same other text: one issue, the worst
        const key = [a.layer.text ?? a.layer.id, b.layer.text ?? b.layer.id].map((x) => x.trim().toLowerCase()).sort().join('|');
        const prev = overlapSeen.get(key);
        if (!prev) {
          overlapSeen.set(key, issue);
          out.push(issue);
        } else if (worst * 100 > Number(/\((\d+)%\)/.exec(prev.msg)?.[1] ?? 0)) Object.assign(prev, issue);
      }
    }
    // one source node repeated (repeat/list/each): one issue with a count
    const sceneStart = out.findIndex((i) => i.scene === sc.index);
    if (sceneStart >= 0) {
      const groups = new Map<string, QAIssue[]>();
      for (const i of out.slice(sceneStart)) {
        if (i.kind !== 'out-of-frame') continue;
        const k = `${i.ptr ?? String(i.layer).replace(/[.:#]\d+$/, '')}|${i.msg}`;
        groups.set(k, [...(groups.get(k) ?? []), i]);
      }
      for (const g of groups.values()) {
        if (g.length < 2) continue;
        g[0].layer = `${g[0].layer} (+${g.length - 1} more of the same layer)`;
        g[0].msg = `${g.length} repeated layers: ${g[0].msg}`;
        for (const extra of g.slice(1)) out.splice(out.indexOf(extra), 1);
      }
    }
    if (sec < 0.8) out.push({ severity: 'warning', kind: 'short-shot', scene: sc.index, t: info.start / ir.fps, msg: `scene lasts ${sec.toFixed(2)} s — too short to read`, fix: 'make it at least 1 s, or merge it' });
    if (sec > 14) out.push({ severity: 'info', kind: 'long-shot', scene: sc.index, t: info.start / ir.fps, msg: `scene lasts ${sec.toFixed(1)} s — attention drops on long static shots`, fix: 'split it or add movement' });
    const wps = words / Math.max(0.5, sec - 0.4);
    if (words >= 6 && wps > 3.6) out.push({ severity: 'warning', kind: 'reading-speed', scene: sc.index, t: info.start / ir.fps, msg: `${words} words in ${sec.toFixed(1)} s (${wps.toFixed(1)} words/s) — faster than people read`, fix: `give it about ${Math.ceil(words / 3 + 0.6)} s, or cut words` });
  }
  return out;
}

/** Text colour of a layer (inherits nothing: text layers carry their own colour). */
function textColor(l: IRLayer): [number, number, number] | null {
  const c = parseColor(String(l.style.color ?? '#ffffff'));
  if (!c || c[3] < 0.5) return null;
  return [c[0], c[1], c[2]];
}

export async function pixelChecks(
  ir: IRDoc,
  renderFrame: (frame: number) => Promise<string>,
  scale: number,
): Promise<{ issues: QAIssue[]; frames: { scene: number; frame: number; path: string }[] }> {
  const out: QAIssue[] = [];
  const frames: { scene: number; frame: number; path: string }[] = [];
  const thumbs: Buffer[] = [];
  for (const sc of sceneLayouts(ir)) {
    const info = ir.scenes[sc.index];
    const frame = Math.min(info.end - 1, Math.round(info.start + (info.end - info.start) * 0.7));
    const file = await renderFrame(frame);
    frames.push({ scene: sc.index, frame, path: file });
    const img = sharp(file);
    const meta = await img.metadata();
    const { data, info: rawInfo } = await img.removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const iw = rawInfo.width;
    const ih = rawInfo.height;
    const px = (x: number, y: number): [number, number, number] => {
      const i = (Math.max(0, Math.min(ih - 1, y)) * iw + Math.max(0, Math.min(iw - 1, x))) * 3;
      return [data[i], data[i + 1], data[i + 2]];
    };
    void meta;
    // empty frame
    let sum = 0;
    let sum2 = 0;
    let n = 0;
    for (let y = 0; y < ih; y += 6) for (let x = 0; x < iw; x += 6) {
      const l = luminance(px(x, y)) * 255;
      sum += l;
      sum2 += l * l;
      n++;
    }
    const sd = Math.sqrt(Math.max(0, sum2 / n - (sum / n) ** 2));
    if (sd < 1.5) out.push({ severity: 'warning', kind: 'empty-frame', scene: sc.index, t: +(frame / ir.fps).toFixed(2), msg: 'this frame is almost uniform (nothing visible?)', fix: 'check that the content is on screen at this time' });
    thumbs.push(await sharp(file).resize(48, 27, { fit: 'fill' }).greyscale().raw().toBuffer());
    // contrast: text colour vs the pixels just around the text box
    const lf = frame - info.start;
    for (const b of sc.layout.boxes) {
      if (b.layer.type !== 'text' || b.depth === 0 || b.remapped || technical(b)) continue;
      if (lf < b.abs0 || lf >= b.abs1) continue;
      if (b.layer.blend && b.layer.blend !== 'normal') continue; // blended copies are effects (glitch, glow passes)
      const tc = b.layer.style.gradient ? null : textColor(b.layer);
      if (!tc) continue;
      // real position and visibility at this frame (motion paths, moving parents, clips, fades)
      const at = boxAt(b, lf);
      if (!at || at.opacity < 0.5) continue;
      const r = at.rect;
      const bgCol = b.layer.style.bg ? parseColor(String(b.layer.style.bg)) : null;
      let bgLum: number;
      if (bgCol && bgCol[3] > 0.9) bgLum = luminance([bgCol[0], bgCol[1], bgCol[2]]);
      else {
        // sample a ring around the box and take the median luminance
        const ring: number[] = [];
        const x0 = Math.round(r.x * scale) - 6;
        const y0 = Math.round(r.y * scale) - 6;
        const x1 = Math.round((r.x + r.w) * scale) + 6;
        const y1 = Math.round((r.y + r.h) * scale) + 6;
        for (let x = x0; x <= x1; x += 3) ring.push(luminance(px(x, y0)), luminance(px(x, y1)));
        for (let y = y0; y <= y1; y += 3) ring.push(luminance(px(x0, y)), luminance(px(x1, y)));
        ring.sort((a, c) => a - c);
        bgLum = ring[Math.floor(ring.length / 2)] ?? 0;
      }
      const cr = ratio(luminance(tc), bgLum);
      const size = Number(b.layer.style.size ?? 64);
      const need = size >= 36 ? 3 : 4.5;
      if (cr < need) {
        out.push({
          severity: cr < 2 ? 'error' : 'warning',
          kind: 'contrast',
          scene: sc.index,
          t: +(frame / ir.fps).toFixed(2),
          layer: label(b),
          ptr: b.layer.ptr,
          rect: r,
          msg: `contrast ${cr.toFixed(1)}:1 against what is behind it (needs ${need}:1)`,
          fix: 'use a lighter/darker text colour, a backing panel ("bg"), or darken the background',
        });
      }
    }
  }
  for (let i = 1; i < thumbs.length; i++) {
    let d = 0;
    for (let k = 0; k < thumbs[i].length; k++) d += Math.abs(thumbs[i][k] - thumbs[i - 1][k]);
    const diff = d / thumbs[i].length / 255;
    if (diff < 0.035) out.push({ severity: 'warning', kind: 'near-duplicate', scene: i, t: +(frames[i].frame / ir.fps).toFixed(2), msg: `scene ${i + 1} looks almost the same as scene ${i} (${(diff * 100).toFixed(1)}% difference)`, fix: 'change the framing, layout or background, or merge them' });
  }
  return { issues: out, frames };
}

export function summarize(issues: QAIssue[]) {
  const by = { error: 0, warning: 0, info: 0 };
  for (const i of issues) by[i.severity]++;
  return by;
}
