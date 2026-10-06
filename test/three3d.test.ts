import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { zipSync, strToU8 } from 'three/examples/jsm/libs/fflate.module.js';
import { compile } from '../src/dsl/compile';
import { extractZip, inspectModel } from '../src/core/models';
import { mulberry32, sampleSurface } from '../src/remotion/three/particles';
import { SandPile } from '../src/remotion/three/sandpile';
import type { EffectSpec } from '../src/dsl/features/three';
import { LibraryStore, SYSTEM_AGENT } from '../src/registry/store';

const store = new LibraryStore(path.resolve('libraries'));
store.scan();
const MODEL = 'a1b2c3d4e5f60708';
const HDR = 'f0e1d2c3b4a59687';
const base = {
  store,
  defaultFormat: '1920x1080@30',
  defaultTheme: 'core:dark',
  assetUrl: (id: string) => `http://mf/${id}`,
  assetFile: (id: string) => (id === HDR ? '/x/env.hdr' : null),
  modelInfo: (id: string) =>
    id === MODEL ? { ext: 'glb', info: { parts: ['Body', 'Wheel_L'], animations: [{ name: 'Walk', duration: 1 }], missing: [] } } : null,
};
const run = (composition: unknown) => compile({ composition, agent: SYSTEM_AGENT }, base as any);
const three = (r: ReturnType<typeof run>): any => {
  const find = (ls: any[]): any => {
    for (const l of ls) {
      if (l.type === 'three') return l;
      const k = find(l.children ?? []);
      if (k) return k;
    }
  };
  return find(r.ir!.layers);
};
const scene = (layer: Record<string, unknown>) => ({ scenes: [{ d: 2, layers: [{ type: 'three', ...layer }] }] });

const OBJ = `mtllib cube.mtl
o Cube
v -1 -1 -1
v 1 -1 -1
v 1 1 -1
v -1 1 -1
v -1 -1 1
v 1 -1 1
v 1 1 1
v -1 1 1
usemtl Red
f 1 2 3 4
f 5 6 7 8
f 1 2 6 5
f 2 3 7 6
f 3 4 8 7
f 4 1 5 8
`;

describe('3D model assets', () => {
  it('extracts a zip, finds the main model and inspects it', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mf3d-'));
    const zip = path.join(dir, 'a.zip');
    fs.writeFileSync(
      zip,
      zipSync({
        'model/cube.obj': strToU8(OBJ),
        'model/cube.mtl': strToU8('newmtl Red\nKd 1 0 0\nmap_Kd red.png\n'),
        '../evil.txt': strToU8('nope'),
      }),
    );
    const z = extractZip(zip);
    expect(z.main).toBe('model/cube.obj');
    expect(fs.existsSync(path.join(dir, 'evil.txt'))).toBe(false); // zip-slip blocked
    const info = await inspectModel(path.join(z.dir, 'model', 'cube.obj'));
    expect(info.format).toBe('obj');
    expect(info.meshes).toBe(1);
    expect(info.triangles).toBe(12);
    expect(info.size).toEqual([2, 2, 2]);
    expect(info.missing).toEqual(['red.png']);
  });
});

describe('3D compile', () => {
  it('compiles models, animations, parts, effects and the studio look', () => {
    const r = run(
      scene({
        environment: { src: `asset:${HDR}`, rotation: 30, background: true },
        toneMapping: 'agx',
        contactShadow: true,
        post: { bloom: 0.5, dof: { focus: 5 }, vignette: true },
        motionBlur: { samples: 6 },
        quality: 'pathtrace',
        objects: [
          { shape: 'model', src: `asset:${MODEL}`, animation: 'Walk', parts: { Wheel_L: { rotation: [0, 0, 30] } }, effect: { kind: 'disintegrate', count: 1000, at: 0.5, d: 1 } },
        ],
      }),
    );
    expect(r.errors).toEqual([]);
    const d = three(r).data;
    expect(d.envMap).toMatchObject({ src: `http://mf/${HDR}`, ext: 'hdr', rotation: 30, background: true });
    expect(d.toneMapping).toBe('agx');
    expect(d.contact).toBeTruthy();
    expect(d.post.bloom.strength).toBe(0.5);
    expect(d.post.vignette).toBe(0.4);
    expect(d.motionBlur).toEqual({ samples: 6, shutter: 0.5 });
    expect(d.quality).toBe('pathtrace');
    const o = d.objects[0];
    expect(o.model).toMatchObject({ src: `http://mf/${MODEL}`, ext: 'glb', fit: 2, center: 'center', animation: { name: 'Walk', speed: 1, loop: true } });
    expect(o.model.parts.Wheel_L.rotation).toEqual([0, 0, 30]);
    expect(o.effect).toMatchObject({ kind: 'disintegrate', count: 1000, at: 15, d: 30 });
  });

  it('reports wrong animations, unknown parts, bad effects and non-model assets', () => {
    const r = run(
      scene({
        objects: [
          { shape: 'model', src: `asset:${MODEL}`, animation: 'Run', parts: { Nope: { visible: false } } },
          { shape: 'model', src: `asset:${HDR}` },
          { shape: 'box', effect: { kind: 'melt' } },
        ],
      }),
    );
    const msgs = [...r.errors, ...r.warnings].map((i) => i.msg).join(' | ');
    expect(msgs).toContain('no animation "Run"');
    expect(msgs).toContain('no part named "Nope"');
    expect(msgs).toContain('is not a 3D model');
    expect(msgs).toContain('effect is');
  });

  it('wraps a cached 3D layer in a pre-rendered sub-composition', () => {
    const r = run(scene({ cache: true, objects: [{ shape: 'knot' }] }));
    expect(r.errors).toEqual([]);
    const find = (ls: any[]): any => ls.find((l) => l.data?.prerender) ?? ls.map((l) => find(l.children ?? [])).find(Boolean);
    expect(find(r.ir!.layers)?.data.prerender).toBeTruthy();
  });

  it('warns when an object is outside the camera view', () => {
    const r = run(scene({ camera: { position: [0, 0, 6], target: [0, 0, 0] }, objects: [{ shape: 'sphere', position: [40, 0, 0] }, { shape: 'box' }] }));
    expect(r.warnings.map((w) => w.msg).join(' ')).toContain('outside the camera view');
    expect(r.warnings.filter((w) => w.msg.includes('outside')).length).toBe(1);
  });

  it('every @core/3d 1.1 preset example compiles', () => {
    const lv = (store as any).libs.get('@core/3d').versions.get('1.1.0');
    expect(lv.presets.size).toBe(11);
    for (const slug of ['model-hero', 'model-turntable', 'model-exploded', 'character-intro', 'sand-disintegrate', 'sand-assemble', 'particle-morph']) {
      const r = run({ use: ['@core/3d@1.1.0'], scenes: [{ p: `three:${slug}`, title: 'Test' }] });
      expect(r.errors, slug).toEqual([]);
    }
  });
});

describe('particles', () => {
  it('samples a surface deterministically, in the root space', () => {
    const root = new THREE.Group();
    root.position.set(5, 0, 0);
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), new THREE.MeshStandardMaterial({ color: '#ff0000' }));
    root.add(mesh);
    const a = sampleSurface(mesh, root, 500, 3);
    const b = sampleSurface(mesh, root, 500, 3);
    expect(a.count).toBe(500);
    expect(Array.from(a.pos)).toEqual(Array.from(b.pos));
    // on the surface of the cube (root space: centred on 0)
    for (let i = 0; i < 500; i++) {
      const p = [a.pos[i * 3], a.pos[i * 3 + 1], a.pos[i * 3 + 2]];
      expect(Math.max(...p.map(Math.abs))).toBeCloseTo(1, 4);
    }
    expect(a.col[0]).toBeGreaterThan(a.col[1]); // red
    expect(mulberry32(7)()).toBe(mulberry32(7)());
  });

  it('a sand pile gives the same frame whatever the order frames are computed in', () => {
    const fx: EffectSpec = {
      kind: 'pile', count: 2000, at: 0, d: 30, sweep: [0, -1, 0], wind: [0, 0, 0], turbulence: 0.2, gravity: 9.8, grain: 0.02, floor: -1,
      color: 'texture', render: 'points', seed: 1, spread: 0.6, dissolve: true, axis: [0, 1, 0], turns: 1, emissive: 0, fade: false,
    };
    const rnd = mulberry32(5);
    const origins = new Float32Array(2000 * 3).map((_, i) => (i % 3 === 1 ? 0.5 + rnd() : rnd() - 0.5));
    const box = new THREE.Box3().setFromBufferAttribute(new THREE.BufferAttribute(origins, 3));
    const s1 = new SandPile(fx, origins, 30, box);
    const late = Array.from(s1.at(60));
    const early = Array.from(s1.at(30));
    const s2 = new SandPile(fx, origins, 30, box);
    expect(Array.from(s2.at(30))).toEqual(early);
    expect(Array.from(s2.at(60))).toEqual(late);
    // grains ended on (or above) the floor, heaped
    const ys = late.filter((_, i) => i % 3 === 1);
    expect(Math.min(...ys)).toBeGreaterThanOrEqual(-1.001);
    expect(Math.max(...ys)).toBeLessThan(1.6);
  });
});
