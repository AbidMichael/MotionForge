/**
 * 3D layer renderer (three.js inside Remotion).
 *
 * The scene graph is built once; every frame (and every motion-blur sub-frame) is posed by
 * `update(t)` functions registered by the objects, the camera and the effects. A driver then
 * renders it: directly, through the post-processing chain, with motion blur, or path traced.
 * Everything is a function of the frame number, so frames can be rendered in any order.
 */
import React, { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { cancelRender, continueRender, delayRender, useVideoConfig } from 'remotion';
import { ThreeCanvas } from '@remotion/three';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import * as SkeletonUtils from 'three/examples/jsm/utils/SkeletonUtils.js';
import { ease } from '../../ir/easing';
import type { ChannelState } from '../../ir/evaluate';
import type { IRLayer } from '../../ir/types';
import type { EffectSpec, Obj3D, ThreeIR, VKey } from '../../dsl/features/three';
import { RenderHints } from '../context';
import { getEnv, getModel, getTexture, useResources, type Req } from './loaders';
import { addDissolve, buildParticles, sampleSurface, type ParticleSystem, type Samples } from './particles';
import { PILE_VERT, SandPile } from './sandpile';
import { ContactShadow, makePipeline } from './effects';

const D2R = Math.PI / 180;

export function sampleKeys(keys: VKey[] | undefined, lf: number, fallback: number[]): number[] {
  if (!keys || !keys.length) return fallback;
  if (lf <= keys[0][0]) return keys[0][1];
  for (let i = 1; i < keys.length; i++) {
    const [f1, v1, e] = keys[i];
    if (lf <= f1) {
      const [f0, v0] = keys[i - 1];
      const t = ease(e ?? 'inOutCubic', (lf - f0) / Math.max(1, f1 - f0));
      return v0.map((a, k) => a + ((v1[k] ?? a) - a) * t);
    }
  }
  return keys[keys.length - 1][1];
}

// ---------------------------------------------------------------- registry of per-frame updates
type Updater = { order: number; fn: (t: number) => void };
interface Reg {
  add(u: Updater): () => void;
  before(fn: () => void): () => void;
  fps: number;
  draft: boolean;
  ir: ThreeIR;
  /** Explode progress (0..1 × amount) at frame t. */
  explode(t: number): number;
  /** World-level group (simulated particles live in world space). */
  world: THREE.Group;
}
const RegCtx = createContext<Reg>(null as any);

function useUpdate(fn: (t: number) => void, order = 0, deps: unknown[] = []) {
  const reg = useContext(RegCtx);
  const ref = useRef(fn);
  ref.current = fn;
  useLayoutEffect(() => reg.add({ order, fn: (t) => ref.current(t) }), [reg, ...deps]);
}

// ---------------------------------------------------------------- resources a scene needs
function collect(objs: Obj3D[], ir: ThreeIR, out: Req[] = []): Req[] {
  const walk = (o: Obj3D) => {
    if (o.image) out.push({ kind: 'texture', url: o.image });
    if (typeof o.material?.map === 'string') out.push({ kind: 'texture', url: o.material.map });
    if (o.model) out.push({ kind: 'model', url: o.model.src, ext: o.model.ext });
    if (o.effect?.target) walk(o.effect.target);
    o.children.forEach(walk);
  };
  objs.forEach(walk);
  if (ir.envMap) out.push({ kind: 'env', url: ir.envMap.src, ext: ir.envMap.ext });
  const seen = new Set<string>();
  return out.filter((r) => {
    const k = `${r.kind}:${r.url}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// ---------------------------------------------------------------- materials & primitives
function usesAlpha(o: Obj3D, url: string | undefined): boolean {
  if (!url) return false;
  if (o.alpha === true || o.alpha === false) return o.alpha;
  return getTexture(url)?.alpha ?? false;
}

function useAlphaShadow(map: THREE.Texture | null, on: boolean, cut: number) {
  return useMemo(() => {
    if (!map || !on) return {};
    return {
      customDepthMaterial: new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, map, alphaTest: cut, side: THREE.DoubleSide }),
      customDistanceMaterial: new THREE.MeshDistanceMaterial({ map, alphaTest: cut, side: THREE.DoubleSide }),
    };
  }, [map, on, cut]);
}

function ImagePlane({ w, h, map, alpha, cut, z = 0, shadow, fade }: { w: number; h: number; map: THREE.Texture; alpha: boolean; cut: number; z?: number; shadow: boolean; fade: boolean }) {
  const sh = useAlphaShadow(map, alpha, cut);
  return (
    <mesh position={[0, 0, z]} castShadow={shadow} {...sh}>
      <planeGeometry args={[w, h]} />
      <meshBasicMaterial map={map} transparent={alpha || fade} alphaTest={alpha ? 0.004 : 0} depthWrite={!alpha} side={alpha ? THREE.DoubleSide : THREE.FrontSide} toneMapped={false} />
    </mesh>
  );
}

function Material({ m, map, alpha = false, fade }: { m: Record<string, any>; map?: THREE.Texture | null; alpha?: boolean; fade: boolean }) {
  const common: Record<string, any> = {
    color: map ? '#ffffff' : m.color,
    map: map ?? null,
    transparent: alpha || fade || !!m.transparent || (m.opacity ?? 1) < 1,
    alphaTest: alpha ? 0.004 : 0,
    opacity: m.opacity ?? 1,
    wireframe: !!m.wireframe,
    side: m.side === 'double' || (alpha && !m.side) ? THREE.DoubleSide : THREE.FrontSide,
  };
  if (alpha) common.depthWrite = false;
  switch (m.type) {
    case 'basic':
      return <meshBasicMaterial {...common} />;
    case 'toon':
      return <meshToonMaterial {...common} />;
    case 'physical':
      return (
        <meshPhysicalMaterial
          {...common}
          metalness={m.metalness ?? 0}
          roughness={m.roughness ?? 0.3}
          transmission={m.transmission ?? 0}
          thickness={m.thickness ?? 0}
          ior={m.ior ?? 1.5}
          clearcoat={m.clearcoat ?? 0}
          sheen={m.sheen ?? 0}
          iridescence={m.iridescence ?? 0}
          emissive={m.emissive ?? '#000000'}
          emissiveIntensity={m.emissiveIntensity ?? 1}
        />
      );
    default:
      return <meshStandardMaterial {...common} metalness={m.metalness ?? 0.1} roughness={m.roughness ?? 0.45} emissive={m.emissive ?? '#000000'} emissiveIntensity={m.emissiveIntensity ?? 1} />;
  }
}

function geometryFor(o: Obj3D): THREE.BufferGeometry {
  const s = o.size;
  switch (o.shape) {
    case 'sphere':
      return new THREE.SphereGeometry(s[0] ?? 0.8, 64, 48);
    case 'cylinder':
      return new THREE.CylinderGeometry(s[0] ?? 0.6, s[1] ?? s[0] ?? 0.6, s[2] ?? 1.4, 64);
    case 'cone':
      return new THREE.ConeGeometry(s[0] ?? 0.7, s[1] ?? 1.4, 64);
    case 'torus':
      return new THREE.TorusGeometry(s[0] ?? 0.8, s[1] ?? 0.28, 48, 128);
    case 'knot':
      return new THREE.TorusKnotGeometry(s[0] ?? 0.7, s[1] ?? 0.22, 220, 32);
    case 'plane':
      return new THREE.PlaneGeometry(s[0] ?? 2, s[1] ?? s[0] ?? 2);
    case 'capsule':
      return new THREE.CapsuleGeometry(s[0] ?? 0.4, s[1] ?? 1, 12, 32);
    case 'ring':
      return new THREE.RingGeometry(s[0] ?? 0.6, s[1] ?? 1, 96);
    case 'icosahedron':
      return new THREE.IcosahedronGeometry(s[0] ?? 0.9, 0);
    case 'octahedron':
      return new THREE.OctahedronGeometry(s[0] ?? 0.9, 0);
    case 'roundedBox':
      return new RoundedBoxGeometry(s[0] ?? 1, s[1] ?? s[0] ?? 1, s[2] ?? s[0] ?? 1, 6, Math.min(s[3] ?? 0.12, (s[0] ?? 1) / 2, (s[1] ?? 1) / 2, (s[2] ?? 1) / 2));
    default:
      return new THREE.BoxGeometry(s[0] ?? 1, s[1] ?? s[0] ?? 1, s[2] ?? s[0] ?? 1);
  }
}

// ---------------------------------------------------------------- models
interface ModelInstance {
  root: THREE.Group;
  mixer: THREE.AnimationMixer | null;
  /** Pose the model at layer frame t. */
  pose(t: number): void;
  size: number;
}

function applyMaterialSpec(target: THREE.Material, m: Record<string, any>) {
  const t = target as any;
  if (m.color !== undefined && t.color) t.color.set(m.color);
  for (const k of ['metalness', 'roughness', 'opacity', 'transmission', 'thickness', 'ior', 'clearcoat', 'emissiveIntensity', 'envMapIntensity'] as const) if (m[k] !== undefined && k in t) t[k] = m[k];
  if (m.emissive !== undefined && t.emissive) t.emissive.set(m.emissive);
  if (m.wireframe !== undefined) t.wireframe = !!m.wireframe;
  if ((m.opacity ?? 1) < 1) t.transparent = true;
  t.needsUpdate = true;
}

function instantiateModel(o: Obj3D, fps: number, explodeOf: (t: number) => number): ModelInstance | null {
  const spec = o.model!;
  const res = getModel(spec.src);
  if (!res) return null;
  const clone = SkeletonUtils.clone(res.scene) as THREE.Group;
  // own materials: overrides, fades and dissolves must not leak to other instances
  clone.traverse((n: any) => {
    if (!n.isMesh) return;
    n.material = Array.isArray(n.material) ? n.material.map((m: THREE.Material) => m.clone()) : n.material.clone();
    if (o.castShadow === false) n.castShadow = false;
  });
  if (spec.materials) {
    clone.traverse((n: any) => {
      if (!n.isMesh) return;
      for (const m of Array.isArray(n.material) ? n.material : [n.material]) {
        const ov = spec.materials![m.name] ?? spec.materials!['*'];
        if (ov) applyMaterialSpec(m, ov);
      }
    });
  }
  // normalise size and placement
  const wrap = new THREE.Group();
  wrap.add(clone);
  clone.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(clone, true);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const k = spec.fit && size.length() > 0 ? spec.fit / Math.max(size.x, size.y, size.z) : 1;
  clone.scale.multiplyScalar(k);
  if (spec.center === 'center') clone.position.sub(center.clone().multiplyScalar(k));
  else if (spec.center === 'base') clone.position.set(-center.x * k, -box.min.y * k, -center.z * k);
  // animation
  let mixer: THREE.AnimationMixer | null = null;
  if (spec.animation && res.animations.length) {
    const clip = spec.animation.name ? res.animations.find((a) => a.name === spec.animation!.name) : res.animations[spec.animation.index ?? 0];
    if (clip) {
      mixer = new THREE.AnimationMixer(clone);
      const action = mixer.clipAction(clip);
      action.setLoop(spec.animation.loop ? THREE.LoopRepeat : THREE.LoopOnce, Infinity);
      action.clampWhenFinished = true;
      action.play();
    }
  }
  // parts: named nodes with overrides and their own keyframes
  const parts: { node: THREE.Object3D; spec: NonNullable<typeof spec.parts>[string]; p0: THREE.Vector3; r0: THREE.Euler; s0: THREE.Vector3 }[] = [];
  for (const [name, ps] of Object.entries(spec.parts ?? {})) {
    const node = clone.getObjectByName(name);
    if (!node) continue;
    if (ps.visible === false) node.visible = false;
    if (ps.material)
      node.traverse((n: any) => {
        if (n.isMesh) for (const m of Array.isArray(n.material) ? n.material : [n.material]) applyMaterialSpec(m, ps.material!);
      });
    const p0 = node.position.clone();
    const r0 = node.rotation.clone();
    const s0 = node.scale.clone();
    if (ps.position) p0.add(new THREE.Vector3(...ps.position));
    if (ps.rotation) r0.set(r0.x + ps.rotation[0] * D2R, r0.y + ps.rotation[1] * D2R, r0.z + ps.rotation[2] * D2R);
    if (ps.scale) s0.multiply(new THREE.Vector3(...ps.scale));
    parts.push({ node, spec: ps, p0, r0, s0 });
  }
  // exploded view: every mesh moves away from the model centre
  const exploding: { node: THREE.Object3D; base: THREE.Vector3; dir: THREE.Vector3 }[] = [];
  if (o.explodeParts) {
    clone.updateMatrixWorld(true);
    const mc = new THREE.Box3().setFromObject(clone).getCenter(new THREE.Vector3());
    clone.traverse((n: any) => {
      if (!n.isMesh || !n.parent) return;
      const c = new THREE.Box3().setFromObject(n).getCenter(new THREE.Vector3());
      const dirWorld = c.sub(mc);
      if (dirWorld.lengthSq() < 1e-10) dirWorld.set(0, 1, 0);
      // direction in the parent's space
      const inv = new THREE.Matrix4().copy(n.parent.matrixWorld).invert();
      const dir = dirWorld.clone().transformDirection(inv).multiplyScalar(dirWorld.length() / Math.max(1e-6, n.parent.matrixWorld.getMaxScaleOnAxis()));
      exploding.push({ node: n, base: n.position.clone(), dir });
    });
  }
  const fit = spec.fit ?? Math.max(size.x, size.y, size.z);
  return {
    root: wrap,
    mixer,
    size: fit,
    pose(t: number) {
      if (mixer && spec.animation) mixer.setTime(Math.max(0, (t / fps) * spec.animation.speed + spec.animation.offset));
      for (const p of parts) {
        const dp = sampleKeys(p.spec.keys?.position, t, [0, 0, 0]);
        const dr = sampleKeys(p.spec.keys?.rotation, t, [0, 0, 0]);
        const ds = sampleKeys(p.spec.keys?.scale, t, [1, 1, 1]);
        p.node.position.set(p.p0.x + dp[0], p.p0.y + dp[1], p.p0.z + dp[2]);
        p.node.rotation.set(p.r0.x + dr[0] * D2R, p.r0.y + dr[1] * D2R, p.r0.z + dr[2] * D2R);
        p.node.scale.set(p.s0.x * ds[0], p.s0.y * (ds[1] ?? ds[0]), p.s0.z * (ds[2] ?? ds[0]));
      }
      if (exploding.length) {
        const e = explodeOf(t) * (o.explodeParts ?? 0);
        for (const x of exploding) x.node.position.copy(x.base).addScaledVector(x.dir, e);
      }
    },
  };
}

// ---------------------------------------------------------------- particle host
/** Build a standalone object (primitive or model) for sampling a morph target. */
function standalone(o: Obj3D, fps: number): THREE.Object3D | null {
  let body: THREE.Object3D | null = null;
  if (o.shape === 'model') {
    const inst = instantiateModel(o, fps, () => 0);
    if (inst) {
      inst.pose(0);
      body = inst.root;
    }
  } else body = new THREE.Mesh(geometryFor(o), new THREE.MeshStandardMaterial({ color: o.material?.color ?? '#ffffff' }));
  if (!body) return null;
  const g = new THREE.Group();
  g.add(body);
  g.position.set(...o.position);
  g.rotation.set(o.rotation[0] * D2R, o.rotation[1] * D2R, o.rotation[2] * D2R);
  g.scale.set(...o.scale);
  return g;
}

function useParticles(o: Obj3D, outer: React.RefObject<THREE.Group | null>, body: React.RefObject<THREE.Group | null>, poseBody: (t: number) => void) {
  const reg = useContext(RegCtx);
  const fx = o.effect;
  const state = useRef<{ ps?: ParticleSystem; pile?: { sim: SandPile; points: THREE.Points; show: Float32Array }; toRoot: { value: THREE.Matrix4 }; front: { value: number }; built: boolean }>({
    toRoot: { value: new THREE.Matrix4() },
    front: { value: -1 },
    built: false,
  });
  const camera = useThree((s) => s.camera);
  const size = useThree((s) => s.size);
  const build = () => {
    const st = state.current;
    if (st.built || !fx || !outer.current || !body.current) return;
    st.built = true;
    const count = Math.max(1, Math.round(reg.draft ? Math.min(fx.count, Math.max(20000, fx.count * 0.25)) : fx.count));
    // sample the surface in its pose at the effect start, whatever frame we are on
    poseBody(fx.at);
    outer.current.updateWorldMatrix(true, true);
    const samples = sampleSurface(body.current, outer.current, count, fx.seed, fx.color);
    if (!samples.count) return;
    const sec = (f: number) => f / reg.fps;
    const mats: THREE.Mesh[] = [];
    body.current.traverse((n: any) => {
      if (n.isMesh && !n.userData.mfParticles) mats.push(n);
    });
    if (fx.kind === 'pile') {
      const world = new Float32Array(samples.count * 3);
      const v = new THREE.Vector3();
      for (let i = 0; i < samples.count; i++) {
        v.set(samples.pos[i * 3], samples.pos[i * 3 + 1], samples.pos[i * 3 + 2]).applyMatrix4(outer.current.matrixWorld);
        world[i * 3] = v.x;
        world[i * 3 + 1] = v.y;
        world[i * 3 + 2] = v.z;
      }
      const bounds = new THREE.Box3().setFromBufferAttribute(new THREE.BufferAttribute(world, 3));
      const sim = new SandPile(fx, world, reg.fps, bounds);
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(sim.out, 3));
      geo.setAttribute('aColor', new THREE.BufferAttribute(samples.col, 3));
      const show = new Float32Array(samples.count);
      geo.setAttribute('aShow', new THREE.BufferAttribute(show, 1));
      const ps = buildParticles({ ...fx, kind: 'disintegrate' }, samples, null, sec);
      const mat = new THREE.ShaderMaterial({ uniforms: ps.material.uniforms, vertexShader: PILE_VERT, fragmentShader: (ps.material as THREE.ShaderMaterial).fragmentShader });
      const points = new THREE.Points(geo, mat);
      points.frustumCulled = false;
      points.userData.mfParticles = true;
      reg.world.add(points);
      st.ps = ps; // for the dissolve sweep and uniforms
      st.pile = { sim, points, show };
      if (fx.dissolve) addDissolve(mats, ps, fx, st.toRoot, st.front);
      return;
    }
    let target: Samples | null = null;
    if (fx.kind === 'morph' && fx.target) {
      const tg = standalone(fx.target, reg.fps);
      if (tg) {
        const holder = new THREE.Group();
        holder.add(tg);
        holder.updateWorldMatrix(true, true);
        target = sampleSurface(tg, holder, samples.count, fx.seed + 1, 'texture');
      }
    }
    const ps = buildParticles(fx, samples, target, sec);
    outer.current.add(ps.object);
    st.ps = ps;
    if (fx.dissolve) addDissolve(mats, ps, fx, st.toRoot, st.front);
  };
  useUpdate(
    (t) => {
      if (!fx) return;
      build();
      const st = state.current;
      if (!st.ps || !outer.current) return;
      const T = (t - fx.at) / reg.fps;
      const D = fx.d / reg.fps;
      const spreadT = Math.max(1e-3, (fx.kind === 'morph' ? fx.spread * 0.5 : fx.spread) * D);
      st.front.value = fx.kind === 'assemble' ? (D - Math.max(0, Math.min(D, T))) / spreadT : T / spreadT;
      if (T < 0 && fx.kind !== 'assemble') st.front.value = -1;
      st.toRoot.value.copy(outer.current.matrixWorld).invert();
      st.ps.update(Math.max(0, Math.min(D * 1.6, T)), camera, size.height);
      if (st.pile) {
        const f = t - fx.at;
        const { sim, points, show } = st.pile;
        if (f < 0) show.fill(0);
        else {
          sim.at(f);
          for (let i = 0; i < sim.count; i++) show[i] = sim.released(f, i) ? 1 : 0;
          (points.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
        }
        (points.geometry.attributes.aShow as THREE.BufferAttribute).needsUpdate = true;
      }
    },
    5,
    [fx],
  );
}

// ---------------------------------------------------------------- objects
function Obj({ o }: { o: Obj3D }) {
  const reg = useContext(RegCtx);
  const fps = reg.fps;
  const outer = useRef<THREE.Group>(null);
  const body = useRef<THREE.Group>(null);
  const url = o.image ?? (typeof o.material.map === 'string' ? o.material.map : undefined);
  const tex = getTexture(url);
  const map = tex?.texture ?? null;
  const alpha = !!map && usesAlpha(o, url);
  const cut = o.alphaTest ?? 0.5;
  const sh = useAlphaShadow(map, alpha, cut);
  const fade = !!o.keys.opacity;
  const model = useMemo(() => (o.shape === 'model' ? instantiateModel(o, fps, reg.explode) : null), [o, fps]);
  const mats = useRef<{ m: any; base: number }[] | null>(null);
  const primGeo = useMemo(() => (['group', 'model', 'image', 'card', 'device'].includes(o.shape) ? null : geometryFor(o)), [o]);
  const poseBody = (t: number) => model?.pose(t);
  useUpdate(
    (t) => {
      const g = outer.current;
      if (!g) return;
      let pos = sampleKeys(o.keys.position, t, o.position);
      let rot = sampleKeys(o.keys.rotation, t, o.rotation);
      const scl = sampleKeys(o.keys.scale, t, o.scale);
      const sec = t / fps;
      if (o.spin) rot = rot.map((r, i) => r + (o.spin![i] ?? 0) * sec);
      if (o.float) pos = [pos[0], pos[1] + Math.sin(sec * 1.6 + o.id.length) * o.float, pos[2]];
      const ex = reg.explode(t);
      if (o.explode && ex) pos = pos.map((p, i) => p + o.explode![i] * ex);
      g.position.set(pos[0], pos[1], pos[2]);
      g.rotation.set(rot[0] * D2R, rot[1] * D2R, rot[2] * D2R);
      g.scale.set(scl[0], scl[1] ?? scl[0], scl[2] ?? scl[0]);
      poseBody(t);
      if (fade && body.current) {
        if (!mats.current) {
          mats.current = [];
          body.current.traverse((n: any) => {
            if (!n.isMesh || n.userData.mfParticles) return;
            for (const m of Array.isArray(n.material) ? n.material : [n.material]) {
              m.transparent = true;
              m.needsUpdate = true;
              mats.current!.push({ m, base: m.opacity ?? 1 });
            }
          });
        }
        const op = sampleKeys(o.keys.opacity, t, [1])[0];
        for (const x of mats.current) x.m.opacity = x.base * op;
        g.visible = op > 0.001;
      }
      g.updateMatrixWorld(true);
    },
    0,
    [o, model],
  );
  useParticles(o, outer, body, poseBody);
  const s = o.size;
  let content: React.ReactNode = null;
  if (o.shape === 'group') content = null;
  else if (o.shape === 'model') content = model ? <primitive object={model.root} /> : null;
  else if (o.shape === 'image') {
    const aspect = tex?.aspect || 1;
    const h = s.length >= 2 ? s[1] : s[0] ?? 2;
    const w = s.length >= 2 ? s[0] : h * aspect;
    content = map ? <ImagePlane w={w} h={h} map={map} alpha={alpha} cut={cut} shadow fade={fade} /> : null;
  } else if (o.shape === 'card' && alpha) {
    content = <ImagePlane w={s[0] ?? 2.4} h={s[1] ?? 1.5} map={map!} alpha cut={cut} shadow fade={fade} />;
  } else if (o.shape === 'device' || o.shape === 'card') {
    const w = s[0] ?? (o.shape === 'device' ? 1.5 : 2.4);
    const h = s[1] ?? (o.shape === 'device' ? 3.1 : 1.5);
    const d = s[2] ?? (o.shape === 'device' ? 0.16 : 0.04);
    const bezel = o.shape === 'device' ? Math.min(w, h) * 0.05 : 0;
    const r = s[3] ?? (o.shape === 'device' ? Math.min(w, h) * 0.14 : 0.08);
    content = (
      <>
        <mesh castShadow receiveShadow geometry={geometryFor({ ...o, shape: 'roundedBox', size: [w, h, d, r] })}>
          <Material m={o.shape === 'device' ? { ...o.material, color: o.material.color ?? '#15171c' } : { ...o.material, map: undefined }} fade={fade} />
        </mesh>
        {o.shape === 'device' && (!map || alpha) ? (
          <mesh position={[0, 0, d / 2 + 0.001]}>
            <planeGeometry args={[w - bezel * 2, h - bezel * 2]} />
            <meshBasicMaterial color="#0a0b0f" transparent={fade} />
          </mesh>
        ) : null}
        {map ? <ImagePlane w={w - bezel * 2} h={h - bezel * 2} map={map} alpha={alpha} cut={cut} z={d / 2 + 0.002} shadow={false} fade={fade} /> : null}
      </>
    );
  } else {
    content = (
      <mesh castShadow={o.castShadow !== false} receiveShadow={!alpha} geometry={primGeo!} {...sh}>
        <Material m={o.material} map={map} alpha={alpha} fade={fade} />
      </mesh>
    );
  }
  return (
    <group ref={outer} position={o.position} rotation={[o.rotation[0] * D2R, o.rotation[1] * D2R, o.rotation[2] * D2R]} scale={o.scale}>
      <group ref={body}>{content}</group>
      {o.children.map((c) => (
        <Obj key={c.id} o={c} />
      ))}
    </group>
  );
}

// ---------------------------------------------------------------- camera, lights, environment
function CameraRig({ ir }: { ir: ThreeIR }) {
  const camera = useThree((s) => s.camera) as THREE.PerspectiveCamera;
  const reg = useContext(RegCtx);
  useUpdate(
    (lf) => {
      const c = ir.camera;
      let pos = sampleKeys(c.keys.position, lf, c.position);
      const target = sampleKeys(c.keys.target, lf, c.target);
      const fov = sampleKeys(c.keys.fov, lf, [c.fov])[0];
      if (c.orbit) {
        const a = (c.orbit.from + (c.orbit.speed * lf) / reg.fps) * D2R;
        pos = [target[0] + Math.sin(a) * c.orbit.radius, target[1] + c.orbit.height, target[2] + Math.cos(a) * c.orbit.radius];
      }
      if (c.shake) {
        const t = lf / reg.fps;
        pos = [pos[0] + Math.sin(t * 13.1) * c.shake * 0.05, pos[1] + Math.sin(t * 17.3 + 1) * c.shake * 0.05, pos[2]];
      }
      camera.position.set(pos[0], pos[1], pos[2]);
      camera.fov = fov;
      camera.near = 0.05;
      camera.far = 400;
      camera.lookAt(target[0], target[1], target[2]);
      camera.updateProjectionMatrix();
      camera.updateMatrixWorld(true);
    },
    -10,
    [ir],
  );
  return null;
}

function Environment({ ir }: { ir: ThreeIR }) {
  const gl = useThree((s) => s.gl);
  const scene = useThree((s) => s.scene);
  useLayoutEffect(() => {
    if (!ir.env && !ir.envMap) return;
    const pm = new THREE.PMREMGenerator(gl);
    let env: THREE.Texture;
    const src = ir.envMap ? getEnv(ir.envMap.src) : null;
    if (src) env = pm.fromEquirectangular(src).texture;
    else env = pm.fromScene(new RoomEnvironment(), 0.04).texture;
    scene.environment = env;
    // the path tracer samples the original equirectangular image (PMREM targets have no pixels to read)
    scene.userData.mfEnvRaw = src ?? null;
    scene.environmentIntensity = ir.env || 1;
    const rot = (ir.envMap?.rotation ?? 0) * D2R;
    scene.environmentRotation.set(0, rot, 0);
    if (src && ir.envMap!.background) {
      scene.background = src;
      scene.backgroundBlurriness = ir.envMap!.blur;
      scene.backgroundRotation.set(0, rot, 0);
      scene.backgroundIntensity = ir.env || 1;
    }
    return () => {
      scene.environment = null;
      env.dispose();
      pm.dispose();
    };
  }, [gl, scene, ir]);
  return null;
}

function Lights({ lights, shadowSize }: { lights: Record<string, any>[]; shadowSize: number }) {
  return (
    <>
      {lights.map((l, i) => {
        const p = (l.position ?? [3, 5, 4]) as [number, number, number];
        switch (l.type) {
          case 'ambient':
            return <ambientLight key={i} intensity={l.intensity ?? 0.4} color={l.color ?? '#ffffff'} />;
          case 'hemisphere':
            return <hemisphereLight key={i} intensity={l.intensity ?? 1} color={l.color ?? '#ffffff'} groundColor={l.ground ?? '#444444'} />;
          case 'point':
            return <pointLight key={i} position={p} intensity={l.intensity ?? 10} color={l.color ?? '#ffffff'} distance={l.distance ?? 0} decay={l.decay ?? 2} castShadow={!!l.castShadow} shadow-bias={-0.0004} />;
          case 'spot':
            return <spotLight key={i} position={p} intensity={l.intensity ?? 60} color={l.color ?? '#ffffff'} angle={(l.angle ?? 30) * D2R} penumbra={l.penumbra ?? 0.5} castShadow={!!l.castShadow} shadow-mapSize={[shadowSize, shadowSize]} shadow-bias={-0.0004} />;
          default:
            return <directionalLight key={i} position={p} intensity={l.intensity ?? 1.5} color={l.color ?? '#ffffff'} castShadow={!!l.castShadow} shadow-mapSize={[shadowSize, shadowSize]} shadow-bias={-0.0004} shadow-normalBias={0.02} userData={{ mfDir: true }} />;
        }
      })}
    </>
  );
}

/** Fit directional-light shadow cameras to the objects (once), so shadows stay sharp at any scale. */
function fitShadows(scene: THREE.Scene, objects: THREE.Object3D) {
  const box = new THREE.Box3();
  objects.traverse((o: any) => {
    if (o.isMesh && !o.userData.mfParticles && !o.userData.mfHelper && !o.userData.mfGround) box.expandByObject(o);
  });
  if (box.isEmpty()) return;
  const c = box.getCenter(new THREE.Vector3());
  const r = Math.max(0.5, box.getSize(new THREE.Vector3()).length() * 0.65);
  scene.traverse((o: any) => {
    if (!o.isDirectionalLight || !o.castShadow) return;
    const dir = o.position.clone().sub(o.target.position).normalize();
    o.target.position.copy(c);
    if (!o.target.parent) scene.add(o.target);
    o.position.copy(c).addScaledVector(dir, r * 3);
    const cam = o.shadow.camera as THREE.OrthographicCamera;
    cam.left = cam.bottom = -r * 1.2;
    cam.right = cam.top = r * 1.2;
    cam.near = 0.1;
    cam.far = r * 6;
    cam.updateProjectionMatrix();
    o.shadow.needsUpdate = true;
  });
}

// ---------------------------------------------------------------- driver
function Driver({ ir, lfRef, objectsRef, updaters, befores, quality, size }: { ir: ThreeIR; lfRef: React.MutableRefObject<number>; objectsRef: React.RefObject<THREE.Group | null>; updaters: Updater[]; befores: (() => void)[]; quality: string; size: { w: number; h: number } }) {
  const gl = useThree((s) => s.gl);
  const scene = useThree((s) => s.scene);
  const camera = useThree((s) => s.camera);
  const fitted = useRef(false);
  const tone = { aces: THREE.ACESFilmicToneMapping, agx: THREE.AgXToneMapping, neutral: THREE.NeutralToneMapping, none: THREE.NoToneMapping }[ir.toneMapping];
  useLayoutEffect(() => {
    gl.toneMapping = tone;
    gl.toneMappingExposure = ir.exposure;
    gl.shadowMap.type = ir.shadowMap === 'vsm' ? THREE.VSMShadowMap : ir.shadowMap === 'basic' ? THREE.BasicShadowMap : THREE.PCFShadowMap;
    gl.shadowMap.needsUpdate = true;
  }, [gl, tone, ir.exposure, ir.shadowMap]);
  const pipeline = useMemo(() => makePipeline(gl, scene, camera, size, ir.post, ir.motionBlur, quality === 'draft'), [gl, scene, camera, ir, quality]);
  useEffect(() => () => pipeline.dispose(), [pipeline]);
  const update = (t: number) => {
    if (!fitted.current && objectsRef.current) {
      // fit shadow cameras on the scene at its first frame — the same in every render tab, whatever frame it starts on
      for (const u of updaters) u.fn(0);
      fitShadows(scene, objectsRef.current);
      fitted.current = true;
    }
    for (const u of updaters) u.fn(t);
  };
  const before = () => {
    for (const b of befores) b();
  };
  useFrame(() => {
    pipeline.render(lfRef.current, update, before);
  }, 1);
  return quality === 'pathtrace' ? <PathTrace lfRef={lfRef} update={update} before={before} samples={ir.samples} /> : null;
}

/** GPU path tracing (three-gpu-pathtracer): the raster frame is replaced once enough samples are in. */
function PathTrace({ lfRef, update, samples }: { lfRef: React.MutableRefObject<number>; update: (t: number) => void; before: () => void; samples: number }) {
  const gl = useThree((s) => s.gl);
  const scene = useThree((s) => s.scene);
  const camera = useThree((s) => s.camera);
  const pt = useRef<any>(null);
  const lf = lfRef.current;
  useEffect(() => {
    const handle = delayRender('path tracing', { timeoutInMilliseconds: 600_000 });
    let alive = true;
    (async () => {
      try {
        const { WebGLPathTracer, GradientEquirectTexture } = await import('three-gpu-pathtracer');
        if (!pt.current) {
          const p = new WebGLPathTracer(gl);
          p.renderDelay = 0;
          p.minSamples = 1;
          p.fadeDuration = 0;
          p.dynamicLowRes = false;
          p.rasterizeScene = false;
          p.renderToCanvas = true;
          (p as any).stableNoise = true;
          p.tiles.set(1, 1);
          pt.current = p;
        }
        const p = pt.current;
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        update(lf);
        // particles and custom shaders cannot be path traced: hide them
        const hidden: THREE.Object3D[] = [];
        scene.traverse((o) => {
          if (o.visible && (o.userData.mfParticles || o.userData.mfHelper)) {
            hidden.push(o);
            o.visible = false;
          }
        });
        const pmrem = scene.environment;
        let gradient: any = null;
        if (pmrem) {
          if (scene.userData.mfEnvRaw) scene.environment = scene.userData.mfEnvRaw;
          else {
            // no HDR given: a soft studio gradient stands in for the room environment
            gradient = new GradientEquirectTexture(64);
            gradient.topColor.set('#ffffff');
            gradient.bottomColor.set('#4a4f5a');
            gradient.update();
            scene.environment = gradient;
          }
        }
        p.setScene(scene, camera);
        scene.environment = pmrem;
        let guard = 0;
        while (alive && p.samples < samples && guard < samples * 20) {
          p.renderSample();
          guard++;
          if (p.isCompiling || guard % 16 === 0) await new Promise((r) => setTimeout(r, 0));
        }
        for (const o of hidden) o.visible = true;
      } catch (e) {
        console.error('MotionForge: path tracing failed, keeping the raster frame', (e as any)?.stack ?? e);
      } finally {
        continueRender(handle);
      }
    })();
    return () => {
      alive = false;
    };
  }, [lf]);
  return null;
}

/**
 * With post-processing the background would be tone mapped (a light grey turns darker): the canvas
 * stays transparent and the exact colour is painted behind it instead.
 */
function cssBg(ir: ThreeIR, quality: string): boolean {
  if (!ir.bg || ir.envMap?.background) return false;
  const p = ir.post ?? {};
  return !!(p.bloom || p.vignette || p.grain || p.chromatic || (quality !== 'draft' && (p.ao || p.dof || ir.motionBlur)));
}

// ---------------------------------------------------------------- scene
function Scene({ ir, lf, quality, size }: { ir: ThreeIR; lf: number; quality: string; size: { w: number; h: number } }) {
  const { fps } = useVideoConfig();
  const lfRef = useRef(lf);
  lfRef.current = lf;
  const objectsRef = useRef<THREE.Group>(null);
  const scene = useThree((s) => s.scene);
  const gl = useThree((s) => s.gl);
  const updaters = useRef<Updater[]>([]).current;
  const befores = useRef<(() => void)[]>([]).current;
  const world = useMemo(() => new THREE.Group(), []);
  const reg = useMemo<Reg>(
    () => ({
      add(u) {
        updaters.push(u);
        updaters.sort((a, b) => a.order - b.order);
        return () => {
          const i = updaters.indexOf(u);
          if (i >= 0) updaters.splice(i, 1);
        };
      },
      before(fn) {
        befores.push(fn);
        return () => {
          const i = befores.indexOf(fn);
          if (i >= 0) befores.splice(i, 1);
        };
      },
      fps,
      draft: quality === 'draft',
      ir,
      explode: (t) => (ir.explode ? ease(ir.explode.ease, (t - ir.explode.at) / Math.max(1, ir.explode.d)) * ir.explode.amount : 0),
      world,
    }),
    [ir, fps, quality],
  );
  // contact shadow: rendered before every frame
  useLayoutEffect(() => {
    if (!ir.contact) return;
    const cs = new ContactShadow(ir.contact, quality === 'draft' ? 256 : 512);
    scene.add(cs.mesh);
    const off = reg.before(() => cs.render(gl, scene));
    return () => {
      off();
      scene.remove(cs.mesh);
    };
  }, [ir, quality]);
  return (
    <RegCtx.Provider value={reg}>
      {ir.bg && !ir.envMap?.background && !cssBg(ir, quality) ? <color attach="background" args={[ir.bg]} /> : null}
      {ir.fog ? <fog attach="fog" args={ir.fog} /> : null}
      <CameraRig ir={ir} />
      {ir.env || ir.envMap ? <Environment ir={ir} /> : null}
      <Lights lights={ir.lights} shadowSize={quality === 'draft' ? 1024 : 2048} />
      <group ref={objectsRef}>
        {ir.objects.map((o) => (
          <Obj key={o.id} o={o} />
        ))}
      </group>
      <primitive object={world} />
      {ir.ground ? (
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, ir.ground.y, 0]} receiveShadow userData={{ mfGround: true }}>
          <planeGeometry args={[200, 200]} />
          {ir.ground.shadow && ir.ground.opacity < 1 ? <shadowMaterial opacity={ir.ground.opacity} /> : <meshStandardMaterial color={ir.ground.color} roughness={0.9} />}
        </mesh>
      ) : null}
      <Driver ir={ir} lfRef={lfRef} objectsRef={objectsRef} updaters={updaters} befores={befores} quality={quality} size={size} />
    </RegCtx.Provider>
  );
}

export const ThreeView: React.FC<{ layer: IRLayer; lf: number; st?: ChannelState }> = ({ layer, lf }) => {
  const hints = useContext(RenderHints);
  const ir = (layer.data as ThreeIR | undefined) ?? ({ objects: [], w: 0, h: 0 } as unknown as ThreeIR);
  const w = Math.round(layer.w ?? ir.w);
  const h = Math.round(layer.h ?? ir.h);
  const reqs = useMemo(() => collect(ir.objects ?? [], ir), [ir]);
  const ready = useResources(reqs);
  const quality = ir.quality === 'auto' || !ir.quality ? (hints.draft ? 'draft' : 'final') : ir.quality === 'pathtrace' && hints.draft ? 'draft' : ir.quality;
  if (!ready || !layer.data) return null;
  const shadows = ir.shadows ? (ir.shadowMap === 'vsm' ? 'variance' : ir.shadowMap === 'basic' ? 'basic' : 'percentage') : false;
  return (
    <div style={{ position: 'absolute', left: 0, top: 0, width: w, height: h }}>
      <ThreeCanvas
        width={w}
        height={h}
        shadows={shadows as any}
        gl={{ antialias: true, alpha: !ir.bg || cssBg(ir, quality), preserveDrawingBuffer: true }}
        onCreated={(state: any) => {
          // a lost context renders blank frames (flicker): fail loudly instead of delivering them
          state.gl.domElement.addEventListener('webglcontextlost', (e: Event) => {
            e.preventDefault();
            cancelRender(new Error('MotionForge: the WebGL context of a 3D layer was lost (GPU memory or too many contexts). Lower the particle "count", the number of 3D scenes rendered at once (render.concurrency3d), or use "cache": true on heavy shots.'));
          });
        }}
        style={{ background: ir.bg ?? 'transparent' }}
      >
        <Scene ir={ir} lf={lf} quality={quality} size={{ w, h }} />
      </ThreeCanvas>
    </div>
  );
};
