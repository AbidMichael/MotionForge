/**
 * Accessible 3D: {"type":"three", "w", "h", "objects":[…], "lights":[…], "camera":{…}}
 *  object: {"id":"phone", "shape":"box|roundedBox|sphere|cylinder|cone|torus|knot|plane|capsule|ring|card|device|image",
 *           "size":[w,h,d] | radius, "position":[x,y,z], "rotation":[deg,deg,deg], "scale":1 | [x,y,z],
 *           "material": "glass|metal|matte|plastic|emissive|toon|wire" | {"type", "color", "metalness", "roughness",
 *                        "emissive", "opacity", "map":"asset:<id>", "transmission", "clearcoat"},
 *           "image":"asset:<id>" (screen of a "device"/"card", or texture), "keys":{"position":[[0,[0,0,0]],[1.5,[0,1,0],"outCubic"]], "rotation", "scale", "opacity"},
 *           "alpha":"auto"|true|false (transparent images: no slab behind, shadow shaped by the image; auto = detect),
 *           "alphaTest":0.5 (alpha cut for shadows), "shape":"image" = a cut-out plane sized to the image ratio (size: height),
 *           "spin":[0,30,0] (degrees per second), "float": 0.1 (bobbing), "explode":[0,0,1] (offset for exploded views), "children":[…]}
 *  lights: [{"type":"ambient|directional|point|spot|hemisphere", "color", "intensity", "position", "target", "castShadow"}]
 *          or a preset: "studio" | "soft" | "dramatic" | "neon"
 *  camera: {"fov":35, "position":[0,1,6], "target":[0,0,0], "keys":{"position":…, "target":…, "fov":…},
 *           "orbit":{"speed":20, "radius":6, "height":1.2, "from":0}, "dolly":{"from":[…], "to":[…]}, "shake":0}
 *  "stack": {"items":[{"color","image","label"}…] | 4, "shape":"roundedBox|card|device…", "size", "step":[0,0.3,0], "explode":[0,0.8,0]},
 *  "explode": {"at":1, "d":1.4, "amount":1.2, "ease":"inOutCubic"}, "ground": true | {"color", "y", "shadow":true},
 *  "fog": ["#000", 6, 18], "bg": "transparent" | colour, "shadows": true, "environment": 0.6 (reflections; false = off)
 */
import { isObj } from '../../core/util';
import type { IRLayer } from '../../ir/types';
import type { Session } from '../compile';
import { lookupToken } from '../bind';
import { layerHandlers, registerLayer } from '../registry';
import { palette } from './data';

type V3 = [number, number, number];
export type VKey = [number, number[], string?];

export interface Obj3D {
  id: string;
  shape: string;
  size: number[];
  position: V3;
  rotation: V3;
  scale: V3;
  material: Record<string, any>;
  image?: string;
  /** Transparency of the image: 'auto' detects it from the pixels. */
  alpha?: 'auto' | boolean;
  alphaTest?: number;
  keys: Record<string, VKey[]>;
  spin?: V3;
  float?: number;
  explode?: V3;
  children: Obj3D[];
  text?: string;
  /** shape "model": an imported glTF/GLB/FBX/OBJ. */
  model?: ModelSpec;
  /** Exploded view of a model's parts: distance (× model size) each part moves away from the centre at "explode" time. */
  explodeParts?: number;
  /** Particle effect built from this object's surface (sand, dust…). */
  effect?: EffectSpec;
  castShadow?: boolean;
}

export interface PartSpec {
  visible?: boolean;
  position?: V3;
  rotation?: V3;
  scale?: V3;
  keys?: Record<string, VKey[]>;
  material?: Record<string, any>;
}

export interface ModelSpec {
  src: string;
  ext: string;
  /** Largest dimension after normalisation (scene units); null = keep the file's units. */
  fit: number | null;
  center: 'center' | 'base' | 'none';
  animation?: { name?: string; index?: number; speed: number; offset: number; loop: boolean };
  materials?: Record<string, Record<string, any>>;
  parts?: Record<string, PartSpec>;
  /** Convert Phong/Lambert materials (FBX, OBJ) to physically based ones. */
  pbr: boolean;
}

export type EffectKind = 'disintegrate' | 'assemble' | 'vortex' | 'scatter' | 'morph' | 'pile';
export interface EffectSpec {
  kind: EffectKind;
  count: number;
  at: number;
  d: number;
  sweep: V3;
  wind: V3;
  turbulence: number;
  gravity: number;
  /** Grain size in scene units. */
  grain: number;
  floor: number | null;
  /** "texture": colours sampled from the model; or one colour. */
  color: string;
  render: 'points' | 'grains';
  seed: number;
  /** Fraction of the duration over which grains leave (the rest is travel). */
  spread: number;
  /** Hide the solid object as the grains leave (disintegrate) or appear (assemble). */
  dissolve: boolean;
  /** morph: the object the grains fly to. */
  target?: Obj3D;
  /** vortex: axis and turns. */
  axis: V3;
  turns: number;
  emissive: number;
  /** Fade grains out at the end (no floor). */
  fade: boolean;
}

export interface PostSpec {
  bloom?: { strength: number; radius: number; threshold: number };
  ao?: { radius: number; intensity: number };
  dof?: { focus: number; aperture: number; maxblur: number; keys?: VKey[] };
  vignette?: number;
  grain?: number;
  chromatic?: number;
}

export interface ThreeIR {
  w: number;
  h: number;
  objects: Obj3D[];
  lights: Record<string, any>[];
  camera: { fov: number; position: V3; target: V3; keys: Record<string, VKey[]>; orbit?: { speed: number; radius: number; height: number; from: number }; shake: number };
  explode?: { at: number; d: number; amount: number; ease: string };
  ground?: { color: string; y: number; shadow: boolean; opacity: number };
  fog?: [string, number, number];
  bg: string | null;
  shadows: boolean;
  /** Environment (reflections) intensity; 0 = off. */
  env: number;
  /** Image-based lighting from an HDR/EXR (equirectangular). */
  envMap?: { src: string; ext: string; rotation: number; background: boolean; blur: number };
  toneMapping: 'aces' | 'agx' | 'neutral' | 'none';
  exposure: number;
  shadowMap: 'soft' | 'vsm' | 'basic';
  /** Soft contact shadow under the objects (product shots). */
  contact?: { opacity: number; blur: number; far: number; y: number; size: number; color: string };
  post?: PostSpec;
  motionBlur?: { samples: number; shutter: number };
  /** auto: draft in previews/draft renders, final otherwise; pathtrace: GPU path tracing (hero shots). */
  quality: 'auto' | 'draft' | 'final' | 'pathtrace';
  samples: number;
}

const LIGHT_PRESETS: Record<string, Record<string, any>[]> = {
  studio: [
    { type: 'ambient', intensity: 0.35 },
    { type: 'directional', position: [4, 6, 5], intensity: 2.2, castShadow: true },
    { type: 'directional', position: [-5, 2, -3], intensity: 0.8, color: '#9db7ff' },
    { type: 'point', position: [0, 3, -4], intensity: 6, color: '#ffffff' },
  ],
  soft: [
    { type: 'hemisphere', intensity: 1.1, color: '#ffffff', ground: '#444455' },
    { type: 'directional', position: [3, 5, 4], intensity: 1.2, castShadow: true },
  ],
  dramatic: [
    { type: 'ambient', intensity: 0.08 },
    { type: 'spot', position: [3, 6, 3], intensity: 120, angle: 32, penumbra: 0.6, castShadow: true },
    { type: 'point', position: [-4, 1, -2], intensity: 12, color: '#4f8cff' },
  ],
  neon: [
    { type: 'ambient', intensity: 0.15 },
    { type: 'point', position: [-3, 2, 3], intensity: 30, color: '#ff2bd6' },
    { type: 'point', position: [3, 2, 3], intensity: 30, color: '#2bd9ff' },
    { type: 'directional', position: [0, 5, 2], intensity: 0.5 },
  ],
};

const MATERIALS: Record<string, Record<string, any>> = {
  glass: { type: 'physical', transmission: 0.95, roughness: 0.05, thickness: 0.6, ior: 1.45, metalness: 0, opacity: 1, transparent: true, clearcoat: 1 },
  metal: { type: 'standard', metalness: 0.95, roughness: 0.22 },
  matte: { type: 'standard', metalness: 0, roughness: 0.9 },
  plastic: { type: 'physical', metalness: 0, roughness: 0.35, clearcoat: 0.6 },
  emissive: { type: 'standard', emissiveIntensity: 1.6 },
  toon: { type: 'toon' },
  wire: { type: 'basic', wireframe: true },
};

const SHAPES = ['box', 'roundedBox', 'sphere', 'cylinder', 'cone', 'torus', 'knot', 'plane', 'capsule', 'ring', 'card', 'device', 'image', 'model', 'group', 'icosahedron', 'octahedron'];
const EFFECTS: EffectKind[] = ['disintegrate', 'assemble', 'vortex', 'scatter', 'morph', 'pile'];
const TONE = ['aces', 'agx', 'neutral', 'none'];

/** Resolve a model asset: URL for the player + file format. */
function modelSrc(S: Session, v: unknown, path: string): { src: string; ext: string; info: any | null } | null {
  if (typeof v !== 'string' || !v) {
    S.err(path, 'a model needs "src": "asset:<id>" (a .glb/.gltf/.fbx/.obj, or a .zip of a model with its textures)');
    return null;
  }
  const url = S.assetSrc(v, path);
  if (!url) return null;
  const m = /^asset:([a-f0-9]{8,64})$/.exec(v);
  if (m) {
    const mi = S.opts.modelInfo?.(m[1]);
    if (S.opts.modelInfo && !mi) {
      S.err(path, `${v} is not a 3D model (glb, gltf, fbx, obj, or a zip holding one)`);
      return null;
    }
    return { src: url, ext: mi?.ext ?? 'glb', info: mi?.info ?? null };
  }
  const ext = /\.(glb|gltf|fbx|obj)(\?|#|$)/i.exec(url)?.[1]?.toLowerCase();
  if (!ext) S.err(path, 'model URL must end with .glb, .gltf, .fbx or .obj');
  return { src: url, ext: ext ?? 'glb', info: null };
}

function partSpecs(S: Session, raw: unknown, path: string, info: any | null): Record<string, PartSpec> | undefined {
  if (raw === undefined) return undefined;
  if (!isObj(raw)) {
    S.err(path, 'parts is {"<node name>": {"visible", "position", "rotation", "scale", "keys", "material"}}');
    return undefined;
  }
  const out: Record<string, PartSpec> = {};
  for (const [name, p] of Object.entries(raw)) {
    const pp = `${path}.${name}`;
    if (info?.parts && !info.parts.includes(name)) S.warn(pp, `no part named "${name}" in the model (parts: ${info.parts.slice(0, 12).join(', ')}${info.parts.length > 12 ? '…' : ''})`);
    if (!isObj(p)) {
      S.err(pp, 'a part override is an object');
      continue;
    }
    const keys: Record<string, VKey[]> = {};
    if (isObj(p.keys))
      for (const [k, kr] of Object.entries(p.keys)) {
        if (!['position', 'rotation', 'scale'].includes(k)) {
          S.err(`${pp}.keys.${k}`, 'part keys: position, rotation, scale (offsets added to the part)');
          continue;
        }
        const ks = vkeys(S, kr, `${pp}.keys.${k}`, 3);
        if (ks) keys[k] = ks;
      }
    out[name] = {
      visible: p.visible === undefined ? undefined : !!p.visible,
      position: p.position !== undefined ? vec(p.position, [0, 0, 0]) : undefined,
      rotation: p.rotation !== undefined ? vec(p.rotation, [0, 0, 0]) : undefined,
      scale: p.scale !== undefined ? vec(p.scale, [1, 1, 1]) : undefined,
      keys: Object.keys(keys).length ? keys : undefined,
      material: p.material !== undefined ? material(S, p.material, '#ffffff', `${pp}.material`) : undefined,
    };
  }
  return out;
}

function modelSpec(S: Session, o: Record<string, any>, path: string): ModelSpec | null {
  const r = modelSrc(S, o.src, `${path}.src`);
  if (!r) return null;
  let animation: ModelSpec['animation'];
  if (o.animation !== undefined && o.animation !== false && o.animation !== null) {
    const a = typeof o.animation === 'string' || typeof o.animation === 'number' ? { name: o.animation } : isObj(o.animation) ? o.animation : {};
    const named = typeof a.name === 'string' ? a.name : undefined;
    const index = typeof a.name === 'number' ? a.name : typeof a.index === 'number' ? a.index : undefined;
    const anims: { name: string }[] = r.info?.animations ?? [];
    if (named && r.info && !anims.some((x) => x.name === named)) S.err(`${path}.animation`, `no animation "${named}" in the model (${anims.map((x) => x.name).join(', ') || 'it has none'})`);
    animation = { name: named, index: index ?? (named ? undefined : 0), speed: Number(a.speed ?? 1), offset: Number(a.offset ?? a.start ?? 0), loop: a.loop !== false };
  }
  let materials: ModelSpec['materials'];
  if (isObj(o.materials)) {
    materials = {};
    for (const [name, m] of Object.entries(o.materials)) materials[name] = material(S, m, '#ffffff', `${path}.materials.${name}`);
  }
  if (r.info?.missing?.length) S.warn(`${path}.src`, `the model references missing textures: ${r.info.missing.slice(0, 4).join(', ')} — upload a .zip with the model and its textures`);
  return {
    src: r.src,
    ext: r.ext,
    fit: o.fit === false || o.fit === null ? null : Number(o.fit ?? 2),
    center: o.center === false ? 'none' : o.center === 'base' ? 'base' : o.center === 'none' ? 'none' : 'center',
    animation,
    materials,
    parts: partSpecs(S, o.parts, `${path}.parts`, r.info),
    pbr: o.pbr !== false,
  };
}

function effectSpec(S: Session, raw: unknown, path: string, pal: string[], idx: { n: number }): EffectSpec | undefined {
  if (raw === undefined || raw === null || raw === false) return undefined;
  const e = typeof raw === 'string' ? { kind: raw } : isObj(raw) ? raw : null;
  if (!e || !EFFECTS.includes(e.kind as EffectKind)) {
    S.err(path, `effect is {"kind": ${EFFECTS.join('|')}, "count", "at", "d", "sweep", "wind", "turbulence", "gravity", "grain", "floor"}`);
    return undefined;
  }
  const kind = e.kind as EffectKind;
  const count = Math.round(Number(e.count ?? (kind === 'pile' ? 60000 : 300000)));
  const max = kind === 'pile' ? 400000 : 20000000;
  if (!(count > 0) || count > max) S.err(`${path}.count`, `count must be 1–${max.toLocaleString('en')}${kind === 'pile' ? ' for a simulated pile' : ''}`);
  let target: Obj3D | undefined;
  if (kind === 'morph') {
    if (!isObj(e.target)) S.err(`${path}.target`, 'morph needs "target": an object (e.g. {"shape":"model","src":"asset:…"} or {"shape":"torus"})');
    else target = object(S, e.target, `${path}.target`, pal, idx) ?? undefined;
  }
  return {
    kind,
    count: Math.min(max, Math.max(1, count || 1)),
    at: S.frames(Number(e.at ?? 0.5)),
    d: Math.max(1, S.frames(Number(e.d ?? 2.5))),
    sweep: vec(e.sweep, [1, 0.25, 0]),
    wind: vec(e.wind, kind === 'pile' || kind === 'vortex' || kind === 'morph' ? [0, 0, 0] : [1.6, 0.6, 0]),
    turbulence: Number(e.turbulence ?? (kind === 'vortex' ? 0.15 : 0.6)),
    gravity: Number(e.gravity ?? (kind === 'pile' ? 9.8 : kind === 'vortex' || kind === 'morph' ? 0 : 0.4)),
    grain: Number(e.grain ?? 0.012),
    floor: e.floor === undefined || e.floor === false || e.floor === null ? (kind === 'pile' ? -1 : null) : e.floor === true ? -1 : Number(e.floor),
    color: typeof e.color === 'string' ? e.color : 'texture',
    render: e.render === 'grains' ? 'grains' : 'points',
    seed: Number(e.seed ?? 1),
    spread: Math.min(0.95, Math.max(0, Number(e.spread ?? 0.6))),
    dissolve: e.dissolve !== false,
    target,
    axis: vec(e.axis, [0, 1, 0]),
    turns: Number(e.turns ?? 1.5),
    emissive: Number(e.emissive ?? 0),
    fade: e.fade !== undefined ? !!e.fade : kind !== 'assemble' && kind !== 'morph' && kind !== 'pile',
  };
}

/** Warn when an object (at rest, static camera) is outside the camera view or far too small. */
function viewCheck(S: Session, ir: ThreeIR, path: string) {
  const cam = ir.camera;
  if (cam.orbit || Object.keys(cam.keys).length) return; // moving camera: judged on frames, not here
  const sub = (a: number[], b: number[]) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const cross = (a: number[], b: number[]) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const norm = (a: number[]) => {
    const l = Math.hypot(a[0], a[1], a[2]) || 1;
    return a.map((v) => v / l);
  };
  const fwd = norm(sub(cam.target, cam.position));
  const right = norm(cross(fwd, [0, 1, 0]));
  const up = cross(right, fwd);
  const tanY = Math.tan((cam.fov * Math.PI) / 360);
  const tanX = tanY * (ir.w / Math.max(1, ir.h));
  ir.objects.forEach((o, i) => {
    if (Object.keys(o.keys).length || o.shape === 'group') return;
    const r = o.model ? (o.model.fit ?? 1) / 2 : Math.max(0.2, ...o.size.slice(0, 3).map((v) => Math.abs(v))) * (o.shape === 'sphere' ? 1 : 0.6);
    const radius = r * Math.max(...o.scale);
    const d = sub(o.position, cam.position);
    const z = dot(d, fwd);
    const label = `${path}[${i}] (${o.id})`;
    if (z <= radius) {
      S.warn(label, 'the object is behind or around the camera: it will not be visible');
      return;
    }
    const x = dot(d, right) / (z * tanX);
    const y = dot(d, up) / (z * tanY);
    const rx = radius / (z * tanX);
    const ry = radius / (z * tanY);
    if (Math.abs(x) - rx > 1 || Math.abs(y) - ry > 1) S.warn(label, `the object is outside the camera view (screen position ${x.toFixed(2)}, ${y.toFixed(2)} in -1…1): move it or the camera`);
    else if (Math.max(rx, ry) < 0.02) S.warn(label, 'the object is tiny in the frame (under 2% of the view): bring it or the camera closer');
  });
}

function postSpec(S: Session, raw: unknown, path: string): PostSpec | undefined {
  if (raw === undefined || raw === false || raw === null) return undefined;
  if (!isObj(raw)) {
    S.err(path, 'post is {"bloom", "ao", "dof", "vignette", "grain", "chromatic"}');
    return undefined;
  }
  const out: PostSpec = {};
  const b = raw.bloom;
  if (b) out.bloom = { strength: Number(isObj(b) ? b.strength ?? 0.6 : typeof b === 'number' ? b : 0.6), radius: Number(isObj(b) ? b.radius ?? 0.4 : 0.4), threshold: Number(isObj(b) ? b.threshold ?? 0.85 : 0.85) };
  const a = raw.ao;
  if (a) out.ao = { radius: Number(isObj(a) ? a.radius ?? 0.25 : 0.25), intensity: Number(isObj(a) ? a.intensity ?? 1 : typeof a === 'number' ? a : 1) };
  const d = raw.dof;
  if (d) {
    const dd = isObj(d) ? d : {};
    out.dof = { focus: Number(dd.focus ?? 6), aperture: Number(dd.aperture ?? 0.6), maxblur: Number(dd.maxblur ?? 0.01) };
    if (dd.keys !== undefined) out.dof.keys = vkeys(S, dd.keys, `${path}.dof.keys`, 1) ?? undefined;
  }
  for (const k of ['vignette', 'grain', 'chromatic'] as const) if (raw[k] !== undefined && raw[k] !== false) out[k] = raw[k] === true ? (k === 'vignette' ? 0.4 : k === 'grain' ? 0.06 : 0.002) : Number(raw[k]);
  for (const k of Object.keys(raw)) if (!['bloom', 'ao', 'dof', 'vignette', 'grain', 'chromatic'].includes(k)) S.warn(`${path}.${k}`, 'unknown post effect (bloom, ao, dof, vignette, grain, chromatic)');
  return out;
}

function vec(v: unknown, d: V3): V3 {
  if (typeof v === 'number') return [v, v, v];
  if (Array.isArray(v) && v.length >= 3) return [Number(v[0]), Number(v[1]), Number(v[2])];
  if (Array.isArray(v) && v.length === 2) return [Number(v[0]), Number(v[1]), d[2]];
  return d;
}

function vkeys(S: Session, raw: unknown, path: string, dims: number): VKey[] | null {
  if (!Array.isArray(raw) || !raw.length) {
    S.err(path, 'keys are [[seconds, value], [seconds, value, "ease"], …]');
    return null;
  }
  const out: VKey[] = [];
  for (const [i, k] of raw.entries()) {
    if (!Array.isArray(k) || k.length < 2) {
      S.err(`${path}[${i}]`, 'a key is [seconds, value] or [seconds, value, "ease"]');
      return null;
    }
    const v = Array.isArray(k[1]) ? k[1].map(Number) : dims === 1 ? [Number(k[1])] : vec(k[1], [0, 0, 0]);
    out.push([S.frames(Number(k[0])), v, typeof k[2] === 'string' ? k[2] : undefined]);
  }
  return out.sort((a, b) => a[0] - b[0]);
}

function resolveImage(S: Session, v: unknown, path: string): string | undefined {
  if (v === undefined || v === '' || v === null) return undefined;
  const src = S.assetSrc(v, path);
  return src ?? undefined;
}

function material(S: Session, v: unknown, color: string, path: string): Record<string, any> {
  let m: Record<string, any> = { type: 'standard', color, metalness: 0.1, roughness: 0.45 };
  if (typeof v === 'string') {
    if (!MATERIALS[v]) S.err(path, `material is one of ${Object.keys(MATERIALS).join(', ')} or {"type", "color", …}`);
    else m = { ...m, ...MATERIALS[v] };
  } else if (isObj(v)) {
    const base = typeof v.preset === 'string' && MATERIALS[v.preset] ? MATERIALS[v.preset] : {};
    m = { ...m, ...base, ...v };
    if (typeof m.map === 'string') m.map = resolveImage(S, m.map, `${path}.map`);
  }
  if (m.color === undefined) m.color = color;
  if (m.emissive === undefined && m.emissiveIntensity) m.emissive = m.color;
  return m;
}

function alphaOpt(S: Session, v: unknown, path: string): 'auto' | boolean | undefined {
  if (v === undefined || v === null || v === 'auto') return undefined;
  if (typeof v === 'boolean') return v;
  S.err(path, 'alpha is "auto", true or false');
  return undefined;
}

function object(S: Session, o: unknown, path: string, pal: string[], idx: { n: number }): Obj3D | null {
  if (!isObj(o)) {
    S.err(path, 'an object is {"shape", "size", "position", "rotation", "material", …}');
    return null;
  }
  const shape = String(o.shape ?? (o.children ? 'group' : 'box'));
  if (!SHAPES.includes(shape)) {
    S.err(`${path}.shape`, `shape is one of ${SHAPES.join(', ')}`);
    return null;
  }
  if (shape === 'image' && (o.image === undefined || o.image === null || o.image === '')) S.err(`${path}.image`, 'shape "image" needs "image":"asset:<id>"');
  const model = shape === 'model' ? modelSpec(S, o, path) : undefined;
  if (shape === 'model' && !model) return null;
  const i = idx.n++;
  const color = String(o.color ?? pal[i % pal.length]);
  const size = Array.isArray(o.size) ? o.size.map(Number) : typeof o.size === 'number' ? [o.size] : [];
  const keys: Record<string, VKey[]> = {};
  if (isObj(o.keys))
    for (const [k, raw] of Object.entries(o.keys)) {
      if (!['position', 'rotation', 'scale', 'opacity'].includes(k)) {
        S.err(`${path}.keys.${k}`, 'animatable: position, rotation, scale, opacity');
        continue;
      }
      const ks = vkeys(S, raw, `${path}.keys.${k}`, k === 'opacity' ? 1 : 3);
      if (ks) keys[k] = k === 'scale' ? ks.map(([f, v, e]) => [f, v.length === 1 ? [v[0], v[0], v[0]] : v, e] as VKey) : ks;
    }
  const children: Obj3D[] = [];
  (Array.isArray(o.children) ? o.children : []).forEach((c: unknown, k: number) => {
    const ch = object(S, c, `${path}.children[${k}]`, pal, idx);
    if (ch) children.push(ch);
  });
  return {
    id: String(o.id ?? `o${i}`),
    shape,
    size,
    position: vec(o.position, [0, 0, 0]),
    rotation: vec(o.rotation, [0, 0, 0]),
    scale: vec(o.scale, [1, 1, 1]),
    material: material(S, o.material, color, `${path}.material`),
    image: resolveImage(S, o.image, `${path}.image`),
    alpha: alphaOpt(S, o.alpha, `${path}.alpha`),
    alphaTest: o.alphaTest !== undefined ? Math.min(1, Math.max(0, Number(o.alphaTest))) : undefined,
    keys,
    spin: o.spin !== undefined ? vec(o.spin, [0, 0, 0]) : undefined,
    float: o.float !== undefined ? Number(o.float) : undefined,
    explode: o.explode !== undefined ? vec(o.explode, [0, 0, 0]) : undefined,
    children,
    text: o.text !== undefined ? String(o.text) : undefined,
    model: model ?? undefined,
    explodeParts: o.explodeParts !== undefined ? Number(o.explodeParts) : undefined,
    effect: effectSpec(S, o.effect, `${path}.effect`, pal, idx),
    castShadow: o.castShadow === false ? false : undefined,
  };
}

registerLayer('three', {
  keys: ['objects', 'stack', 'lights', 'camera', 'explode', 'ground', 'fog', 'bg', 'shadows', 'colors', 'environment', 'toneMapping', 'exposure', 'contactShadow', 'post', 'motionBlur', 'quality', 'samples', 'cache'],
  compile(S, c) {
    const n = c.node;
    // "cache": true — render the 3D shot once to a transparent video (sub-composition cache) and reuse it
    if (n.cache && S.depthLevel < 3) {
      const W = Math.round(Number(c.base.w ?? S.W) / 2) * 2;
      const H = Math.round(Number(c.base.h ?? S.H) / 2) * 2;
      const { cache: _c, x: _x, y: _y, at: _at, dur: _dur, until: _u, in: _in, out: _out, anim: _an, loop: _lp, id: _id, ...inner } = c.raw as Record<string, any>;
      void [_c, _x, _y, _at, _dur, _u, _in, _out, _an, _lp, _id];
      const compNode = {
        type: 'comp',
        cache: true,
        src: { format: `${W}x${H}@${S.fps}`, bg: 'transparent', scenes: [{ d: +c.lenSec.toFixed(3), layers: [{ ...inner, type: 'three', x: W / 2, y: H / 2, w: W, h: H }] }] },
      };
      return layerHandlers.get('comp')!.compile(S, { ...c, node: { ...compNode }, raw: compNode });
    }
    const w = Number(c.base.w ?? S.W);
    const h = Number(c.base.h ?? S.H);
    const pal = palette(S, n);
    const idx = { n: 0 };
    const objects: Obj3D[] = [];
    (Array.isArray(n.objects) ? n.objects : []).forEach((o: unknown, i: number) => {
      const ob = object(S, o, `${c.path}.objects[${i}]`, pal, idx);
      if (ob) objects.push(ob);
    });
    // "stack": a row/pile of similar objects built from data (exploded views, card decks, depth layers)
    if (n.stack !== undefined) {
      const st = isObj(n.stack) ? n.stack : {};
      const items: any[] = Array.isArray(st.items) ? st.items : typeof st.items === 'number' ? Array.from({ length: st.items }, () => ({})) : [];
      if (!items.length) S.err(`${c.path}.stack.items`, 'stack needs "items": an array (of {color, image, label…}) or a count');
      const step = vec(st.step, [0, 0.3, 0]);
      const ex = vec(st.explode, [0, 0, 0]);
      const origin = vec(st.position, [0, 0, 0]);
      items.forEach((it: any, i: number) => {
        const k = i - (items.length - 1) / 2;
        const o = object(
          S,
          {
            shape: st.shape ?? 'roundedBox',
            size: it?.size ?? st.size ?? [2, 0.16, 1.4, 0.06],
            position: [origin[0] + step[0] * k, origin[1] + step[1] * k, origin[2] + step[2] * k],
            rotation: it?.rotation ?? st.rotation,
            material: it?.material ?? st.material,
            color: it?.color,
            image: it?.image,
            alpha: it?.alpha ?? st.alpha,
            alphaTest: it?.alphaTest ?? st.alphaTest,
            explode: [ex[0] * k, ex[1] * k, ex[2] * k],
            spin: st.spin,
            float: st.float,
            keys: it?.keys,
            id: it?.id ?? `stack${i}`,
          },
          `${c.path}.stack.items[${i}]`,
          pal,
          idx,
        );
        if (o) objects.push(o);
      });
    }
    if (!objects.length) S.warn(c.path, 'the 3D scene has no objects');
    let lights: Record<string, any>[] = LIGHT_PRESETS.studio;
    if (typeof n.lights === 'string') {
      if (!LIGHT_PRESETS[n.lights]) S.err(`${c.path}.lights`, `light preset is one of ${Object.keys(LIGHT_PRESETS).join(', ')}`);
      else lights = LIGHT_PRESETS[n.lights];
    } else if (Array.isArray(n.lights)) lights = n.lights.filter(isObj);
    const cam = isObj(n.camera) ? n.camera : {};
    const camKeys: Record<string, VKey[]> = {};
    if (isObj(cam.keys))
      for (const [k, raw] of Object.entries(cam.keys)) {
        if (!['position', 'target', 'fov'].includes(k)) {
          S.err(`${c.path}.camera.keys.${k}`, 'camera keys: position, target, fov');
          continue;
        }
        const ks = vkeys(S, raw, `${c.path}.camera.keys.${k}`, k === 'fov' ? 1 : 3);
        if (ks) camKeys[k] = ks;
      }
    if (isObj(cam.dolly)) {
      const from = vec(cam.dolly.from, [0, 1, 7]);
      const to = vec(cam.dolly.to, [0, 1, 4]);
      camKeys.position = [[0, from, undefined], [c.lenFrames, to, String(cam.dolly.ease ?? 'inOutSine')]];
    }
    const fg = lookupToken(S.tokens, 'color.bg2');
    const ir: ThreeIR = {
      w,
      h,
      objects,
      lights,
      camera: {
        fov: Number(cam.fov ?? 35),
        position: vec(cam.position, [0, 1.2, 6]),
        target: vec(cam.target, [0, 0, 0]),
        keys: camKeys,
        orbit: isObj(cam.orbit) ? { speed: Number(cam.orbit.speed ?? 20), radius: Number(cam.orbit.radius ?? 6), height: Number(cam.orbit.height ?? 1.2), from: Number(cam.orbit.from ?? 0) } : undefined,
        shake: Number(cam.shake ?? 0),
      },
      bg: n.bg === undefined || n.bg === null || n.bg === false || n.bg === 'transparent' ? null : String(n.bg),
      shadows: n.shadows !== false,
      env: n.environment === false ? 0 : typeof n.environment === 'number' ? n.environment : isObj(n.environment) ? Number(n.environment.intensity ?? 1) : 0.6,
      toneMapping: 'aces',
      exposure: Number(n.exposure ?? 1),
      shadowMap: 'soft',
      quality: 'auto',
      samples: Math.max(1, Math.round(Number(n.samples ?? 128))),
    };
    if (n.toneMapping !== undefined) {
      if (!TONE.includes(String(n.toneMapping))) S.err(`${c.path}.toneMapping`, `toneMapping is one of ${TONE.join(', ')}`);
      else ir.toneMapping = n.toneMapping;
    }
    if (isObj(n.environment) && n.environment.src !== undefined) {
      const src = S.assetSrc(n.environment.src, `${c.path}.environment.src`);
      const m = /^asset:([a-f0-9]{8,64})$/.exec(String(n.environment.src));
      const file = m ? S.opts.assetFile?.(m[1]) : null;
      const ext = (file ?? String(n.environment.src)).toLowerCase().match(/\.(hdr|exr|jpe?g|png|webp)$/)?.[1] ?? 'hdr';
      const bg = n.environment.background;
      if (src) ir.envMap = { src, ext, rotation: Number(n.environment.rotation ?? 0), background: !!bg, blur: typeof bg === 'number' ? bg : Number(n.environment.blur ?? 0) };
    }
    if (typeof n.shadows === 'string') {
      if (!['soft', 'vsm', 'basic'].includes(n.shadows)) S.err(`${c.path}.shadows`, 'shadows: true | false | "soft" | "vsm" | "basic"');
      else ir.shadowMap = n.shadows as ThreeIR['shadowMap'];
    }
    if (n.contactShadow) {
      const cs = isObj(n.contactShadow) ? n.contactShadow : {};
      ir.contact = { opacity: Number(cs.opacity ?? 0.6), blur: Number(cs.blur ?? 2.5), far: Number(cs.far ?? 1.5), y: Number(cs.y ?? (isObj(n.ground) ? n.ground.y ?? -1 : -1)), size: Number(cs.size ?? 10), color: String(cs.color ?? '#000000') };
    }
    ir.post = postSpec(S, n.post, `${c.path}.post`);
    if (n.motionBlur) {
      const mb = isObj(n.motionBlur) ? n.motionBlur : {};
      ir.motionBlur = { samples: Math.max(2, Math.min(32, Math.round(Number(mb.samples ?? 8)))), shutter: Math.max(0.05, Math.min(1, Number(mb.shutter ?? 0.5))) };
    }
    if (n.quality !== undefined) {
      if (!['auto', 'draft', 'final', 'pathtrace'].includes(String(n.quality))) S.err(`${c.path}.quality`, 'quality: auto | draft | final | pathtrace');
      else ir.quality = n.quality;
    }
    viewCheck(S, ir, `${c.path}.objects`);
    const countGrains = (os: Obj3D[]): number => os.reduce((acc, o) => acc + (o.effect?.count ?? 0) + countGrains(o.children), 0);
    const grains = countGrains(objects);
    if (grains > 5_000_000) S.warn(c.path, `${(grains / 1e6).toFixed(1)} M particles: needs a strong GPU (and memory); previews use fewer`);
    if (isObj(n.explode)) ir.explode = { at: S.frames(Number(n.explode.at ?? 0.6)), d: S.frames(Number(n.explode.d ?? 1.4)), amount: Number(n.explode.amount ?? 1), ease: String(n.explode.ease ?? 'inOutCubic') };
    if (n.ground) {
      const g = isObj(n.ground) ? n.ground : {};
      ir.ground = { color: String(g.color ?? (typeof fg === 'string' ? fg : '#222631')), y: Number(g.y ?? -1), shadow: g.shadow !== false, opacity: Number(g.opacity ?? 1) };
    }
    if (Array.isArray(n.fog)) ir.fog = [String(n.fog[0]), Number(n.fog[1] ?? 5), Number(n.fog[2] ?? 20)];
    const layer: IRLayer = { ...(c.base as IRLayer), type: 'three', w, h, style: {}, anims: [], data: ir };
    return [layer];
  },
});
