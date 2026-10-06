/**
 * Particle effects built from an object's surface: sand, dust, embers.
 * Grains are sampled on the visible surface (skinned poses included) and take the colour of the
 * texture under them. Their motion is a pure function of time (shader), so any frame renders the
 * same whatever the order — except "pile", which is simulated (see sandpile.ts).
 */
import * as THREE from 'three';
import type { EffectSpec } from '../../dsl/features/three';
import { texturePixels } from './loaders';

export function mulberry32(seed: number) {
  let a = seed >>> 0 || 1;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface Samples {
  count: number;
  /** Positions in the effect root's local space. */
  pos: Float32Array;
  col: Float32Array;
  /** Bounds of the sampled surface (root space). */
  box: THREE.Box3;
}

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _p = new THREE.Vector3();

/**
 * Sample `count` points on the meshes under `source`, expressed in `root`'s local space.
 * Uses the current pose (call after posing skinned meshes).
 */
export function sampleSurface(source: THREE.Object3D, root: THREE.Object3D, count: number, seed: number, solid?: string): Samples {
  const rnd = mulberry32(seed * 9973 + 17);
  source.updateWorldMatrix(true, true);
  root.updateWorldMatrix(true, false);
  const toRoot = new THREE.Matrix4().copy(root.matrixWorld).invert();
  type Tri = { mesh: THREE.Mesh; a: number; b: number; c: number; area: number; mat: THREE.Material };
  const tris: Tri[] = [];
  const meshes: THREE.Mesh[] = [];
  source.traverse((o: any) => {
    if (o.isMesh && !o.userData.mfParticles && o.visible !== false && o.geometry?.attributes?.position) meshes.push(o);
  });
  let total = 0;
  const tmp = new THREE.Matrix4();
  for (const mesh of meshes) {
    const g = mesh.geometry as THREE.BufferGeometry;
    const idx = g.index;
    const n = idx ? idx.count : g.attributes.position.count;
    tmp.multiplyMatrices(toRoot, mesh.matrixWorld);
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    const groups = g.groups.length ? g.groups : [{ start: 0, count: n, materialIndex: 0 }];
    for (const grp of groups) {
      const mat = mats[grp.materialIndex ?? 0] ?? mats[0];
      for (let i = grp.start; i < Math.min(n, grp.start + grp.count) - 2; i += 3) {
        const a = idx ? idx.getX(i) : i;
        const b = idx ? idx.getX(i + 1) : i + 1;
        const c = idx ? idx.getX(i + 2) : i + 2;
        mesh.getVertexPosition(a, _a).applyMatrix4(tmp);
        mesh.getVertexPosition(b, _b).applyMatrix4(tmp);
        mesh.getVertexPosition(c, _c).applyMatrix4(tmp);
        const area = _b.clone().sub(_a).cross(_c.clone().sub(_a)).length() * 0.5;
        if (!(area > 1e-12)) continue;
        total += area;
        tris.push({ mesh, a, b, c, area: total, mat });
      }
    }
  }
  const pos = new Float32Array(count * 3);
  const col = new Float32Array(count * 3);
  const box = new THREE.Box3();
  if (!tris.length) return { count: 0, pos, col, box };
  const solidColor = solid && solid !== 'texture' ? new THREE.Color(solid) : null;
  const uvA = new THREE.Vector2();
  const uvB = new THREE.Vector2();
  const uvC = new THREE.Vector2();
  const color = new THREE.Color();
  for (let k = 0; k < count; k++) {
    const r = rnd() * total;
    let lo = 0;
    let hi = tris.length - 1;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      if (tris[m].area < r) lo = m + 1;
      else hi = m;
    }
    const t = tris[lo];
    let u = rnd();
    let v = rnd();
    if (u + v > 1) {
      u = 1 - u;
      v = 1 - v;
    }
    const w = 1 - u - v;
    tmp.multiplyMatrices(toRoot, t.mesh.matrixWorld);
    t.mesh.getVertexPosition(t.a, _a).applyMatrix4(tmp);
    t.mesh.getVertexPosition(t.b, _b).applyMatrix4(tmp);
    t.mesh.getVertexPosition(t.c, _c).applyMatrix4(tmp);
    _p.set(0, 0, 0).addScaledVector(_a, w).addScaledVector(_b, u).addScaledVector(_c, v);
    pos[k * 3] = _p.x;
    pos[k * 3 + 1] = _p.y;
    pos[k * 3 + 2] = _p.z;
    box.expandByPoint(_p);
    // colour: solid, texture under the point × material colour, or vertex colour
    const m: any = t.mat;
    if (solidColor) color.copy(solidColor);
    else {
      color.set(m?.color ?? '#ffffff');
      const g = t.mesh.geometry as THREE.BufferGeometry;
      const px = texturePixels(m?.map);
      const uv = g.attributes.uv;
      if (px && uv) {
        uvA.fromBufferAttribute(uv as any, t.a);
        uvB.fromBufferAttribute(uv as any, t.b);
        uvC.fromBufferAttribute(uv as any, t.c);
        let su = uvA.x * w + uvB.x * u + uvC.x * v;
        let sv = uvA.y * w + uvB.y * u + uvC.y * v;
        su = su - Math.floor(su);
        sv = sv - Math.floor(sv);
        if (m.map?.flipY !== false) sv = 1 - sv;
        const ix = Math.min(px.w - 1, Math.floor(su * px.w));
        const iy = Math.min(px.h - 1, Math.floor(sv * px.h));
        const o = (iy * px.w + ix) * 4;
        // texture pixels are sRGB: convert to linear like the renderer does
        const tc = new THREE.Color().setRGB(px.data[o] / 255, px.data[o + 1] / 255, px.data[o + 2] / 255, THREE.SRGBColorSpace);
        color.multiply(tc);
      } else if (g.attributes.color) {
        const ca = g.attributes.color;
        color.setRGB(ca.getX(t.a) * w + ca.getX(t.b) * u + ca.getX(t.c) * v, ca.getY(t.a) * w + ca.getY(t.b) * u + ca.getY(t.c) * v, ca.getZ(t.a) * w + ca.getZ(t.b) * u + ca.getZ(t.c) * v);
      }
    }
    // a little per-grain variation reads as sand rather than a flat print
    const j = 0.85 + rnd() * 0.3;
    col[k * 3] = color.r * j;
    col[k * 3 + 1] = color.g * j;
    col[k * 3 + 2] = color.b * j;
  }
  return { count, pos, col, box };
}

const KIND_ID: Record<string, number> = { disintegrate: 0, assemble: 1, vortex: 2, scatter: 3, morph: 4, pile: 5 };

/** Shared motion code (world space). Returns the grain's world position; sets vAlpha. */
const MOTION = /* glsl */ `
uniform float uT;        // seconds since the effect start
uniform float uD;        // effect duration (s)
uniform float uSpread;   // fraction of the duration over which grains leave
uniform int uKind;
uniform vec3 uWind;
uniform float uTurb;
uniform float uGrav;
uniform float uFloor;    // world y, or -1e9
uniform vec3 uSweepDir;  // root space
uniform vec2 uSweepRange;
uniform vec3 uCenter;    // root space
uniform vec3 uAxis;
uniform float uTurns;
uniform float uFade;
attribute vec3 aOrigin;
attribute vec3 aColor;
attribute vec4 aRnd;
attribute vec3 aTarget;
varying vec3 vColor;
varying float vAlpha;

float sweepCoord(vec3 p) { return clamp((dot(p, uSweepDir) - uSweepRange.x) / max(1e-5, uSweepRange.y - uSweepRange.x), 0.0, 1.0); }

vec3 rotateAxis(vec3 v, vec3 axis, float a) {
  float c = cos(a), s = sin(a);
  return v * c + cross(axis, v) * s + axis * dot(axis, v) * (1.0 - c);
}

vec3 grainWorld(out float alpha) {
  vec3 origin = aOrigin;
  float s = sweepCoord(origin);
  float release = (s * uSpread + aRnd.x * 0.08) * uD;
  float travel = max(0.05, uD - release);
  float T = uKind == 1 ? (uD - uT) : uT;       // assemble = disintegrate played backwards
  float tau = max(0.0, T - release);
  float k = clamp(tau / travel, 0.0, 1.0);
  alpha = T >= release ? 1.0 : 0.0;
  vec3 local = origin;
  if (uKind == 2) {
    // vortex: spin round the axis through the centre, widening and rising
    vec3 rel = origin - uCenter;
    float ang = uTurns * 6.2831853 * k * (0.6 + 0.8 * aRnd.y);
    rel = rotateAxis(rel, normalize(uAxis), ang) * (1.0 + k * (0.6 + aRnd.z));
    local = uCenter + rel + normalize(uAxis) * k * (0.5 + aRnd.w) * 1.2;
  } else if (uKind == 3) {
    // scatter: burst outwards, slowing down
    vec3 dir = normalize(origin - uCenter + (aRnd.yzw - 0.5) * 0.6);
    local = origin + dir * (1.0 - exp(-3.0 * tau)) * (0.8 + aRnd.y * 1.6);
  } else if (uKind == 4) {
    // morph: fly to the target surface on an arc
    float e = k * k * (3.0 - 2.0 * k);
    local = mix(origin, aTarget, e) + (aRnd.yzw - 0.5) * sin(3.14159 * e) * uTurb * 1.5;
    alpha = 1.0;
  }
  vec4 w = modelMatrix * vec4(local, 1.0);
  vec3 p = w.xyz;
  if (uKind == 0 || uKind == 1 || uKind == 2 || uKind == 3) {
    float sp = 0.6 + 0.8 * aRnd.y;
    p += uWind * tau * sp;
    p.y -= 0.5 * uGrav * tau * tau;
    p += uTurb * tau * vec3(
      sin(tau * (1.3 + aRnd.z * 2.0) + aRnd.w * 6.28),
      sin(tau * (1.7 + aRnd.w * 2.0) + aRnd.y * 6.28) * 0.6 + 0.25,
      sin(tau * (1.1 + aRnd.y * 2.0) + aRnd.z * 6.28));
    if (p.y < uFloor) p.y = uFloor + aRnd.z * 0.004;
    if (uFade > 0.5 && uKind != 1) alpha *= 1.0 - smoothstep(0.55, 1.0, k + aRnd.w * 0.15);
    if (uKind == 1) alpha *= smoothstep(0.0, 0.15, (uT) / max(0.01, uD)) ;
  }
  return p;
}
`;

const POINTS_VERT = /* glsl */ `
uniform float uSize;     // grain size (world units)
uniform float uPxScale;  // projection[1][1] * viewport height / 2
${MOTION}
void main() {
  float a;
  vec3 p = grainWorld(a);
  vAlpha = a;
  vColor = aColor;
  vec4 mv = viewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = a > 0.001 ? max(1.0, uSize * (0.6 + 0.8 * aRnd.z) * uPxScale / max(0.01, -mv.z)) : 0.0;
}`;

const POINTS_FRAG = /* glsl */ `
uniform vec3 uLight;     // view-space light direction
uniform float uEmissive;
varying vec3 vColor;
varying float vAlpha;
void main() {
  vec2 q = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(q, q);
  if (r2 > 1.0 || vAlpha < 0.01) discard;
  vec3 n = vec3(q.x, -q.y, sqrt(1.0 - r2));
  float diff = max(dot(n, normalize(uLight)), 0.0);
  vec3 c = vColor * (0.35 + 0.85 * diff) + vColor * uEmissive;
  gl_FragColor = vec4(c, vAlpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

const GRAINS_VERT = /* glsl */ `
uniform float uSize;
varying vec3 vNormalV;
${MOTION}
void main() {
  float a;
  vec3 c = grainWorld(a);
  vAlpha = a;
  vColor = aColor;
  // tumbling grain: random axis, spins while it travels
  vec3 axis = normalize(aRnd.yzw - 0.5 + 1e-3);
  float spin = (uT + aRnd.x * 10.0) * (2.0 + aRnd.y * 6.0);
  vec3 lp = rotateAxis(position * uSize * (0.6 + 0.8 * aRnd.z) * (a > 0.001 ? 1.0 : 0.0), axis, spin);
  vec3 ln = rotateAxis(normal, axis, spin);
  vNormalV = normalize(mat3(viewMatrix) * ln);
  gl_Position = projectionMatrix * viewMatrix * vec4(c + lp, 1.0);
}`;

const GRAINS_FRAG = /* glsl */ `
uniform vec3 uLight;
uniform float uEmissive;
varying vec3 vColor;
varying float vAlpha;
varying vec3 vNormalV;
void main() {
  if (vAlpha < 0.01) discard;
  float diff = max(dot(normalize(vNormalV), normalize(uLight)), 0.0);
  vec3 c = vColor * (0.3 + 0.9 * diff) + vColor * uEmissive;
  gl_FragColor = vec4(c, vAlpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

export interface ParticleSystem {
  object: THREE.Object3D;
  material: THREE.ShaderMaterial;
  /** Sweep frame shared with the dissolve of the solid object. */
  sweepDir: THREE.Vector3;
  sweepRange: THREE.Vector2;
  update(tSec: number, camera: THREE.Camera, viewportH: number): void;
}

export function buildParticles(fx: EffectSpec, samples: Samples, target: Samples | null, fpsSec: (frames: number) => number): ParticleSystem {
  const n = samples.count;
  const rnd = mulberry32(fx.seed * 7919 + 3);
  const rndA = new Float32Array(n * 4);
  for (let i = 0; i < n * 4; i++) rndA[i] = rnd();
  const sweepDir = new THREE.Vector3(...fx.sweep);
  if (sweepDir.lengthSq() < 1e-8) sweepDir.set(1, 0, 0);
  sweepDir.normalize();
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < n; i++) {
    const d = samples.pos[i * 3] * sweepDir.x + samples.pos[i * 3 + 1] * sweepDir.y + samples.pos[i * 3 + 2] * sweepDir.z;
    if (d < lo) lo = d;
    if (d > hi) hi = d;
  }
  const sweepRange = new THREE.Vector2(lo, hi);
  const center = samples.box.getCenter(new THREE.Vector3());
  const size = samples.box.getSize(new THREE.Vector3()).length() || 1;
  const uniforms: Record<string, THREE.IUniform> = {
    uT: { value: 0 },
    uD: { value: fpsSec(fx.d) },
    uSpread: { value: fx.kind === 'morph' ? fx.spread * 0.5 : fx.spread },
    uKind: { value: KIND_ID[fx.kind] ?? 0 },
    uWind: { value: new THREE.Vector3(...fx.wind) },
    uTurb: { value: fx.turbulence * (fx.kind === 'morph' ? size * 0.2 : 1) },
    uGrav: { value: fx.gravity },
    uFloor: { value: fx.floor === null ? -1e9 : fx.floor },
    uSweepDir: { value: sweepDir },
    uSweepRange: { value: sweepRange },
    uCenter: { value: center },
    uAxis: { value: new THREE.Vector3(...fx.axis) },
    uTurns: { value: fx.turns },
    uFade: { value: fx.fade ? 1 : 0 },
    uSize: { value: fx.grain },
    uPxScale: { value: 500 },
    uLight: { value: new THREE.Vector3(0.4, 0.8, 0.6) },
    uEmissive: { value: fx.emissive },
  };
  let geo: THREE.BufferGeometry;
  let obj: THREE.Object3D;
  let material: THREE.ShaderMaterial;
  const tgt = target && target.count === n ? target.pos : samples.pos;
  if (fx.render === 'grains') {
    const base = new THREE.IcosahedronGeometry(0.5, 0);
    const ig = new THREE.InstancedBufferGeometry();
    ig.index = base.index;
    ig.setAttribute('position', base.attributes.position);
    ig.setAttribute('normal', base.attributes.normal);
    ig.setAttribute('aOrigin', new THREE.InstancedBufferAttribute(samples.pos, 3));
    ig.setAttribute('aColor', new THREE.InstancedBufferAttribute(samples.col, 3));
    ig.setAttribute('aRnd', new THREE.InstancedBufferAttribute(rndA, 4));
    ig.setAttribute('aTarget', new THREE.InstancedBufferAttribute(tgt, 3));
    ig.instanceCount = n;
    geo = ig;
    material = new THREE.ShaderMaterial({ uniforms, vertexShader: GRAINS_VERT, fragmentShader: GRAINS_FRAG, transparent: fx.fade, depthWrite: true });
    obj = new THREE.Mesh(geo, material);
  } else {
    geo = new THREE.BufferGeometry();
    // "position" is required by three; the shader uses aOrigin
    geo.setAttribute('position', new THREE.BufferAttribute(samples.pos, 3));
    geo.setAttribute('aOrigin', new THREE.BufferAttribute(samples.pos, 3));
    geo.setAttribute('aColor', new THREE.BufferAttribute(samples.col, 3));
    geo.setAttribute('aRnd', new THREE.BufferAttribute(rndA, 4));
    geo.setAttribute('aTarget', new THREE.BufferAttribute(tgt, 3));
    material = new THREE.ShaderMaterial({ uniforms, vertexShader: POINTS_VERT, fragmentShader: POINTS_FRAG, transparent: fx.fade, depthWrite: true });
    obj = new THREE.Points(geo, material);
  }
  obj.frustumCulled = false;
  obj.userData.mfParticles = true;
  const lightW = new THREE.Vector3(0.4, 0.9, 0.5).normalize();
  return {
    object: obj,
    material,
    sweepDir,
    sweepRange,
    update(tSec, camera, viewportH) {
      uniforms.uT.value = tSec;
      const proj = (camera as THREE.PerspectiveCamera).projectionMatrix;
      uniforms.uPxScale.value = proj.elements[5] * viewportH * 0.5;
      (uniforms.uLight.value as THREE.Vector3).copy(lightW).transformDirection(camera.matrixWorldInverse);
    },
  };
}

/**
 * Dissolve the solid object along the same sweep as the grains: fragments whose sweep coordinate
 * is behind the front are discarded, with a thin glowing edge. Shadow depth materials get the same
 * cut, so a dissolved part stops casting shadows.
 */
export function addDissolve(meshes: THREE.Mesh[], ps: ParticleSystem, fx: EffectSpec, toRoot: { value: THREE.Matrix4 }, front: { value: number }) {
  const edge = new THREE.Color('#ffb070').multiplyScalar(0.6 + fx.emissive);
  const inject = (m: THREE.Material, emissive: boolean) => {
    if ((m as any).userData?.mfDissolve) return;
    (m as any).userData.mfDissolve = true;
    m.onBeforeCompile = (shader) => {
      shader.uniforms.uMfToRoot = toRoot;
      shader.uniforms.uMfFront = front;
      shader.uniforms.uMfDir = { value: ps.sweepDir };
      shader.uniforms.uMfRange = { value: ps.sweepRange };
      shader.uniforms.uMfEdge = { value: edge };
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vMfWorld;')
        .replace('#include <project_vertex>', '#include <project_vertex>\nvMfWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;');
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          `#include <common>
varying vec3 vMfWorld;
uniform mat4 uMfToRoot; uniform float uMfFront; uniform vec3 uMfDir; uniform vec2 uMfRange; uniform vec3 uMfEdge;
float mfHash(vec3 p) { return fract(sin(dot(p, vec3(12.9898, 78.233, 37.719))) * 43758.5453); }`,
        )
        .replace(
          '#include <clipping_planes_fragment>',
          `#include <clipping_planes_fragment>
vec3 mfP = (uMfToRoot * vec4(vMfWorld, 1.0)).xyz;
float mfS = clamp((dot(mfP, uMfDir) - uMfRange.x) / max(1e-5, uMfRange.y - uMfRange.x), 0.0, 1.0) + (mfHash(floor(mfP * 60.0)) - 0.5) * 0.04;
if (mfS < uMfFront) discard;
float mfEdge = 1.0 - smoothstep(0.0, 0.025, abs(mfS - uMfFront));`,
        );
      if (emissive)
        shader.fragmentShader = shader.fragmentShader.replace(
          '#include <emissivemap_fragment>',
          '#include <emissivemap_fragment>\ntotalEmissiveRadiance += uMfEdge * mfEdge * step(0.0001, uMfFront) * step(uMfFront, 0.9999);',
        );
    };
    m.needsUpdate = true;
  };
  for (const mesh of meshes) {
    for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) inject(m, true);
    const depth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
    const dist = new THREE.MeshDistanceMaterial();
    inject(depth, false);
    inject(dist, false);
    mesh.customDepthMaterial = depth;
    mesh.customDistanceMaterial = dist;
    mesh.userData.mfFront = front;
  }
}
