/** Precomputed data for chart / map / graph layers (compiled in Node, drawn by the player). */

export interface VizStyle {
  fg: string;
  muted: string;
  grid: string;
  bg: string;
  font: string;
  /** Label font size in px. */
  size: number;
  valueSize: number;
}

export interface VizFormat {
  prefix?: string;
  suffix?: string;
  decimals?: number;
  /** "compact" → 1.2k, 3.4M */
  compact?: boolean;
  /** Thousands separator (default ",") and decimal mark (default "."). */
  sep?: string;
  dec?: string;
}

export interface ChartIR {
  kind: 'bar' | 'hbar' | 'stack' | 'line' | 'area' | 'pie' | 'donut' | 'scatter' | 'race';
  w: number;
  h: number;
  pad: [number, number, number, number];
  cats: string[];
  series: { name: string; color: string }[];
  /** values[snapshot][series][category] */
  values: number[][][];
  /** Local frame of each snapshot. */
  keys: number[];
  keyLabels?: string[];
  /** Frames to morph from one snapshot to the next (race: continuous). */
  morph: number;
  /** Value domain over all snapshots (race uses per-frame max). */
  domain: [number, number];
  ticks: number[];
  /** Colour per category (pie, race, single-series bars). */
  catColors?: string[];
  points?: { x: number; y: number; r: number; label?: string; color: string; at: number }[];
  xDomain?: [number, number];
  xTicks?: number[];
  grow: [number, number];
  stagger: number;
  ease: string;
  top?: number;
  show: { axis: boolean; grid: boolean; values: boolean; legend: boolean; labels: boolean };
  fmt: VizFormat;
  style: VizStyle;
  title?: string;
  xLabel?: string;
  yLabel?: string;
  /** Highlighted categories (others are dimmed). */
  highlight?: string[];
  radius: number;
  barGap: number;
}

export interface MapIR {
  kind: 'choropleth' | 'dots' | 'bubbles' | 'routes';
  w: number;
  h: number;
  projection: 'naturalEarth' | 'mercator' | 'equirect' | 'orthographic';
  /** Country ids (ISO numeric as in world-atlas) to fit the view to; empty = world. */
  focus: string[];
  bbox?: [number, number, number, number];
  /** values[snapshot][countryId] */
  values: Record<string, number>[];
  keys: number[];
  keyLabels?: string[];
  morph: number;
  domain: [number, number];
  colors: [string, string];
  land: string;
  border: string;
  highlight: string[];
  highlightColor: string;
  points: { lon: number; lat: number; r: number; label?: string; color: string; at: number; value?: number }[];
  routes: { a: [number, number]; b: [number, number]; at: number; d: number; color: string; width: number }[];
  rotate?: [number, number];
  /** Orthographic globe spin in degrees per second. */
  spin?: number;
  grow: [number, number];
  stagger: number;
  show: { legend: boolean; labels: boolean; graticule: boolean };
  fmt: VizFormat;
  style: VizStyle;
  /** Zoom (camera) keyframes [frame, bbox] for travelling between regions. */
  zooms?: { at: number; d: number; bbox: [number, number, number, number] | null }[];
}

export interface GraphIR {
  w: number;
  h: number;
  nodes: { id: string; label?: string; x: number; y: number; r: number; color: string; at: number; shape: 'circle' | 'rect' | 'pill'; textColor: string }[];
  edges: { a: number; b: number; at: number; color: string; width: number; directed: boolean; label?: string; curve: number; dash?: string }[];
  /** Packets travelling along edges: path of node indexes. */
  pulses: { path: number[]; at: number; speed: number; color: string; size: number; repeat: number; every: number }[];
  highlights: { nodes: number[]; at: number; d: number; color: string }[];
  grow: number;
  style: VizStyle;
  directed: boolean;
}

export function fmtValue(v: number, f: VizFormat): string {
  let s: string;
  const d = f.decimals;
  if (f.compact) {
    const a = Math.abs(v);
    const [div, suf] = a >= 1e9 ? [1e9, 'B'] : a >= 1e6 ? [1e6, 'M'] : a >= 1e3 ? [1e3, 'k'] : [1, ''];
    const x = v / div;
    s = x.toFixed(d ?? (suf && Math.abs(x) < 10 ? 1 : 0)) + suf;
  } else {
    const fixed = d !== undefined ? v.toFixed(d) : Number.isInteger(v) ? String(v) : v.toFixed(Math.abs(v) < 10 ? 1 : 0);
    const [i, dec] = fixed.split('.');
    s = i.replace(/\B(?=(\d{3})+(?!\d))/g, f.sep ?? ',') + (dec ? (f.dec ?? '.') + dec : '');
  }
  return `${f.prefix ?? ''}${s}${f.suffix ?? ''}`;
}

/** "Nice" axis ticks. */
export function niceTicks(min: number, max: number, count = 5): number[] {
  if (!(max > min)) return [min];
  const span = max - min;
  const step0 = span / count;
  const mag = Math.pow(10, Math.floor(Math.log10(step0)));
  const norm = step0 / mag;
  const step = (norm >= 7 ? 10 : norm >= 3 ? 5 : norm >= 1.5 ? 2 : 1) * mag;
  const out: number[] = [];
  for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-6; v += step) out.push(+v.toFixed(10));
  return out;
}
