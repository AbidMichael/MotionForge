/**
 * Composition DSL → Render IR.
 * Resolves imports (with a lockfile), expands presets (extends/bind/addLayers/macros/slots),
 * binds params + tokens + expressions, schedules animations and transitions.
 */
import semver from 'semver';
import { didYouMean, type Issue } from '../core/errors';
import { clone, isObj } from '../core/util';
import { parseEasing } from '../ir/easing';
import { ellipsePath, flattenPath, pointAt, throughPath } from '../ir/motionpath';
import { ALL_CHANNELS, parseColor } from '../ir/evaluate';
import type { ClipDir, IRAnim, IRAudio, IRDoc, IRFont, IRLayer, IRLayout, IRMarker, IRSceneInfo, Keyframe } from '../ir/types';
import { canSee, type AgentCtx, type LibraryStore, type LibVersion } from '../registry/store';
import { bindValue, lookupToken, tokenScope, toPx, type Tokens } from './bind';
import type { Scope } from './expr';
import { LayoutMap } from './layoutmap';
import { baselineOffset, fitSize } from './metrics';
import { textStyleOf } from './layoutmap';
import { docPasses, hooks, layerHandlers, scenePasses, type SceneCtx } from './registry';
import { ELEMENT_KEYS, LAYER_KEYS, normalizeParams, SCENE_KEYS, type DurationRule, type ParamDef, type PresetDef, type PresetKind } from './schema';
import './features';

export interface CompileOptions {
  store: LibraryStore;
  defaultFormat: string;
  defaultTheme: string;
  /** Map an asset id (sha prefix) to a URL the renderer can load, or null when unknown. */
  assetUrl: (id: string) => string | null;
  /** Local file of an asset (audio mixing, data files, fonts). */
  assetFile?: (id: string) => string | null;
  /** A stored composition (sub-compositions by id): its JSON and lockfile. */
  loadComposition?: (id: string, rev?: number) => { composition: unknown; lock: Record<string, string> } | null;
  /** Beat analysis of an audio asset (montage musical). */
  audioInfo?: (id: string) => AudioInfo | null;
  /** 3D model assets: format of the model file, and its inspection once known (it is computed in the background). */
  modelInfo?: (id: string) => { ext: string; info: any | null } | null;
  /** A UI capture made with mf_capture. */
  loadCapture?: (id: string) => any | null;
  /** Built-in sound effects: name → local file. */
  sfxFile?: (name: string) => string | null;
}

export interface AudioInfo {
  duration: number;
  bpm: number;
  beats: number[];
  downbeats: number[];
  onsets: { t: number; s: number }[];
  sections?: { t: number; energy: number }[];
}

export interface CompileInput {
  composition: unknown;
  agent: AgentCtx;
  lock?: Record<string, string>;
  /** Values for the composition's exposed "params" (sub-compositions, data templates). */
  props?: Record<string, unknown>;
  /** Nesting depth of sub-compositions (guards recursion). */
  depth?: number;
  /** Override the format (sub-compositions default to their box size). */
  format?: string;
  /** Inherit the parent's theme tokens when the child has no theme. */
  inheritTheme?: { tokens: Tokens; fonts: IRFont[] };
}

export interface SceneOut {
  i: number;
  id: string;
  preset?: string;
  start: number;
  d: number;
}

export interface CompileResult {
  ok: boolean;
  ir?: IRDoc;
  errors: Issue[];
  warnings: Issue[];
  lock: Record<string, string>;
  used: string[];
  scenes: SceneOut[];
  duration: number;
  format: { width: number; height: number; fps: number };
}

export interface AliasCtx {
  aliases: Map<string, LibVersion>;
}

interface Hit {
  preset: PresetDef;
  lib: LibVersion;
  id: string; // alias:slug as seen by the caller
  key: string; // @scope/name/slug@version
}

interface Usage {
  hit: Hit;
  values: Record<string, unknown>;
  body: Record<string, any>;
  bodyCtx: AliasCtx;
  extras: { layers: unknown[]; values: Record<string, unknown>; actx: AliasCtx }[];
  rule?: DurationRule;
}

export type SlotMap = Map<string, { layers: unknown[]; scope: Scope; actx: AliasCtx }>;

/** Orientation flags for "@portrait" / "@landscape" / "@square" / "@wide" / "@tall" overrides. */
export function orientations(W: number, H: number): string[] {
  const r = W / H;
  const out: string[] = [];
  if (r > 1.05) out.push('@landscape', '@horizontal');
  else if (r < 0.95) out.push('@portrait', '@vertical');
  else out.push('@square');
  if (r >= 1.7) out.push('@wide');
  if (r <= 0.6) out.push('@tall');
  return out;
}

/** Merge format-conditional overrides ("@portrait": {...}) into their parent object and drop the others. */
export function applyOverrides<T>(v: T, flags: string[]): T {
  if (Array.isArray(v)) {
    let changed = false;
    const out = v.map((x) => {
      const y = applyOverrides(x, flags);
      if (y !== x) changed = true;
      return y;
    });
    return (changed ? out : v) as T;
  }
  if (!v || typeof v !== 'object') return v;
  const o = v as Record<string, any>;
  let out: Record<string, any> | null = null;
  const merges: Record<string, any>[] = [];
  for (const k of Object.keys(o)) {
    if (k.startsWith('@')) {
      out ??= { ...o };
      delete out[k];
      if (flags.includes(k) && o[k] && typeof o[k] === 'object') merges.push(o[k]);
      continue;
    }
    const y = applyOverrides(o[k], flags);
    if (y !== o[k]) {
      out ??= { ...o };
      out[k] = y;
    }
  }
  if (merges.length) {
    out ??= { ...o };
    for (const m of merges) Object.assign(out, applyOverrides(m, flags));
  }
  return (out ?? o) as T;
}

const hasOverrides = (v: unknown) => JSON.stringify(v ?? null).includes('"@');

export const FORMAT_ALIASES: Record<string, string> = {
  '16:9': '1920x1080',
  '1080p': '1920x1080',
  '720p': '1280x720',
  '4k': '3840x2160',
  '9:16': '1080x1920',
  vertical: '1080x1920',
  '1:1': '1080x1080',
  square: '1080x1080',
  '4:5': '1080x1350',
};

export function parseFormat(f: string): { width: number; height: number; fps: number } | null {
  const [sizeRaw, fpsRaw] = f.trim().toLowerCase().split('@');
  const size = FORMAT_ALIASES[sizeRaw] ?? sizeRaw;
  const m = /^(\d{2,5})x(\d{2,5})$/.exec(size);
  if (!m) return null;
  const width = Number(m[1]);
  const height = Number(m[2]);
  const fps = fpsRaw ? Number(fpsRaw) : 30;
  if (width % 2 || height % 2 || width > 7680 || height > 7680 || !(fps >= 1 && fps <= 120)) return null;
  return { width, height, fps };
}

const SHORT_REF = /^([a-z][a-z0-9-]*):([a-z0-9][a-z0-9-]*)$/;
const FULL_REF = /^(@[a-z0-9-]+\/[a-z0-9-]+)\/([a-z0-9][a-z0-9-]*)(?:@(\S+))?$/;
const USE_RE = /^(@[a-z0-9-]+\/[a-z0-9-]+)(?:@(\S+?))?(?:\s+as\s+([a-z][a-z0-9-]*))?$/;

const ANCHORS: Record<string, [number, number]> = {
  center: [0.5, 0.5],
  'top-left': [0, 0],
  top: [0.5, 0],
  'top-right': [1, 0],
  left: [0, 0.5],
  right: [1, 0.5],
  'bottom-left': [0, 1],
  bottom: [0.5, 1],
  'bottom-right': [1, 1],
};

const ANIM_REF_KEYS = new Set(['p', 'd', 'at', 'delay', 'ease', 'stagger', 'whole', 'clipDir', 'tracks', 'unit', 'loop']);
const STYLE_PX_KEYS: Record<string, 'x' | 'y' | 'min'> = { size: 'y', radius: 'min', strokeWidth: 'min', glowSize: 'min' };
const CHANNEL_AXIS: Record<string, 'x' | 'y' | 'min'> = { dx: 'x', dy: 'y', blur: 'min' };

const countWords = (v: unknown): number => {
  if (Array.isArray(v)) return v.reduce((n: number, x) => n + countWords(x), 0);
  if (typeof v !== 'string') return 0;
  return v.trim().split(/\s+/).filter(Boolean).length;
};

const PLACEHOLDER: Record<string, unknown> = { string: '', number: 0, integer: 0, duration: 1, boolean: false, array: [], object: {}, color: '#000000', any: '' };

const typeOf = (v: unknown) => (Array.isArray(v) ? 'array' : v === null ? 'null' : typeof v);

/** "scenes[2].layers[0].children[1]" → "/scenes/2/layers/0/children/1" (only for composition-level nodes). */
export function pathToPtr(path: string): string | undefined {
  if (!/^scenes\[\d+\](\.layers\[\d+\](\.children\[\d+\])*)$/.test(path)) return undefined;
  return '/' + path.replace(/\[(\d+)\]/g, '/$1').replace(/\./g, '/');
}

const WHOLE_NAME = /^\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}$/;

/** CSS clip-path for a "mask" value. */
export function maskCss(v: unknown): string | undefined {
  if (v === undefined || v === null || v === false) return undefined;
  if (typeof v === 'number') return `inset(0 round ${v}px)`;
  const s = String(v).trim();
  if (s === 'circle') return 'circle(50% at 50% 50%)';
  if (s === 'ellipse') return 'ellipse(50% 50% at 50% 50%)';
  if (s === 'diamond') return 'polygon(50% 0, 100% 50%, 50% 100%, 0 50%)';
  if (s === 'hexagon') return 'polygon(25% 3%, 75% 3%, 100% 50%, 75% 97%, 25% 97%, 0 50%)';
  if (/^(inset|circle|ellipse|polygon|path)\(/.test(s)) return s;
  if (/^[Mm][\s\d.-]/.test(s)) return `path('${s.replace(/'/g, '')}')`;
  return undefined;
}

export class Session {
  errors: Issue[] = [];
  warnings: Issue[] = [];
  lock: Record<string, string>;
  used = new Set<string>();
  W = 1920;
  H = 1080;
  fps = 30;
  tokens: Tokens = {};
  fonts: IRFont[] = [];
  /** Values of the composition's exposed params (in every expression scope). */
  params: Record<string, unknown> = {};
  /** Orientation flags for "@portrait" etc. */
  orient: string[] = ['@landscape'];
  /** Direction (art direction) multipliers. */
  pace = 1;
  /** Composition-level "pace" also scales explicit durations. */
  paceExplicit = 1;
  animScale = 1;
  /** Markers of the scene being compiled (scene-local frames). */
  markers: IRMarker[] = [];
  /** Named layers of the scene being compiled. */
  names = new Map<string, IRLayer>();
  /** Scene-level gesture/state actions collected by pre-passes (by passes that need them). */
  scratch: Record<string, any> = {};
  /** Named text styles: built-ins from the theme tokens, tokens.text, then the composition's "textStyles". */
  textStyles: Record<string, Record<string, any>> = {};
  /** The composition's "data" (data-driven videos), in scope as `data`. */
  data: unknown = undefined;
  /** Sub-composition nesting depth. */
  depthLevel = 0;
  /** Format adaptation: the frame inline layers were written for. */
  retarget: { W: number; H: number; text: number } | null = null;
  /** Extra audio tracks produced while compiling (sub-compositions, captures). */
  extraAudio: IRAudio[] = [];
  private libCtxCache = new Map<string, AliasCtx>();
  private paramCache = new Map<string, Record<string, ParamDef>>();
  private bodyCache = new Map<string, Record<string, any>>();
  private depth = 0;

  constructor(
    public opts: CompileOptions,
    public agent: AgentCtx,
    lock: Record<string, string> | undefined,
  ) {
    this.lock = { ...(lock ?? {}) };
  }

  setFormat(W: number, H: number, fps: number) {
    this.W = W;
    this.H = H;
    this.fps = fps;
    this.orient = orientations(W, H);
  }

  /** Static layout of a compiled scene (cached on the scene context). */
  sceneLayout(sc: SceneCtx): LayoutMap {
    if (!sc.layout) sc.layout = new LayoutMap(sc.group, { x: 0, y: 0, w: this.W, h: this.H });
    return sc.layout;
  }

  /** Record a marker (scene-local frame). */
  mark(m: IRMarker) {
    this.markers.push(m);
  }

  /** Register a named layer for gestures/connectors/morphs. */
  registerName(name: string, layer: IRLayer, path: string) {
    layer.name = name;
    if (this.names.has(name)) {
      this.warn(path, `id "${name}" is used twice in this scene; gestures and connectors use the first one`);
      return;
    }
    this.names.set(name, layer);
  }

  err(path: string, msg: string) {
    this.errors.push({ path, msg });
  }
  warn(path: string, msg: string) {
    this.warnings.push({ path, msg });
  }

  base(dur: number): Scope {
    return { params: this.params, ...this.params, data: this.data, W: this.W, H: this.H, fps: this.fps, dur, U: Math.min(this.W, this.H) / 1080, portrait: this.H > this.W * 1.05, ...tokenScope(this.tokens) };
  }

  /** A preset body with format overrides applied (cached). */
  presetBody(key: string, body: Record<string, any>): Record<string, any> {
    if (!hasOverrides(body)) return body;
    const k = `${key}|${this.orient.join(',')}`;
    let b = this.bodyCache.get(k);
    if (!b) {
      b = applyOverrides(body, this.orient);
      this.bodyCache.set(k, b);
    }
    return b;
  }

  bind(v: unknown, scope: Scope, path: string, skip?: Set<string>) {
    return bindValue(v, { scope, tokens: this.tokens, issues: this.errors }, path, skip);
  }

  // ---------- libraries ----------
  resolveLib(name: string, range: string | undefined, path: string): LibVersion | null {
    const locked = this.lock[name];
    try {
      if (locked) {
        const ok =
          !range ||
          range === 'latest' ||
          range === '*' ||
          (range === 'draft' ? locked === 'draft' : locked !== 'draft' && semver.satisfies(locked, range));
        if (ok) return this.opts.store.resolve(name, locked === 'draft' ? 'draft' : locked, this.agent);
      }
      const lv = this.opts.store.resolve(name, range, this.agent);
      this.lock[name] = lv.version;
      return lv;
    } catch (e: any) {
      this.err(path, e.message + (e.hint ? ` (${e.hint})` : ''));
      return null;
    }
  }

  libCtx(lib: LibVersion): AliasCtx {
    const key = `${lib.name}@${lib.version}`;
    const hit = this.libCtxCache.get(key);
    if (hit) return hit;
    const ctx: AliasCtx = { aliases: new Map() };
    this.libCtxCache.set(key, ctx);
    if (lib.name !== '@core/base') {
      const core = this.resolveLib('@core/base', lib.manifest.depends['@core/base'], `${key}.depends`);
      if (core) ctx.aliases.set('core', core);
    }
    for (const [dep, range] of Object.entries(lib.manifest.depends)) {
      if (dep === '@core/base') continue;
      const lv = this.resolveLib(dep, range, `${key}.depends`);
      if (lv) ctx.aliases.set(lv.alias, lv);
    }
    ctx.aliases.set(lib.alias, lib);
    return ctx;
  }

  lookup(ref: unknown, actx: AliasCtx, path: string, kinds?: PresetKind[]): Hit | null {
    if (typeof ref !== 'string' || !ref) {
      this.err(path, `expected a preset id like "core:fade-up", got ${typeOf(ref)}`);
      return null;
    }
    let lib: LibVersion | null | undefined;
    let slug: string;
    const short = SHORT_REF.exec(ref);
    const full = short ? null : FULL_REF.exec(ref);
    if (short) {
      lib = actx.aliases.get(short[1]);
      slug = short[2];
      if (!lib) {
        // official libraries need no "use": @core/* resolve by their alias on first reference
        for (const [name] of this.opts.store.libs) {
          if (!name.startsWith('@core/')) continue;
          const lv = this.opts.store.latest(name);
          if (lv && lv.alias === short[1]) {
            lib = this.resolveLib(name, undefined, path) ?? undefined;
            if (lib) actx.aliases.set(short[1], lib);
            break;
          }
        }
      }
      if (!lib) {
        const dym = didYouMean(short[1], actx.aliases.keys());
        this.err(path, `unknown library alias '${short[1]}' in "${ref}" — imported: ${[...actx.aliases.keys()].join(', ')}${dym.length ? ` (did you mean ${dym[0]}?)` : ''}. Add it to "use".`);
        return null;
      }
    } else if (full) {
      lib = this.resolveLib(full[1], full[3], path);
      slug = full[2];
      if (!lib) return null;
    } else {
      this.err(path, `bad preset id "${ref}" — use alias:slug (core:fade-up) or @scope/name/slug`);
      return null;
    }
    const preset = lib.presets.get(slug);
    if (!preset) {
      const dym = didYouMean(slug, lib.presets.keys());
      this.err(path, `${lib.alias}:${slug} not found in ${lib.name}@${lib.version}${dym.length ? ` — did you mean ${dym.map((d) => `${lib!.alias}:${d}`).join(', ')}?` : ''}`);
      return null;
    }
    if (kinds && !kinds.includes(preset.kind)) {
      this.err(path, `${ref} is a ${preset.kind}; expected ${kinds.join(' or ')}`);
      return null;
    }
    if (preset.deprecated) {
      this.warn(path, `${ref} is deprecated${preset.deprecated.successor ? `; use ${preset.deprecated.successor}` : ''}${preset.deprecated.reason ? ` (${preset.deprecated.reason})` : ''}`);
    }
    if (!canSee(lib, this.agent)) {
      this.err(path, `${ref}: library ${lib.name} is not visible to agent '${this.agent.id}'`);
      return null;
    }
    return { preset, lib, id: `${lib.alias}:${slug}`, key: `${lib.name}/${slug}@${lib.version}` };
  }

  publicParams(hit: Hit, seen = new Set<string>()): Record<string, ParamDef> {
    const cached = this.paramCache.get(hit.key);
    if (cached) return cached;
    let out: Record<string, ParamDef> = {};
    if (hit.preset.extends) {
      if (seen.has(hit.key)) {
        this.err(hit.id, 'extends cycle');
        return {};
      }
      seen.add(hit.key);
      const parent = this.lookup(hit.preset.extends, this.libCtx(hit.lib), `${hit.id}.extends`);
      if (parent) out = { ...this.publicParams(parent, seen) };
      for (const k of Object.keys(hit.preset.bind ?? {})) delete out[k];
    }
    for (const [k, def] of Object.entries(hit.preset.params)) {
      if ((def as any).__partial) {
        const { __partial: _p, type: _t, ...rest } = def as any;
        out[k] = { ...(out[k] ?? { type: 'any' }), ...rest };
      } else out[k] = def;
    }
    this.paramCache.set(hit.key, out);
    return out;
  }

  checkParams(defs: Record<string, ParamDef>, provided: Record<string, unknown>, path: string, ref: string): Record<string, unknown> {
    const values: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(provided)) {
      if (v === undefined) continue;
      if (!defs[k]) {
        const dym = didYouMean(k, Object.keys(defs));
        const avail = Object.keys(defs);
        this.err(`${path}.${k}`, `unknown param for ${ref}${dym.length ? ` — did you mean '${dym[0]}'?` : ''} (params: ${avail.length ? avail.join(', ') : 'none'})`);
        continue;
      }
      values[k] = v;
    }
    for (const [k, def] of Object.entries(defs)) {
      let v = values[k];
      if (v === undefined) {
        if (def.default !== undefined) {
          v = this.bind(clone(def.default), { ...this.base(0), ...values }, `${path}.${k}(default)`);
          values[k] = v;
          continue;
        }
        if (def.required) {
          this.err(`${path}.${k}`, `required (${def.type}${def.values ? ': ' + def.values.join('|') : ''}) for ${ref}`);
          values[k] = PLACEHOLDER[def.type] ?? ''; // keep going without cascading errors
        }
        continue;
      }
      const msg = checkType(def, v);
      if (typeof msg === 'string') this.err(`${path}.${k}`, msg);
      else values[k] = msg.value;
    }
    return values;
  }

  /** The body a preset ends up using (walks extends without validating params). */
  rootBody(hit: Hit): Record<string, any> | undefined {
    let cur: Hit | null = hit;
    for (let i = 0; cur && i < 12; i++) {
      if (cur.preset.body) return cur.preset.body as Record<string, any>;
      cur = this.lookup(cur.preset.extends, this.libCtx(cur.lib), `${hit.id}.extends`);
    }
    return undefined;
  }

  /** Resolve a preset usage through its extends chain. */
  expand(ref: unknown, provided: Record<string, unknown>, actx: AliasCtx, path: string, kinds: PresetKind[]): Usage | null {
    const hit = this.lookup(ref, actx, path, kinds);
    if (!hit) return null;
    this.used.add(`${hit.lib.name}/${hit.preset.slug}`);
    let values = this.checkParams(this.publicParams(hit), provided, path, hit.id);
    const extras: Usage['extras'] = [];
    let cur = hit;
    let rule = hit.preset.duration;
    let guard = 0;
    while (!cur.preset.body) {
      if (++guard > 12) {
        this.err(path, `extends chain too deep from ${hit.id}`);
        return null;
      }
      const curCtx = this.libCtx(cur.lib);
      const parent = this.lookup(cur.preset.extends, curCtx, `${path}(${cur.id}.extends)`);
      if (!parent) return null;
      const scope = { ...this.base(0), ...values };
      const bound = (cur.preset.bind ? this.bind(clone(cur.preset.bind), scope, `${path}(${cur.id}.bind)`) : {}) as Record<string, unknown>;
      if (cur.preset.addLayers?.length) extras.unshift({ layers: this.presetBody(cur.key + '#add', cur.preset.addLayers as any) as any, values: { ...values }, actx: curCtx });
      const parentDefs = this.publicParams(parent);
      const next: Record<string, unknown> = { ...values, ...bound };
      for (const [k, def] of Object.entries(parentDefs)) {
        if (next[k] === undefined && def.default !== undefined) next[k] = this.bind(clone(def.default), { ...this.base(0), ...next }, `${path}.${k}(default)`);
      }
      values = next;
      rule = rule ?? parent.preset.duration;
      cur = parent;
    }
    return { hit, values, body: this.presetBody(cur.key, cur.preset.body as Record<string, any>), bodyCtx: this.libCtx(cur.lib), extras, rule };
  }

  durationFor(d: unknown, rule: DurationRule | undefined, values: Record<string, unknown>, fallback: number, path: string): number {
    if (d !== undefined) {
      const n = typeof d === 'string' ? parseFloat(d) : d;
      if (typeof n !== 'number' || !(n > 0)) {
        this.err(path, `d must be a positive number of seconds`);
        return fallback;
      }
      if (rule?.min && n < rule.min) this.warn(path, `d=${n}s is below this preset's minimum ${rule.min}s`);
      return this.paceExplicit === 1 ? n : Math.round(n * this.paceExplicit * 100) / 100;
    }
    let sec = rule?.default ?? fallback;
    if (rule?.perWord && rule.wordsFrom) sec = (rule.default ?? 1) + rule.perWord * countWords(values[rule.wordsFrom]);
    sec *= this.pace;
    if (rule?.min) sec = Math.max(rule.min, sec);
    if (rule?.max) sec = Math.min(rule.max, sec);
    return Math.round(sec * 100) / 100;
  }

  frames(sec: number) {
    return Math.round(sec * this.fps);
  }

  parseTime(v: unknown, parentSec: number, path: string): number | undefined {
    if (v === undefined || v === null) return undefined;
    if (typeof v === 'number') return v;
    if (typeof v === 'string') {
      const s = v.trim();
      if (s === 'end') return parentSec;
      let m = /^end\s*-\s*(\d*\.?\d+)$/.exec(s);
      if (m) return parentSec - Number(m[1]);
      m = /^(\d*\.?\d+)%$/.exec(s);
      if (m) return (parentSec * Number(m[1])) / 100;
      const n = Number(s);
      if (!Number.isNaN(n)) return n;
    }
    this.err(path, `bad time ${JSON.stringify(v)} — use seconds, "end", "end-0.5" or "50%"`);
    return undefined;
  }

  // ---------- keyframes & anims ----------
  normTracks(raw: unknown, scope: Scope, path: string, defaultEase?: string): Record<string, Keyframe[]> | null {
    if (!isObj(raw)) {
      this.err(path, 'tracks must be an object of channel → keyframes');
      return null;
    }
    const out: Record<string, Keyframe[]> = {};
    for (const [ch, kfsRaw] of Object.entries(raw)) {
      const p = `${path}.${ch}`;
      if (!ALL_CHANNELS.includes(ch)) {
        const dym = didYouMean(ch, ALL_CHANNELS);
        this.err(p, `unknown channel${dym.length ? ` — did you mean '${dym[0]}'?` : ''} (channels: ${ALL_CHANNELS.join(', ')})`);
        continue;
      }
      const kfs = this.bind(kfsRaw, scope, p);
      if (!Array.isArray(kfs) || kfs.length === 0) {
        this.err(p, 'keyframes must be a non-empty array: [[t, value, ease?], …] or [v0, v1, …]');
        continue;
      }
      const shorthand = kfs.every((k) => !Array.isArray(k) && !isObj(k));
      const list: Keyframe[] = [];
      kfs.forEach((k: any, i: number) => {
        let t: unknown;
        let v: unknown;
        let e: unknown;
        if (shorthand) {
          t = kfs.length === 1 ? 0 : i / (kfs.length - 1);
          v = k;
          e = i > 0 ? defaultEase : undefined;
        } else if (Array.isArray(k)) [t, v, e] = k;
        else if (isObj(k)) ({ t, v, e } = k as any);
        if (typeof t !== 'number' || t < 0 || t > 1) {
          this.err(`${p}[${i}]`, 't must be a number in 0..1');
          return;
        }
        if (e === undefined && i > 0) e = defaultEase;
        if (e !== undefined && (typeof e !== 'string' || !parseEasing(e))) {
          this.err(`${p}[${i}]`, `bad easing ${JSON.stringify(e)} (named: linear, in, out, inOut, snap, smooth, outBack, outElastic, outExpo…, or cubic(a,b,c,d), spring(0.4), steps(4))`);
          return;
        }
        let val: number | string;
        if (ch === 'color') {
          if (typeof v !== 'string' || !parseColor(v)) {
            this.err(`${p}[${i}]`, 'color keyframes must be hex or rgb()/rgba() colours');
            return;
          }
          val = v;
        } else {
          const n = toPx(v, CHANNEL_AXIS[ch] ?? 'min', this.W, this.H);
          if (n === undefined || Number.isNaN(n)) {
            this.err(`${p}[${i}]`, `expected a number${CHANNEL_AXIS[ch] ? ' or length (px, %, vw, vh)' : ''}, got ${JSON.stringify(v)}`);
            return;
          }
          val = n;
        }
        list.push(e ? [t, val, e as string] : [t, val]);
      });
      for (let i = 1; i < list.length; i++) {
        if (list[i][0] < list[i - 1][0]) this.err(p, 'keyframe times must be ascending');
      }
      out[ch] = list;
    }
    return out;
  }

  buildAnims(
    node: Record<string, any>,
    layerFrames: number,
    actx: AliasCtx,
    scope: Scope,
    path: string,
    split: boolean,
    unitCount: number,
    stagger: { frames: number },
    layerBox: { w?: number; h?: number },
  ): IRAnim[] {
    const anims: IRAnim[] = [];
    const layerSec = layerFrames / this.fps;
    for (const slot of ['in', 'out', 'anim', 'loop'] as const) {
      const raw = node[slot];
      if (raw === undefined || raw === null || raw === false) continue;
      const refs = Array.isArray(raw) ? raw : [raw];
      refs.forEach((r: any, i: number) => {
        const p = `${path}.${slot}[${i}]`;
        const ref: Record<string, any> = typeof r === 'string' ? { p: r } : isObj(r) ? r : {};
        if (!ref.p && !ref.tracks) {
          this.err(p, 'anim ref needs "p" (an animation preset) or inline "tracks"');
          return;
        }
        if (ref.stagger !== undefined) stagger.frames = Math.max(0, Math.round(Number(ref.stagger) * this.fps));
        let body: Record<string, any>;
        let values: Record<string, unknown> = {};
        let name = 'inline';
        let rule: DurationRule | undefined;
        if (ref.tracks) {
          body = { tracks: ref.tracks, ease: ref.ease, clipDir: ref.clipDir, unit: ref.unit };
        } else {
          const params: Record<string, unknown> = {};
          for (const [k, v] of Object.entries(ref)) if (!ANIM_REF_KEYS.has(k)) params[k] = v;
          const u = this.expand(ref.p, params, actx, p, ['animation']);
          if (!u) return;
          body = u.body;
          values = u.values;
          name = u.hit.id;
          rule = u.rule;
        }
        const dSec = ref.d !== undefined ? Number(ref.d) : (rule?.default ?? (typeof body.d === 'number' ? body.d : slot === 'loop' ? 2 : 0.6)) * (slot === 'loop' ? 1 : this.animScale);
        if (!(dSec > 0)) {
          this.err(p, 'd must be > 0');
          return;
        }
        const aScope = { ...scope, ...values, d: dSec, w: layerBox.w ?? 0, h: layerBox.h ?? 0 };
        const tracks = this.normTracks(body.tracks, aScope, `${p}${ref.p ? `(${name})` : ''}.tracks`, ref.ease ?? (typeof body.ease === 'string' ? body.ease : undefined));
        if (!tracks) return;
        if (ref.ease) for (const kfs of Object.values(tracks)) for (let k = 1; k < kfs.length; k++) kfs[k][2] = ref.ease;
        const unit = split ? (ref.whole ? false : body.unit !== false) : false;
        const dF = Math.max(1, this.frames(dSec));
        let s = 0;
        let e = dF;
        const delay = this.parseTime(ref.at ?? ref.delay, layerSec, p) ?? 0;
        if (slot === 'in') {
          s = this.frames(delay);
          e = s + dF;
        } else if (slot === 'out') {
          e = layerFrames - this.frames(delay);
          s = e - dF;
          if (unit) {
            const shift = Math.max(0, unitCount - 1) * stagger.frames;
            s -= shift;
            e -= shift;
          }
        } else {
          s = this.frames(delay);
          e = s + dF;
        }
        const clipDir = (ref.clipDir ?? body.clipDir) as ClipDir | undefined;
        const anim: IRAnim = { s, e, tracks, n: name };
        if (unit) anim.unit = true;
        if (slot === 'loop' || ref.loop || body.loop) anim.loop = true;
        if (clipDir) anim.clipDir = clipDir;
        anims.push(anim);
      });
    }
    return anims;
  }

  /** "keys": {"dx": [[0, 0], [1.2, 300, "snap"]]} — keyframes in seconds within the layer. */
  keysAnim(keys: unknown, lenFrames: number, scope: Scope, path: string): IRAnim | null {
    if (!isObj(keys)) {
      this.err(path, 'keys must be {channel: [[seconds, value, ease?], …]}');
      return null;
    }
    const lenSec = Math.max(1e-6, lenFrames / this.fps);
    const tracks: Record<string, unknown> = {};
    for (const [ch, list] of Object.entries(keys)) {
      const arr = this.bind(list, scope, `${path}.${ch}`);
      if (!Array.isArray(arr) || !arr.length || !arr.every((k) => Array.isArray(k) && k.length >= 2)) {
        this.err(`${path}.${ch}`, 'keys use [[seconds, value, ease?], …]');
        continue;
      }
      const sorted = [...arr].sort((a: any, b: any) => Number(a[0]) - Number(b[0]));
      tracks[ch] = sorted.map((k: any) => [Math.max(0, Math.min(1, Number(k[0]) / lenSec)), k[1], ...(k[2] ? [k[2]] : [])]);
    }
    const t = this.normTracks(tracks, scope, path);
    if (!t || !Object.keys(t).length) return null;
    return { s: 0, e: lenFrames, tracks: t, n: 'keys' };
  }

  /**
   * "motionPath": {"path":"M… C…"} | {"through":[[x,y],…]} | {"ellipse":{"rx","ry","center","start","turns","dir"}} | {"circle":r},
   * + "at", "d", "ease", "from"/"to" (fractions of the path), "orient" (true | degrees), "loop", "relative".
   * A list of paths plays them one after the other (each one starts where the layer is).
   */
  motionPaths(layer: IRLayer, raw: unknown, path: string) {
    const list = Array.isArray(raw) ? raw : [raw];
    const lenF = layer.to - layer.from;
    const lenSec = lenF / this.fps;
    let first = true;
    let cursorSec = 0;
    list.forEach((mp: any, i: number) => {
      const p = Array.isArray(raw) ? `${path}[${i}]` : path;
      if (typeof mp === 'string') mp = { path: mp };
      if (!isObj(mp)) {
        this.err(p, 'motionPath is {"path":"M0 0 C…"} | {"through":[[x,y],…]} | {"ellipse":{"rx","ry"}} | {"circle":r}, with at, d, ease, orient');
        return;
      }
      const lx = layer.x;
      const ly = layer.y;
      let d: string;
      let relative = !!mp.relative;
      try {
        if (typeof mp.path === 'string') d = mp.path;
        else if (Array.isArray(mp.through)) {
          const pts = mp.through.map((q: any) => [Number(q?.[0]), Number(q?.[1])] as [number, number]);
          if (pts.some((q: number[]) => q.some((n) => !Number.isFinite(n)))) throw new Error('"through" points are [x, y] numbers');
          d = throughPath(pts, mp.tension !== undefined ? Number(mp.tension) : 0.5, !!mp.closed);
        } else if (mp.ellipse !== undefined || mp.circle !== undefined) {
          const e = isObj(mp.ellipse) ? mp.ellipse : {};
          const r = Number(mp.circle ?? e.r ?? 200);
          const rx = Number(e.rx ?? r);
          const ry = Number(e.ry ?? r);
          const start = Number(e.start ?? mp.start ?? 0);
          if (start !== 0 && Math.abs(start) <= 6.3)
            this.warn(`${p}.start`, `start is in degrees (0 = right, 90 = down): ${start}° is almost the same point for every value — for ${start} turn(s) write ${+(start * 360).toFixed(1)}`);
          const turns = Number(e.turns ?? mp.turns ?? 1);
          const cw = (e.dir ?? mp.dir ?? 'cw') !== 'ccw';
          const center = e.center ?? mp.center;
          if (Array.isArray(center)) d = ellipsePath(Number(center[0]), Number(center[1]), rx, ry, start, turns, cw);
          else {
            // no centre: the layer starts on the ellipse where it already is
            const a = (start * Math.PI) / 180;
            d = ellipsePath(lx - rx * Math.cos(a), ly - ry * Math.sin(a), rx, ry, start, turns, cw);
          }
          relative = false;
        } else throw new Error('give "path" (SVG path data), "through" (points), "ellipse" or "circle"');
        flattenPath(d);
      } catch (e: any) {
        this.err(p, `motionPath: ${e.message}`);
        return;
      }
      const from = Math.max(0, Math.min(1, Number(mp.from ?? 0)));
      const to = Math.max(0, Math.min(1, Number(mp.to ?? 1)));
      const atSec = this.parseTime(mp.at, lenSec, `${p}.at`) ?? cursorSec;
      const dSec = mp.d !== undefined ? Number(mp.d) : Math.max(0.1, lenSec - atSec);
      if (!(dSec > 0)) {
        this.err(`${p}.d`, 'd must be > 0 (seconds)');
        return;
      }
      cursorSec = atSec + dSec;
      const ease = typeof mp.ease === 'string' ? mp.ease : 'inOutSine';
      if (!parseEasing(ease)) this.warn(`${p}.ease`, `unknown easing "${ease}"`);
      const orient = mp.orient === true ? 0 : typeof mp.orient === 'number' ? mp.orient : undefined;
      const f = flattenPath(d);
      const start = pointAt(f, from);
      if (first) {
        // absolute paths put the layer on the path; orient turns it along the path from the first frame
        if (!relative) {
          layer.x = +start.x.toFixed(2);
          layer.y = +start.y.toFixed(2);
        }
        if (orient !== undefined) layer.rot = +((layer.rot ?? 0) + start.angle + orient).toFixed(2);
      }
      const s = this.frames(atSec);
      if (!first && orient !== undefined) {
        // a later oriented path: turn to its starting direction when it begins
        layer.anims.push({ s, e: s + 1, tracks: { rotate: [[0, 0], [1, +(start.angle + orient - (layer.rot ?? 0)).toFixed(2), 'hold']] }, n: 'motionPath' });
      }
      first = false;
      const anim: IRAnim = { s, e: s + Math.max(1, this.frames(dSec)), tracks: {}, n: 'motionPath', path: { d, ease } };
      if (from !== 0) anim.path!.from = from;
      if (to !== 1) anim.path!.to = to;
      if (orient !== undefined) anim.path!.orient = orient;
      if (mp.loop) anim.loop = true;
      layer.anims.push(anim);
    });
  }

  /** Common finishing for every compiled layer: names, editor pointers, keys, sound and beat effects. */
  finishLayer(layer: IRLayer, node: Record<string, any>, raw: Record<string, any>, scope: Scope, path: string): IRLayer {
    const idp = scope.$idp as string | false | undefined;
    if (typeof node.id === 'string' && node.id && idp !== false) this.registerName(idp ? `${idp}.${node.id}` : node.id, layer, path);
    const ptr = pathToPtr(path);
    if (ptr) layer.ptr = ptr;
    if (layer.type === 'text' && typeof raw.text === 'string') {
      const m = WHOLE_NAME.exec(raw.text);
      const prov = scope.$prov as Record<string, string> | undefined;
      if (m && prov?.[m[1]]) layer.textPtr = prov[m[1]];
      else if (ptr && !raw.text.includes('{{')) layer.textPtr = `${ptr}/text`;
    }
    if (node.keys !== undefined) {
      const a = this.keysAnim(node.keys, layer.to - layer.from, scope, `${path}.keys`);
      if (a) layer.anims.push(a);
    }
    if (node.motionPath !== undefined && node.motionPath !== null && node.motionPath !== false) {
      this.motionPaths(layer, this.bind(node.motionPath, scope, `${path}.motionPath`), `${path}.motionPath`);
    }
    if (node.sfx !== undefined && node.sfx !== null && node.sfx !== false) {
      const f = typeof node.sfx === 'string' ? { name: node.sfx } : isObj(node.sfx) ? node.sfx : null;
      if (!f || typeof f.name !== 'string') this.err(`${path}.sfx`, 'sfx is a sound name ("pop", "sfx:whoosh", "asset:<id>") or {name, at, gain}');
      else {
        const inAnim = layer.anims.find((a) => a.n !== 'keys' && a.s >= 0);
        layer.fx = { ...layer.fx, sfx: { name: f.name, at: f.at !== undefined ? this.frames(Number(f.at)) : inAnim?.s ?? 0, gain: Number(f.gain ?? 1) } };
      }
    }
    if (node.beat !== undefined && node.beat !== null && node.beat !== false) {
      const b = typeof node.beat === 'string' ? { kind: node.beat } : isObj(node.beat) ? node.beat : null;
      const kinds = ['pulse', 'flash', 'shake', 'bounce', 'blink'];
      if (!b || !kinds.includes(b.kind)) this.err(`${path}.beat`, `beat is one of ${kinds.join(', ')} or {kind, every, amount, on: "beat"|"bar"|"hit"}`);
      else layer.fx = { ...layer.fx, beat: { kind: b.kind, every: Number(b.every ?? 1), amount: Number(b.amount ?? 1), ...(b.on ? { on: String(b.on) } : {}) } };
    }
    return layer;
  }

  // ---------- layers ----------
  compileLayers(
    nodes: unknown,
    scope: Scope,
    actx: AliasCtx,
    parentFrames: number,
    path: string,
    slots: SlotMap,
    defPos: [number, number],
    idPrefix: string,
  ): IRLayer[] {
    if (nodes === undefined) return [];
    if (!Array.isArray(nodes)) {
      this.err(path, 'layers must be an array');
      return [];
    }
    const out: IRLayer[] = [];
    nodes.forEach((n, i) => out.push(...this.compileNode(n, scope, actx, parentFrames, `${path}[${i}]`, slots, defPos, `${idPrefix}.${i}`)));
    return out;
  }

  compileNode(
    raw: unknown,
    scope: Scope,
    actx: AliasCtx,
    parentFrames: number,
    path: string,
    slots: SlotMap,
    defPos: [number, number],
    id: string,
  ): IRLayer[] {
    if (!isObj(raw)) {
      this.err(path, 'layer must be an object');
      return [];
    }
    if (++this.depth > 400) {
      this.depth--;
      this.err(path, 'layers nested too deeply (recursive element?)');
      return [];
    }
    try {
      return this.compileNodeInner(raw, scope, actx, parentFrames, path, slots, defPos, id);
    } finally {
      this.depth--;
    }
  }

  private compileNodeInner(
    raw: Record<string, any>,
    scope: Scope,
    actx: AliasCtx,
    parentFrames: number,
    path: string,
    slots: SlotMap,
    defPos: [number, number],
    id: string,
  ): IRLayer[] {
    if (raw.slot !== undefined) {
      const s = slots.get(String(raw.slot));
      if (!s) return raw.default ? this.compileLayers(raw.default, scope, actx, parentFrames, `${path}.default`, slots, defPos, id) : [];
      return this.compileLayers(s.layers, { ...s.scope, dur: parentFrames / this.fps }, s.actx, parentFrames, `slots.${raw.slot}`, new Map(), defPos, `${id}.slot`);
    }
    if (raw.if !== undefined) {
      const cond = this.bind(raw.if, scope, `${path}.if`);
      if (!cond || (Array.isArray(cond) && cond.length === 0)) return [];
    }
    if (raw.repeat !== undefined || raw.each !== undefined) {
      let arr = this.bind(raw.repeat ?? raw.each, scope, `${path}.repeat`);
      if (typeof arr === 'number') arr = Array.from({ length: Math.max(0, Math.min(500, Math.floor(arr))) }, (_, i) => i);
      if (!Array.isArray(arr)) {
        this.err(`${path}.repeat`, `expected an array or a count, got ${typeOf(arr)}`);
        return [];
      }
      if (!isObj(raw.layer)) {
        this.err(`${path}.layer`, 'repeat needs a "layer" template');
        return [];
      }
      const as = typeof raw.as === 'string' ? raw.as : 'item';
      const out: IRLayer[] = [];
      arr.forEach((item, i) => {
        const s2 = { ...scope, [as]: item, index: i, count: arr.length };
        out.push(...this.compileNode(raw.layer, s2, actx, parentFrames, `${path}.layer#${i}`, slots, defPos, `${id}.${i}`));
      });
      return out;
    }

    let node = this.bind(raw, scope, path, new Set(['children', 'layer', 'slots', 'if', 'item', 'states'])) as Record<string, any>;
    if (node.textStyle !== undefined && node.use === undefined) {
      const names = String(node.textStyle).split(/[\s,+]+/).filter(Boolean);
      const merged: Record<string, any> = {};
      for (const n of names) {
        const st = this.textStyles[n];
        if (!st) this.err(`${path}.textStyle`, `unknown text style "${n}" (known: ${Object.keys(this.textStyles).join(', ')})`);
        else Object.assign(merged, st);
      }
      // the layer's own values win over the style
      node = { ...merged, ...node };
      delete node.textStyle;
    }
    const parentSec = parentFrames / this.fps;
    const at = Math.max(0, this.parseTime(node.at, parentSec, `${path}.at`) ?? 0);
    let end = parentSec;
    if (node.until !== undefined) end = this.parseTime(node.until, parentSec, `${path}.until`) ?? parentSec;
    else if (node.dur !== undefined) {
      const dur = this.parseTime(node.dur, parentSec, `${path}.dur`);
      if (dur !== undefined) end = at + dur;
    }
    end = Math.min(end, parentSec);
    const from = this.frames(at);
    const to = this.frames(end);
    if (to <= from) {
      this.warn(path, `layer has no visible time (at=${at}s, end=${end}s within ${parentSec}s)`);
      return [];
    }
    const lenFrames = to - from;
    const lenSec = lenFrames / this.fps;

    const x = node.x !== undefined ? toPx(node.x, 'x', this.W, this.H) : defPos[0];
    const y = node.y !== undefined ? toPx(node.y, 'y', this.W, this.H) : defPos[1];
    if (x === undefined || y === undefined) {
      this.err(path, `bad position x=${JSON.stringify(node.x)} y=${JSON.stringify(node.y)} — numbers or "50%", "10vw", "5vh"`);
      return [];
    }
    let anchor: [number, number] = [0.5, 0.5];
    /** "baseline…" anchors: x fraction; y is resolved on the first line's baseline once the text is sized. */
    let baselineX: number | undefined;
    if (Array.isArray(node.anchor) && node.anchor.length === 2) anchor = [Number(node.anchor[0]), Number(node.anchor[1])];
    else if (typeof node.anchor === 'string' && /^baseline(-(left|center|right))?$/.test(node.anchor)) {
      baselineX = node.anchor.endsWith('center') ? 0.5 : node.anchor.endsWith('right') ? 1 : 0;
      anchor = [baselineX, 0];
    } else if (typeof node.anchor === 'string') {
      if (ANCHORS[node.anchor]) anchor = ANCHORS[node.anchor];
      else this.err(`${path}.anchor`, `anchor must be one of ${Object.keys(ANCHORS).join(', ')}, baseline, baseline-center, baseline-right or [ax, ay]`);
    }
    const w = node.w !== undefined ? toPx(node.w, 'x', this.W, this.H) : undefined;
    const h = node.h !== undefined ? toPx(node.h, 'y', this.W, this.H) : undefined;

    const base: Partial<IRLayer> = { id: typeof node.id === 'string' ? `${id}:${node.id}` : id, from, to, x, y, anchor, anims: [], style: {} };
    if (w !== undefined) base.w = w;
    if (h !== undefined) base.h = h;
    for (const k of ['rot', 'scale', 'opacity', 'z'] as const) {
      if (node[k] !== undefined) {
        const n = Number(node[k]);
        if (Number.isNaN(n)) this.err(`${path}.${k}`, 'must be a number');
        else (base as any)[k] = n;
      }
    }
    if (typeof node.blend === 'string') base.blend = node.blend;
    if (typeof node.clipDir === 'string') base.clipDir = node.clipDir as ClipDir;
    const stagger = { frames: node.stagger !== undefined ? Math.round(Number(node.stagger) * this.fps) : 2 };

    // ----- element usage -----
    if (node.use !== undefined) {
      const params: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(node)) if (!ELEMENT_KEYS.has(k)) params[k] = v;
      const u = this.expand(node.use, params, actx, path, ['element']);
      if (!u) return [];
      const idp = scope.$idp as string | false | undefined;
      const fullName = typeof node.id === 'string' && node.id && idp !== false ? (idp ? `${idp}.${node.id}` : node.id) : undefined;
      // editor provenance: which composition value each element param came from
      const elPtr = pathToPtr(path);
      const parentProv = scope.$prov as Record<string, string> | undefined;
      const prov: Record<string, string> = {};
      for (const k of Object.keys(params)) {
        const rv = raw[k];
        if (typeof rv !== 'string') continue;
        const m = WHOLE_NAME.exec(rv);
        if (m && parentProv?.[m[1]]) prov[k] = parentProv[m[1]];
        else if (elPtr && !rv.includes('{{')) prov[k] = `${elPtr}/${k}`;
      }
      const elScope = { ...this.base(lenSec), ...u.values, $idp: fullName ?? false, $prov: prov };
      const bw = u.body.w !== undefined ? toPx(this.bind(u.body.w, elScope, `${path}(${u.hit.id}).w`), 'x', this.W, this.H) : undefined;
      const bh = u.body.h !== undefined ? toPx(this.bind(u.body.h, elScope, `${path}(${u.hit.id}).h`), 'y', this.W, this.H) : undefined;
      if (base.w === undefined && bw !== undefined) base.w = bw;
      if (base.h === undefined && bh !== undefined) base.h = bh;
      const childSlots = this.slotMap(raw.slots, scope, actx, path);
      const inner: [number, number] = base.w !== undefined && base.h !== undefined ? [base.w / 2, base.h / 2] : [0, 0];
      const children = this.compileLayers(u.body.layers, elScope, u.bodyCtx, lenFrames, `${path}(${u.hit.id})`, childSlots, inner, base.id!);
      u.extras.forEach((ex, k) => {
        children.push(...this.compileLayers(ex.layers, { ...this.base(lenSec), ...ex.values }, ex.actx, lenFrames, `${path}(${u.hit.id}).addLayers`, childSlots, inner, `${base.id}.x${k}`));
      });
      if (u.body.layout) base.layout = this.layout(this.bind(u.body.layout, elScope, `${path}.layout`), path, base.w, base.h);
      const style = isObj(u.body.style) ? (this.bind(u.body.style, elScope, `${path}.style`) as Record<string, any>) : {};
      const layer = { ...base, type: 'group', style, children, src_preset: u.hit.id } as IRLayer;
      if (base.w === undefined && !layer.layout) layer.anchor = [0, 0];
      const em = maskCss(node.mask);
      if (em) layer.mask = em;
      layer.anims = this.buildAnims(node, lenFrames, actx, scope, path, false, 1, stagger, { w: layer.w, h: layer.h });
      return [this.finishLayer(layer, node, raw, scope, path)];
    }

    // ----- primitives -----
    let type = node.type as string | undefined;
    if (!type) type = node.text !== undefined || node.counter !== undefined ? 'text' : node.children ? 'group' : undefined;
    if (type === 'circle') type = 'ellipse';
    const handler = type ? layerHandlers.get(type) : undefined;
    if (handler) {
      const out = handler.compile(this, { node, raw, base, scope, actx, lenFrames, lenSec, path, slots, id: base.id!, stagger });
      return out.map((l) => {
        if (!l.anims.length) l.anims = this.buildAnims(node, lenFrames, actx, scope, path, false, 1, stagger, { w: l.w, h: l.h });
        return this.finishLayer(l, node, raw, scope, path);
      });
    }
    const TYPES = ['text', 'rect', 'ellipse', 'line', 'path', 'image', 'video', 'svg', 'group', ...layerHandlers.keys()];
    if (!type || !TYPES.includes(type)) {
      this.err(`${path}.type`, `expected one of ${TYPES.join(', ')} (or "use": an element preset)${type ? `, got "${type}"` : ''}`);
      return [];
    }
    const style: Record<string, any> = isObj(node.style) ? { ...node.style } : {};
    for (const [k, v] of Object.entries(node)) if (!LAYER_KEYS.has(k)) style[k] = v;
    for (const [k, axis] of Object.entries(STYLE_PX_KEYS)) {
      if (style[k] !== undefined && typeof style[k] === 'string') {
        const n = toPx(style[k], axis, this.W, this.H);
        if (n !== undefined) style[k] = n;
      }
    }
    for (const [k, v] of Object.entries(style)) {
      if (v === undefined || v === null) delete style[k];
      else if (typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean') {
        this.err(`${path}.${k}`, `style values must be strings or numbers, got ${typeOf(v)}`);
        delete style[k];
      } else if (typeof v === 'boolean') style[k] = v ? 1 : 0;
    }
    const layer = { ...base, type, style } as IRLayer;
    if (baselineX !== undefined && type !== 'text') {
      this.warn(`${path}.anchor`, 'baseline anchors are for text layers; using the bottom edge');
      layer.anchor = [baselineX, 1];
    }
    let unitCount = 1;
    let split = false;

    switch (type) {
      case 'text': {
        if (node.text !== undefined) layer.text = String(node.text);
        if (node.counter !== undefined) {
          const c = node.counter;
          if (!isObj(c) || typeof c.to !== 'number') {
            this.err(`${path}.counter`, 'counter needs { to: number, from?, at?, d?, ease?, decimals?, prefix?, suffix?, sep? }');
          } else {
            const cs = this.frames(Number(c.at ?? 0));
            layer.counter = {
              from: Number(c.from ?? 0),
              to: c.to,
              s: cs,
              e: cs + Math.max(1, this.frames(Number(c.d ?? 1.5))),
              ease: c.ease,
              decimals: c.decimals !== undefined ? Number(c.decimals) : undefined,
              prefix: c.prefix !== undefined ? String(c.prefix) : undefined,
              suffix: c.suffix !== undefined ? String(c.suffix) : undefined,
              sep: c.sep !== undefined ? String(c.sep) : undefined,
            };
            if (c.ease && !parseEasing(String(c.ease))) this.err(`${path}.counter.ease`, `bad easing ${JSON.stringify(c.ease)}`);
          }
        }
        if (layer.text === undefined && !layer.counter) {
          this.err(path, 'text layer needs "text" or "counter"');
          return [];
        }
        if (style.fit === 'shrink' || style.fit === 1) delete style.fit;
        if (node.fit === 'shrink' || node.fit === true || node.maxLines !== undefined) {
          const pad = typeof style.padding === 'number' ? style.padding * 2 : 0;
          const boxW = (layer.w ?? this.W - 2 * Math.round(this.W * 0.06)) - pad;
          const st = textStyleOf(layer);
          const size = fitSize(layer.text ?? '', st, {
            w: boxW,
            h: layer.h,
            maxLines: node.maxLines !== undefined ? Number(node.maxLines) : undefined,
            minSize: node.minSize !== undefined ? Number(node.minSize) : undefined,
          });
          if (size < st.size) style.size = size;
          if (layer.w === undefined && node.fit) layer.w = boxW + pad;
        }
        if (baselineX !== undefined) {
          // put the first line's baseline on y (text sits on the line like in a layout tool)
          const pad = typeof style.padding === 'number' ? style.padding : 0;
          layer.y = +(layer.y - baselineOffset(textStyleOf(layer)) - pad).toFixed(2);
          layer.anchor = [baselineX, 0];
        }
        if (node.split !== undefined && node.split !== null && node.split !== false) {
          if (!['chars', 'words', 'lines'].includes(node.split)) this.err(`${path}.split`, 'split must be chars, words or lines');
          else if (!layer.counter) {
            layer.split = node.split;
            split = true;
            const t = layer.text ?? '';
            unitCount = node.split === 'chars' ? t.replace(/\s+/g, '').length : node.split === 'words' ? countWords(t) : t.split('\n').length;
          }
        }
        break;
      }
      case 'rect':
      case 'ellipse':
        if (layer.w === undefined) layer.w = 100;
        if (layer.h === undefined) layer.h = layer.w;
        break;
      case 'line': {
        const x2 = toPx(node.x2, 'x', this.W, this.H);
        const y2 = toPx(node.y2, 'y', this.W, this.H);
        if (x2 === undefined || y2 === undefined) {
          this.err(path, 'line needs x2 and y2');
          return [];
        }
        layer.points = [x, y, x2, y2];
        break;
      }
      case 'path':
        if (typeof node.d !== 'string') {
          this.err(`${path}.d`, 'path needs an SVG path string "d"');
          return [];
        }
        layer.d = node.d;
        if (typeof node.viewBox === 'string') layer.viewBox = node.viewBox;
        if (layer.w === undefined || layer.h === undefined) {
          this.err(path, 'path needs w and h');
          return [];
        }
        break;
      case 'svg':
        if (typeof node.svg !== 'string' || !/<svg[\s>]/i.test(node.svg)) {
          this.err(`${path}.svg`, 'svg needs inline <svg> markup');
          return [];
        }
        if (/<script|on[a-z]+\s*=/i.test(node.svg)) {
          this.err(`${path}.svg`, 'scripts and event handlers are not allowed in svg');
          return [];
        }
        layer.svg = node.svg;
        break;
      case 'image':
      case 'video': {
        const src = this.assetSrc(node.src, `${path}.src`);
        if (!src) return [];
        layer.src = src;
        if (layer.w === undefined) layer.w = this.W;
        if (layer.h === undefined) layer.h = this.H;
        const im = maskCss(node.mask);
        if (im) layer.mask = im;
        break;
      }
      case 'group': {
        const sized = layer.w !== undefined && layer.h !== undefined;
        if (!sized) layer.anchor = node.anchor !== undefined ? layer.anchor : [0, 0];
        if (node.layout !== undefined) layer.layout = this.layout(node.layout, path, layer.w, layer.h);
        if (node.overflow === 'hidden') layer.overflow = 'hidden';
        const childSlots = this.slotMap(raw.slots, scope, actx, path);
        layer.children = this.compileLayers(raw.children, { ...scope, dur: lenSec }, actx, lenFrames, `${path}.children`, new Map([...slots, ...childSlots]), sized ? [layer.w! / 2, layer.h! / 2] : [0, 0], layer.id);
        const gm = maskCss(node.mask);
        if (gm) layer.mask = gm;
        break;
      }
    }
    if (layer.split || node.stagger !== undefined) layer.stagger = stagger.frames;
    layer.anims = this.buildAnims(node, lenFrames, actx, scope, path, split, unitCount, stagger, { w: layer.w, h: layer.h });
    if (layer.split) layer.stagger = stagger.frames;
    return [this.finishLayer(layer, node, raw, scope, path)];
  }

  layout(v: unknown, path: string, boxW?: number, boxH?: number): IRLayout | undefined {
    if (!isObj(v)) {
      this.err(`${path}.layout`, 'layout must be { dir: row|column, gap?, align?, justify?, wrap? }');
      return undefined;
    }
    // "auto": a row when there is room across (wide box or landscape frame), a column otherwise
    const dir = v.dir === 'row' ? 'row' : v.dir === 'auto' ? ((boxW ?? this.W) >= (boxH ?? this.H) ? 'row' : 'column') : 'column';
    const gap = v.gap !== undefined ? toPx(v.gap, 'min', this.W, this.H) : undefined;
    return { dir, gap, align: v.align, justify: v.justify, wrap: !!v.wrap };
  }

  slotMap(raw: unknown, scope: Scope, actx: AliasCtx, path: string): SlotMap {
    const m: SlotMap = new Map();
    if (raw === undefined) return m;
    if (!isObj(raw)) {
      this.err(`${path}.slots`, 'slots must be { name: [layers] }');
      return m;
    }
    for (const [k, v] of Object.entries(raw)) m.set(k, { layers: Array.isArray(v) ? v : [v], scope, actx });
    return m;
  }

  assetSrc(v: unknown, path: string): string | null {
    if (typeof v !== 'string' || !v) {
      this.err(path, 'src is required: "asset:<id>" (from mf_asset_put) or an https URL');
      return null;
    }
    const m = /^asset:([a-f0-9]{8,64})$/.exec(v);
    if (m) {
      const url = this.opts.assetUrl(m[1]);
      if (!url) this.err(path, `unknown asset ${v} — upload it with mf_asset_put`);
      return url;
    }
    if (/^(https?:|data:)/.test(v)) return v;
    this.err(path, `local paths are not allowed in compositions; register the file with mf_asset_put and use the asset:<id> it returns`);
    return null;
  }
}

function checkType(def: ParamDef, v: unknown): { value: unknown } | string {
  const t = def.type;
  const got = `got ${typeOf(v)}${typeof v === 'string' || typeof v === 'number' ? ' ' + JSON.stringify(v).slice(0, 40) : ''}`;
  switch (t) {
    case 'any':
    case 'object':
      if (t === 'object' && !isObj(v)) return `expected object, ${got}`;
      return { value: v };
    case 'string':
      if (typeof v === 'number') v = String(v);
      if (typeof v !== 'string') return `expected string, ${got}`;
      if (def.max !== undefined && v.length > def.max) return `too long (${v.length} > ${def.max} chars)`;
      if (def.min !== undefined && v.length < def.min) return `too short (min ${def.min} chars)`;
      return { value: v };
    case 'number':
    case 'integer':
    case 'duration': {
      let n = v;
      if (typeof n === 'string' && n.trim() !== '' && !Number.isNaN(Number(n))) n = Number(n);
      if (typeof n !== 'number' || Number.isNaN(n)) return `expected ${t}, ${got}`;
      if (t === 'integer' && !Number.isInteger(n)) return `expected integer, ${got}`;
      if (def.min !== undefined && n < def.min) return `must be ≥ ${def.min}`;
      if (def.max !== undefined && n > def.max) return `must be ≤ ${def.max}`;
      return { value: n };
    }
    case 'boolean':
      if (typeof v !== 'boolean') return `expected boolean, ${got}`;
      return { value: v };
    case 'color':
      if (typeof v !== 'string') return `expected color string, ${got}`;
      return { value: v };
    case 'enum':
      if (typeof v !== 'string' || !def.values?.includes(v)) return `expected one of ${def.values?.join('|')}, ${got}`;
      return { value: v };
    case 'asset':
      if (typeof v !== 'string' || !/^(asset:[a-f0-9]{8,64}|https?:\/\/|data:)/.test(v)) return `expected "asset:<id>" or URL, ${got}`;
      return { value: v };
    case 'preset':
      if (typeof v !== 'string') return `expected preset id, ${got}`;
      return { value: v };
    case 'array': {
      if (!Array.isArray(v)) {
        if (typeof v === 'string' && def.items === 'string') return { value: v.split('\n').filter(Boolean) };
        return `expected array, ${got}`;
      }
      if (def.min !== undefined && v.length < def.min) return `needs at least ${def.min} items`;
      if (def.max !== undefined && v.length > def.max) return `at most ${def.max} items`;
      if (def.items && def.items !== 'any') {
        for (let i = 0; i < v.length; i++) {
          const r = checkType({ type: def.items }, v[i]);
          if (typeof r === 'string') return `item ${i}: ${r}`;
        }
      }
      return { value: v };
    }
  }
  return { value: v };
}

// ======================================================================

const dedupe = (xs: Issue[]) => {
  const seen = new Set<string>();
  return xs.filter((x) => {
    const k = x.path + '|' + x.msg;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
};

export function compile(input: CompileInput, opts: CompileOptions): CompileResult {
  const r = compileInner(input, opts);
  r.errors = dedupe(r.errors);
  r.warnings = dedupe(r.warnings);
  return r;
}

export interface DirectionSpec {
  id: string;
  theme?: unknown;
  tokens?: Tokens;
  fonts?: IRFont[];
  pace?: number;
  animScale?: number;
  transition?: Record<string, any> | null;
  transitions?: Record<string, any>[];
  sceneDefaults?: Record<string, unknown>;
  overlays?: unknown[];
  sfx?: Record<string, string>;
  /** Params of the direction preset (in scope for its overlays). */
  values?: Record<string, unknown>;
  actx: AliasCtx;
}

export interface TransitionRun {
  u: NonNullable<ReturnType<Session['expand']>>;
  A: SceneCtx | null;
  B: SceneCtx | null;
  /** Frames of the transition, and where it starts in A's local time. */
  tdF: number;
  aStart: number;
  /** Absolute frame where the transition starts. */
  absStart: number;
  overlap: boolean;
  overlays: IRLayer[];
  idx: number;
  path: string;
}

interface Item {
  k: 'scene' | 'transition';
  entry: Record<string, any>;
  /** The entry before binding (to know which values were literals, for the editor). */
  rawEntry: Record<string, any>;
  actx: AliasCtx;
  path: string;
  /** Extra names in scope (repeat item, macro params). */
  extra: Scope;
  topLevel: boolean;
}

const KNOWN_TOP = new Set([
  'use', 'theme', 'format', 'tokens', 'bg', 'title', 'scenes', 'audio', 'fonts', 'note', 'params', 'direction', 'music', 'template', 'description', 'adapt', 'pace', 'framing', 'props', 'textStyles', 'data',
]);

/** Built-in text styles, only with the token values the theme actually defines. */
const BUILTIN_TEXT: Record<string, Record<string, unknown>> = {
  display: { font: '$font.display', weight: '$weight.display', size: '$size.hero', lineHeight: 1, tracking: -0.02 },
  h1: { font: '$font.display', weight: '$weight.display', size: '$size.h1', lineHeight: 1.05, tracking: -0.01 },
  h2: { font: '$font.display', weight: '$weight.heading', size: '$size.h2', lineHeight: 1.1 },
  h3: { font: '$font.display', weight: '$weight.heading', size: '$size.h3', lineHeight: 1.15 },
  body: { font: '$font.body', weight: '$weight.body', size: '$size.body', lineHeight: 1.4 },
  small: { font: '$font.body', weight: '$weight.body', size: '$size.small', lineHeight: 1.4 },
  caption: { font: '$font.body', weight: '$weight.body', size: '$size.small', lineHeight: 1.35, color: '$color.muted' },
  label: { font: '$font.body', weight: 600, size: '$size.label', tracking: 0.08, case: 'upper' },
  kicker: { font: '$font.display', weight: 700, size: '$size.label', tracking: 0.18, case: 'upper', color: '$color.accent' },
  mono: { font: '$font.mono', weight: 400, size: '$size.small', lineHeight: 1.4 },
};

function buildTextStyles(S: Session, own: unknown): Record<string, Record<string, any>> {
  const out: Record<string, Record<string, any>> = {};
  for (const [name, st] of Object.entries(BUILTIN_TEXT)) {
    const keep: Record<string, any> = {};
    for (const [k, v] of Object.entries(st)) {
      if (typeof v === 'string' && v.startsWith('$')) {
        const t = lookupToken(S.tokens, v.slice(1));
        if (t !== undefined && typeof t !== 'object') keep[k] = t;
      } else keep[k] = v;
    }
    out[name] = keep;
  }
  const add = (src: unknown, where: string) => {
    if (src === undefined) return;
    if (!isObj(src)) {
      S.err(where, 'text styles are {"name": {"font","size","weight","tracking","lineHeight","color","case",…}}');
      return;
    }
    for (const [name, st] of Object.entries(src)) {
      if (!isObj(st)) {
        S.err(`${where}.${name}`, 'a text style is an object of text properties, e.g. {"font":"$font.display","size":96,"weight":800}');
        continue;
      }
      const { extends: base, ...rest } = st as Record<string, any>;
      let parent: Record<string, any> = out[name] && base === undefined ? out[name] : {};
      if (base !== undefined) {
        if (typeof base !== 'string' || !out[base]) S.err(`${where}.${name}.extends`, `unknown text style "${base}" (known: ${Object.keys(out).join(', ')})`);
        else parent = out[base];
      }
      out[name] = { ...parent, ...(S.bind(rest, S.base(0), `${where}.${name}`) as Record<string, any>) };
    }
  };
  add(lookupToken(S.tokens, 'text'), 'tokens.text');
  add(own, 'textStyles');
  return out;
}

function compileInner(input: CompileInput, opts: CompileOptions, snapped?: number[]): CompileResult {
  const S = new Session(opts, input.agent, input.lock);
  S.depthLevel = input.depth ?? 0;
  const fail = (): CompileResult => ({
    ok: false,
    errors: S.errors,
    warnings: S.warnings,
    lock: S.lock,
    used: [...S.used],
    scenes: [],
    duration: 0,
    format: { width: S.W, height: S.H, fps: S.fps },
  });
  let comp = input.composition as Record<string, any>;
  if (!isObj(comp)) {
    S.err('', 'composition must be a JSON object');
    return fail();
  }
  for (const k of Object.keys(comp)) if (!KNOWN_TOP.has(k) && !k.startsWith('@')) S.warn(k, `unknown top-level key (known: ${[...KNOWN_TOP].join(', ')})`);

  // format
  const fmt = parseFormat(String(input.format ?? comp.format ?? opts.defaultFormat));
  if (!fmt) {
    S.err('format', `bad format "${comp.format}" — "1920x1080@30", "16:9", "9:16@60", "1:1"…`);
    return fail();
  }
  S.setFormat(fmt.width, fmt.height, fmt.fps);
  comp = applyOverrides(comp, S.orient);
  // format adaptation: inline layers were authored for another frame ("adapt": {"from": "16:9"})
  if (comp.adapt !== undefined) {
    const from = parseFormat(String(isObj(comp.adapt) ? comp.adapt.from : comp.adapt));
    if (!from) S.err('adapt', 'adapt is {"from": "16:9"} (the format the inline layers were written for), optional "text": 1.15 (extra text scale)');
    else if (from.width !== S.W || from.height !== S.H) S.retarget = { W: from.width, H: from.height, text: Number(isObj(comp.adapt) ? comp.adapt.text ?? 1 : 1) };
  }

  // exposed params (sub-compositions, data templates)
  if (comp.params !== undefined) {
    const pIssues: Issue[] = [];
    const defs = normalizeParams(comp.params, 'params', pIssues);
    for (const i of pIssues) S.errors.push(i);
    S.params = S.checkParams(defs, { ...(isObj(comp.props) ? comp.props : {}), ...(input.props ?? {}) } as Record<string, unknown>, 'props', 'this composition');
  } else if (input.props && Object.keys(input.props).length) {
    S.warn('props', 'props were given but the composition declares no "params"');
  }

  // data-driven compositions: "data" is in scope everywhere ({{data.title}}, "each": "{{data.items}}")
  if (comp.data !== undefined) {
    if (typeof comp.data === 'string') S.err('data', 'data is inline JSON (object or array); for CSV/asset rows use mf_template {"data": "asset:<id>"}');
    else S.data = comp.data;
  }

  // imports
  const compCtx: AliasCtx = { aliases: new Map() };
  const core = S.resolveLib('@core/base', undefined, 'use');
  if (core) compCtx.aliases.set('core', core);
  const uses = comp.use === undefined ? [] : Array.isArray(comp.use) ? comp.use : [comp.use];
  uses.forEach((u: unknown, i: number) => {
    const m = typeof u === 'string' ? USE_RE.exec(u.trim()) : null;
    if (!m) {
      S.err(`use[${i}]`, `bad import ${JSON.stringify(u)} — "@scope/name", "@scope/name@^1", "@scope/name@draft as x"`);
      return;
    }
    const lv = S.resolveLib(m[1], m[2], `use[${i}]`);
    if (!lv) return;
    const alias = m[3] ?? lv.alias;
    const prev = compCtx.aliases.get(alias);
    if (prev && prev.name !== lv.name) S.err(`use[${i}]`, `alias '${alias}' is already used by ${prev.name}; add "as <other>"`);
    compCtx.aliases.set(alias, lv);
  });
  if (S.errors.length) return fail();

  // art direction (optional): theme, tokens, pace, default transitions, overlays, sounds
  let dir: DirectionSpec | null = null;
  if (comp.direction !== undefined && comp.direction !== null) {
    dir = hooks.direction?.(S, comp.direction, compCtx) ?? null;
    if (dir) {
      S.scratch.direction = dir;
      S.pace = dir.pace ?? 1;
      S.animScale = dir.animScale ?? 1;
    }
  }

  // global pace (×scene durations) and framing (×scale of every scene: 1.1 = tighter framing)
  if (comp.pace !== undefined) {
    const p = Number(comp.pace);
    if (!(p > 0.2 && p < 5)) S.err('pace', 'pace multiplies scene durations (0.2–5); 0.85 = snappier');
    else {
      S.pace *= p;
      S.paceExplicit = p;
    }
  }
  // theme + tokens
  let fonts: IRFont[] = [];
  const themeRef = comp.theme ?? dir?.theme ?? (input.inheritTheme ? undefined : opts.defaultTheme);
  if (themeRef !== undefined) {
    const themeEntry: Record<string, any> = typeof themeRef === 'string' ? { p: themeRef } : isObj(themeRef) ? themeRef : {};
    const { p: themeP, ...themeParams } = themeEntry;
    const themeU = S.expand(themeP, themeParams, comp.theme === undefined && dir ? dir.actx : compCtx, 'theme', ['theme']);
    if (themeU) {
      S.tokens = (S.bind(clone(themeU.body.tokens ?? {}), { W: S.W, H: S.H, fps: S.fps, U: Math.min(S.W, S.H) / 1080, ...themeU.values }, 'theme.tokens') as Tokens) ?? {};
      if (Array.isArray(themeU.body.fonts)) fonts = themeU.body.fonts as IRFont[];
    }
  } else if (input.inheritTheme) {
    S.tokens = clone(input.inheritTheme.tokens);
    fonts = [...input.inheritTheme.fonts];
  }
  if (dir?.tokens) S.tokens = deepMerge(S.tokens, dir.tokens);
  if (dir?.fonts) fonts = [...fonts, ...dir.fonts];
  if (comp.tokens !== undefined) {
    if (!isObj(comp.tokens)) S.err('tokens', 'tokens must be an object like {"color":{"accent":"#ff3d71"}}');
    else S.tokens = deepMerge(S.tokens, comp.tokens);
  }
  if (Array.isArray(comp.fonts)) fonts = [...fonts, ...comp.fonts];
  fonts = fonts.filter((f, i) => {
    if (!isObj(f) || typeof f.family !== 'string') {
      S.err(`fonts[${i}]`, 'font needs { family, source: google|url|system, weights?, url? }');
      return false;
    }
    if (!f.source) (f as any).source = 'google';
    return true;
  });
  S.fonts = fonts;
  S.textStyles = buildTextStyles(S, comp.textStyles);

  // scenes
  if (!Array.isArray(comp.scenes) || comp.scenes.length === 0) {
    S.err('scenes', 'scenes must be a non-empty array');
    return fail();
  }

  const items: Item[] = [];
  const SKIP_BIND = new Set(['layers', 'slots', 'tweaks', 'scene']);
  const pushEntry = (e: Record<string, any>, rawEntry: Record<string, any>, actx: AliasCtx, p: string, extra: Scope, depth: number, topLevel: boolean) => {
    if (e.preset !== undefined && e.p === undefined) (e.p = e.preset), delete e.preset;
    if (e.duration !== undefined && e.d === undefined) (e.d = e.duration), delete e.duration;
    if (e.transition !== undefined && e.t === undefined) (e.t = e.transition), delete e.transition;
    if (e.t !== undefined) {
      items.push({ k: 'transition', entry: e, rawEntry, actx, path: p, extra, topLevel });
      return;
    }
    if (e.p === undefined) {
      if (Array.isArray(e.layers)) {
        items.push({ k: 'scene', entry: e, rawEntry, actx, path: p, extra, topLevel });
        return;
      }
      S.err(p, 'scene entry needs "p" (a scene preset), "t" (a transition), "layers" or "repeat"');
      return;
    }
    // macro presets expand into several entries
    const hit = S.lookup(e.p, actx, `${p}.p`, ['scene', 'template', 'element']);
    if (!hit) return;
    if (!Array.isArray(S.rootBody(hit)?.scenes)) {
      items.push({ k: 'scene', entry: e, rawEntry, actx, path: p, extra, topLevel });
      return;
    }
    const probe = S.expand(e.p, paramsOf(e), actx, p, ['scene', 'template', 'element']);
    if (!probe) return;
    const scope = { ...S.base(0), ...extra, ...probe.values };
    const sub = S.bind(clone(probe.body.scenes), scope, `${p}(${probe.hit.id}).scenes`, new Set(['layers', 'slots', 'scene'])) as unknown[];
    expandEntries(sub, probe.bodyCtx, `${p}(${probe.hit.id})`, depth + 1, { ...extra, ...probe.values }, false);
  };
  const expandEntries = (entries: unknown[], actx: AliasCtx, path: string, depth: number, extra: Scope, topLevel: boolean) => {
    if (depth > 6) {
      S.err(path, 'macro presets nested too deeply');
      return;
    }
    entries.forEach((raw: any, i) => {
      const p = `${path}[${i}]`;
      if (!isObj(raw)) {
        S.err(p, 'scene entry must be an object: {"p":"alias:slug", …params}, {"t":"alias:transition"} or {"repeat":…, "scene":{…}}');
        return;
      }
      if (raw.if !== undefined) {
        const cond = S.bind(raw.if, { ...S.base(0), ...extra }, `${p}.if`);
        if (!cond || (Array.isArray(cond) && !cond.length)) return;
      }
      if (raw.repeat !== undefined || raw.each !== undefined) {
        const key = raw.each !== undefined ? 'each' : 'repeat';
        let arr = S.bind(raw[key], { ...S.base(0), ...extra }, `${p}.${key}`);
        if (typeof arr === 'number') arr = Array.from({ length: Math.max(0, Math.min(200, Math.floor(arr))) }, (_, k) => k);
        if (isObj(arr)) arr = Object.entries(arr).map(([k, v]) => (isObj(v) ? { key: k, ...v } : { key: k, value: v }));
        if (!Array.isArray(arr)) return S.err(`${p}.${key}`, `expected an array, an object or a count, got ${typeOf(arr)}`);
        const group = Array.isArray(raw.scenes) ? raw.scenes : isObj(raw.scene) ? [raw.scene] : null;
        if (!group || !group.length) return S.err(`${p}.scenes`, `${key} needs "scenes": [scene entries (and transitions) repeated for each item] or "scene": {…}`);
        if (arr.length > 200) return S.err(`${p}.${key}`, `${arr.length} items: at most 200`);
        const as = typeof raw.as === 'string' ? raw.as : 'item';
        const list = arr as unknown[];
        list.forEach((item, k) => {
          const ex = { ...extra, [as]: item, index: k, count: list.length, first: k === 0, last: k === list.length - 1 };
          if (k > 0 && isObj(raw.between)) {
            const b = S.bind(clone(raw.between), { ...S.base(0), ...ex }, `${p}.between`) as Record<string, any>;
            pushEntry({ ...b }, raw.between, actx, `${p}.between`, ex, depth, false);
          }
          group.forEach((g: unknown, j: number) => {
            const gp = Array.isArray(raw.scenes) ? `${p}.scenes[${j}]#${k}` : `${p}.scene#${k}`;
            if (!isObj(g)) return S.err(gp, 'scene entry must be an object');
            if (g.if !== undefined) {
              const cond = S.bind(g.if, { ...S.base(0), ...ex }, `${gp}.if`);
              if (!cond || (Array.isArray(cond) && !cond.length)) return;
            }
            const { if: _if, ...rest } = g as Record<string, any>;
            void _if;
            const bound = S.bind(clone(rest), { ...S.base(0), ...ex }, gp, SKIP_BIND) as Record<string, any>;
            pushEntry({ ...bound }, rest, actx, gp, ex, depth, false);
          });
        });
        return;
      }
      if (raw.if !== undefined) {
        const { if: _if, ...rest } = raw as Record<string, any>;
        void _if;
        raw = rest;
      }
      const bound = depth === 0 ? (S.bind(raw, { ...S.base(0), ...extra }, p, SKIP_BIND) as Record<string, any>) : { ...raw };
      pushEntry({ ...bound }, raw, actx, p, extra, depth, topLevel);
    });
  };
  expandEntries(comp.scenes, compCtx, 'scenes', 0, {}, true);
  if (S.errors.length) return fail();

  // compile scenes
  const scenes: SceneCtx[] = [];
  const sceneMarkers: IRMarker[][] = [];
  const transitions: { before: number; entry: Record<string, any>; actx: AliasCtx; path: string }[] = [];
  let sceneCount = 0;
  let prevWasScene = false;
  let autoIdx = 0;
  for (const it of items) {
    if (it.k === 'transition') {
      const last = transitions[transitions.length - 1];
      if (last && last.before === sceneCount) S.err(it.path, 'two transitions in a row; put a scene between them');
      transitions.push({ before: sceneCount, entry: it.entry, actx: it.actx, path: it.path });
      prevWasScene = false;
      continue;
    }
    if (prevWasScene && dir && (dir.transition || dir.transitions?.length)) {
      const t = dir.transitions?.length ? dir.transitions[autoIdx++ % dir.transitions.length] : dir.transition!;
      if (t && t.t) transitions.push({ before: sceneCount, entry: clone(t), actx: dir.actx, path: `direction(${dir.id}).transition` });
    }
    S.names = new Map();
    S.markers = [];
    const cs = compileScene(S, it, sceneCount, compCtx, dir, snapped?.[sceneCount]);
    if (cs) {
      scenes.push(cs);
      sceneMarkers.push(S.markers);
    }
    sceneCount++;
    prevWasScene = true;
  }
  if (S.errors.length || scenes.length === 0) {
    if (!scenes.length && !S.errors.length) S.err('scenes', 'no scenes to render');
    return fail();
  }

  // timeline
  const starts: number[] = [];
  const overlays: IRLayer[] = [];
  const tBetween = new Map<number, (typeof transitions)[number]>();
  for (const t of transitions) tBetween.set(t.before, t);
  const transMarkers: IRMarker[] = [];
  const overlapsOut: number[] = [];
  let cursor = 0;
  for (let i = 0; i < scenes.length; i++) {
    const A = scenes[i];
    if (i === 0 && tBetween.has(0)) applyTransition(S, tBetween.get(0)!, null, A, 0, overlays, i, transMarkers);
    starts.push(cursor);
    const t = tBetween.get(i + 1);
    const B = scenes[i + 1];
    if (t) {
      const shift = applyTransition(S, t, A, B ?? null, cursor, overlays, i, transMarkers);
      overlapsOut.push(shift);
      cursor += A.frames - shift;
    } else {
      overlapsOut.push(0);
      cursor += A.frames;
    }
  }
  const total = Math.max(...scenes.map((s, i) => starts[i] + s.frames));
  if (total > S.fps * 60 * 30) S.err('scenes', 'videos are limited to 30 minutes');
  if (S.errors.length) return fail();

  // music: snap the cuts onto beats/bars, then compile again with those durations
  if (!snapped && hooks.snap && isObj(comp.music) && comp.music.snap && comp.music.snap !== 'none') {
    const mins = scenes.map((s) => Math.round(S.fps * 0.8));
    const durs = hooks.snap(S, comp, { frames: scenes.map((s) => s.frames), overlaps: overlapsOut, mins });
    if (durs) {
      const r2 = compileInner(input, opts, durs);
      r2.warnings.push(...S.warnings.filter((w) => w.path.startsWith('music')));
      return r2;
    }
  }

  const layers: IRLayer[] = scenes.map((s, i) => ({ ...s.group, from: starts[i], to: starts[i] + s.frames }));
  if (comp.framing !== undefined) {
    const f = Number(comp.framing);
    if (!(f >= 0.5 && f <= 2)) S.err('framing', 'framing scales every scene (0.5–2): 1.12 = tighter, 0.9 = wider');
    else if (f !== 1) for (const l of layers) l.scale = (l.scale ?? 1) * f;
  }
  layers.push(...overlays);
  const sceneInfo: IRSceneInfo[] = scenes.map((s, i) => ({ index: i, id: s.group.id, preset: s.group.src_preset, start: starts[i], end: starts[i] + s.frames }));
  const bgTok = lookupToken(S.tokens, 'color.bg');
  const bg = typeof comp.bg === 'string' ? (S.bind(comp.bg, S.base(0), 'bg') as string) : typeof bgTok === 'string' ? bgTok : '#000000';

  const markers: IRMarker[] = [];
  scenes.forEach((s, i) => {
    markers.push({ t: starts[i], kind: 'scene', name: s.group.src_preset ?? `scene ${i + 1}`, d: s.frames });
    for (const m of sceneMarkers[i]) markers.push({ ...m, t: m.t + starts[i] });
  });
  markers.push(...transMarkers);
  markers.sort((a, b) => a.t - b.t);

  const ir: IRDoc = { v: 1, width: S.W, height: S.H, fps: S.fps, duration: total, bg, fonts: S.fonts, layers, scenes: sceneInfo, markers };
  for (const p of docPasses) p.run(S, { ir, comp, scenes, starts });
  if (S.errors.length) return fail();
  return {
    ok: S.errors.length === 0,
    ir,
    errors: S.errors,
    warnings: S.warnings,
    lock: S.lock,
    used: [...S.used],
    scenes: scenes.map((s, i) => ({ i, id: s.group.id, preset: s.group.src_preset, start: +(starts[i] / S.fps).toFixed(2), d: +(s.frames / S.fps).toFixed(2) })),
    duration: +(total / S.fps).toFixed(2),
    format: fmt,
  };
}

/** Compile a child composition inside the current one (sub-compositions, captures). */
export function compileChild(S: Session, input: Omit<CompileInput, 'agent'>): CompileResult {
  const r = compileInner({ ...input, agent: S.agent, depth: S.depthLevel + 1 }, S.opts);
  for (const [k, v] of Object.entries(r.lock)) if (!S.lock[k]) S.lock[k] = v;
  for (const u of r.used) S.used.add(u);
  return r;
}

function paramsOf(e: Record<string, any>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(e)) if (!SCENE_KEYS.has(k)) out[k] = v;
  return out;
}

function compileScene(S: Session, it: Item, index: number, compCtx: AliasCtx, dir: DirectionSpec | null, forcedFrames?: number): SceneCtx | null {
  const { actx, path, extra } = it;
  const entry = it.entry;
  const id = `s${index}`;
  let frames: number;
  let children: IRLayer[] = [];
  let bg: unknown;
  let preset: string | undefined;
  const slots = S.slotMap(entry.slots, { ...S.base(0), ...extra }, compCtx, path);
  const sc0 = { entry, path, frames: 0, index, actx };
  // pre-passes see the entry before its duration is known
  for (const p of scenePasses) p.pre?.(S, sc0);
  let scope: Scope;
  if (entry.p === undefined) {
    const sec = forcedFrames !== undefined ? forcedFrames / S.fps : S.durationFor(entry.d, undefined, {}, 3, `${path}.d`);
    frames = forcedFrames ?? S.frames(sec);
    scope = { ...S.base(sec), ...extra };
    children = compileInline(S, () => S.compileLayers(entry.layers, { ...S.base(sec), ...extra }, actx, frames, `${path}.layers`, slots, [S.W / 2, S.H / 2], id));
  } else {
    const params = paramsOf(entry);
    // direction defaults fill params the scene left out (only params the preset has)
    if (dir?.sceneDefaults) {
      const hit = S.lookup(entry.p, actx, `${path}.p`, ['scene', 'element']);
      if (hit) {
        const defs = S.publicParams(hit);
        for (const [k, v] of Object.entries(dir.sceneDefaults)) if (defs[k] && params[k] === undefined) params[k] = v;
      }
    }
    const u = S.expand(entry.p, params, actx, path, ['scene', 'element']);
    if (!u) return null;
    preset = u.hit.id;
    const sec = forcedFrames !== undefined ? forcedFrames / S.fps : S.durationFor(entry.d, u.rule, u.values, 3, `${path}.d`);
    frames = forcedFrames ?? S.frames(sec);
    const prov: Record<string, string> = {};
    if (it.topLevel) {
      const ptr = '/' + path.replace(/\[(\d+)\]/g, '/$1').replace(/\./g, '/');
      for (const k of Object.keys(params)) if (typeof it.rawEntry[k] === 'string' && !String(it.rawEntry[k]).includes('{{')) prov[k] = `${ptr}/${k}`;
    }
    scope = { ...S.base(sec), ...extra, ...u.values, $prov: prov };
    if (u.hit.preset.kind === 'element') {
      children = S.compileNode({ use: entry.p, ...params }, { ...S.base(sec), ...extra, $prov: prov }, actx, frames, path, slots, [S.W / 2, S.H / 2], `${id}.0`);
    } else {
      children = S.compileLayers(u.body.layers, scope, u.bodyCtx, frames, `${path}(${u.hit.id})`, slots, [S.W / 2, S.H / 2], id);
      u.extras.forEach((ex, k) => {
        children.push(...S.compileLayers(ex.layers, { ...S.base(sec), ...extra, ...ex.values }, ex.actx, frames, `${path}(${u.hit.id}).addLayers`, slots, [S.W / 2, S.H / 2], `${id}.x${k}`));
      });
      if (u.body.bg !== undefined) bg = S.bind(u.body.bg, scope, `${path}.bg`);
    }
    if (entry.layers) {
      children.push(...compileInline(S, () => S.compileLayers(entry.layers, { ...S.base(sec), ...extra }, compCtx, frames, `${path}.layers`, slots, [S.W / 2, S.H / 2], `${id}.o`)));
    }
  }
  if (dir?.overlays?.length) {
    children.push(...S.compileLayers(dir.overlays, { ...S.base(frames / S.fps), ...extra, ...(dir.values ?? {}) }, dir.actx, frames, `direction(${dir.id}).overlays`, new Map(), [S.W / 2, S.H / 2], `${id}.d`));
  }
  if (entry.bg !== undefined) bg = S.bind(entry.bg, S.base(0), `${path}.bg`);
  const group: IRLayer = {
    id,
    type: 'group',
    from: 0,
    to: frames,
    x: S.W / 2,
    y: S.H / 2,
    w: S.W,
    h: S.H,
    anchor: [0.5, 0.5],
    style: typeof bg === 'string' ? { bg } : {},
    overflow: 'hidden',
    anims: [],
    children,
    src_preset: preset,
  };
  const sc: SceneCtx = { index, entry, path, group, frames, scope, actx };
  applyTweaks(S, sc);
  for (const p of scenePasses) p.post?.(S, sc);
  return sc;
}

/**
 * Inline layers of an adapted composition are compiled in the frame they were written for, then
 * mapped into the new frame: one uniform scale (so nothing is distorted) and positions spread
 * around the centre so the layout uses the new frame's long side.
 */
function compileInline(S: Session, run: () => IRLayer[]): IRLayer[] {
  const rt = S.retarget;
  if (!rt) return run();
  const W = S.W;
  const H = S.H;
  const orient = S.orient;
  S.setFormat(rt.W, rt.H, S.fps);
  let out: IRLayer[];
  try {
    out = run();
  } finally {
    S.setFormat(W, H, S.fps);
    S.orient = orient;
  }
  const u = Math.min(W / rt.W, H / rt.H);
  const fx = Math.min(W / rt.W, u * 1.5);
  const fy = Math.min(H / rt.H, u * 1.5);
  const k = Math.min(1.25, u * rt.text);
  const map = (list: IRLayer[]) => {
  for (const l of list) {
    // unsized groups at the origin are just containers: map their children instead
    if (l.type === 'group' && l.w === undefined && l.h === undefined && !l.x && !l.y && !l.scale && l.children?.length) {
      map(l.children);
      continue;
    }
    const covers = (x: IRLayer, d: number): boolean =>
      ((x.w ?? 0) >= rt.W * 0.98 && (x.h ?? 0) >= rt.H * 0.98) || (d < 2 && x.type === 'group' && (x.w === undefined || x.w >= rt.W * 0.98) && !!x.children?.length && x.children.every((c) => covers(c, d + 1)));
    const full = covers(l, 0);
    if (full) {
      // full-frame backgrounds keep covering the frame
      l.x = W / 2 + (l.x - rt.W / 2) * (W / rt.W);
      l.y = H / 2 + (l.y - rt.H / 2) * (H / rt.H);
      l.scale = (l.scale ?? 1) * Math.max(W / rt.W, H / rt.H);
      continue;
    }
    l.x = W / 2 + (l.x - rt.W / 2) * fx;
    l.y = H / 2 + (l.y - rt.H / 2) * fy;
    l.scale = (l.scale ?? 1) * k;
  }
  };
  map(out);
  return out;
}

/**
 * Visual-editor tweaks: {"tweaks": {"<id or name>": {"dx": 20, "dy": -10, "scale": 1.1, "rot": 5, "opacity": 0.8, "shift": 0.2}}}.
 * Keys are a layer name ("title", "form.email") or its id relative to the scene (".1.0").
 */
function applyTweaks(S: Session, sc: SceneCtx) {
  const tw = sc.entry.tweaks;
  if (tw === undefined) return;
  if (!isObj(tw)) return S.err(`${sc.path}.tweaks`, 'tweaks must be {"<layer>": {dx, dy, scale, rot, opacity, shift}}');
  const all: IRLayer[] = [];
  const walk = (l: IRLayer) => {
    all.push(l);
    l.children?.forEach(walk);
  };
  walk(sc.group);
  for (const [key, t] of Object.entries(tw)) {
    if (!isObj(t)) continue;
    const target = all.find((l) => l.name === key || l.id === `${sc.group.id}${key}` || l.id.endsWith(`:${key}`));
    if (!target) {
      S.warn(`${sc.path}.tweaks.${key}`, 'no layer with that name or id in this scene (it may have moved)');
      continue;
    }
    if (t.dx) target.x += Number(t.dx);
    if (t.dy) target.y += Number(t.dy);
    if (target.points && (t.dx || t.dy)) {
      const [a, b, c, d] = target.points;
      target.points = [a + Number(t.dx ?? 0), b + Number(t.dy ?? 0), c + Number(t.dx ?? 0), d + Number(t.dy ?? 0)];
    }
    if (t.scale !== undefined) target.scale = (target.scale ?? 1) * Number(t.scale);
    if (t.rot !== undefined) target.rot = (target.rot ?? 0) + Number(t.rot);
    if (t.opacity !== undefined) target.opacity = Number(t.opacity);
    if (t.size !== undefined && target.type === 'text') target.style.size = Number(t.size);
    if (t.shift) {
      const f = S.frames(Number(t.shift));
      const len = target.to - target.from;
      target.from = Math.max(0, target.from + f);
      target.to = Math.min(target.from + len, sc.frames);
    }
  }
}

/** Returns the overlap (frames) between A and B. */
function applyTransition(
  S: Session,
  t: { entry: Record<string, any>; actx: AliasCtx; path: string },
  A: SceneCtx | null,
  B: SceneCtx | null,
  aStart: number,
  overlays: IRLayer[],
  idx: number,
  markers: IRMarker[],
): number {
  const params: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(t.entry)) if (!['t', 'd', 'note', 'sfx'].includes(k)) params[k] = v;
  const u = S.expand(t.entry.t, params, t.actx, t.path, ['transition']);
  if (!u) return 0;
  const sec = S.durationFor(t.entry.d, u.rule, u.values, 0.5, `${t.path}.d`);
  let tdF = Math.max(1, S.frames(sec));
  const overlap = u.body.overlap !== false && !!A && !!B;
  const maxF = Math.max(1, Math.min(A?.frames ?? Infinity, B?.frames ?? Infinity) - 1);
  if (tdF > maxF) {
    S.warn(`${t.path}.d`, `transition shortened to ${(maxF / S.fps).toFixed(2)}s to fit the neighbouring scenes`);
    tdF = maxF;
  }
  const scope = { ...S.base(tdF / S.fps), ...u.values, d: tdF / S.fps };
  const mk = (part: unknown, s: number, e: number, path: string): IRAnim | null => {
    if (!isObj(part)) return null;
    const tracks = S.normTracks(part.tracks, scope, path, typeof part.ease === 'string' ? part.ease : undefined);
    if (!tracks) return null;
    const a: IRAnim = { s, e, tracks };
    (a as any).n = u.hit.id;
    if (part.clipDir) a.clipDir = part.clipDir as ClipDir;
    return a;
  };
  const half = A && B && !overlap ? Math.round(tdF / 2) : tdF;
  if (A) {
    const a = mk(u.body.out, A.frames - half, A.frames, `${t.path}(${u.hit.id}).out`);
    if (a) A.group.anims.push(a);
  }
  if (B) {
    const b = mk(u.body.in, 0, half, `${t.path}(${u.hit.id}).in`);
    if (b) B.group.anims.push(b);
  }
  const cut = A ? aStart + A.frames : 0;
  const oStart = A && B ? (overlap ? cut - tdF : cut - half) : A ? cut - tdF : 0;
  const oLen = A && B && !overlap ? half * 2 : tdF;
  markers.push({ t: Math.max(0, oStart), kind: 'transition', name: u.hit.id, d: oLen, ...(typeof t.entry.sfx === 'string' ? { sfx: t.entry.sfx } : {}) });
  if (Array.isArray(u.body.overlay) && u.body.overlay.length) {
    const children = S.compileLayers(u.body.overlay, scope, u.bodyCtx, oLen, `${t.path}(${u.hit.id}).overlay`, new Map(), [S.W / 2, S.H / 2], `t${idx}`);
    overlays.push({
      id: `t${idx}`,
      type: 'group',
      from: Math.max(0, oStart),
      to: Math.max(0, oStart) + oLen,
      x: S.W / 2,
      y: S.H / 2,
      w: S.W,
      h: S.H,
      anchor: [0.5, 0.5],
      style: {},
      overflow: 'hidden',
      anims: [],
      children,
      z: 1000,
      src_preset: u.hit.id,
    });
  }
  if (u.body.continuity && hooks.continuity) {
    hooks.continuity(S, { u, A, B, tdF: oLen, aStart: A ? A.frames - (overlap ? tdF : half) : 0, absStart: Math.max(0, oStart), overlap, overlays, idx, path: t.path });
  }
  return overlap ? tdF : 0;
}


function deepMerge(a: any, b: any): any {
  if (!isObj(a) || !isObj(b)) return b;
  const out: any = { ...a };
  for (const k of Object.keys(b)) out[k] = isObj(a[k]) && isObj(b[k]) ? deepMerge(a[k], b[k]) : b[k];
  return out;
}

// ======================================================================
// Preset inspection (for mf_get / registry tools)

export interface PresetInfo {
  id: string;
  ref: string;
  library: string;
  version: string;
  preset: PresetDef;
  params: Record<string, ParamDef>;
  chain: string[];
  body?: Record<string, any>;
  libDepends: Record<string, string>;
}

/** Resolve "alias:slug", "alias:slug@draft", "@scope/name/slug[@range]" to a preset with its effective params. */
export function inspectPreset(ref: string, agent: AgentCtx, opts: CompileOptions): { info?: PresetInfo; errors: Issue[] } {
  const S = new Session(opts, agent, undefined);
  const ctx: AliasCtx = { aliases: new Map() };
  let lookupRef = ref;
  const short = /^([a-z][a-z0-9-]*):([a-z0-9][a-z0-9-]*)(?:@(\S+))?$/.exec(ref);
  if (short) {
    const [, alias, slug, range] = short;
    const candidates = [...opts.store.libs.values()]
      .map((e) => (range === 'draft' ? e.draft : opts.store.latest(e.name)))
      .filter((lv): lv is LibVersion => !!lv && lv.alias === alias && canSee(lv, agent));
    const lib = candidates.find((l) => l.name === '@core/base') ?? candidates.find((l) => l.manifest.visibility !== 'public') ?? candidates[0];
    if (!lib) return { errors: [{ path: ref, msg: `no visible library with alias '${alias}'` }] };
    const resolved = range && range !== 'draft' ? S.resolveLib(lib.name, range, ref) : lib;
    if (!resolved) return { errors: S.errors };
    ctx.aliases.set(alias, resolved);
    lookupRef = `${alias}:${slug}`;
  }
  const core = S.resolveLib('@core/base', undefined, 'core');
  if (core && !ctx.aliases.has('core')) ctx.aliases.set('core', core);
  const hit = S.lookup(lookupRef, ctx, ref);
  if (!hit) return { errors: S.errors };
  const params = S.publicParams(hit);
  const chain = [hit.id];
  let cur: typeof hit | null = hit;
  while (cur && !cur.preset.body && cur.preset.extends) {
    cur = S.lookup(cur.preset.extends, S.libCtx(cur.lib), ref);
    if (cur) chain.push(cur.id);
  }
  const clean: Record<string, ParamDef> = {};
  for (const [k, d] of Object.entries(params)) {
    const { __partial: _p, ...rest } = d as any;
    clean[k] = rest;
  }
  return {
    info: {
      id: hit.id,
      ref: `${hit.lib.name}/${hit.preset.slug}`,
      library: hit.lib.name,
      version: hit.lib.version,
      preset: hit.preset,
      params: clean,
      chain,
      body: cur?.preset.body as Record<string, any> | undefined,
      libDepends: hit.lib.manifest.depends,
    },
    errors: S.errors,
  };
}

const PLACEHOLDER_IMAGE =
  'data:image/svg+xml;utf8,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="900" viewBox="0 0 1600 900"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#2b3a67"/><stop offset="1" stop-color="#b8336a"/></linearGradient></defs><rect width="1600" height="900" fill="url(#g)"/><circle cx="1180" cy="300" r="140" fill="#ffd166" opacity=".9"/><path d="M0 900 L520 420 L860 700 L1120 520 L1600 900Z" fill="#11162b" opacity=".85"/></svg>',
  );

/** A small composition that exercises a preset (used for validation on put, and thumbnails). */
export function exampleComposition(
  p: PresetDef,
  id: string,
  alias: string,
  libName: string,
  version: string,
  effective?: Record<string, ParamDef>,
): Record<string, unknown> {
  const synth: Record<string, unknown> = {};
  for (const [k, d] of Object.entries(effective ?? p.params)) {
    if (!d.required || (d as any).__partial) continue;
    synth[k] =
      d.type === 'number' || d.type === 'integer' || d.type === 'duration'
        ? d.min !== undefined ? Math.max(d.min, 42) : 42
        : d.type === 'boolean'
          ? true
          : d.type === 'enum'
            ? d.values?.[0]
            : d.type === 'array'
              ? d.items === 'object' || d.items === 'any' ? [{ label: 'A', value: 3 }, { label: 'B', value: 5 }, { label: 'C', value: 8 }] : ['First point', 'Second point', 'Third point']
              : d.type === 'color'
                ? '#7c8cff'
                : d.type === 'asset'
                  ? PLACEHOLDER_IMAGE
                  : d.type === 'object'
                    ? {}
                    : 'Sample text';
  }
  const ex: Record<string, any> = { ...synth, ...(p.example ?? {}) };
  delete ex.p;
  delete ex.use;
  delete ex.t;
  const use = libName === '@core/base' ? [] : [`${libName}@${version} as ${alias}`];
  const sample = { type: 'text', text: 'Motion', size: 180, weight: 800, font: '$font.display', color: '$color.fg' };
  switch (p.kind) {
    case 'scene':
    case 'template':
      return { use, scenes: [{ p: id, ...ex }] };
    case 'element':
      return { use, scenes: [{ d: 3, layers: [{ use: 'core:backdrop', style: 'solid' }, { use: id, ...ex }] }] };
    case 'animation':
      return { use, scenes: [{ d: 2, layers: [{ use: 'core:backdrop', style: 'solid' }, { ...sample, in: [{ p: id, ...ex }] }] }] };
    case 'transition': {
      // continuity transitions (morph, expand…) need something to carry across: a "card" in both scenes
      if ((p.body as any)?.continuity)
        return {
          use,
          scenes: [
            { d: 1.5, layers: [{ use: 'core:backdrop', style: 'solid', base: '$color.bg' }, { ...sample, text: 'A', x: 640 }, { type: 'rect', id: 'card', x: 1380, y: 540, w: 420, h: 300, fill: '$color.accent', radius: 28 }] },
            { t: id, ...ex },
            { d: 1.5, layers: [{ use: 'core:backdrop', style: 'solid', base: '$color.bg2' }, { ...sample, text: 'B', color: '$color.accent', x: 1300 }, { type: 'rect', id: 'card', x: 520, y: 540, w: 640, h: 640, fill: '$color.accent2', radius: 40 }] },
          ],
        };
      return {
        use,
        scenes: [
          { d: 1.5, layers: [{ use: 'core:backdrop', style: 'solid', base: '$color.bg' }, { ...sample, text: 'A' }] },
          { t: id, ...ex },
          { d: 1.5, layers: [{ use: 'core:backdrop', style: 'solid', base: '$color.bg2' }, { ...sample, text: 'B', color: '$color.accent' }] },
        ],
      };
    }
    case 'theme':
      return { use, theme: { p: id, ...ex }, scenes: [{ p: 'core:title-card', title: 'Theme', subtitle: id, kicker: 'Preview' }] };
    case 'direction':
      return {
        use,
        direction: { p: id, ...ex },
        scenes: [
          { p: 'core:title-card', title: 'Direction', subtitle: id, kicker: 'Preview' },
          { p: 'core:stat', value: 87, suffix: '%', label: 'of the same content' },
        ],
      };
    case 'choreography': {
      // a small form the choreography can act on (ids: field, button, list, card, target)
      return {
        use,
        scenes: [
          {
            d: 5,
            cursor: { style: 'arrow' },
            layers: [
              { use: 'core:backdrop', style: 'solid' },
              { type: 'rect', id: 'card', x: 960, y: 540, w: 760, h: 520, fill: '$color.surface', radius: 28 },
              {
                type: 'group',
                id: 'field',
                x: 960,
                y: 470,
                w: 560,
                h: 84,
                children: [
                  { type: 'rect', x: 280, y: 42, w: 560, h: 84, fill: '$color.bg', radius: 14 },
                  { type: 'text', x: 26, y: 42, anchor: [0, 0.5], text: 'you@example.com', size: 32, color: '$color.muted' },
                ],
              },
              { type: 'rect', id: 'button', x: 960, y: 620, w: 560, h: 84, fill: '$color.accent', radius: 14 },
              { type: 'text', x: 960, y: 620, text: 'Continue', size: 32, weight: 700, color: '$color.bg' },
            ],
            gestures: [{ p: id, ...ex }],
          },
        ],
      };
    }
  }
  return { use, scenes: [{ p: id }] };
}

/** exampleComposition using the params a preset really exposes (including inherited ones). */
export function presetExample(lv: LibVersion, p: PresetDef, opts: CompileOptions, agent: AgentCtx) {
  const ref = `${lv.name}/${p.slug}@${lv.version === 'draft' ? 'draft' : lv.version}`;
  const { info } = inspectPreset(ref, agent, opts);
  return exampleComposition(p, `${lv.alias}:${p.slug}`, lv.alias, lv.name, lv.version, info?.params);
}
