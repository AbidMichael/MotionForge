/**
 * 3D models as assets: .glb/.gltf/.fbx/.obj files, or a .zip holding a model and its textures.
 * A zip is extracted next to the stored file and served as a folder, so relative texture paths work.
 * Inspection runs the real three.js loaders in Node (no images decoded) to report meshes, triangles,
 * size, materials, textures (and missing ones), skinning and animations.
 */
import fs from 'node:fs';
import path from 'node:path';
import * as THREE from 'three';
import { unzipSync } from 'three/examples/jsm/libs/fflate.module.js';
import { badRequest } from './errors';

export const MODEL_EXTS = ['glb', 'gltf', 'fbx', 'obj'];
const MODEL_PRIORITY = ['glb', 'gltf', 'fbx', 'obj'];

/** Folder a zip asset is extracted to. */
export const zipDir = (file: string) => file.replace(/\.zip$/i, '');

/** Extract a zip (once) and return the path of its main model, relative to the folder. */
export function extractZip(file: string): { dir: string; main: string | null; files: string[] } {
  const dir = zipDir(file);
  const meta = path.join(dir, '.mf.json');
  if (fs.existsSync(meta)) return JSON.parse(fs.readFileSync(meta, 'utf8'));
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(new Uint8Array(fs.readFileSync(file)));
  } catch (e: any) {
    throw badRequest(`cannot read the zip: ${e.message}`);
  }
  const files: string[] = [];
  for (const [name, data] of Object.entries(entries)) {
    if (name.endsWith('/') || name.startsWith('__MACOSX') || /(^|\/)\./.test(name)) continue;
    const norm = path.posix.normalize(name.replace(/\\/g, '/'));
    if (norm.startsWith('..') || path.posix.isAbsolute(norm)) continue; // zip-slip
    const out = path.join(dir, ...norm.split('/'));
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, data);
    files.push(norm);
  }
  const models = files.filter((f) => MODEL_EXTS.includes(path.extname(f).slice(1).toLowerCase()));
  models.sort((a, b) => {
    const pa = MODEL_PRIORITY.indexOf(path.extname(a).slice(1).toLowerCase());
    const pb = MODEL_PRIORITY.indexOf(path.extname(b).slice(1).toLowerCase());
    return pa - pb || a.split('/').length - b.split('/').length || a.length - b.length;
  });
  const res = { dir, main: models[0] ?? null, files };
  fs.writeFileSync(meta, JSON.stringify(res));
  return res;
}

export interface ModelInfo {
  format: string;
  meshes: number;
  triangles: number;
  vertices: number;
  /** Bounding box size in model units, and its centre. */
  size: [number, number, number];
  center: [number, number, number];
  materials: { name: string; maps: string[] }[];
  /** Named nodes (meshes and groups) that can be targeted with "parts". */
  parts: string[];
  skinned: boolean;
  animations: { name: string; duration: number; tracks: number }[];
  textures: string[];
  missing: string[];
  warnings: string[];
}

let patched = false;
const recorded = new Set<string>();
/** Make three's loaders usable in Node: files from disk, textures recorded but not decoded. */
function patchLoaders() {
  if (patched) return;
  patched = true;
  (globalThis as any).self ??= globalThis;
  const fakeTexture = (url: string, onLoad?: (t: THREE.Texture) => void) => {
    recorded.add(url);
    const t = new THREE.Texture();
    t.userData = { url };
    setTimeout(() => onLoad?.(t), 0);
    return t;
  };
  (THREE.TextureLoader.prototype as any).load = function (url: string, onLoad: any) {
    return fakeTexture(this.manager.resolveURL(url), onLoad);
  };
  (THREE.ImageLoader.prototype as any).load = function (url: string, onLoad: any) {
    recorded.add(this.manager.resolveURL(url));
    setTimeout(() => onLoad?.({ width: 1, height: 1 }), 0);
    return {};
  };
  const origFile = THREE.FileLoader.prototype.load;
  (THREE.FileLoader.prototype as any).load = function (url: string, onLoad: any, onProgress: any, onError: any) {
    const u = this.manager.resolveURL((this.path ?? '') + url);
    if (/^(https?|data|blob):/.test(u)) return origFile.call(this, url, onLoad, onProgress, onError);
    const p = u.startsWith('file://') ? decodeURIComponent(new URL(u).pathname) : u;
    setTimeout(() => {
      try {
        const buf = fs.readFileSync(p);
        onLoad?.(this.responseType === 'arraybuffer' ? buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) : buf.toString('utf8'));
      } catch (e) {
        onError?.(e);
      }
    }, 0);
    return undefined;
  };
}

const ab = (b: Buffer) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;

/** Load a model in Node with the same loaders the renderer uses. */
export async function loadModelNode(file: string): Promise<{ root: THREE.Object3D; animations: THREE.AnimationClip[] }> {
  patchLoaders();
  const ext = path.extname(file).slice(1).toLowerCase();
  const dir = path.dirname(file) + path.sep;
  if (ext === 'glb' || ext === 'gltf') {
    const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js');
    const data = ext === 'glb' ? ab(fs.readFileSync(file)) : fs.readFileSync(file, 'utf8');
    const g: any = await new Promise((res, rej) => new GLTFLoader().parse(data as any, dir, res, rej));
    return { root: g.scene, animations: g.animations ?? [] };
  }
  if (ext === 'fbx') {
    const { FBXLoader } = await import('three/examples/jsm/loaders/FBXLoader.js');
    const root = new FBXLoader().parse(ab(fs.readFileSync(file)), dir);
    return { root, animations: (root as any).animations ?? [] };
  }
  if (ext === 'obj') {
    const { OBJLoader } = await import('three/examples/jsm/loaders/OBJLoader.js');
    const loader = new OBJLoader();
    const text = fs.readFileSync(file, 'utf8');
    const mtl = /^mtllib\s+(.+)$/m.exec(text)?.[1]?.trim();
    if (mtl && fs.existsSync(path.join(path.dirname(file), mtl))) {
      const { MTLLoader } = await import('three/examples/jsm/loaders/MTLLoader.js');
      const mats = new MTLLoader().setResourcePath(dir).parse(fs.readFileSync(path.join(path.dirname(file), mtl), 'utf8'), dir);
      mats.preload();
      loader.setMaterials(mats);
    }
    return { root: loader.parse(text), animations: [] };
  }
  throw badRequest(`not a 3D model: .${ext} (glb, gltf, fbx, obj or a zip of them)`);
}

export async function inspectModel(file: string, cacheFile?: string): Promise<ModelInfo> {
  if (cacheFile && fs.existsSync(cacheFile)) return JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
  recorded.clear();
  const warnings: string[] = [];
  const ext = path.extname(file).slice(1).toLowerCase();
  const origWarn = console.warn;
  console.warn = (...a: unknown[]) => {
    const m = a.map(String).join(' ');
    if (warnings.length < 8 && !/^THREE\.ImageUtils/.test(m)) warnings.push(m.replace(/^THREE\./, '').slice(0, 160));
  };
  let loaded: Awaited<ReturnType<typeof loadModelNode>>;
  try {
    loaded = await loadModelNode(file);
  } finally {
    console.warn = origWarn;
  }
  const { root, animations } = loaded;
  let meshes = 0;
  let triangles = 0;
  let vertices = 0;
  let skinned = false;
  const mats = new Map<string, Set<string>>();
  const parts: string[] = [];
  root.traverse((o: any) => {
    if (o.name && o !== root && parts.length < 200) parts.push(o.name);
    if (!o.isMesh) return;
    meshes++;
    if (o.isSkinnedMesh) skinned = true;
    const g = o.geometry as THREE.BufferGeometry;
    const n = g.attributes.position?.count ?? 0;
    vertices += n;
    triangles += (g.index ? g.index.count : n) / 3;
    for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
      const name = m?.name || m?.type || 'material';
      const maps = mats.get(name) ?? new Set<string>();
      for (const k of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'emissiveMap', 'aoMap', 'alphaMap', 'bumpMap', 'specularMap']) if (m?.[k]) maps.add(k);
      mats.set(name, maps);
    }
  });
  root.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(root);
  const size = box.isEmpty() ? new THREE.Vector3() : box.getSize(new THREE.Vector3());
  const center = box.isEmpty() ? new THREE.Vector3() : box.getCenter(new THREE.Vector3());
  const base = path.dirname(file);
  const textures = [...recorded].filter((u) => !/^(data|blob):/.test(u));
  const missing = textures
    .map((u) => (u.startsWith('file://') ? decodeURIComponent(new URL(u).pathname) : u))
    .filter((p) => !/^https?:/.test(p) && !fs.existsSync(p))
    .map((p) => path.relative(base, p).replace(/\\/g, '/'));
  if (ext === 'gltf' && missing.length && !base.includes(path.sep + 'files')) warnings.push('a .gltf with separate files: upload a .zip with the .gltf, .bin and textures');
  const r = (v: number) => +v.toFixed(4);
  const info: ModelInfo = {
    format: ext,
    meshes,
    triangles: Math.round(triangles),
    vertices,
    size: [r(size.x), r(size.y), r(size.z)],
    center: [r(center.x), r(center.y), r(center.z)],
    materials: [...mats].map(([name, maps]) => ({ name, maps: [...maps] })),
    parts,
    skinned,
    animations: animations.filter((a) => a.duration > 0.01).map((a) => ({ name: a.name, duration: +a.duration.toFixed(3), tracks: a.tracks.length })),
    textures: textures.map((u) => path.relative(base, u.startsWith('file://') ? decodeURIComponent(new URL(u).pathname) : u).replace(/\\/g, '/')),
    missing: [...new Set(missing)],
    warnings,
  };
  if (cacheFile) fs.writeFileSync(cacheFile, JSON.stringify(info));
  return info;
}
