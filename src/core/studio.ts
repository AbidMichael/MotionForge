/**
 * Higher-level production tools built on compositions:
 *  - storyboard: scenes with their narrative intent, text density, energy; repetition / length problems; edits
 *  - variants:   the same content with other directions / pace / framing / formats, compared side by side
 *  - adapt:      the same composition in other formats (9:16, 1:1…) with layout checks
 *  - templates:  a composition with "params" rendered once per data row (batch), reusing cached scenes
 *  - editor:     layer boxes at a time + edits (move, text, timing) written back into the source JSON
 */
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import type { Ctx } from './context';
import { badRequest } from './errors';
import { clone, isObj } from './util';
import type { AgentCtx } from '../registry/store';
import type { IRDoc, IRLayer } from '../ir/types';
import { LayoutMap } from '../dsl/layoutmap';
import { staticChecks, summarize } from './qa';
import { parseCsv } from '../dsl/features/data';

// ------------------------------------------------------------------ helpers
export const INTENTS = ['hook', 'demonstration', 'explanation', 'breathing', 'conclusion'] as const;

function sceneEntries(comp: Record<string, any>): { k: number; entry: Record<string, any> }[] {
  const out: { k: number; entry: Record<string, any> }[] = [];
  (Array.isArray(comp.scenes) ? comp.scenes : []).forEach((e: any, k: number) => {
    if (isObj(e) && e.t === undefined && e.transition === undefined) out.push({ k, entry: e });
  });
  return out;
}

function texts(l: IRLayer, acc: string[] = []): string[] {
  if (l.text && (l.opacity ?? 1) > 0.05) acc.push(l.text);
  const d = l.data as any;
  if (d && typeof d.title === 'string') acc.push(d.title);
  l.children?.forEach((c) => texts(c, acc));
  return acc;
}

const SELF_ANIMATED = ['chart', 'map', 'graph', 'sim', 'three', 'connector', 'states', 'list'];

function countAnims(l: IRLayer): number {
  return l.anims.length + (SELF_ANIMATED.includes(l.type) ? 3 : 0) + (l.children ?? []).reduce((n, c) => n + countAnims(c), 0);
}

function signature(l: IRLayer): string {
  const types: Record<string, number> = {};
  const walk = (x: IRLayer, d: number) => {
    if (d > 3) return;
    const key = x.src_preset ?? x.type;
    types[key] = (types[key] ?? 0) + 1;
    x.children?.forEach((c) => walk(c, d + 1));
  };
  walk(l, 0);
  return Object.entries(types)
    .sort()
    .map(([k, v]) => `${k}${v}`)
    .join(',');
}

function inferIntent(preset: string | undefined, i: number, n: number, entry: Record<string, any>): string {
  const p = (preset ?? '').toLowerCase();
  if (entry.gestures || /capture|product|ui:|demo|three:|device|split-media|media/.test(p)) return 'demonstration';
  if (/end-card|cta|outro|logo-reveal|finale/.test(p) || (i === n - 1 && n > 2)) return 'conclusion';
  if (/quote|section|breath|statement|pause/.test(p)) return 'breathing';
  if (/title|hook|slam|intro|countdown|glitch-title/.test(p) || i === 0) return 'hook';
  return 'explanation';
}

// ------------------------------------------------------------------ storyboard
export function storyboard(ctx: Ctx, id: string, rev?: number) {
  const { r, rev: n } = ctx.comps.compiled(id, rev);
  if (!r.ok || !r.ir) throw badRequest(`${id} r${n} does not compile`, r.errors);
  const comp = ctx.comps.get(id, n).composition as Record<string, any>;
  const ir = r.ir;
  const entries = sceneEntries(comp);
  const aligned = entries.length === ir.scenes.length;
  const fps = ir.fps;
  const scenes = ir.scenes.map((s, i) => {
    const layer = ir.layers.find((l) => l.id === s.id)!;
    const entry = aligned ? entries[i].entry : {};
    const words = texts(layer)
      .join(' ')
      .split(/\s+/)
      .filter(Boolean).length;
    const d = (s.end - s.start) / fps;
    const intent = typeof entry.intent === 'string' ? entry.intent : inferIntent(s.preset, i, ir.scenes.length, entry);
    return {
      i,
      index: aligned ? entries[i].k : null,
      start: +(s.start / fps).toFixed(2),
      d: +d.toFixed(2),
      preset: s.preset ?? 'inline',
      intent,
      intentSet: typeof entry.intent === 'string',
      words,
      energy: +(countAnims(layer) / Math.max(0.5, d)).toFixed(1),
      text: texts(layer).slice(0, 2).join(' / ').slice(0, 80),
      sig: signature(layer),
    };
  });
  const issues: { scene: number; kind: string; msg: string; fix?: string }[] = [];
  scenes.forEach((s, i) => {
    if (s.intentSet && !INTENTS.includes(s.intent as any)) issues.push({ scene: i, kind: 'intent', msg: `unknown intent "${s.intent}"`, fix: `one of ${INTENTS.join(', ')}` });
    const reading = s.words / 3.0 + 1.2;
    if (s.words > 0 && s.d < reading * 0.75) issues.push({ scene: i, kind: 'too-short', msg: `${s.words} words in ${s.d}s — too fast to read (needs ~${reading.toFixed(1)}s)`, fix: `set "d": ${Math.ceil(reading)}` });
    const max = s.intent === 'hook' ? 4.5 : s.intent === 'breathing' ? 4 : s.intent === 'demonstration' ? 12 : Math.max(5, reading + 2.5);
    if (s.d > max + 0.5) issues.push({ scene: i, kind: 'too-long', msg: `${s.d}s for a ${s.intent} scene with ${s.words} words — it will drag`, fix: `"d": ${Math.max(2, Math.round(max))}, or split it` });
    if (i > 0 && s.sig === scenes[i - 1].sig) issues.push({ scene: i, kind: 'repetitive', msg: `looks like scene ${i} (same structure${s.preset !== 'inline' ? `, ${s.preset}` : ''})`, fix: 'change the layout, add a breathing scene between them, or merge them' });
    if (i > 1 && s.preset !== 'inline' && s.preset === scenes[i - 1].preset && s.preset === scenes[i - 2].preset) issues.push({ scene: i, kind: 'repetitive', msg: `third ${s.preset} in a row`, fix: 'vary the presets' });
  });
  if (scenes.length && scenes[0].intent !== 'hook') issues.push({ scene: 0, kind: 'arc', msg: 'the video does not open with a hook', fix: 'start with a short, strong scene ("intent": "hook", ≤ 3 s)' });
  if (scenes.length > 2 && scenes[scenes.length - 1].intent !== 'conclusion') issues.push({ scene: scenes.length - 1, kind: 'arc', msg: 'no conclusion at the end', fix: 'end with a conclusion / call to action' });
  let run = 0;
  scenes.forEach((s, i) => {
    run = s.intent === 'breathing' ? 0 : run + s.d;
    if (run > 25 && (i === scenes.length - 1 || scenes[i + 1].intent !== 'breathing')) {
      issues.push({ scene: i, kind: 'no-breathing', msg: `${run.toFixed(0)}s of dense content without a pause`, fix: 'insert a breathing scene (quote, statement, section)' });
      run = 0;
    }
  });
  const total = ir.duration / fps;
  const cuts = Math.max(0, scenes.length - 1);
  return {
    id,
    rev: n,
    duration: +total.toFixed(2),
    rhythm: { scenes: scenes.length, avgShot: +(total / Math.max(1, scenes.length)).toFixed(2), cutsPerMin: +((cuts / Math.max(1, total)) * 60).toFixed(1) },
    arc: scenes.map((s) => s.intent).join(' → '),
    scenes: scenes.map(({ sig: _s, ...s }) => s),
    issues,
    aligned,
  };
}

/** Storyboard edits → a new revision. Indices count scenes only (transitions stay between the same neighbours). */
export function storyboardEdit(ctx: Ctx, id: string, edits: unknown[], agent: AgentCtx) {
  const comp = clone(ctx.comps.get(id).composition) as Record<string, any>;
  if (!Array.isArray(comp.scenes)) throw badRequest('the composition has no scenes');
  // group each scene with the transition that precedes it
  type Unit = { scene: Record<string, any>; before?: Record<string, any> };
  let units: Unit[] = [];
  let pending: Record<string, any> | undefined;
  let lead: Record<string, any> | undefined;
  for (const e of comp.scenes) {
    if (isObj(e) && (e.t !== undefined || e.transition !== undefined)) {
      if (!units.length) lead = e;
      else pending = e;
      continue;
    }
    units.push({ scene: e, before: pending });
    pending = undefined;
  }
  const trailing = pending;
  const at = (i: unknown, p: string) => {
    const k = Number(i);
    if (!Number.isInteger(k) || k < 0 || k >= units.length) throw badRequest(`${p}: scene ${i} does not exist (0..${units.length - 1})`);
    return k;
  };
  edits.forEach((e: any, j: number) => {
    const p = `edits[${j}]`;
    if (!isObj(e)) throw badRequest(`${p}: an edit is {"move":[from,to]}, {"remove":i}, {"duplicate":i}, {"swap":[a,b]}, {"set":{"i":2,"d":4,"intent":"breathing",…}}, {"insert":{"at":3,"scene":{…}}}`);
    if (e.move) {
      const [a, b] = e.move.map((x: unknown) => at(x, p));
      const [u] = units.splice(a, 1);
      units.splice(b, 0, u);
    } else if (e.swap) {
      const [a, b] = e.swap.map((x: unknown) => at(x, p));
      [units[a], units[b]] = [units[b], units[a]];
    } else if (e.remove !== undefined) units.splice(at(e.remove, p), 1);
    else if (e.duplicate !== undefined) {
      const k = at(e.duplicate, p);
      units.splice(k + 1, 0, clone(units[k]));
    } else if (isObj(e.set)) {
      const k = at(e.set.i, p);
      const { i: _i, ...fields } = e.set;
      for (const [f, v] of Object.entries(fields)) {
        if (v === null) delete units[k].scene[f];
        else units[k].scene[f] = v;
      }
    } else if (isObj(e.insert)) {
      const k = Math.max(0, Math.min(units.length, Number(e.insert.at ?? units.length)));
      if (!isObj(e.insert.scene)) throw badRequest(`${p}.insert.scene must be a scene entry`);
      units.splice(k, 0, { scene: e.insert.scene, before: isObj(e.insert.transition) ? e.insert.transition : undefined });
    } else throw badRequest(`${p}: unknown edit (move, swap, remove, duplicate, set, insert)`);
  });
  units = units.filter(Boolean);
  const scenes: unknown[] = [];
  if (lead) scenes.push(lead);
  units.forEach((u, i) => {
    if (u.before && i > 0) scenes.push(u.before);
    scenes.push(u.scene);
  });
  if (trailing) scenes.push(trailing);
  comp.scenes = scenes;
  return ctx.comps.submit({ composition: comp, id }, agent);
}

// ------------------------------------------------------------------ variants
export interface VariantSpec {
  name?: string;
  direction?: unknown;
  theme?: unknown;
  pace?: number;
  framing?: number;
  format?: string;
  music?: unknown;
  set?: Record<string, unknown>;
}

function metrics(ir: IRDoc) {
  const fps = ir.fps;
  const total = ir.duration / fps;
  let anims = 0;
  let words = 0;
  for (const l of ir.layers) {
    anims += countAnims(l);
    words += texts(l).join(' ').split(/\s+/).filter(Boolean).length;
  }
  return {
    duration: +total.toFixed(2),
    scenes: ir.scenes.length,
    avgShot: +(total / Math.max(1, ir.scenes.length)).toFixed(2),
    cutsPerMin: +(((ir.scenes.length - 1) / Math.max(1, total)) * 60).toFixed(1),
    energy: +(anims / Math.max(1, total)).toFixed(1),
    wordsPerSec: +(words / Math.max(1, total)).toFixed(2),
    format: `${ir.width}x${ir.height}`,
  };
}

async function previewFrames(ctx: Ctx, id: string, rev: number, at: number[], agent: string, scale: number) {
  const job = ctx.jobs.enqueue('preview', agent, { at, scale, sheet: false }, { compId: id, rev, priority: 10 });
  const done = await ctx.jobs.wait(job.id, 300_000);
  if (done.status !== 'done') throw new Error(`preview of ${id} failed: ${done.error ?? done.status}`);
  return (done.result as any).frames as { path: string; t: number }[];
}

/** Rows of frames with a label column: one row per variant. */
async function comparisonSheet(rows: { label: string; sub: string; frames: string[] }[], out: string) {
  const metas = await Promise.all(rows.flatMap((r) => r.frames.map((f) => sharp(f).metadata())));
  const maxW = Math.max(...metas.map((m) => m.width ?? 0));
  const maxH = Math.max(...metas.map((m) => m.height ?? 0));
  const cellW = Math.min(480, maxW);
  const cellH = Math.round(cellW * (maxH / Math.max(1, maxW)));
  const labelW = 300;
  const gap = 8;
  const cols = Math.max(...rows.map((r) => r.frames.length));
  const W = labelW + cols * (cellW + gap) + gap;
  const H = rows.length * (cellH + gap) + gap;
  const composites: { input: Buffer; left: number; top: number }[] = [];
  for (const [ri, r] of rows.entries()) {
    const y = gap + ri * (cellH + gap);
    const esc = (s: string) => s.replace(/[<&>]/g, (c) => ({ '<': '&lt;', '&': '&amp;', '>': '&gt;' })[c]!);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${labelW}" height="${cellH}"><text x="16" y="40" font-family="sans-serif" font-size="26" font-weight="700" fill="#fff">${esc(r.label)}</text>${r.sub
      .split('\n')
      .map((l, i) => `<text x="16" y="${80 + i * 26}" font-family="sans-serif" font-size="18" fill="#aab">${esc(l)}</text>`)
      .join('')}</svg>`;
    composites.push({ input: Buffer.from(svg), left: 0, top: y });
    for (const [ci, f] of r.frames.entries()) {
      const buf = await sharp(f).resize(cellW, cellH, { fit: 'contain', background: '#000' }).toBuffer();
      composites.push({ input: buf, left: labelW + gap + ci * (cellW + gap), top: y });
    }
  }
  await sharp({ create: { width: W, height: H, channels: 3, background: '#141418' } }).composite(composites).jpeg({ quality: 84 }).toFile(out);
}

export async function variants(ctx: Ctx, id: string, specs: VariantSpec[], agent: AgentCtx, opts: { preview?: boolean; frames?: number } = {}) {
  if (!Array.isArray(specs) || !specs.length || specs.length > 8) throw badRequest('variants is an array of 1–8 {name, direction, theme, pace, framing, format, music, set}');
  const base = ctx.comps.get(id);
  if (!base.ok) throw badRequest(`${id} has errors; fix them first`, base.errors);
  const src = base.composition as Record<string, any>;
  const title = (src.title as string) ?? id;
  const out: any[] = [];
  const all = [{ name: 'original', spec: null as VariantSpec | null }, ...specs.map((s, i) => ({ name: s.name ?? `variant ${i + 1}`, spec: s }))];
  for (const v of all) {
    let rid = id;
    let rev = base.rev;
    let res: any = { ok: true, errors: [], warnings: [] };
    if (v.spec) {
      const c = clone(src);
      const s = v.spec;
      if (s.direction !== undefined) c.direction = s.direction;
      if (s.theme !== undefined) {
        c.theme = s.theme;
        if (s.direction === undefined) delete c.direction;
      }
      if (s.pace !== undefined) c.pace = s.pace;
      if (s.framing !== undefined) c.framing = s.framing;
      if (s.music !== undefined) c.music = s.music;
      if (s.format !== undefined) {
        if (!c.adapt && c.format !== s.format) c.adapt = { from: c.format ?? ctx.cfg.defaultFormat };
        c.format = s.format;
      }
      if (isObj(s.set)) Object.assign(c, s.set);
      c.title = `${title} · ${v.name}`;
      res = ctx.comps.submit({ composition: c, title: c.title }, agent);
      rid = res.id;
      rev = res.rev;
    }
    const entry: any = { name: v.name, id: rid, rev, ok: res.ok, errors: res.errors?.slice(0, 5) };
    if (res.ok) {
      const { r } = ctx.comps.compiled(rid, rev);
      entry.metrics = metrics(r.ir!);
      entry.qa = summarize(staticChecks(r.ir!));
    }
    out.push(entry);
  }
  let sheet: string | undefined;
  if (opts.preview !== false) {
    const n = Math.max(2, Math.min(6, opts.frames ?? 4));
    const rows: { label: string; sub: string; frames: string[] }[] = [];
    for (const v of out) {
      if (!v.ok) continue;
      const d = v.metrics.duration;
      // same relative moments in every variant (they may have different lengths)
      const at = Array.from({ length: n }, (_, i) => +((d * (i + 0.6)) / n).toFixed(2));
      const frames = await previewFrames(ctx, v.id, v.rev, at, agent.id, 0.35);
      v.frames = frames.map((f) => f.path);
      rows.push({ label: v.name, sub: `${v.metrics.duration}s · ${v.metrics.scenes} scenes\n${v.metrics.cutsPerMin} cuts/min\nenergy ${v.metrics.energy}\n${v.metrics.format}`, frames: v.frames });
    }
    if (rows.length) {
      const dir = path.join(ctx.paths.previews, 'variants');
      fs.mkdirSync(dir, { recursive: true });
      sheet = path.join(dir, `${id}-r${base.rev}-${Date.now().toString(36)}.jpg`);
      await comparisonSheet(rows, sheet);
    }
  }
  return { base: id, variants: out, sheet, sheetUrl: sheet ? `${ctx.baseUrl()}/files/previews/${path.relative(ctx.paths.previews, sheet).split(path.sep).join('/')}` : undefined };
}

// ------------------------------------------------------------------ format adaptation
export async function adapt(ctx: Ctx, id: string, formats: string[], agent: AgentCtx, opts: { preview?: boolean; text?: number } = {}) {
  if (!Array.isArray(formats) || !formats.length) throw badRequest('formats: e.g. ["9:16", "1:1"]');
  const base = ctx.comps.get(id);
  if (!base.ok) throw badRequest(`${id} has errors; fix them first`, base.errors);
  const src = base.composition as Record<string, any>;
  const out: any[] = [];
  for (const f of formats) {
    const c = clone(src);
    c.adapt = { from: src.adapt?.from ?? src.format ?? ctx.cfg.defaultFormat, ...(opts.text ? { text: opts.text } : {}) };
    c.format = f;
    c.title = `${src.title ?? id} · ${f}`;
    const res = ctx.comps.submit({ composition: c, title: c.title }, agent);
    const e: any = { format: f, id: res.id, rev: res.rev, ok: res.ok, errors: res.errors.slice(0, 5) };
    if (res.ok) {
      const { r } = ctx.comps.compiled(res.id, res.rev);
      const issues = staticChecks(r.ir!);
      e.qa = summarize(issues);
      e.issues = issues.filter((i) => i.severity !== 'info').slice(0, 12).map((i) => ({ scene: i.scene + 1, kind: i.kind, layer: i.layer, msg: i.msg, fix: i.fix, ptr: i.ptr }));
      if (opts.preview !== false) {
        const job = ctx.jobs.enqueue('preview', agent.id, { scale: 0.35 }, { compId: res.id, rev: res.rev, priority: 10 });
        const done = await ctx.jobs.wait(job.id, 300_000);
        if (done.status === 'done') e.sheet = (done.result as any).sheet?.path ?? (done.result as any).frames?.[0]?.path;
      }
    }
    out.push(e);
  }
  return { base: id, adapted: out, note: 'Scene presets re-layout themselves for the new frame (and "@portrait" overrides apply); inline layers are mapped with one uniform scale. Fix remaining issues on each new composition with mf_patch (add "@portrait": {…} overrides for precise control).' };
}

// ------------------------------------------------------------------ data templates
export function loadRows(ctx: Ctx, data: unknown): Record<string, unknown>[] {
  if (Array.isArray(data)) return data.map((r, i) => (isObj(r) ? r : { value: r, index: i })) as Record<string, unknown>[];
  if (isObj(data)) return [data as Record<string, unknown>];
  if (typeof data === 'string') {
    const a = /^asset:([a-f0-9]{8,64})$/.exec(data.trim());
    const text = a ? fs.readFileSync(ctx.assets.get(a[1]).path, 'utf8') : data;
    if (/^\s*[[{]/.test(text)) return loadRows(ctx, JSON.parse(text));
    return parseCsv(text);
  }
  throw badRequest('data is a row object, an array of rows, CSV text or "asset:<id>" (JSON/CSV)');
}

export function templateRun(ctx: Ctx, id: string, data: unknown, agent: AgentCtx, opts: { render?: boolean; quality?: string; titleField?: string; limit?: number } = {}) {
  const base = ctx.comps.get(id);
  const src = base.composition as Record<string, any>;
  if (!isObj(src.params) || !Object.keys(src.params).length) throw badRequest(`${id} declares no "params" — a data template exposes what changes: "params": {"name": "string!", "sales": "array<object>!", …} and uses "{{params.name}}"`);
  const rows = loadRows(ctx, data).slice(0, Math.max(1, Math.min(500, opts.limit ?? 200)));
  const results: any[] = [];
  for (const [i, row] of rows.entries()) {
    const c = clone(src);
    c.props = { ...(isObj(src.props) ? src.props : {}), ...row };
    const label = String(row[opts.titleField ?? 'title'] ?? row.name ?? `#${i + 1}`);
    c.title = `${src.title ?? id} · ${label}`;
    const res = ctx.comps.submit({ composition: c, title: c.title }, agent);
    const e: any = { row: i, label, id: res.id, rev: res.rev, ok: res.ok, duration: res.duration };
    if (!res.ok) e.errors = res.errors.slice(0, 4);
    else if (opts.render) {
      const job = ctx.jobs.enqueue('render', agent.id, { quality: opts.quality ?? 'hq' }, { compId: res.id, rev: res.rev, lane: 'render' });
      e.job = job.id;
    }
    results.push(e);
  }
  return {
    template: id,
    rows: rows.length,
    ok: results.filter((r) => r.ok).length,
    results,
    note: opts.render ? 'renders queued; scenes that do not depend on the data are rendered once and reused from the segment cache' : 'validated only; pass render:true to queue the renders',
  };
}

// ------------------------------------------------------------------ visual editor
export function layoutAt(ctx: Ctx, id: string, t: number, rev?: number) {
  const { r, rev: n } = ctx.comps.compiled(id, rev);
  if (!r.ok || !r.ir) throw badRequest(`${id} r${n} does not compile`, r.errors);
  const ir = r.ir;
  const frame = Math.max(0, Math.min(ir.duration - 1, Math.round(t * ir.fps)));
  const si = ir.scenes.findIndex((s) => frame >= s.start && frame < s.end);
  const info = ir.scenes[Math.max(0, si)];
  const layer = ir.layers.find((l) => l.id === info.id)!;
  const lm = new LayoutMap(layer, { x: 0, y: 0, w: ir.width, h: ir.height });
  const local = frame - info.start;
  const boxes = lm
    .visibleAt(local)
    .filter((b) => b.rect.w > 2 && b.rect.h > 2 && !(b.rect.w >= ir.width * 0.98 && b.rect.h >= ir.height * 0.98))
    .map((b) => ({
      id: b.layer.id,
      rel: b.layer.id.slice(info.id.length),
      name: b.layer.name,
      type: b.layer.type,
      preset: b.layer.src_preset,
      text: b.layer.text?.slice(0, 120),
      rect: { x: Math.round(b.rect.x), y: Math.round(b.rect.y), w: Math.round(b.rect.w), h: Math.round(b.rect.h) },
      ptr: b.layer.ptr,
      textPtr: b.layer.textPtr,
      from: +((info.start + b.abs0) / ir.fps).toFixed(2),
      to: +((info.start + b.abs1) / ir.fps).toFixed(2),
      depth: b.depth,
    }));
  return { id, rev: n, width: ir.width, height: ir.height, fps: ir.fps, duration: ir.duration / ir.fps, scene: info.index, sceneStart: info.start / ir.fps, sceneEnd: info.end / ir.fps, scenes: ir.scenes.map((s) => ({ i: s.index, start: s.start / ir.fps, end: s.end / ir.fps, preset: s.preset })), boxes };
}

function getAt(doc: any, ptr: string): any {
  return ptr
    .split('/')
    .slice(1)
    .reduce((o, k) => (o == null ? undefined : o[k.replace(/~1/g, '/').replace(/~0/g, '~')]), doc);
}

/**
 * Editor edits: [{"layer": "<IR id>", "dx": 20, "dy": -10}, {"layer": …, "text": "New"}, {"layer": …, "shift": 0.3},
 * {"layer": …, "scale": 1.1}, {"scene": 2, "d": 4}] → JSON Patch on the source (direct values when the layer
 * comes from the composition itself, scene "tweaks" for layers generated by presets).
 */
export function applyEdits(ctx: Ctx, id: string, edits: unknown[], agent: AgentCtx) {
  const { r } = ctx.comps.compiled(id);
  if (!r.ok || !r.ir) throw badRequest(`${id} does not compile`, r.errors);
  const ir = r.ir;
  const doc = clone(ctx.comps.get(id).composition) as Record<string, any>;
  const entries = sceneEntries(doc);
  const byId = new Map<string, { l: IRLayer; scene: number }>();
  ir.layers.forEach((top) => {
    const si = ir.scenes.findIndex((s) => s.id === top.id);
    const walk = (l: IRLayer) => {
      byId.set(l.id, { l, scene: si });
      l.children?.forEach(walk);
    };
    walk(top);
  });
  const ops: any[] = [];
  const tweakOps = new Map<number, Record<string, Record<string, number>>>();
  const tweak = (scene: number, key: string, field: string, v: number, mode: 'add' | 'mul' | 'set') => {
    if (entries.length !== ir.scenes.length) throw badRequest('this composition expands scenes with "repeat"; edit the preset or the repeat template instead');
    const k = entries[scene].k;
    const cur = tweakOps.get(k) ?? clone(doc.scenes[k].tweaks ?? {});
    const t = (cur[key] = cur[key] ?? {});
    t[field] = mode === 'add' ? +((t[field] ?? 0) + v).toFixed(3) : mode === 'mul' ? +((t[field] ?? 1) * v).toFixed(4) : v;
    tweakOps.set(k, cur);
  };
  edits.forEach((e: any, i: number) => {
    const p = `edits[${i}]`;
    if (!isObj(e)) throw badRequest(`${p}: expected an object`);
    if (e.scene !== undefined && e.layer === undefined) {
      const s = Number(e.scene);
      if (!entries[s]) throw badRequest(`${p}: no scene ${s}`);
      if (e.d !== undefined) ops.push({ op: entries[s].entry.d === undefined ? 'add' : 'replace', path: `/scenes/${entries[s].k}/d`, value: +Number(e.d).toFixed(2) });
      return;
    }
    const hit = byId.get(String(e.layer));
    if (!hit) throw badRequest(`${p}: no layer ${e.layer} (ids come from the editor layout)`);
    const { l, scene } = hit;
    const sceneId = ir.scenes[scene].id;
    const key = l.name ?? l.id.slice(sceneId.length);
    if (e.text !== undefined) {
      if (!l.textPtr) throw badRequest(`${p}: this text is generated (expression or preset internals); edit the preset param instead`);
      ops.push({ op: 'replace', path: l.textPtr, value: String(e.text) });
    }
    if (e.dx || e.dy) {
      const node = l.ptr ? getAt(doc, l.ptr) : undefined;
      const direct = isObj(node) && (node.x === undefined || typeof node.x === 'number') && (node.y === undefined || typeof node.y === 'number') && node.x !== undefined && node.y !== undefined;
      if (direct) {
        if (e.dx) ops.push({ op: 'replace', path: `${l.ptr}/x`, value: Math.round(node.x + Number(e.dx)) });
        if (e.dy) ops.push({ op: 'replace', path: `${l.ptr}/y`, value: Math.round(node.y + Number(e.dy)) });
      } else {
        if (e.dx) tweak(scene, key, 'dx', Math.round(Number(e.dx)), 'add');
        if (e.dy) tweak(scene, key, 'dy', Math.round(Number(e.dy)), 'add');
      }
    }
    if (e.scale !== undefined) tweak(scene, key, 'scale', Number(e.scale), 'mul');
    if (e.shift !== undefined) tweak(scene, key, 'shift', Number(e.shift), 'add');
    if (e.opacity !== undefined) tweak(scene, key, 'opacity', Number(e.opacity), 'set');
    if (e.size !== undefined) tweak(scene, key, 'size', Number(e.size), 'set');
  });
  for (const [k, tw] of tweakOps) ops.push({ op: doc.scenes[k].tweaks === undefined ? 'add' : 'replace', path: `/scenes/${k}/tweaks`, value: tw });
  if (!ops.length) throw badRequest('nothing to change');
  return { ops, result: ctx.comps.patch(id, ops, agent) };
}
