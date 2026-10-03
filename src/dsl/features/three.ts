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
import { registerLayer } from '../registry';
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

const SHAPES = ['box', 'roundedBox', 'sphere', 'cylinder', 'cone', 'torus', 'knot', 'plane', 'capsule', 'ring', 'card', 'device', 'image', 'group', 'icosahedron', 'octahedron'];

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
  };
}

registerLayer('three', {
  keys: ['objects', 'stack', 'lights', 'camera', 'explode', 'ground', 'fog', 'bg', 'shadows', 'colors', 'environment'],
  compile(S, c) {
    const n = c.node;
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
      env: n.environment === false ? 0 : typeof n.environment === 'number' ? n.environment : 0.6,
    };
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
