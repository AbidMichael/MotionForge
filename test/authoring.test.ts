import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { compile } from '../src/dsl/compile';
import { ease } from '../src/ir/easing';
import { evaluateAnims } from '../src/ir/evaluate';
import { ellipsePath, flattenPath, pointAt } from '../src/ir/motionpath';
import type { IRLayer } from '../src/ir/types';
import { readJsonFile, resolveFile, writeJsonFile } from '../src/core/files';
import { loadConfig } from '../src/core/config';
import { LibraryStore, SYSTEM_AGENT } from '../src/registry/store';

const store = new LibraryStore(path.resolve('libraries'));
store.scan();
const base = { store, defaultFormat: '1920x1080@30', defaultTheme: 'core:dark', assetUrl: () => null };
const run = (composition: unknown) => compile({ composition, agent: SYSTEM_AGENT }, base as any);

const find = (layers: IRLayer[], pred: (l: IRLayer) => boolean): IRLayer | undefined => {
  for (const l of layers) {
    if (pred(l)) return l;
    const k = find(l.children ?? [], pred);
    if (k) return k;
  }
  return undefined;
};

describe('motion paths', () => {
  it('flattens Béziers and arcs at constant speed', () => {
    const line = flattenPath('M0 0 L100 0 L100 100');
    expect(line.total).toBeCloseTo(200);
    expect(pointAt(line, 0.75)).toMatchObject({ x: 100, y: 50, angle: 90 });
    const circle = flattenPath(ellipsePath(0, 0, 100, 100));
    expect(circle.total).toBeCloseTo(2 * Math.PI * 100, -1);
    const arc = flattenPath('M0 0 A50 50 0 0 1 100 0');
    expect(pointAt(arc, 0.5).y).toBeCloseTo(-50, 0);
  });

  it('places the layer on the path and moves it there', () => {
    const r = run({
      format: '1280x720@30',
      scenes: [{ d: 2, layers: [{ type: 'rect', id: 'dot', w: 20, h: 20, fill: '#fff', motionPath: { path: 'M100 100 L500 100', d: 2, ease: 'linear', orient: true } }] }],
    });
    expect(r.errors).toEqual([]);
    const l = find(r.ir!.layers, (x) => x.name === 'dot')!;
    expect([l.x, l.y]).toEqual([100, 100]);
    const mid = evaluateAnims(l.anims, 30);
    expect(mid.dx).toBeCloseTo(200, 0);
    expect(mid.dy).toBeCloseTo(0);
  });

  it('reports bad paths', () => {
    const r = run({ scenes: [{ d: 1, layers: [{ type: 'rect', w: 10, h: 10, motionPath: { path: 'M0 0 X 3' } }] }] });
    expect(r.errors[0].path).toContain('motionPath');
  });
});

describe('text styles and baseline', () => {
  it('applies named styles, extends and layer overrides', () => {
    const r = run({
      textStyles: { big: { extends: 'h1', color: '#00d4ff' } },
      scenes: [{ d: 1, layers: [{ type: 'text', id: 't', text: 'Hi', textStyle: 'big', size: 50 }, { type: 'text', id: 'k', text: 'K', textStyle: 'kicker' }] }],
    });
    expect(r.errors).toEqual([]);
    const t = find(r.ir!.layers, (x) => x.name === 't')!;
    expect(t.style).toMatchObject({ color: '#00d4ff', size: 50, weight: 800 });
    expect(find(r.ir!.layers, (x) => x.name === 'k')!.style.case).toBe('upper');
    const bad = run({ scenes: [{ d: 1, layers: [{ type: 'text', text: 'x', textStyle: 'nope' }] }] });
    expect(bad.errors[0].msg).toContain('unknown text style');
  });

  it('puts the first baseline on y', () => {
    const r = run({ scenes: [{ d: 1, layers: [{ type: 'text', id: 'a', text: 'Hxg', size: 100, anchor: 'baseline', x: 100, y: 500 }] }] });
    const a = find(r.ir!.layers, (x) => x.name === 'a')!;
    expect(a.anchor).toEqual([0, 0]);
    expect(500 - a.y).toBeGreaterThan(70);
    expect(500 - a.y).toBeLessThan(110);
  });
});

describe('data-driven compositions', () => {
  it('repeats a block of scenes per item, with if', () => {
    const r = run({
      data: { items: [{ n: 'A' }, { n: 'B', skip: true }, { n: 'C' }] },
      scenes: [
        { each: '{{data.items}}', as: 'p', between: { t: 'core:crossfade' }, scenes: [
          { p: 'core:statement', text: '{{p.n}} {{index + 1}}/{{count}}' },
          { if: '{{!p.skip}}', d: 1, layers: [{ type: 'text', text: '{{p.n}}' }] },
        ] },
      ],
    });
    expect(r.errors).toEqual([]);
    expect(r.scenes.length).toBe(5);
  });
});

describe('easing aliases', () => {
  it('knows the long names', () => {
    expect(ease('outCubic', 0.5)).toBeCloseTo(ease('out', 0.5));
    expect(ease('inOutSine', 0.5)).toBeCloseTo(0.5);
  });
});

describe('composition files', () => {
  it('reads, reports JSON errors with a position, and writes back keeping the indent', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mf-'));
    const f = path.join(dir, 'c.json');
    fs.writeFileSync(f, '{\n    "scenes": []\n}\n');
    const cfg = loadConfig();
    const abs = resolveFile(cfg, f, 'read');
    const r = readJsonFile(abs);
    writeJsonFile(abs, { scenes: [1] }, r.text);
    expect(fs.readFileSync(abs, 'utf8')).toBe('{\n    "scenes": [\n        1\n    ]\n}\n');
    fs.writeFileSync(f, '{"a": 1,}');
    expect(() => readJsonFile(abs)).toThrow(/line 1, column 9/);
    expect(() => resolveFile(cfg, path.join(dir, 'c.txt'), 'read')).toThrow(/\.json/);
  });
});

describe('visual QA', async () => {
  const { staticChecks } = await import('../src/core/qa');
  it('ignores stacked copies of the same text and judges moving layers where they go', () => {
    const r = run({
      format: '1280x720@30',
      scenes: [{ d: 3, layers: [
        { type: 'text', text: 'ALDERAAN', size: 120, x: 640, y: 300 },
        { type: 'group', x: 0, y: 0, anchor: 'top-left', w: 1280, h: 720, children: [{ type: 'text', text: 'ALDERAAN', size: 120, x: 646, y: 300, blend: 'screen', color: '#f00' }] },
        { type: 'rect', id: 'ship', w: 40, h: 20, fill: '#fff', motionPath: { path: 'M-200 500 L640 500', d: 2 } },
        { type: 'rect', id: 'lost', w: 40, h: 20, fill: '#fff', motionPath: { path: 'M-400 500 L-200 500', d: 2 } },
      ] }],
    });
    expect(r.errors).toEqual([]);
    const issues = staticChecks(r.ir!);
    expect(issues.filter((i) => i.kind === 'overlap')).toEqual([]);
    const off = issues.filter((i) => i.kind === 'out-of-frame');
    expect(off.map((i) => i.layer)).toEqual(['lost']);
  });
});
