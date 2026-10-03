/**
 * Real text measurement at compile time, from the same font files the renderer uses (@fontsource),
 * so the compiler can wrap, shrink-to-fit, place targets for gestures/connectors and flag overflows
 * without opening a browser. Unknown fonts fall back to Inter metrics (flagged as approximate).
 */
import fs from 'node:fs';
import path from 'node:path';
import * as fontkit from 'fontkit';
import { ROOT } from '../core/config';

type Font = { unitsPerEm: number; ascent: number; descent: number; layout: (s: string) => { advanceWidth: number } };

const fontCache = new Map<string, Font | null>();
const widthCache = new Map<string, number>();
/** Extra fonts registered at runtime (asset fonts): family(lowercase) → weight → file. */
const extraFonts = new Map<string, Map<number, string>>();

export function registerFontFile(family: string, weight: number, file: string) {
  const k = family.toLowerCase();
  if (!extraFonts.has(k)) extraFonts.set(k, new Map());
  extraFonts.get(k)!.set(weight, file);
}

const slug = (family: string) => family.trim().replace(/^['"]|['"]$/g, '').toLowerCase().replace(/\s+/g, '-');

function fontsourceFile(pkg: string, weight: number, italic: boolean): string | null {
  const dir = path.join(ROOT, 'node_modules', '@fontsource', pkg, 'files');
  if (!fs.existsSync(dir)) return null;
  const style = italic ? 'italic' : 'normal';
  const files = fs.readdirSync(dir).filter((f) => new RegExp(`^${pkg}-latin-(\\d+)-${style}\\.woff2?$`).test(f));
  if (!files.length) return italic ? fontsourceFile(pkg, weight, false) : null;
  let best = files[0];
  let bd = Infinity;
  for (const f of files) {
    const w = Number(/-(\d+)-/.exec(f.slice(pkg.length))![1]);
    const d = Math.abs(w - weight) + (w < weight ? 0.5 : 0);
    if (d < bd) {
      bd = d;
      best = f;
    }
  }
  return path.join(dir, best);
}

function loadFont(file: string): Font | null {
  if (fontCache.has(file)) return fontCache.get(file)!;
  let f: Font | null = null;
  try {
    f = (fontkit as any).create(fs.readFileSync(file)) as Font;
  } catch {
    f = null;
  }
  fontCache.set(file, f);
  return f;
}

export interface FontSpec {
  family?: string; // CSS font-family list
  weight?: number | string;
  italic?: boolean;
}

/** Resolve a CSS family list to a font file. */
export function resolveFont(spec: FontSpec): { font: Font; approx: boolean } {
  const weight = Number(spec.weight ?? 400) || 400;
  const fams = (spec.family ?? 'Inter').split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, ''));
  for (const fam of fams) {
    const extra = extraFonts.get(fam.toLowerCase());
    if (extra?.size) {
      let best: string | null = null;
      let bd = Infinity;
      for (const [w, f] of extra) if (Math.abs(w - weight) < bd) (bd = Math.abs(w - weight)), (best = f);
      const font = best && loadFont(best);
      if (font) return { font, approx: false };
    }
    const file = fontsourceFile(slug(fam), weight, !!spec.italic);
    if (file) {
      const font = loadFont(file);
      if (font) return { font, approx: false };
    }
  }
  const fb = fontsourceFile('inter', weight, false);
  const font = fb ? loadFont(fb) : null;
  if (!font) throw new Error('no fallback font (install @fontsource/inter)');
  return { font, approx: true };
}

export interface TextStyle extends FontSpec {
  size: number;
  tracking?: number; // em
  lineHeight?: number;
  upper?: boolean;
}

/** Width in px of one line of text. */
export function textWidth(text: string, st: TextStyle): number {
  const t = st.upper ? text.toUpperCase() : text;
  const key = `${st.family}|${st.weight}|${st.italic ? 1 : 0}|${t}`;
  let units = widthCache.get(key);
  if (units === undefined) {
    const { font } = resolveFont(st);
    try {
      units = font.layout(t).advanceWidth / font.unitsPerEm;
    } catch {
      units = t.length * 0.55;
    }
    if (widthCache.size > 50000) widthCache.clear();
    widthCache.set(key, units);
  }
  const chars = Array.from(t).length;
  return units * st.size + (st.tracking ?? 0) * st.size * chars;
}

/** Greedy word wrap like the browser's `white-space: pre-wrap`. Words longer than the box overflow. */
export function wrapText(text: string, st: TextStyle, maxWidth?: number): string[] {
  const out: string[] = [];
  for (const para of text.split('\n')) {
    if (!maxWidth) {
      out.push(para);
      continue;
    }
    const words = para.split(/(\s+)/);
    let line = '';
    for (const w of words) {
      if (!w) continue;
      const candidate = line + w;
      if (line && /\S/.test(w) && textWidth(candidate.trimEnd(), st) > maxWidth + 0.5) {
        out.push(line.trimEnd());
        line = w.trimStart();
      } else line = candidate;
    }
    out.push(line.trimEnd());
  }
  return out;
}

export interface TextBox {
  w: number;
  h: number;
  lines: string[];
  /** Widest line is wider than the box (a word that cannot wrap). */
  overflowX: boolean;
  approx: boolean;
}

export function measureText(text: string, st: TextStyle, boxWidth?: number): TextBox {
  const lines = wrapText(text, st, boxWidth);
  const widths = lines.map((l) => textWidth(l, st));
  const maxW = Math.max(0, ...widths);
  const lh = (st.lineHeight ?? 1.1) * st.size;
  return {
    w: boxWidth ?? maxW,
    h: lines.length * lh,
    lines,
    overflowX: boxWidth !== undefined && maxW > boxWidth + 1,
    approx: resolveFont(st).approx,
  };
}

/**
 * Largest font size ≤ size that fits the box (width, optional height / maxLines).
 * Used by `fit: "shrink"` on text layers.
 */
export function fitSize(text: string, st: TextStyle, box: { w: number; h?: number; maxLines?: number; minSize?: number }): number {
  const ok = (size: number) => {
    const m = measureText(text, { ...st, size }, box.w);
    if (m.overflowX) return false;
    if (box.maxLines && m.lines.length > box.maxLines) return false;
    if (box.h && m.h > box.h + 0.5) return false;
    return true;
  };
  if (ok(st.size)) return st.size;
  let lo = box.minSize ?? Math.max(8, st.size * 0.2);
  let hi = st.size;
  if (!ok(lo)) return lo;
  for (let i = 0; i < 18; i++) {
    const mid = (lo + hi) / 2;
    if (ok(mid)) lo = mid;
    else hi = mid;
  }
  return Math.floor(lo * 2) / 2;
}
