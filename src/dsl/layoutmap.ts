/**
 * Static layout of an IR layer tree: where every layer sits (resting state, no animation) in the
 * coordinates of the tree's root. It mirrors how the IR player positions things (absolute boxes
 * with anchors, flex groups, text wrapping with real font metrics), so gestures, connectors,
 * morph transitions, the quality checks and the visual editor all agree on the same boxes.
 */
import type { IRLayer } from '../ir/types';
import type { Rect } from '../ir/geometry';
import { measureText, type TextStyle } from './metrics';

export interface LBox {
  layer: IRLayer;
  rect: Rect;
  /** Start frame relative to the root. */
  abs0: number;
  abs1: number;
  parent?: LBox;
  depth: number;
  /** Text measurement details. */
  text?: { lines: string[]; overflowX: boolean; size: number; approx: boolean };
  /** True inside a time-remapped group (frames there are child frames). */
  remapped?: boolean;
}

const num = (v: unknown, d = 0) => (typeof v === 'number' ? v : v == null ? d : parseFloat(String(v)) || d);

export function parsePadding(p: unknown): [number, number, number, number] {
  if (p == null) return [0, 0, 0, 0];
  if (typeof p === 'number') return [p, p, p, p];
  const parts = String(p)
    .trim()
    .split(/\s+/)
    .map((x) => parseFloat(x) || 0);
  const [t, r = t, b = t, l = r] = parts;
  // em paddings are relative to the font size; approximate with 0 here and let the caller scale
  return [t, r, b, l];
}

function paddingPx(layer: IRLayer): [number, number, number, number] {
  const p = layer.style.padding;
  if (typeof p === 'string' && /em/.test(p)) {
    const size = num(layer.style.size, 64);
    const parts = p.trim().split(/\s+/).map((x) => (x.endsWith('em') ? parseFloat(x) * size : parseFloat(x) || 0));
    const [t, r = t, b = t, l = r] = parts;
    return [t, r, b, l];
  }
  return parsePadding(p);
}

export function textStyleOf(layer: IRLayer, sizeOverride?: number): TextStyle {
  const s = layer.style;
  return {
    family: (s.font as string) ?? 'Inter',
    weight: (s.weight as number) ?? 700,
    italic: !!s.italic,
    size: sizeOverride ?? num(s.size, 64),
    tracking: num(s.tracking, 0),
    lineHeight: s.lineHeight != null ? num(s.lineHeight, 1.1) : 1.1,
    upper: s.case === 'upper',
  };
}

/** Longest string a counter will show (for sizing). */
function counterSample(layer: IRLayer): string {
  const c = layer.counter!;
  const v = Math.max(Math.abs(c.from), Math.abs(c.to));
  const dec = c.decimals ?? 0;
  const int = Math.floor(v).toString().replace(/\B(?=(\d{3})+(?!\d))/g, c.sep ?? ',');
  return (c.prefix ?? '') + (c.from < 0 || c.to < 0 ? '-' : '') + int + (dec ? '.' + '0'.repeat(dec) : '') + (c.suffix ?? '');
}

interface Sized {
  w: number;
  h: number;
  text?: LBox['text'];
}

export class LayoutMap {
  boxes: LBox[] = [];
  byLayer = new Map<IRLayer, LBox>();
  byName = new Map<string, LBox>();
  private sizeCache = new Map<IRLayer, Sized>();

  constructor(root: IRLayer, rootRect: Rect) {
    const box: LBox = { layer: root, rect: rootRect, abs0: 0, abs1: root.to - root.from, depth: 0 };
    this.add(box);
    this.placeChildren(box, root.children ?? []);
  }

  private add(b: LBox) {
    this.boxes.push(b);
    this.byLayer.set(b.layer, b);
    if (b.layer.name && !this.byName.has(b.layer.name)) this.byName.set(b.layer.name, b);
  }

  size(layer: IRLayer): Sized {
    const hit = this.sizeCache.get(layer);
    if (hit) return hit;
    let out: Sized;
    const pad = paddingPx(layer);
    switch (layer.type) {
      case 'text': {
        const st = textStyleOf(layer);
        const str = layer.counter ? counterSample(layer) : layer.text ?? '';
        const innerW = layer.w !== undefined ? Math.max(1, layer.w - pad[1] - pad[3]) : undefined;
        const m = measureText(str, st, innerW);
        const w = layer.w ?? m.w + pad[1] + pad[3];
        out = { w, h: layer.h ?? m.h + pad[0] + pad[2], text: { lines: m.lines, overflowX: m.overflowX, size: st.size, approx: m.approx } };
        break;
      }
      case 'line': {
        const [x1, y1, x2, y2] = layer.points ?? [0, 0, 0, 0];
        out = { w: Math.abs(x2 - x1), h: Math.abs(y2 - y1) };
        break;
      }
      case 'group': {
        if (layer.w !== undefined && layer.h !== undefined) out = { w: layer.w, h: layer.h };
        else if (layer.layout) {
          const kids = (layer.children ?? []).map((k) => this.size(k));
          const row = layer.layout.dir === 'row';
          const gap = layer.layout.gap ?? 0;
          const main = kids.reduce((n, k) => n + (row ? k.w : k.h), 0) + gap * Math.max(0, kids.length - 1);
          const cross = Math.max(0, ...kids.map((k) => (row ? k.h : k.w)));
          out = { w: layer.w ?? (row ? main : cross) + pad[1] + pad[3], h: layer.h ?? (row ? cross : main) + pad[0] + pad[2] };
        } else out = { w: layer.w ?? 0, h: layer.h ?? 0 };
        break;
      }
      default:
        out = { w: layer.w ?? 0, h: layer.h ?? 0 };
    }
    this.sizeCache.set(layer, out);
    return out;
  }

  private placeChildren(parent: LBox, kids: IRLayer[]) {
    const pl = parent.layer;
    const remapped = parent.remapped || !!pl.time;
    if (pl.type === 'group' && pl.layout) {
      const L = pl.layout;
      const pad = paddingPx(pl);
      const row = L.dir === 'row';
      const sizes = kids.map((k) => this.size(k));
      const gap = L.gap ?? 0;
      const inner = { w: parent.rect.w - pad[1] - pad[3], h: parent.rect.h - pad[0] - pad[2] };
      const used = sizes.reduce((n, s) => n + (row ? s.w : s.h), 0) + gap * Math.max(0, kids.length - 1);
      const free = Math.max(0, (row ? inner.w : inner.h) - used);
      let cursor = 0;
      let between = gap;
      if (L.justify === 'center') cursor = free / 2;
      else if (L.justify === 'end') cursor = free;
      else if (L.justify === 'between' && kids.length > 1) between = gap + free / (kids.length - 1);
      kids.forEach((k, i) => {
        const s = sizes[i];
        const crossFree = (row ? inner.h : inner.w) - (row ? s.h : s.w);
        const align = L.align ?? 'center';
        const c = align === 'start' || align === 'stretch' ? 0 : align === 'end' ? crossFree : crossFree / 2;
        const x = parent.rect.x + pad[3] + (row ? cursor : c);
        const y = parent.rect.y + pad[0] + (row ? c : cursor);
        this.place(k, parent, { x, y, w: s.w, h: s.h }, remapped);
        cursor += (row ? s.w : s.h) + between;
      });
      return;
    }
    for (const k of kids) this.place(k, parent, null, remapped);
  }

  private place(layer: IRLayer, parent: LBox, flowRect: Rect | null, remapped: boolean) {
    const s = this.size(layer);
    let rect: Rect;
    if (flowRect) rect = flowRect;
    else if (layer.type === 'line') {
      const [x1, y1, x2, y2] = layer.points ?? [0, 0, 0, 0];
      rect = { x: parent.rect.x + Math.min(x1, x2), y: parent.rect.y + Math.min(y1, y2), w: s.w, h: s.h };
    } else if (layer.type === 'connector') {
      rect = { x: parent.rect.x, y: parent.rect.y, w: 0, h: 0 };
    } else {
      const [ax, ay] = layer.anchor;
      rect = { x: parent.rect.x + layer.x - ax * s.w, y: parent.rect.y + layer.y - ay * s.h, w: s.w, h: s.h };
    }
    const sc = layer.scale ?? 1;
    if (sc !== 1) {
      const [ax, ay] = flowRect ? [0.5, 0.5] : layer.anchor;
      const px = rect.x + ax * rect.w;
      const py = rect.y + ay * rect.h;
      rect = { x: px - (px - rect.x) * sc, y: py - (py - rect.y) * sc, w: rect.w * sc, h: rect.h * sc };
    }
    const box: LBox = {
      layer,
      rect,
      abs0: parent.abs0 + layer.from,
      abs1: parent.abs0 + layer.to,
      parent,
      depth: parent.depth + 1,
      text: s.text,
      remapped: remapped || undefined,
    };
    this.add(box);
    if (layer.children?.length) this.placeChildren(box, layer.children);
  }

  /** Box of a named layer ("card", "form.email"). */
  find(name: string): LBox | undefined {
    return this.byName.get(name.replace(/^#/, ''));
  }

  /** Visible boxes at a root-relative frame (not inside remapped groups). */
  visibleAt(frame: number): LBox[] {
    return this.boxes.filter((b) => !b.remapped && b.depth > 0 && frame >= b.abs0 && frame < b.abs1);
  }
}

/** Ancestors (closest first) of a box, excluding the root. */
export function ancestors(b: LBox): LBox[] {
  const out: LBox[] = [];
  for (let p = b.parent; p && p.depth > 0; p = p.parent) out.push(p);
  return out;
}
