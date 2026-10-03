/**
 * Data-driven animation: "chart", "map" and "graph" layers fed by inline data, a JSON/CSV asset
 * or the composition's params ("data": "{{params.sales}}"). Data can evolve over time:
 *   - "time": "year"           → one snapshot per distinct value of that column (bar races, maps)
 *   - "steps": [{"at": 0, "data": …}, {"at": 3, "data": …}] → bars/pies/lines morph between datasets
 *
 * chart: {"type":"chart", "kind":"bar|hbar|stack|line|area|pie|donut|scatter|race",
 *         "data": […] | "asset:<id>", "category":"month", "value":"sales" | ["a","b"], "series":"country",
 *         (scatter: "fields": {"x":"gdp", "y":"life", "r":"pop", "label":"country", "group":"continent"})
 *         "w":1400, "h":700, "colors":[…], "values":true, "grid":true, "axis":true, "legend":true,
 *         "prefix":"$", "suffix":"%", "decimals":1, "compact":true, "top":10, "highlight":["Q3"],
 *         "grow":1.2, "stagger":0.06, "ease":"outCubic", "step":1.2, "morph":0.6, "title":"…"}
 * map:   {"type":"map", "kind":"choropleth|dots|bubbles|routes", "data":[{"country":"France","value":3}],
 *         "projection":"naturalEarth|mercator|equirect|orthographic", "focus":["Europe"|"France",…],
 *         "points":[{"lon","lat","label","value"}], "routes":[{"from":"Paris","to":[-74,40.7]}],
 *         "colors":["#1b2a4a","#ffb000"], "zoom":[{"at":2,"focus":["Japan"]}], "spin":10}
 * graph: {"type":"graph", "nodes":[{"id":"a","label":"API","group":1,"at":0.5}], "edges":[["a","b"],{"from":"b","to":"c","at":2}],
 *         "layout":"force|circle|grid|tree|layers|manual", "pulses":[{"path":["a","b","c"],"at":2,"repeat":3}],
 *         "highlight":[{"nodes":["b"],"at":3,"d":1}], "directed":true}
 */
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { isObj } from '../../core/util';
import type { IRLayer } from '../../ir/types';
import { niceTicks, type ChartIR, type GraphIR, type MapIR, type VizFormat, type VizStyle } from '../../ir/dataviz';
import { lookupToken } from '../bind';
import type { Session } from '../compile';
import { registerLayer, type NodeCtx } from '../registry';

type Row = Record<string, any>;

// ---------- data loading ----------
export function parseCsv(text: string): Row[] {
  const lines: string[][] = [];
  let cur: string[] = [];
  let cell = '';
  let q = false;
  const sep = (text.split('\n')[0].match(/;/g)?.length ?? 0) > (text.split('\n')[0].match(/,/g)?.length ?? 0) ? ';' : text.split('\n')[0].includes('\t') ? '\t' : ',';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') q = false;
      else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === sep) {
      cur.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      cur.push(cell);
      cell = '';
      if (cur.some((c) => c.trim() !== '')) lines.push(cur);
      cur = [];
    } else cell += ch;
  }
  cur.push(cell);
  if (cur.some((c) => c.trim() !== '')) lines.push(cur);
  if (lines.length < 1) return [];
  const head = lines[0].map((h) => h.trim());
  return lines.slice(1).map((l) => {
    const r: Row = {};
    head.forEach((h, i) => {
      const v = (l[i] ?? '').trim();
      const n = Number(v.replace(/\s/g, '').replace(/,(?=\d+$)/, '.'));
      r[h] = v !== '' && Number.isFinite(n) && /^[-+]?[\d\s.,]+%?$/.test(v) ? n : v;
    });
    return r;
  });
}

export function loadData(S: Session, v: unknown, path: string): Row[] | null {
  if (v === undefined || v === null) return null;
  if (Array.isArray(v)) {
    return v.map((r, i) => (isObj(r) ? r : Array.isArray(r) ? { label: String(r[0]), value: Number(r[1]) } : { label: String(i + 1), value: Number(r) }));
  }
  if (isObj(v)) {
    // {"A": 3, "B": 5} or {"columns": {...}}
    return Object.entries(v).map(([k, x]) => (isObj(x) ? { label: k, ...x } : { label: k, value: Number(x) }));
  }
  if (typeof v === 'string') {
    const a = /^asset:([a-f0-9]{8,64})$/.exec(v.trim());
    if (a) {
      const file = S.opts.assetFile?.(a[1]);
      if (!file) {
        S.err(path, `unknown asset ${v}`);
        return null;
      }
      const text = fs.readFileSync(file, 'utf8');
      if (/\.json$/i.test(file) || /^\s*[[{]/.test(text)) {
        try {
          const j = JSON.parse(text);
          return loadData(S, Array.isArray(j) ? j : isObj(j) && Array.isArray((j as any).data) ? (j as any).data : j, path);
        } catch (e) {
          S.err(path, `the JSON asset does not parse: ${(e as Error).message}`);
          return null;
        }
      }
      return parseCsv(text);
    }
    if (v.includes('\n')) return parseCsv(v);
    try {
      const j = JSON.parse(v);
      return loadData(S, j, path);
    } catch {
      /* fallthrough */
    }
  }
  S.err(path, 'data is an array of rows, an object {label: value}, CSV text or "asset:<id>" (JSON or CSV)');
  return null;
}

// ---------- helpers ----------
/** Optional preset params arrive as "" — treat them as absent. */
export function dropEmpty(n: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(n)) if (v !== '' && v !== null) out[k] = v;
  return out;
}

export function vizStyle(S: Session, n: Record<string, any>): VizStyle {
  const tok = (k: string, d: string) => {
    const v = lookupToken(S.tokens, k);
    return typeof v === 'string' ? v : d;
  };
  const size = Number(n.labelSize ?? lookupToken(S.tokens, 'size.label') ?? 24);
  return {
    fg: String(n.color ?? tok('color.fg', '#ffffff')),
    muted: String(n.muted ?? tok('color.muted', '#9aa3b2')),
    grid: String(n.gridColor ?? tok('color.line', 'rgba(255,255,255,0.12)')),
    bg: String(n.bg ?? tok('color.bg', '#0b0d12')),
    font: String(n.font ?? tok('font.body', 'Inter, sans-serif')),
    size: Number.isFinite(size) ? size : 24,
    valueSize: Number(n.valueSize ?? (Number.isFinite(size) ? size : 24)),
  };
}

export function palette(S: Session, n: Record<string, any>): string[] {
  if (Array.isArray(n.colors) && n.colors.length) return n.colors.map(String);
  const out: string[] = [];
  for (const k of ['color.accent', 'color.accent2', 'color.accent3']) {
    const v = lookupToken(S.tokens, k);
    if (typeof v === 'string') out.push(v);
  }
  for (const c of ['#4f8cff', '#ffb020', '#2ec4b6', '#ff5d73', '#9b6bff', '#7bd389', '#ff8a3d', '#4cc9f0', '#f72585', '#b5e48c']) if (!out.includes(c)) out.push(c);
  return out;
}

function fmtOf(n: Record<string, any>): VizFormat {
  const f: VizFormat = {};
  if (n.prefix !== undefined) f.prefix = String(n.prefix);
  if (n.suffix !== undefined) f.suffix = String(n.suffix);
  if (n.decimals !== undefined) f.decimals = Number(n.decimals);
  if (n.compact) f.compact = true;
  if (n.sep !== undefined) f.sep = String(n.sep);
  if (n.dec !== undefined) f.dec = String(n.dec);
  return f;
}

const num = (v: unknown) => {
  const x = typeof v === 'number' ? v : Number(String(v ?? '').replace(/[\s%]/g, '').replace(',', '.'));
  return Number.isFinite(x) ? x : 0;
};

function numericCols(rows: Row[], except: string[]): string[] {
  const keys = new Set<string>();
  for (const r of rows.slice(0, 50)) for (const k of Object.keys(r)) if (!except.includes(k)) keys.add(k);
  return [...keys].filter((k) => rows.every((r) => r[k] === undefined || r[k] === '' || Number.isFinite(Number(r[k]))));
}

function textCol(rows: Row[]): string | undefined {
  const r = rows[0] ?? {};
  return Object.keys(r).find((k) => typeof r[k] === 'string');
}

function sizeOf(S: Session, c: NodeCtx, w: number, h: number): [number, number] {
  return [Number(c.base.w ?? w), Number(c.base.h ?? h)];
}

/** Split rows into snapshots by a "time" column or explicit "steps". */
function snapshots(S: Session, c: NodeCtx, n: Record<string, any>, len: number): { sets: Row[][]; keys: number[]; labels?: string[] } | null {
  const grow = S.frames(Number(n.grow ?? 1));
  if (Array.isArray(n.steps)) {
    const sets: Row[][] = [];
    const keys: number[] = [];
    n.steps.forEach((st: any, i: number) => {
      if (!isObj(st)) return S.err(`${c.path}.steps[${i}]`, 'a step is {"at": seconds, "data": …}');
      const rows = loadData(S, st.data, `${c.path}.steps[${i}].data`);
      if (!rows) return;
      sets.push(rows);
      keys.push(st.at !== undefined ? S.frames(Number(st.at)) : i === 0 ? 0 : keys[i - 1] + S.frames(Number(n.step ?? 1.5)));
    });
    return sets.length ? { sets, keys, labels: n.steps.map((s: any) => (s?.label !== undefined ? String(s.label) : '')) } : null;
  }
  const rows = loadData(S, n.data, `${c.path}.data`);
  if (!rows) {
    if (n.data === undefined) S.err(`${c.path}.data`, `${c.node.type} needs "data" (rows, CSV or "asset:<id>") or "steps"`);
    return null;
  }
  if (n.time) {
    const tc = String(n.time);
    const vals = [...new Set(rows.map((r) => r[tc]))].filter((v) => v !== undefined && v !== '');
    vals.sort((a, b) => (typeof a === 'number' && typeof b === 'number' ? a - b : String(a).localeCompare(String(b), undefined, { numeric: true })));
    if (!vals.length) {
      S.err(`${c.path}.time`, `no values in column "${tc}"`);
      return null;
    }
    const start = grow;
    const avail = Math.max(1, len - start - S.frames(Number(n.hold ?? 1)));
    const step = n.step !== undefined ? S.frames(Number(n.step)) : Math.max(1, Math.floor(avail / Math.max(1, vals.length - 1)));
    return { sets: vals.map((v) => rows.filter((r) => r[tc] === v)), keys: vals.map((_, i) => (i === 0 ? 0 : start + i * step)), labels: vals.map(String) };
  }
  return { sets: [rows], keys: [0] };
}

// ---------- chart ----------
const CHART_KINDS = ['bar', 'hbar', 'stack', 'line', 'area', 'pie', 'donut', 'scatter', 'race'];

registerLayer('chart', {
  keys: ['kind', 'data', 'category', 'by', 'value', 'fields', 'series', 'time', 'steps', 'step', 'morph', 'hold', 'colors', 'values', 'grid', 'axis', 'legend', 'labels', 'prefix', 'suffix', 'decimals', 'compact', 'sep', 'dec', 'top', 'highlight', 'grow', 'stagger', 'ease', 'title', 'xLabel', 'yLabel', 'min', 'max', 'labelSize', 'valueSize', 'color', 'muted', 'gridColor', 'font', 'r', 'size', 'radius', 'gap', 'pad'],
  compile(S, c) {
    const n = dropEmpty(c.node);
    const kind = String(n.kind ?? 'bar');
    if (!CHART_KINDS.includes(kind)) {
      S.err(`${c.path}.kind`, `kind is one of ${CHART_KINDS.join(', ')}`);
      return [];
    }
    const [w, h] = sizeOf(S, c, Math.round(S.W * 0.7), Math.round(S.H * 0.62));
    const style = vizStyle(S, n);
    const pal = palette(S, n);
    if (kind === 'race' && !n.time && !n.steps) {
      S.err(c.path, 'a race needs "time" (the column with years/dates) or "steps"');
      return [];
    }
    const snap = snapshots(S, c, n, c.lenFrames);
    if (!snap) return [];
    const first = snap.sets[0];
    if (!first.length) {
      S.err(`${c.path}.data`, 'the data is empty');
      return [];
    }
    const grow = S.frames(Number(n.grow ?? (kind === 'race' ? 0.6 : 1.1)));
    const ir: ChartIR = {
      kind: kind as ChartIR['kind'],
      w,
      h,
      pad: [0, 0, 0, 0],
      cats: [],
      series: [],
      values: [],
      keys: snap.keys,
      keyLabels: snap.labels?.some((l) => l) ? snap.labels : undefined,
      morph: kind === 'race' ? 0 : S.frames(Number(n.morph ?? 0.7)),
      domain: [0, 1],
      ticks: [],
      grow: [0, grow],
      stagger: S.frames(Number(n.stagger ?? (kind === 'line' || kind === 'area' ? 0 : 0.05))),
      ease: String(n.ease ?? 'outCubic'),
      show: {
        axis: n.axis !== false && !['pie', 'donut'].includes(kind),
        grid: n.grid !== false && !['pie', 'donut', 'race'].includes(kind),
        values: n.values !== undefined ? !!n.values : ['bar', 'hbar', 'race', 'pie', 'donut'].includes(kind),
        legend: n.legend !== undefined ? !!n.legend : false,
        labels: n.labels !== false,
      },
      fmt: fmtOf(n),
      style,
      title: n.title !== undefined ? String(n.title) : undefined,
      xLabel: n.xLabel !== undefined ? String(n.xLabel) : undefined,
      yLabel: n.yLabel !== undefined ? String(n.yLabel) : undefined,
      highlight: Array.isArray(n.highlight) ? n.highlight.map(String) : typeof n.highlight === 'string' ? [n.highlight] : undefined,
      radius: Number(n.radius ?? 6),
      barGap: Number(n.gap ?? 0.28),
    };
    if (kind === 'scatter') {
      const F = isObj(n.fields) ? n.fields : {};
      const xk = String(F.x ?? numericCols(first, [])[0] ?? 'x');
      const yk = String(F.y ?? numericCols(first, [xk])[0] ?? 'y');
      const rk = F.r !== undefined ? String(F.r) : F.size !== undefined ? String(F.size) : undefined;
      const lk = F.label !== undefined ? String(F.label) : textCol(first);
      const gk = F.group !== undefined ? String(F.group) : n.series !== undefined ? String(n.series) : undefined;
      const groups = gk ? [...new Set(first.map((r) => String(r[gk])))] : [];
      const rMax = Math.max(1, ...first.map((r) => (rk ? num(r[rk]) : 1)));
      ir.points = first.map((r, i) => ({
        x: num(r[xk]),
        y: num(r[yk]),
        r: rk ? 6 + 28 * Math.sqrt(num(r[rk]) / rMax) : 10,
        label: lk ? String(r[lk]) : undefined,
        color: gk ? pal[groups.indexOf(String(r[gk])) % pal.length] : pal[0],
        at: r.at !== undefined ? S.frames(num(r.at)) : i * ir.stagger,
      }));
      ir.series = groups.map((g, i) => ({ name: g, color: pal[i % pal.length] }));
      const xs = ir.points.map((p) => p.x);
      const ys = ir.points.map((p) => p.y);
      const pad = (a: number, b: number): [number, number] => {
        const s = (b - a || Math.abs(a) || 1) * 0.08;
        return [a - s, b + s];
      };
      const xd = pad(Math.min(...xs), Math.max(...xs));
      const yd = pad(Math.min(...ys), Math.max(...ys));
      ir.xTicks = niceTicks(xd[0], xd[1], 6);
      ir.ticks = niceTicks(yd[0], yd[1], 5);
      ir.xDomain = [Math.min(xd[0], ir.xTicks[0]), Math.max(xd[1], ir.xTicks[ir.xTicks.length - 1])];
      ir.domain = [Math.min(yd[0], ir.ticks[0]), Math.max(yd[1], ir.ticks[ir.ticks.length - 1])];
      ir.show.legend = n.legend !== undefined ? !!n.legend : groups.length > 1;
    } else {
      // categories × series, possibly long format (series column)
      const xk = String(n.category ?? n.by ?? textCol(first) ?? 'label');
      let seriesNames: string[];
      let get: (rows: Row[], s: number, cat: string) => number;
      if (n.series !== undefined) {
        const sk = String(n.series);
        const yk = String(Array.isArray(n.value) ? n.value[0] : n.value ?? numericCols(first, [xk, sk, String(n.time ?? '')])[0] ?? 'value');
        seriesNames = [...new Set(snap.sets.flat().map((r) => String(r[sk])))];
        get = (rows, s, cat) => num(rows.find((r) => String(r[xk]) === cat && String(r[sk]) === seriesNames[s])?.[yk]);
      } else {
        const ys = Array.isArray(n.value) ? n.value.map(String) : n.value !== undefined ? [String(n.value)] : numericCols(first, [xk, String(n.time ?? '')]);
        if (!ys.length) {
          S.err(`${c.path}.value`, `no numeric column found; columns: ${Object.keys(first).join(', ')}`);
          return [];
        }
        seriesNames = ys;
        get = (rows, s, cat) => num(rows.find((r) => String(r[xk]) === cat)?.[ys[s]]);
      }
      const cats: string[] = [];
      for (const set of snap.sets) for (const r of set) if (!cats.includes(String(r[xk]))) cats.push(String(r[xk]));
      ir.cats = cats;
      ir.series = seriesNames.map((s, i) => ({ name: s, color: pal[i % pal.length] }));
      ir.values = snap.sets.map((rows) => seriesNames.map((_, s) => cats.map((cat) => get(rows, s, cat))));
      if (seriesNames.length === 1 && ['pie', 'donut', 'race', 'hbar', 'bar'].includes(kind) && (kind !== 'bar' || n.colors || cats.length <= 12)) {
        ir.catColors = cats.map((_, i) => pal[i % pal.length]);
        if (kind === 'bar' || kind === 'hbar') ir.catColors = n.colors || n.multicolor ? ir.catColors : undefined;
      }
      if (kind === 'race') ir.catColors = cats.map((_, i) => pal[i % pal.length]);
      let lo = Infinity;
      let hi = -Infinity;
      for (const snapV of ir.values) {
        if (kind === 'stack') {
          for (let k = 0; k < cats.length; k++) {
            const sum = snapV.reduce((a, s) => a + Math.max(0, s[k]), 0);
            hi = Math.max(hi, sum);
            lo = Math.min(lo, 0);
          }
        } else
          for (const s of snapV)
            for (const v of s) {
              lo = Math.min(lo, v);
              hi = Math.max(hi, v);
            }
      }
      if (!['line', 'area', 'scatter'].includes(kind) || lo > 0) lo = Math.min(0, lo);
      if (n.min !== undefined) lo = Number(n.min);
      if (n.max !== undefined) hi = Number(n.max);
      if (kind === 'line' && n.min === undefined && lo > 0) {
        const span = hi - lo;
        lo = Math.max(0, lo - span * 0.15);
      }
      ir.ticks = niceTicks(lo, hi, 5);
      ir.domain = [Math.min(lo, ir.ticks[0]), Math.max(hi, ir.ticks[ir.ticks.length - 1])];
      ir.show.legend = n.legend !== undefined ? !!n.legend : seriesNames.length > 1;
      if (kind === 'race') ir.top = Math.max(1, Number(n.top ?? 10));
    }
    // inner padding for axes/labels
    const sz = style.size;
    const longest = Math.max(0, ...ir.cats.map((s) => s.length));
    if (kind === 'hbar' || kind === 'race') ir.pad = [ir.title ? sz * 2 : 8, sz * 4, ir.show.axis && kind === 'hbar' ? sz * 1.8 : 8, Math.min(w * 0.32, longest * sz * 0.58 + 16)];
    else if (kind === 'pie' || kind === 'donut') ir.pad = [ir.title ? sz * 2 : 0, 0, ir.show.legend ? sz * 2.2 : 0, 0];
    else ir.pad = [(ir.title ? sz * 2 : 0) + (ir.show.legend ? sz * 2 : 0) + sz * 0.8, sz, sz * 2.2, ir.show.axis ? sz * 3.2 : 8];
    if (Array.isArray(n.pad)) ir.pad = n.pad.map(Number) as [number, number, number, number];
    const layer: IRLayer = { ...(c.base as IRLayer), type: 'chart', w, h, style: {}, anims: [], data: ir };
    return [layer];
  },
});

// ---------- map ----------
// works whether this module is loaded as ESM (server) or transpiled to CommonJS (scripts, tests)
const require_: NodeRequire = typeof require === 'function' ? require : createRequire(import.meta.url);
let countries: { id: string; name: string; lon: number; lat: number }[] | null = null;
const ALIASES: Record<string, string> = {
  usa: 'United States of America', us: 'United States of America', 'united states': 'United States of America', 'états-unis': 'United States of America', 'etats-unis': 'United States of America',
  uk: 'United Kingdom', 'great britain': 'United Kingdom', 'royaume-uni': 'United Kingdom', britain: 'United Kingdom',
  russia: 'Russia', 'russie': 'Russia', allemagne: 'Germany', espagne: 'Spain', italie: 'Italy', chine: 'China', japon: 'Japan', inde: 'India', brésil: 'Brazil', bresil: 'Brazil',
  mexique: 'Mexico', 'corée du sud': 'South Korea', 'south korea': 'South Korea', korea: 'South Korea', 'north korea': 'North Korea', 'pays-bas': 'Netherlands', belgique: 'Belgium', suisse: 'Switzerland',
  suède: 'Sweden', norvège: 'Norway', danemark: 'Denmark', pologne: 'Poland', grèce: 'Greece', turquie: 'Turkey', égypte: 'Egypt', 'afrique du sud': 'South Africa', maroc: 'Morocco', algérie: 'Algeria', tunisie: 'Tunisia',
  australie: 'Australia', 'nouvelle-zélande': 'New Zealand', argentine: 'Argentina', chili: 'Chile', colombie: 'Colombia', pérou: 'Peru', irlande: 'Ireland', autriche: 'Austria', hongrie: 'Hungary', roumanie: 'Romania',
  'czech republic': 'Czechia', 'république tchèque': 'Czechia', 'côte d’ivoire': "Côte d'Ivoire", 'ivory coast': "Côte d'Ivoire", drc: 'Dem. Rep. Congo', 'dr congo': 'Dem. Rep. Congo', uae: 'United Arab Emirates', 'émirats arabes unis': 'United Arab Emirates',
  'arabie saoudite': 'Saudi Arabia', iran: 'Iran', israël: 'Israel', liban: 'Lebanon', syrie: 'Syria', irak: 'Iraq', vietnam: 'Vietnam', 'viet nam': 'Vietnam', indonésie: 'Indonesia', malaisie: 'Malaysia', thaïlande: 'Thailand', singapour: 'Malaysia',
  canada: 'Canada', france: 'France', portugal: 'Portugal', ukraine: 'Ukraine', finlande: 'Finland', islande: 'Iceland', nigéria: 'Nigeria', kenya: 'Kenya', éthiopie: 'Ethiopia', sénégal: 'Senegal', cameroun: 'Cameroon',
};
const REGIONS: Record<string, [number, number, number, number]> = {
  world: [-170, -58, 190, 84],
  europe: [-25, 34, 45, 71],
  'western europe': [-11, 36, 20, 60],
  africa: [-20, -36, 53, 38],
  asia: [25, -10, 150, 60],
  'east asia': [95, 15, 148, 50],
  'south america': [-82, -56, -34, 13],
  'north america': [-170, 7, -50, 75],
  'latin america': [-118, -56, -34, 33],
  'middle east': [25, 12, 63, 42],
  oceania: [110, -48, 180, 0],
  usa: [-126, 24, -66, 50],
};

function countryList() {
  if (countries) return countries;
  const topo = require_('world-atlas/countries-110m.json');
  const { feature } = require_('topojson-client');
  const fc = feature(topo, topo.objects.countries) as any;
  countries = fc.features.map((f: any) => {
    // rough centroid: mean of the largest ring's points
    let best: number[][] = [];
    const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
    for (const p of polys) if (p[0].length > best.length) best = p[0];
    const lon = best.reduce((a, q) => a + q[0], 0) / Math.max(1, best.length);
    const lat = best.reduce((a, q) => a + q[1], 0) / Math.max(1, best.length);
    return { id: String(f.id), name: String(f.properties.name), lon, lat };
  });
  return countries!;
}

export function findCountry(q: unknown): { id: string; name: string; lon: number; lat: number } | null {
  const list = countryList();
  const s = String(q ?? '').trim();
  if (!s) return null;
  if (/^\d{1,3}$/.test(s)) return list.find((c) => Number(c.id) === Number(s)) ?? null;
  const l = s.toLowerCase();
  const name = ALIASES[l] ?? s;
  return list.find((c) => c.name.toLowerCase() === name.toLowerCase()) ?? list.find((c) => c.name.toLowerCase().startsWith(l)) ?? null;
}

function place(S: Session, v: unknown, path: string): [number, number] | null {
  if (Array.isArray(v) && v.length === 2) return [Number(v[0]), Number(v[1])];
  if (isObj(v) && v.lon !== undefined) return [Number(v.lon), Number(v.lat)];
  const c = findCountry(v);
  if (c) return [c.lon, c.lat];
  S.err(path, `unknown place ${JSON.stringify(v)} — a country name or [lon, lat]`);
  return null;
}

function bboxOf(S: Session, focus: unknown, path: string): { ids: string[]; bbox?: [number, number, number, number] } {
  if (focus === undefined || focus === null) return { ids: [] };
  if (Array.isArray(focus) && focus.length === 4 && focus.every((v) => typeof v === 'number')) return { ids: [], bbox: focus as [number, number, number, number] };
  const list = Array.isArray(focus) ? focus : [focus];
  const ids: string[] = [];
  let bbox: [number, number, number, number] | undefined;
  for (const f of list) {
    const r = REGIONS[String(f).toLowerCase()];
    if (r) {
      bbox = bbox ? [Math.min(bbox[0], r[0]), Math.min(bbox[1], r[1]), Math.max(bbox[2], r[2]), Math.max(bbox[3], r[3])] : r;
      continue;
    }
    const c = findCountry(f);
    if (!c) S.err(path, `unknown country or region "${f}" (regions: ${Object.keys(REGIONS).join(', ')})`);
    else ids.push(c.id);
  }
  return { ids, bbox };
}

registerLayer('map', {
  keys: ['kind', 'data', 'country', 'value', 'time', 'steps', 'step', 'morph', 'hold', 'projection', 'focus', 'points', 'routes', 'colors', 'land', 'border', 'highlight', 'highlightColor', 'legend', 'labels', 'graticule', 'prefix', 'suffix', 'decimals', 'compact', 'grow', 'stagger', 'rotate', 'spin', 'zoom', 'labelSize', 'color', 'muted', 'font', 'min', 'max'],
  compile(S, c) {
    const n = dropEmpty(c.node);
    const [w, h] = sizeOf(S, c, S.W, S.H);
    const style = vizStyle(S, n);
    const pal = palette(S, n);
    const kind = String(n.kind ?? (n.data !== undefined || n.steps !== undefined ? 'choropleth' : n.routes ? 'routes' : 'dots'));
    if (!['choropleth', 'dots', 'bubbles', 'routes'].includes(kind)) {
      S.err(`${c.path}.kind`, 'kind is choropleth, dots, bubbles or routes');
      return [];
    }
    const proj = String(n.projection ?? 'naturalEarth');
    if (!['naturalEarth', 'mercator', 'equirect', 'orthographic'].includes(proj)) S.err(`${c.path}.projection`, 'projection is naturalEarth, mercator, equirect or orthographic');
    const focus = bboxOf(S, n.focus, `${c.path}.focus`);
    const ir: MapIR = {
      kind: kind as MapIR['kind'],
      w,
      h,
      projection: proj as MapIR['projection'],
      focus: focus.ids,
      bbox: focus.bbox,
      values: [],
      keys: [0],
      morph: S.frames(Number(n.morph ?? 0.6)),
      domain: [0, 1],
      colors: Array.isArray(n.colors) && n.colors.length >= 2 ? [String(n.colors[0]), String(n.colors[1])] : [String(lookupToken(S.tokens, 'color.bg2') ?? '#1d2433'), pal[0]],
      land: String(n.land ?? lookupToken(S.tokens, 'color.bg2') ?? '#1d2433'),
      border: String(n.border ?? lookupToken(S.tokens, 'color.bg') ?? '#0b0d12'),
      highlight: [],
      highlightColor: String(n.highlightColor ?? pal[0]),
      points: [],
      routes: [],
      grow: [0, S.frames(Number(n.grow ?? 1))],
      stagger: S.frames(Number(n.stagger ?? 0.04)),
      show: { legend: n.legend !== undefined ? !!n.legend : kind === 'choropleth', labels: !!n.labels, graticule: n.graticule !== undefined ? !!n.graticule : proj === 'orthographic' },
      fmt: fmtOf(n),
      style,
    };
    if (n.rotate !== undefined && Array.isArray(n.rotate)) ir.rotate = [Number(n.rotate[0]), Number(n.rotate[1] ?? 0)];
    if (n.spin !== undefined) ir.spin = Number(n.spin);
    for (const hname of Array.isArray(n.highlight) ? n.highlight : n.highlight ? [n.highlight] : []) {
      const cty = findCountry(hname);
      if (!cty) S.err(`${c.path}.highlight`, `unknown country "${hname}"`);
      else ir.highlight.push(cty.id);
    }
    if (n.data !== undefined || n.steps !== undefined) {
      const snap = snapshots(S, c, n, c.lenFrames);
      if (!snap) return [];
      const first = snap.sets[0];
      const ck = String(n.country ?? Object.keys(first[0] ?? {}).find((k) => /country|pays|name|nom|iso/i.test(k)) ?? textCol(first) ?? 'country');
      const vk = String(n.value ?? numericCols(first, [ck, String(n.time ?? '')])[0] ?? 'value');
      const unknown = new Set<string>();
      ir.values = snap.sets.map((rows) => {
        const o: Record<string, number> = {};
        for (const r of rows) {
          const cty = findCountry(r[ck]);
          if (!cty) unknown.add(String(r[ck]));
          else o[cty.id] = num(r[vk]);
        }
        return o;
      });
      if (unknown.size) S.warn(`${c.path}.data`, `countries not found on the map: ${[...unknown].slice(0, 8).join(', ')}`);
      ir.keys = snap.keys;
      ir.keyLabels = snap.labels;
      const all = ir.values.flatMap((o) => Object.values(o));
      ir.domain = [Number(n.min ?? Math.min(0, ...all)), Number(n.max ?? Math.max(1, ...all))];
      if (kind === 'bubbles') {
        // one bubble per country at its centroid, sized by value
        const max = ir.domain[1] || 1;
        const ids = Object.keys(ir.values[0]);
        ir.points = ids.map((id, i) => {
          const cty = countryList().find((x) => x.id === id)!;
          return { lon: cty.lon, lat: cty.lat, r: 4 + 40 * Math.sqrt(Math.max(0, ir.values[0][id]) / max), label: n.labels ? cty.name : undefined, color: pal[0], at: i * ir.stagger, value: ir.values[0][id] };
        });
      }
    }
    if (Array.isArray(n.points)) {
      n.points.forEach((p: any, i: number) => {
        const pp = `${c.path}.points[${i}]`;
        const at = place(S, isObj(p) && p.lon === undefined ? p.at ?? p.place ?? p.country ?? p.name : p, pp);
        if (!at) return;
        ir.points.push({
          lon: at[0],
          lat: at[1],
          r: Number(p.r ?? (p.value !== undefined ? 5 + 30 * Math.sqrt(Math.max(0, num(p.value)) / Math.max(1, ...n.points.map((q: any) => num(q.value)))) : 8)),
          label: p.label !== undefined ? String(p.label) : undefined,
          color: String(p.color ?? pal[0]),
          at: p.t !== undefined ? S.frames(num(p.t)) : i * ir.stagger,
          value: p.value !== undefined ? num(p.value) : undefined,
        });
      });
    }
    if (Array.isArray(n.routes)) {
      n.routes.forEach((r: any, i: number) => {
        const pp = `${c.path}.routes[${i}]`;
        if (!isObj(r)) return S.err(pp, 'a route is {"from": place, "to": place, "t": seconds, "d": seconds}');
        const a = place(S, r.from, `${pp}.from`);
        const b = place(S, r.to, `${pp}.to`);
        if (!a || !b) return;
        ir.routes.push({ a, b, at: S.frames(num(r.t ?? i * 0.25)), d: S.frames(num(r.d ?? 1.2)), color: String(r.color ?? pal[1 % pal.length]), width: num(r.width ?? 3) });
      });
    }
    if (Array.isArray(n.zoom)) {
      ir.zooms = n.zoom.map((z: any, i: number) => {
        const f = bboxOf(S, z.focus, `${c.path}.zoom[${i}].focus`);
        let bbox: [number, number, number, number] | null = f.bbox ?? null;
        for (const id of f.ids) {
          const cty = countryList().find((x) => x.id === id)!;
          const b: [number, number, number, number] = [cty.lon - 8, cty.lat - 6, cty.lon + 8, cty.lat + 6];
          bbox = bbox ? [Math.min(bbox[0], b[0]), Math.min(bbox[1], b[1]), Math.max(bbox[2], b[2]), Math.max(bbox[3], b[3])] : b;
        }
        return { at: S.frames(num(z.t ?? z.at)), d: S.frames(num(z.d ?? 1.2)), bbox };
      });
    }
    const layer: IRLayer = { ...(c.base as IRLayer), type: 'map', w, h, style: {}, anims: [], data: ir };
    return [layer];
  },
});

// ---------- graph ----------
function rand(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

export function layoutGraph(nodes: { id: string; group?: unknown; x?: number; y?: number; level?: number }[], edges: [number, number][], layout: string, w: number, h: number, pad: number): [number, number][] {
  const N = nodes.length;
  const cx = w / 2;
  const cy = h / 2;
  if (layout === 'manual') return nodes.map((n) => [Number(n.x ?? cx), Number(n.y ?? cy)]);
  if (layout === 'circle') {
    const r = Math.min(w, h) / 2 - pad;
    return nodes.map((_, i) => [cx + r * Math.cos((2 * Math.PI * i) / N - Math.PI / 2), cy + r * Math.sin((2 * Math.PI * i) / N - Math.PI / 2)]);
  }
  if (layout === 'grid') {
    const cols = Math.ceil(Math.sqrt((N * w) / h));
    const rows = Math.ceil(N / cols);
    return nodes.map((_, i) => [pad + ((i % cols) + 0.5) * ((w - 2 * pad) / cols), pad + (Math.floor(i / cols) + 0.5) * ((h - 2 * pad) / rows)]);
  }
  if (layout === 'tree' || layout === 'layers') {
    // levels by BFS from roots (no incoming edge) or explicit "level"
    const level = new Array(N).fill(-1);
    nodes.forEach((n, i) => {
      if (n.level !== undefined) level[i] = Number(n.level);
    });
    const incoming = new Array(N).fill(0);
    for (const [, b] of edges) incoming[b]++;
    const queue: number[] = [];
    for (let i = 0; i < N; i++)
      if (level[i] < 0 && incoming[i] === 0) {
        level[i] = 0;
        queue.push(i);
      } else if (level[i] >= 0) queue.push(i);
    while (queue.length) {
      const a = queue.shift()!;
      for (const [x, b] of edges) if (x === a && level[b] < 0) {
        level[b] = level[a] + 1;
        queue.push(b);
      }
    }
    for (let i = 0; i < N; i++) if (level[i] < 0) level[i] = 0;
    const L = Math.max(...level) + 1;
    const byL: number[][] = Array.from({ length: L }, () => []);
    level.forEach((l, i) => byL[l].push(i));
    const horizontal = layout === 'layers' && w >= h * 0.9;
    const pos: [number, number][] = new Array(N);
    byL.forEach((ids, l) => {
      ids.forEach((id, k) => {
        const along = pad + ((k + 0.5) / ids.length) * ((horizontal ? h : w) - 2 * pad);
        const across = pad + (L === 1 ? 0.5 : l / (L - 1)) * ((horizontal ? w : h) - 2 * pad);
        pos[id] = horizontal ? [across, along] : [along, across];
      });
    });
    return pos;
  }
  // force-directed (deterministic)
  const r = rand(N * 7919 + edges.length);
  const p: [number, number][] = nodes.map((_, i) => [cx + (r() - 0.5) * w * 0.5, cy + (r() - 0.5) * h * 0.5]);
  const k = Math.sqrt(((w - 2 * pad) * (h - 2 * pad)) / Math.max(1, N)) * 0.75;
  for (let it = 0; it < 400; it++) {
    const temp = (1 - it / 400) * Math.min(w, h) * 0.08;
    const d: [number, number][] = p.map(() => [0, 0]);
    for (let i = 0; i < N; i++)
      for (let j = i + 1; j < N; j++) {
        let dx = p[i][0] - p[j][0];
        let dy = p[i][1] - p[j][1];
        const dist = Math.max(1, Math.hypot(dx, dy));
        const f = (k * k) / dist;
        dx /= dist;
        dy /= dist;
        d[i][0] += dx * f;
        d[i][1] += dy * f;
        d[j][0] -= dx * f;
        d[j][1] -= dy * f;
      }
    for (const [a, b] of edges) {
      let dx = p[a][0] - p[b][0];
      let dy = p[a][1] - p[b][1];
      const dist = Math.max(1, Math.hypot(dx, dy));
      const f = (dist * dist) / k;
      dx /= dist;
      dy /= dist;
      d[a][0] -= dx * f;
      d[a][1] -= dy * f;
      d[b][0] += dx * f;
      d[b][1] += dy * f;
    }
    for (let i = 0; i < N; i++) {
      // gravity
      d[i][0] += (cx - p[i][0]) * 0.05 * k * 0.02;
      d[i][1] += (cy - p[i][1]) * 0.05 * k * 0.02;
      const len = Math.max(1e-6, Math.hypot(d[i][0], d[i][1]));
      p[i][0] += (d[i][0] / len) * Math.min(len, temp);
      p[i][1] += (d[i][1] / len) * Math.min(len, temp);
    }
  }
  // fit into the box
  const xs = p.map((q) => q[0]);
  const ys = p.map((q) => q[1]);
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const sx = (w - 2 * pad) / Math.max(1, x1 - x0);
  const sy = (h - 2 * pad) / Math.max(1, y1 - y0);
  const s = Math.min(sx, sy);
  const ox = (w - (x1 - x0) * s) / 2;
  const oy = (h - (y1 - y0) * s) / 2;
  return p.map((q) => [ox + (q[0] - x0) * s, oy + (q[1] - y0) * s]);
}

registerLayer('graph', {
  keys: ['nodes', 'edges', 'chain', 'layout', 'pulses', 'highlight', 'directed', 'colors', 'nodeSize', 'nodeShape', 'edgeColor', 'edgeWidth', 'curve', 'grow', 'stagger', 'labelSize', 'color', 'muted', 'font', 'textColor', 'data'],
  compile(S, c) {
    const n = dropEmpty(c.node);
    const [w, h] = sizeOf(S, c, Math.round(S.W * 0.75), Math.round(S.H * 0.7));
    const style = vizStyle(S, n);
    const pal = palette(S, n);
    let rawNodes: any[] = Array.isArray(n.nodes) ? n.nodes : [];
    let rawEdges: any[] = Array.isArray(n.edges) ? n.edges : [];
    if (n.chain && Array.isArray(n.nodes)) {
      const ids0 = n.nodes.map((x: any) => String(isObj(x) ? x.id ?? x.label : x));
      for (let i = 1; i < ids0.length; i++) rawEdges = [...rawEdges, [ids0[i - 1], ids0[i]]];
    }
    if (isObj(n.data)) {
      rawNodes = Array.isArray(n.data.nodes) ? n.data.nodes : rawNodes;
      rawEdges = Array.isArray(n.data.edges) ? n.data.edges : Array.isArray(n.data.links) ? n.data.links : rawEdges;
    }
    // nodes implied by edges
    const nodesIn: any[] = rawNodes.map((x: any) => (isObj(x) ? x : { id: String(x) }));
    const ids = nodesIn.map((x: any) => String(x.id ?? x.label));
    const edgeEnds = (e: any): [string, string] | null => (Array.isArray(e) ? [String(e[0]), String(e[1])] : isObj(e) ? [String(e.from ?? e.source ?? e.a), String(e.to ?? e.target ?? e.b)] : null);
    for (const e of rawEdges) {
      const ab = edgeEnds(e);
      if (!ab) continue;
      for (const x of ab)
        if (!ids.includes(x)) {
          ids.push(x);
          nodesIn.push({ id: x });
        }
    }
    if (!nodesIn.length) {
      S.err(c.path, 'graph needs "nodes" and/or "edges"');
      return [];
    }
    const edges: [number, number][] = [];
    const edgeObjs: any[] = [];
    rawEdges.forEach((e: any, i: number) => {
      const ab = edgeEnds(e);
      if (!ab) return S.err(`${c.path}.edges[${i}]`, 'an edge is ["a", "b"] or {"from", "to", "at", "label", "color"}');
      edges.push([ids.indexOf(ab[0]), ids.indexOf(ab[1])]);
      edgeObjs.push(isObj(e) ? e : {});
    });
    const layout = String(n.layout ?? (nodesIn.every((x: any) => x.x !== undefined) ? 'manual' : 'force'));
    const size = Number(n.nodeSize ?? 26);
    const pos = layoutGraph(nodesIn, edges, layout, w, h, size * 2 + style.size);
    const groups = [...new Set(nodesIn.map((x: any) => String(x.group ?? '')))];
    const stagger = S.frames(Number(n.stagger ?? 0.06));
    const grow = S.frames(Number(n.grow ?? 0.5));
    const at = (v: any, def: number) => (v !== undefined ? S.frames(num(v)) : def);
    const ir: GraphIR = {
      w,
      h,
      nodes: nodesIn.map((x: any, i: number) => ({
        id: ids[i],
        label: x.label !== undefined ? String(x.label) : ids[i],
        x: pos[i][0],
        y: pos[i][1],
        r: Number(x.size ?? x.r ?? size),
        color: String(x.color ?? pal[groups.indexOf(String(x.group ?? '')) % pal.length]),
        at: at(x.at ?? x.t, i * stagger),
        shape: (x.shape ?? n.nodeShape ?? 'circle') as 'circle',
        textColor: String(x.textColor ?? n.textColor ?? style.fg),
      })),
      edges: [],
      pulses: [],
      highlights: [],
      grow,
      style,
      directed: !!n.directed,
    };
    edges.forEach(([a, b], i) => {
      const e = edgeObjs[i];
      const start = Math.max(ir.nodes[a].at, ir.nodes[b].at) + Math.round(grow * 0.6);
      ir.edges.push({
        a,
        b,
        at: at(e.at ?? e.t, start),
        color: String(e.color ?? n.edgeColor ?? style.muted),
        width: Number(e.width ?? n.edgeWidth ?? 3),
        directed: e.directed !== undefined ? !!e.directed : !!n.directed,
        label: e.label !== undefined ? String(e.label) : undefined,
        curve: Number(e.curve ?? n.curve ?? 0),
        dash: e.dash !== undefined ? String(e.dash) : undefined,
      });
    });
    const idx = (v: unknown, p: string) => {
      const k = ids.indexOf(String(v));
      if (k < 0) S.err(p, `unknown node "${v}"`);
      return k;
    };
    (Array.isArray(n.pulses) ? n.pulses : []).forEach((p: any, i: number) => {
      const pp = `${c.path}.pulses[${i}]`;
      const path = (Array.isArray(p) ? p : p?.path ?? []).map((v: unknown) => idx(v, pp));
      if (path.length < 2 || path.some((k: number) => k < 0)) return S.err(pp, 'a pulse needs a "path" of at least two node ids');
      ir.pulses.push({ path, at: at(p.at ?? p.t, S.frames(1)), speed: Number(p.speed ?? 1), color: String(p.color ?? pal[1 % pal.length]), size: Number(p.size ?? 10), repeat: Number(p.repeat ?? 1), every: S.frames(Number(p.every ?? 0.8)) });
    });
    (Array.isArray(n.highlight) ? n.highlight : []).forEach((hl: any, i: number) => {
      const pp = `${c.path}.highlight[${i}]`;
      const ns = (Array.isArray(hl?.nodes) ? hl.nodes : [hl?.node ?? hl]).map((v: unknown) => idx(v, pp)).filter((k: number) => k >= 0);
      ir.highlights.push({ nodes: ns, at: at(hl.at ?? hl.t, 0), d: S.frames(Number(hl.d ?? 1)), color: String(hl.color ?? pal[2 % pal.length]) });
    });
    const layer: IRLayer = { ...(c.base as IRLayer), type: 'graph', w, h, style: {}, anims: [], data: ir };
    return [layer];
  },
});
