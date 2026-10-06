/**
 * Resources of the 3D layer, loaded once per URL and shared by every frame of a render tab.
 * The view waits (delayRender) until everything a scene needs is in memory, so frames never
 * render with a missing texture or model.
 */
import { useEffect, useState } from 'react';
import { continueRender, delayRender } from 'remotion';
import * as THREE from 'three';

export interface TexInfo {
  texture: THREE.Texture;
  /** The image really uses its alpha channel. */
  alpha: boolean;
  aspect: number;
}
export interface ModelRes {
  scene: THREE.Group;
  animations: THREE.AnimationClip[];
}

export type Req = { kind: 'texture'; url: string } | { kind: 'model'; url: string; ext: string } | { kind: 'env'; url: string; ext: string };

const done = new Map<string, any>();
const pending = new Map<string, Promise<void>>();
const key = (r: Req) => `${r.kind}:${r.url}`;

export const getTexture = (url?: string): TexInfo | null => (url ? done.get(`texture:${url}`) ?? null : null);
export const getModel = (url: string): ModelRes | null => done.get(`model:${url}`) ?? null;
export const getEnv = (url: string): THREE.Texture | null => done.get(`env:${url}`) ?? null;

function inspectImage(img: any): { alpha: boolean; aspect: number } {
  const iw = img?.naturalWidth ?? img?.width ?? 1;
  const ih = img?.naturalHeight ?? img?.height ?? 1;
  const aspect = iw / Math.max(1, ih);
  try {
    const k = Math.min(1, 160 / Math.max(iw, ih));
    const cw = Math.max(1, Math.round(iw * k));
    const ch = Math.max(1, Math.round(ih * k));
    const cv = document.createElement('canvas');
    cv.width = cw;
    cv.height = ch;
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    if (!ctx) return { alpha: false, aspect };
    ctx.drawImage(img, 0, 0, cw, ch);
    const px = ctx.getImageData(0, 0, cw, ch).data;
    let clear = 0;
    for (let i = 3; i < px.length; i += 4) if (px[i] < 250) clear++;
    return { alpha: clear / (px.length / 4) > 0.002, aspect };
  } catch {
    return { alpha: false, aspect };
  }
}

/** Phong/Lambert (FBX, OBJ) → physically based, so models react to environment light like glTF ones. */
function toPBR(m: THREE.Material): THREE.Material {
  const src = m as any;
  if (!(src.isMeshPhongMaterial || src.isMeshLambertMaterial || src.isMeshBasicMaterial)) return m;
  const shin = src.shininess ?? 30;
  const out = new THREE.MeshStandardMaterial({
    name: src.name,
    color: src.color?.clone() ?? new THREE.Color('#ffffff'),
    map: src.map ?? null,
    normalMap: src.normalMap ?? null,
    bumpMap: src.bumpMap ?? null,
    emissive: src.emissive?.clone() ?? new THREE.Color('#000000'),
    emissiveMap: src.emissiveMap ?? null,
    alphaMap: src.alphaMap ?? null,
    aoMap: src.aoMap ?? null,
    transparent: src.transparent,
    opacity: src.opacity,
    alphaTest: src.alphaTest,
    side: src.side,
    vertexColors: src.vertexColors,
    roughness: Math.max(0.15, Math.min(0.95, 1 - Math.log2(1 + shin) / 9)),
    metalness: 0,
  });
  if (out.map) out.map.colorSpace = THREE.SRGBColorSpace;
  if (out.emissiveMap) out.emissiveMap.colorSpace = THREE.SRGBColorSpace;
  return out;
}

async function loadModel(url: string, ext: string): Promise<ModelRes> {
  const base = url.slice(0, url.lastIndexOf('/') + 1);
  const manager = new THREE.LoadingManager();
  // count what the loader fetches (FBX starts its textures after returning the model)
  let active = 0;
  let idle: (() => void) | null = null;
  const start = manager.itemStart.bind(manager);
  const end = manager.itemEnd.bind(manager);
  const fail = manager.itemError.bind(manager);
  const settle = () => {
    active--;
    if (active <= 0 && idle) idle();
  };
  manager.itemStart = (u: string) => {
    active++;
    start(u);
  };
  manager.itemEnd = (u: string) => {
    end(u);
    settle();
  };
  manager.itemError = (u: string) => {
    fail(u);
    console.warn(`MotionForge: missing model file ${u}`);
  };
  let res: ModelRes;
  if (ext === 'glb' || ext === 'gltf') {
    const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js');
    const { DRACOLoader } = await import('three/examples/jsm/loaders/DRACOLoader.js');
    const loader = new GLTFLoader(manager);
    const draco = new DRACOLoader();
    draco.setDecoderPath('https://www.gstatic.com/draco/versioned/decoders/1.5.7/');
    loader.setDRACOLoader(draco);
    const g = await loader.loadAsync(url);
    res = { scene: g.scene, animations: g.animations ?? [] };
  } else if (ext === 'fbx') {
    const { FBXLoader } = await import('three/examples/jsm/loaders/FBXLoader.js');
    const root = await new FBXLoader(manager).loadAsync(url);
    res = { scene: root, animations: (root as any).animations ?? [] };
  } else {
    const { OBJLoader } = await import('three/examples/jsm/loaders/OBJLoader.js');
    const loader = new OBJLoader(manager);
    const text = await (await fetch(url)).text();
    const mtl = /^mtllib\s+(.+)$/m.exec(text)?.[1]?.trim();
    if (mtl) {
      try {
        const { MTLLoader } = await import('three/examples/jsm/loaders/MTLLoader.js');
        const mats = await new MTLLoader(manager).setResourcePath(base).loadAsync(base + mtl);
        mats.preload();
        loader.setMaterials(mats);
      } catch {
        /* no materials: default grey */
      }
    }
    res = { scene: loader.parse(text), animations: [] };
  }
  // wait for the textures the loader started (a texture's image arrives after the model)
  await new Promise<void>((r) => setTimeout(r, 0));
  if (active > 0) await new Promise<void>((r) => (idle = r));
  res.scene.traverse((o: any) => {
    if (!o.isMesh) return;
    o.castShadow = true;
    o.receiveShadow = true;
    o.frustumCulled = false; // skinned meshes move outside their bind-pose bounds
    o.material = Array.isArray(o.material) ? o.material.map(toPBR) : toPBR(o.material);
  });
  return res;
}

async function loadEnv(url: string, ext: string): Promise<THREE.Texture> {
  let tex: THREE.Texture;
  if (ext === 'hdr') {
    const { HDRLoader } = await import('three/examples/jsm/loaders/HDRLoader.js');
    tex = await new HDRLoader().loadAsync(url);
  } else if (ext === 'exr') {
    const { EXRLoader } = await import('three/examples/jsm/loaders/EXRLoader.js');
    tex = await new EXRLoader().loadAsync(url);
  } else {
    tex = await new THREE.TextureLoader().loadAsync(url);
    tex.colorSpace = THREE.SRGBColorSpace;
  }
  tex.mapping = THREE.EquirectangularReflectionMapping;
  return tex;
}

function loadTexture(url: string): Promise<TexInfo> {
  return new Promise((resolve, reject) => {
    const loader = new THREE.TextureLoader();
    loader.setCrossOrigin('anonymous');
    loader.load(
      url,
      (t) => {
        t.colorSpace = THREE.SRGBColorSpace;
        t.anisotropy = 8;
        resolve({ texture: t, ...inspectImage(t.image) });
      },
      undefined,
      reject,
    );
  });
}

function load(r: Req): Promise<void> {
  const k = key(r);
  if (done.has(k)) return Promise.resolve();
  let p = pending.get(k);
  if (!p) {
    const job = r.kind === 'texture' ? loadTexture(r.url) : r.kind === 'model' ? loadModel(r.url, r.ext) : loadEnv(r.url, r.ext);
    p = job.then(
      (v) => void done.set(k, v),
      (e) => {
        console.error(`MotionForge: cannot load ${r.kind} ${r.url}`, e);
        done.set(k, null);
      },
    );
    pending.set(k, p);
  }
  return p;
}

/** Load everything, holding the frame until it is ready. */
export function useResources(reqs: Req[]): boolean {
  const sig = reqs.map(key).join('|');
  const missing = reqs.filter((r) => !done.has(key(r)));
  const [handle] = useState(() => (missing.length ? delayRender(`3D resources (${missing.length})`, { timeoutInMilliseconds: 180_000 }) : null));
  const [ready, setReady] = useState(!missing.length);
  useEffect(() => {
    if (ready) return;
    let alive = true;
    Promise.all(reqs.map(load)).then(() => alive && setReady(true));
    return () => {
      alive = false;
    };
  }, [sig]);
  useEffect(() => {
    if (!ready || handle === null) return;
    requestAnimationFrame(() => requestAnimationFrame(() => continueRender(handle)));
  }, [ready]);
  return ready;
}

/** Pixels of a texture image (for colouring particles), cached. */
const pixelCache = new WeakMap<object, { data: Uint8ClampedArray; w: number; h: number } | null>();
export function texturePixels(tex: THREE.Texture | null | undefined): { data: Uint8ClampedArray; w: number; h: number } | null {
  const img: any = tex?.image;
  if (!img) return null;
  if (pixelCache.has(img)) return pixelCache.get(img)!;
  let out: { data: Uint8ClampedArray; w: number; h: number } | null = null;
  try {
    const iw = img.naturalWidth ?? img.width;
    const ih = img.naturalHeight ?? img.height;
    const k = Math.min(1, 1024 / Math.max(iw, ih));
    const w = Math.max(1, Math.round(iw * k));
    const h = Math.max(1, Math.round(ih * k));
    const cv = document.createElement('canvas');
    cv.width = w;
    cv.height = h;
    const ctx = cv.getContext('2d', { willReadFrequently: true })!;
    ctx.drawImage(img, 0, 0, w, h);
    out = { data: ctx.getImageData(0, 0, w, h).data, w, h };
  } catch {
    out = null;
  }
  pixelCache.set(img, out);
  return out;
}
