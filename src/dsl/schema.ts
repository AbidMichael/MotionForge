import { z } from 'zod';
import type { Issue } from '../core/errors';

export const PRESET_KINDS = ['animation', 'element', 'scene', 'transition', 'theme', 'template', 'direction', 'choreography'] as const;
export type PresetKind = (typeof PRESET_KINDS)[number];

export const PARAM_TYPES = [
  'string', 'number', 'integer', 'boolean', 'color', 'enum', 'asset', 'array', 'object', 'duration', 'preset', 'any',
] as const;
export type ParamType = (typeof PARAM_TYPES)[number];

export interface ParamDef {
  type: ParamType;
  required?: boolean;
  default?: unknown;
  min?: number;
  max?: number;
  values?: string[];
  items?: ParamType;
  kind?: PresetKind;
  desc?: string;
}

const ParamDefObj = z
  .object({
    type: z.enum(PARAM_TYPES),
    required: z.boolean().optional(),
    default: z.unknown().optional(),
    min: z.number().optional(),
    max: z.number().optional(),
    values: z.array(z.string()).optional(),
    items: z.enum(PARAM_TYPES).optional(),
    kind: z.enum(PRESET_KINDS).optional(),
    desc: z.string().max(200).optional(),
  })
  .strict();

/**
 * Param shorthand (saves tokens when agents write presets):
 *   "string!"            required string
 *   "number=0.5"         number with default
 *   "enum:left|right=left"
 *   "array<string>"      array of strings
 *   "preset:animation=core:fade-up"
 */
export function parseParamShorthand(s: string): ParamDef | string {
  const m = /^([a-z]+)(?::([^=!<]+))?(?:<([a-z]+)>)?(!)?(?:=(.*))?$/s.exec(s.replace(/^\s+/, ''));
  if (!m) return `cannot parse param shorthand '${s}'`;
  const [, type, arg, items, req, def] = m;
  if (!(PARAM_TYPES as readonly string[]).includes(type)) return `unknown param type '${type}' (use ${PARAM_TYPES.join(', ')})`;
  const out: ParamDef = { type: type as ParamType };
  if (req) out.required = true;
  if (type === 'enum') {
    if (!arg) return `enum needs values: "enum:a|b|c"`;
    out.values = arg.split('|').map((v) => v.trim());
  }
  if (type === 'preset' && arg) out.kind = arg.trim() as PresetKind;
  if (items) out.items = items as ParamType;
  if (def !== undefined) {
    if (type === 'number' || type === 'integer' || type === 'duration') {
      const n = Number(def);
      if (Number.isNaN(n)) return `default '${def}' is not a number`;
      out.default = n;
    } else if (type === 'boolean') out.default = def === 'true';
    else if (type === 'array' || type === 'object' || type === 'any') {
      try {
        out.default = JSON.parse(def);
      } catch {
        return `default for ${type} must be JSON`;
      }
    } else out.default = def;
  }
  return out;
}

export function normalizeParams(raw: unknown, path: string, issues: Issue[]): Record<string, ParamDef> {
  const out: Record<string, ParamDef> = {};
  if (raw == null) return out;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    issues.push({ path, msg: 'params must be an object' });
    return out;
  }
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(k)) {
      issues.push({ path: `${path}.${k}`, msg: 'param names must be identifiers (letters, digits, _)' });
      continue;
    }
    if (typeof v === 'string') {
      const p = parseParamShorthand(v);
      if (typeof p === 'string') issues.push({ path: `${path}.${k}`, msg: p });
      else out[k] = p;
      continue;
    }
    // Partial override (e.g. only a new default) is allowed for presets that extend another.
    if (v && typeof v === 'object' && !('type' in (v as object))) {
      out[k] = { ...(v as object), type: 'any', __partial: true } as ParamDef;
      continue;
    }
    const r = ParamDefObj.safeParse(v);
    if (!r.success) {
      for (const e of r.error.issues) issues.push({ path: `${path}.${k}${e.path.length ? '.' + e.path.join('.') : ''}`, msg: e.message });
      continue;
    }
    out[k] = r.data as ParamDef;
  }
  return out;
}

export const DurationRule = z
  .object({
    default: z.number().positive().optional(),
    min: z.number().positive().optional(),
    max: z.number().positive().optional(),
    perWord: z.number().nonnegative().optional(),
    wordsFrom: z.string().optional(),
  })
  .strict();
export type DurationRule = z.infer<typeof DurationRule>;

export const PresetFile = z
  .object({
    slug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/, 'lowercase letters, digits and dashes'),
    kind: z.enum(PRESET_KINDS),
    summary: z.string().min(3).max(200),
    tags: z.array(z.string().max(32)).max(16).default([]),
    params: z.unknown().optional(),
    duration: DurationRule.optional(),
    extends: z.string().optional(),
    bind: z.record(z.unknown()).optional(),
    addLayers: z.array(z.unknown()).optional(),
    slots: z.array(z.string()).optional(),
    example: z.record(z.unknown()).optional(),
    deprecated: z.object({ successor: z.string().optional(), reason: z.string().optional() }).optional(),
    promotedFrom: z.string().optional(),
    /** Audio cue points (seconds from the preset start) for SFX in v1.1, e.g. [{"at":0.32,"name":"impact"}]. */
    cues: z.array(z.object({ at: z.union([z.number(), z.string()]), name: z.string().max(40) })).max(20).optional(),
    body: z.record(z.unknown()).optional(),
  })
  .strict();
export type PresetFileT = z.infer<typeof PresetFile>;

export interface PresetDef extends Omit<PresetFileT, 'params'> {
  params: Record<string, ParamDef>;
}

export const LIB_NAME_RE = /^@[a-z0-9][a-z0-9-]{0,39}\/[a-z0-9][a-z0-9-]{0,39}$/;

export const LibraryManifest = z
  .object({
    name: z.string().regex(LIB_NAME_RE, 'library names look like @scope/name (lowercase)'),
    alias: z.string().regex(/^[a-z][a-z0-9-]{0,23}$/).optional(),
    version: z.string(),
    summary: z.string().min(3).max(300),
    guide: z.string().max(2400).optional(),
    depends: z.record(z.string()).default({}),
    visibility: z.string().regex(/^(private|public|project:[a-z0-9-]+)$/).default('private'),
    owner: z.string().optional(),
    tags: z.array(z.string()).optional(),
    publishedAt: z.string().optional(),
  })
  .strict();
export type LibraryManifestT = z.infer<typeof LibraryManifest>;

export const zodIssues = (err: z.ZodError, prefix = ''): Issue[] =>
  err.issues.map((e) => ({ path: [prefix, ...e.path.map(String)].filter(Boolean).join('.'), msg: e.message }));

/** Reserved keys on a layer node. Everything else is style (primitives) or params (element `use`). */
export const LAYER_KEYS = new Set([
  'id', 'type', 'use', 'if', 'x', 'y', 'w', 'h', 'anchor', 'at', 'dur', 'until', 'in', 'out', 'anim', 'loop', 'z',
  'opacity', 'rot', 'scale', 'blend', 'style', 'text', 'split', 'stagger', 'counter', 'src', 'svg', 'd', 'viewBox',
  'x2', 'y2', 'children', 'layout', 'overflow', 'clipDir', 'slot', 'repeat', 'each', 'as', 'layer', 'note', 'slots',
  'keys', 'maxLines', 'minSize', 'mask', 'sfx', 'beat', 'motionPath', 'textStyle',
]);

/** Keys on an element usage ({"use": …}) that place/time the element; every other key is a param. */
export const ELEMENT_KEYS = new Set([
  'id', 'use', 'if', 'x', 'y', 'w', 'h', 'anchor', 'at', 'dur', 'until', 'in', 'out', 'anim', 'loop', 'z', 'opacity',
  'rot', 'scale', 'blend', 'slots', 'note', 'clipDir', 'keys', 'sfx', 'beat', 'mask', 'motionPath',
]);

/** Names presets may not use for params (they would collide with placement/timing keys). */
export const RESERVED_PARAM_NAMES = new Set([...ELEMENT_KEYS, 'p', 'd', 't', 'preset', 'duration', 'transition', 'layers', 'bg']);

/** Reserved keys on a scene entry in a composition. Everything else is a preset param. */
export const SCENE_KEYS = new Set([
  'p', 'preset', 'd', 'duration', 'id', 'bg', 'layers', 'slots', 'note', 't', 'transition',
  'intent', 'gestures', 'tweaks', 'cursor', 'sfx', 'if',
]);
