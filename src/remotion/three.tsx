import React, { useEffect, useLayoutEffect, useMemo, useState } from 'react';
import { continueRender, delayRender, useVideoConfig } from 'remotion';
import { ThreeCanvas } from '@remotion/three';
import { useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { ease } from '../ir/easing';
import type { ChannelState } from '../ir/evaluate';
import type { IRLayer } from '../ir/types';
import type { Obj3D, ThreeIR, VKey } from '../dsl/features/three';

const D2R = Math.PI / 180;

function sampleKeys(keys: VKey[] | undefined, lf: number, fallback: number[]): number[] {
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

const texCache = new Map<string, THREE.Texture>();
/** Textures are preloaded by ThreeView (outside the canvas) so the frame waits for them. */
function useTexture(url: string | undefined): THREE.Texture | null {
  return url ? texCache.get(url) ?? null : null;
}

function imageUrls(objs: Obj3D[], out: Set<string> = new Set()): Set<string> {
  for (const o of objs) {
    if (o.image) out.add(o.image);
    if (typeof o.material?.map === 'string') out.add(o.material.map);
    imageUrls(o.children ?? [], out);
  }
  return out;
}

/** Per texture: does the image really use its alpha channel, and its aspect ratio (w/h). */
const texInfo = new Map<string, { alpha: boolean; aspect: number }>();

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
    // a handful of soft-edged pixels is enough to treat the image as a cut-out
    return { alpha: clear / (px.length / 4) > 0.002, aspect };
  } catch {
    return { alpha: false, aspect };
  }
}

function loadTexture(url: string): Promise<void> {
  if (texCache.has(url)) return Promise.resolve();
  return new Promise((resolve) => {
    const loader = new THREE.TextureLoader();
    loader.setCrossOrigin('anonymous');
    loader.load(
      url,
      (t) => {
        t.colorSpace = THREE.SRGBColorSpace;
        t.anisotropy = 8;
        texInfo.set(url, inspectImage(t.image));
        texCache.set(url, t);
        resolve();
      },
      undefined,
      (e) => {
        console.error(`MotionForge: texture failed ${url}`, e);
        resolve();
      },
    );
  });
}

/** Whether an object's image should be drawn as a transparent cut-out. */
function usesAlpha(o: Obj3D, url: string | undefined): boolean {
  if (!url) return false;
  if (o.alpha === true || o.alpha === false) return o.alpha;
  return texInfo.get(url)?.alpha ?? false;
}

/** Depth materials that read the image alpha, so shadows take the shape of the image instead of its rectangle. */
function useAlphaShadow(map: THREE.Texture | null, on: boolean, cut: number) {
  return useMemo(() => {
    if (!map || !on) return {};
    return {
      customDepthMaterial: new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, map, alphaTest: cut, side: THREE.DoubleSide }),
      customDistanceMaterial: new THREE.MeshDistanceMaterial({ map, alphaTest: cut, side: THREE.DoubleSide }),
    };
  }, [map, on, cut]);
}

/** Unlit image plane; with alpha it is a cut-out (no black behind) that casts an image-shaped shadow. */
function ImagePlane({ w, h, map, alpha, opacity, cut, z = 0, shadow }: { w: number; h: number; map: THREE.Texture; alpha: boolean; opacity: number; cut: number; z?: number; shadow: boolean }) {
  const sh = useAlphaShadow(map, alpha, cut);
  return (
    <mesh position={[0, 0, z]} castShadow={shadow} {...sh}>
      <planeGeometry args={[w, h]} />
      <meshBasicMaterial
        map={map}
        transparent={alpha || opacity < 1}
        opacity={opacity}
        alphaTest={alpha ? 0.004 : 0}
        depthWrite={!alpha}
        side={alpha ? THREE.DoubleSide : THREE.FrontSide}
        toneMapped={false}
      />
    </mesh>
  );
}

function useTextures(urls: string[]): boolean {
  const key = urls.join('|');
  const missing = urls.filter((u) => !texCache.has(u));
  const [handle] = useState(() => (missing.length ? delayRender(`3D textures (${missing.length})`) : null));
  const [ready, setReady] = useState(!missing.length);
  useEffect(() => {
    if (ready) return;
    let alive = true;
    Promise.all(urls.map(loadTexture)).then(() => alive && setReady(true));
    return () => {
      alive = false;
    };
  }, [key]);
  useEffect(() => {
    if (!ready || handle === null) return;
    // let the canvas draw a frame with the textures before the screenshot
    requestAnimationFrame(() => requestAnimationFrame(() => continueRender(handle)));
  }, [ready]);
  return ready;
}

function Material({ m, map, opacity, alpha = false }: { m: Record<string, any>; map?: THREE.Texture | null; opacity: number; alpha?: boolean }) {
  const common: Record<string, any> = {
    color: map ? '#ffffff' : m.color,
    map: map ?? null,
    transparent: alpha || opacity < 1 || !!m.transparent || (m.opacity ?? 1) < 1,
    alphaTest: alpha ? 0.004 : 0,
    depthWrite: alpha ? false : undefined,
    opacity: opacity * (m.opacity ?? 1),
    wireframe: !!m.wireframe,
    side: m.side === 'double' || (alpha && !m.side) ? THREE.DoubleSide : THREE.FrontSide,
  };
  if (common.depthWrite === undefined) delete common.depthWrite;
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
          emissive={m.emissive ?? '#000000'}
          emissiveIntensity={m.emissiveIntensity ?? 1}
        />
      );
    default:
      return <meshStandardMaterial {...common} metalness={m.metalness ?? 0.1} roughness={m.roughness ?? 0.45} emissive={m.emissive ?? '#000000'} emissiveIntensity={m.emissiveIntensity ?? 1} />;
  }
}

function Geometry({ o }: { o: Obj3D }) {
  const s = o.size;
  switch (o.shape) {
    case 'sphere':
      return <sphereGeometry args={[s[0] ?? 0.8, 64, 48]} />;
    case 'cylinder':
      return <cylinderGeometry args={[s[0] ?? 0.6, s[1] ?? s[0] ?? 0.6, s[2] ?? 1.4, 64]} />;
    case 'cone':
      return <coneGeometry args={[s[0] ?? 0.7, s[1] ?? 1.4, 64]} />;
    case 'torus':
      return <torusGeometry args={[s[0] ?? 0.8, s[1] ?? 0.28, 48, 128]} />;
    case 'knot':
      return <torusKnotGeometry args={[s[0] ?? 0.7, s[1] ?? 0.22, 220, 32]} />;
    case 'plane':
      return <planeGeometry args={[s[0] ?? 2, s[1] ?? s[0] ?? 2]} />;
    case 'capsule':
      return <capsuleGeometry args={[s[0] ?? 0.4, s[1] ?? 1, 12, 32]} />;
    case 'ring':
      return <ringGeometry args={[s[0] ?? 0.6, s[1] ?? 1, 96]} />;
    case 'icosahedron':
      return <icosahedronGeometry args={[s[0] ?? 0.9, 0]} />;
    case 'octahedron':
      return <octahedronGeometry args={[s[0] ?? 0.9, 0]} />;
    default:
      return <boxGeometry args={[s[0] ?? 1, s[1] ?? s[0] ?? 1, s[2] ?? s[0] ?? 1]} />;
  }
}

function Rounded({ w, h, d, r }: { w: number; h: number; d: number; r: number }) {
  const g = useMemo(() => new RoundedBoxGeometry(w, h, d, 6, Math.min(r, w / 2, h / 2, d / 2)), [w, h, d, r]);
  return <primitive object={g} attach="geometry" />;
}

function Obj({ o, lf, fps, explode }: { o: Obj3D; lf: number; fps: number; explode: number }) {
  const url = o.image ?? o.material.map;
  const map = useTexture(url);
  const alpha = !!map && usesAlpha(o, url);
  const cut = o.alphaTest ?? 0.5;
  const sh = useAlphaShadow(map, alpha, cut);
  let pos = sampleKeys(o.keys.position, lf, o.position);
  let rot = sampleKeys(o.keys.rotation, lf, o.rotation);
  const scl = sampleKeys(o.keys.scale, lf, o.scale);
  const opacity = sampleKeys(o.keys.opacity, lf, [1])[0];
  const t = lf / fps;
  if (o.spin) rot = rot.map((r, i) => r + (o.spin![i] ?? 0) * t);
  if (o.float) pos = [pos[0], pos[1] + Math.sin(t * 1.6 + o.id.length) * o.float, pos[2]];
  if (o.explode && explode) pos = pos.map((p, i) => p + o.explode![i] * explode);
  const s = o.size;
  let body: React.ReactNode;
  if (o.shape === 'group') body = null;
  else if (o.shape === 'image') {
    // a free-standing cut-out sized to the picture: size = height, or [w, h]
    const aspect = (url && texInfo.get(url)?.aspect) || 1;
    const h = s.length >= 2 ? s[1] : s[0] ?? 2;
    const w = s.length >= 2 ? s[0] : h * aspect;
    body = map ? <ImagePlane w={w} h={h} map={map} alpha={alpha} opacity={opacity} cut={cut} shadow /> : null;
  } else if (o.shape === 'roundedBox') {
    body = (
      <mesh castShadow receiveShadow>
        <Rounded w={s[0] ?? 1} h={s[1] ?? s[0] ?? 1} d={s[2] ?? s[0] ?? 1} r={s[3] ?? 0.12} />
        <Material m={o.material} map={map} opacity={opacity} />
      </mesh>
    );
  } else if (o.shape === 'card' && alpha) {
    // transparent picture on a card: no slab behind it, only the cut-out (its shadow follows the image)
    const w = s[0] ?? 2.4;
    const h = s[1] ?? 1.5;
    body = <ImagePlane w={w} h={h} map={map!} alpha opacity={opacity} cut={cut} shadow />;
  } else if (o.shape === 'device' || o.shape === 'card') {
    // a rounded slab with the image on its front face
    const w = s[0] ?? (o.shape === 'device' ? 1.5 : 2.4);
    const h = s[1] ?? (o.shape === 'device' ? 3.1 : 1.5);
    const d = s[2] ?? (o.shape === 'device' ? 0.16 : 0.04);
    const bezel = o.shape === 'device' ? Math.min(w, h) * 0.05 : 0;
    const r = s[3] ?? (o.shape === 'device' ? Math.min(w, h) * 0.14 : 0.08);
    body = (
      <>
        <mesh castShadow receiveShadow>
          <Rounded w={w} h={h} d={d} r={r} />
          <Material m={o.shape === 'device' ? { ...o.material, color: o.material.color ?? '#15171c' } : { ...o.material, map: undefined }} opacity={opacity} />
        </mesh>
        {o.shape === 'device' && (!map || alpha) ? (
          <mesh position={[0, 0, d / 2 + 0.001]}>
            <planeGeometry args={[w - bezel * 2, h - bezel * 2]} />
            <meshBasicMaterial color="#0a0b0f" transparent={opacity < 1} opacity={opacity} />
          </mesh>
        ) : null}
        {map ? <ImagePlane w={w - bezel * 2} h={h - bezel * 2} map={map} alpha={alpha} opacity={opacity} cut={cut} z={d / 2 + 0.002} shadow={false} /> : null}
      </>
    );
  } else {
    body = (
      <mesh castShadow receiveShadow={!alpha} {...sh}>
        <Geometry o={o} />
        <Material m={o.material} map={map} opacity={opacity} alpha={alpha} />
      </mesh>
    );
  }
  return (
    <group position={pos as [number, number, number]} rotation={[rot[0] * D2R, rot[1] * D2R, rot[2] * D2R]} scale={scl as [number, number, number]}>
      {body}
      {o.children.map((c) => (
        <Obj key={c.id} o={c} lf={lf} fps={fps} explode={explode} />
      ))}
    </group>
  );
}

function Camera({ ir, lf, fps }: { ir: ThreeIR; lf: number; fps: number }) {
  const camera = useThree((s) => s.camera) as THREE.PerspectiveCamera;
  const c = ir.camera;
  let pos = sampleKeys(c.keys.position, lf, c.position);
  const target = sampleKeys(c.keys.target, lf, c.target);
  const fov = sampleKeys(c.keys.fov, lf, [c.fov])[0];
  if (c.orbit) {
    const a = (c.orbit.from + (c.orbit.speed * lf) / fps) * D2R;
    pos = [target[0] + Math.sin(a) * c.orbit.radius, target[1] + c.orbit.height, target[2] + Math.cos(a) * c.orbit.radius];
  }
  if (c.shake) {
    const t = lf / fps;
    pos = [pos[0] + Math.sin(t * 13.1) * c.shake * 0.05, pos[1] + Math.sin(t * 17.3 + 1) * c.shake * 0.05, pos[2]];
  }
  useLayoutEffect(() => {
    camera.position.set(pos[0], pos[1], pos[2]);
    camera.fov = fov;
    camera.near = 0.05;
    camera.far = 200;
    camera.lookAt(target[0], target[1], target[2]);
    camera.updateProjectionMatrix();
  });
  return null;
}

/** Image-based lighting so metal and glass have something to reflect. */
function Environment({ intensity }: { intensity: number }) {
  const gl = useThree((s) => s.gl);
  const scene = useThree((s) => s.scene);
  useLayoutEffect(() => {
    const pm = new THREE.PMREMGenerator(gl);
    const env = pm.fromScene(new RoomEnvironment(), 0.04).texture;
    scene.environment = env;
    (scene as any).environmentIntensity = intensity;
    return () => {
      scene.environment = null;
      env.dispose();
      pm.dispose();
    };
  }, [gl, scene, intensity]);
  return null;
}

function Lights({ lights }: { lights: Record<string, any>[] }) {
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
            return <pointLight key={i} position={p} intensity={l.intensity ?? 10} color={l.color ?? '#ffffff'} distance={l.distance ?? 0} decay={l.decay ?? 2} castShadow={!!l.castShadow} />;
          case 'spot':
            return <spotLight key={i} position={p} intensity={l.intensity ?? 60} color={l.color ?? '#ffffff'} angle={(l.angle ?? 30) * D2R} penumbra={l.penumbra ?? 0.5} castShadow={!!l.castShadow} shadow-mapSize={[2048, 2048]} />;
          default:
            return <directionalLight key={i} position={p} intensity={l.intensity ?? 1.5} color={l.color ?? '#ffffff'} castShadow={!!l.castShadow} shadow-mapSize={[2048, 2048]} shadow-camera-left={-8} shadow-camera-right={8} shadow-camera-top={8} shadow-camera-bottom={-8} />;
        }
      })}
    </>
  );
}

export const ThreeView: React.FC<{ layer: IRLayer; lf: number; st?: ChannelState }> = ({ layer, lf }) => {
  const { fps } = useVideoConfig();
  const ir = (layer.data as ThreeIR | undefined) ?? ({ objects: [], w: 0, h: 0 } as unknown as ThreeIR);
  const w = Math.round(layer.w ?? ir.w);
  const h = Math.round(layer.h ?? ir.h);
  const explode = ir.explode ? ease(ir.explode.ease, (lf - ir.explode.at) / Math.max(1, ir.explode.d)) * ir.explode.amount : 0;
  const ready = useTextures([...imageUrls(ir.objects)]);
  if (!ready || !layer.data) return null;
  return (
    <div style={{ position: 'absolute', left: 0, top: 0, width: w, height: h }}>
      <ThreeCanvas width={w} height={h} shadows={ir.shadows} gl={{ antialias: true, alpha: !ir.bg, preserveDrawingBuffer: true }} style={{ background: ir.bg ?? 'transparent' }}>
        {ir.bg ? <color attach="background" args={[ir.bg]} /> : null}
        {ir.fog ? <fog attach="fog" args={ir.fog} /> : null}
        <Camera ir={ir} lf={lf} fps={fps} />
        {ir.env ? <Environment intensity={ir.env} /> : null}
        <Lights lights={ir.lights} />
        {ir.objects.map((o) => (
          <Obj key={o.id} o={o} lf={lf} fps={fps} explode={explode} />
        ))}
        {ir.ground ? (
          <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, ir.ground.y, 0]} receiveShadow>
            <planeGeometry args={[60, 60]} />
            {ir.ground.shadow && ir.ground.opacity < 1 ? <shadowMaterial opacity={ir.ground.opacity} /> : <meshStandardMaterial color={ir.ground.color} roughness={0.9} />}
          </mesh>
        ) : null}
      </ThreeCanvas>
    </div>
  );
};
