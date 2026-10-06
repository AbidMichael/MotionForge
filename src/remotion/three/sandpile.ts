/**
 * "pile": grains leave the surface, fall and heap up on the floor (angle of repose).
 * A real simulation, but deterministic and addressable by frame: state snapshots every few frames,
 * any frame = nearest earlier snapshot + steps. Frames can be rendered in any order, by any tab.
 */
import * as THREE from 'three';
import type { EffectSpec } from '../../dsl/features/three';
import { mulberry32, type Samples } from './particles';

const SNAP_EVERY = 12;
const SUBSTEPS = 2;

interface State {
  pos: Float32Array;
  vel: Float32Array;
  /** 0 waiting on the surface, 1 falling, 2 settled. */
  st: Uint8Array;
  height: Float32Array;
  frame: number;
}

export class SandPile {
  private snaps = new Map<number, State>();
  private release: Float32Array;
  private kick: Float32Array;
  private grid: { x0: number; z0: number; cell: number; n: number };
  private repose: number;
  readonly count: number;
  /** World positions at the last computed frame. */
  readonly out: Float32Array;

  constructor(
    private fx: EffectSpec,
    originsWorld: Float32Array,
    private fps: number,
    bounds: THREE.Box3,
  ) {
    const n = originsWorld.length / 3;
    this.count = n;
    this.out = new Float32Array(originsWorld);
    const rnd = mulberry32(fx.seed * 31337 + 5);
    const dir = new THREE.Vector3(...fx.sweep).normalize();
    let lo = Infinity;
    let hi = -Infinity;
    const proj = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      proj[i] = originsWorld[i * 3] * dir.x + originsWorld[i * 3 + 1] * dir.y + originsWorld[i * 3 + 2] * dir.z;
      lo = Math.min(lo, proj[i]);
      hi = Math.max(hi, proj[i]);
    }
    const D = fx.d / fps;
    this.release = new Float32Array(n);
    this.kick = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const s = (proj[i] - lo) / Math.max(1e-5, hi - lo);
      this.release[i] = (s * fx.spread + rnd() * 0.08) * D;
      this.kick[i * 3] = (rnd() - 0.5) * 0.4 + fx.wind[0] * (0.5 + rnd());
      this.kick[i * 3 + 1] = rnd() * 0.3 + fx.wind[1];
      this.kick[i * 3 + 2] = (rnd() - 0.5) * 0.4 + fx.wind[2] * (0.5 + rnd());
    }
    const size = bounds.getSize(new THREE.Vector3());
    const c = bounds.getCenter(new THREE.Vector3());
    const span = Math.max(size.x, size.z, size.y) * 2.2 + 1;
    const cells = 160;
    this.grid = { x0: c.x - span / 2, z0: c.z - span / 2, cell: span / cells, n: cells };
    // a grain adds this much height to its cell
    this.repose = this.grid.cell * 0.9; // max height difference between neighbours (~42°)
    const s0: State = { pos: new Float32Array(originsWorld), vel: new Float32Array(n * 3), st: new Uint8Array(n), height: new Float32Array(cells * cells).fill(fx.floor ?? -1), frame: 0 };
    this.snaps.set(0, s0);
  }

  private grainH() {
    const g = this.fx.grain;
    return (g * g * g * 0.9) / (this.grid.cell * this.grid.cell);
  }

  private step(s: State, tSec: number, dt: number) {
    const { pos, vel, st, height } = s;
    const G = this.fx.gravity;
    const { x0, z0, cell, n } = this.grid;
    const dh = this.grainH();
    const floor = this.fx.floor ?? -1;
    const turb = this.fx.turbulence;
    for (let i = 0; i < this.count; i++) {
      if (st[i] === 2) continue;
      if (st[i] === 0) {
        if (tSec < this.release[i]) continue;
        st[i] = 1;
        vel[i * 3] = this.kick[i * 3];
        vel[i * 3 + 1] = this.kick[i * 3 + 1];
        vel[i * 3 + 2] = this.kick[i * 3 + 2];
      }
      const k = i * 3;
      vel[k + 1] -= G * dt;
      vel[k] += Math.sin(tSec * 3 + i) * turb * dt;
      vel[k + 2] += Math.cos(tSec * 2.3 + i * 1.7) * turb * dt;
      // air drag
      vel[k] *= 1 - 0.4 * dt;
      vel[k + 2] *= 1 - 0.4 * dt;
      pos[k] += vel[k] * dt;
      pos[k + 1] += vel[k + 1] * dt;
      pos[k + 2] += vel[k + 2] * dt;
      let cx = Math.floor((pos[k] - x0) / cell);
      let cz = Math.floor((pos[k + 2] - z0) / cell);
      if (cx < 0 || cz < 0 || cx >= n || cz >= n) {
        if (pos[k + 1] < floor) {
          pos[k + 1] = floor;
          st[i] = 2;
        }
        continue;
      }
      let h = height[cz * n + cx];
      if (pos[k + 1] > h) continue;
      // landed: roll down to a lower neighbour while the slope is too steep
      for (let r = 0; r < 6; r++) {
        let best = -1;
        let bh = h - this.repose;
        for (const [ox, oz] of [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ]) {
          const nx = cx + ox;
          const nz = cz + oz;
          if (nx < 0 || nz < 0 || nx >= n || nz >= n) continue;
          const nh = height[nz * n + nx];
          if (nh < bh) {
            bh = nh;
            best = nz * n + nx;
          }
        }
        if (best < 0) break;
        cx = best % n;
        cz = Math.floor(best / n);
        h = height[best];
      }
      height[cz * n + cx] = h + dh;
      pos[k] = x0 + (cx + 0.5) * cell + (Math.sin(i * 12.9898) * 0.5) * cell * 0.8;
      pos[k + 2] = z0 + (cz + 0.5) * cell + (Math.sin(i * 78.233) * 0.5) * cell * 0.8;
      pos[k + 1] = h + this.fx.grain * 0.5;
      st[i] = 2;
    }
  }

  /** Positions at a frame relative to the effect start (in this.out). */
  at(frame: number): Float32Array {
    const f = Math.max(0, Math.floor(frame));
    let base = Math.floor(f / SNAP_EVERY) * SNAP_EVERY;
    while (base > 0 && !this.snaps.has(base)) base -= SNAP_EVERY;
    const src = this.snaps.get(base)!;
    const s: State = { pos: new Float32Array(src.pos), vel: new Float32Array(src.vel), st: new Uint8Array(src.st), height: new Float32Array(src.height), frame: src.frame };
    const dt = 1 / this.fps / SUBSTEPS;
    while (s.frame < f) {
      for (let k = 0; k < SUBSTEPS; k++) this.step(s, (s.frame + k / SUBSTEPS) / this.fps, dt);
      s.frame++;
      if (s.frame % SNAP_EVERY === 0 && !this.snaps.has(s.frame)) {
        this.snaps.set(s.frame, { pos: new Float32Array(s.pos), vel: new Float32Array(s.vel), st: new Uint8Array(s.st), height: new Float32Array(s.height), frame: s.frame });
      }
    }
    this.out.set(s.pos);
    return this.out;
  }

  /** 1 for grains that have left the surface (or always, once the effect started). */
  released(frame: number, i: number) {
    return frame / this.fps >= this.release[i];
  }
}

/** Points that read their (simulated) world positions from "position". */
export const PILE_VERT = /* glsl */ `
uniform float uSize;
uniform float uPxScale;
attribute vec3 aColor;
attribute float aShow;
varying vec3 vColor;
varying float vAlpha;
void main() {
  vColor = aColor;
  vAlpha = aShow;
  vec4 mv = viewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = aShow > 0.5 ? max(1.0, uSize * uPxScale / max(0.01, -mv.z)) : 0.0;
}`;
