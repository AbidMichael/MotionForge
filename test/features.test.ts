import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { compile, type AudioInfo } from '../src/dsl/compile';
import { parseCsv, layoutGraph } from '../src/dsl/features/data';
import { fmtValue, niceTicks } from '../src/ir/dataviz';
import { mapTime } from '../src/ir/evaluate';
import type { IRLayer } from '../src/ir/types';
import { LibraryStore, SYSTEM_AGENT } from '../src/registry/store';

const store = new LibraryStore(path.resolve('libraries'));
store.scan();
const base = { store, defaultFormat: '1920x1080@30', defaultTheme: 'core:dark', assetUrl: () => null };
const run = (composition: unknown, extra: Record<string, unknown> = {}) => compile({ composition, agent: SYSTEM_AGENT }, { ...base, ...extra } as any);

const find = (layers: IRLayer[], pred: (l: IRLayer) => boolean): IRLayer | undefined => {
  for (const l of layers) {
    if (pred(l)) return l;
    const k = find(l.children ?? [], pred);
    if (k) return k;
  }
  return undefined;
};

describe('official libraries', () => {
  it('load without issues and resolve by alias without "use"', () => {
    expect(store.loadIssues).toEqual([]);
    const r = run({ direction: 'dir:cinematic', scenes: [{ p: 'data:chart-story', title: 'T', data: { A: 1, B: 2 } }, { p: 'explain:pipeline', steps: ['a', 'b', 'c'] }] });
    expect(r.errors).toEqual([]);
    expect(r.lock['@core/directions']).toBe('1.0.0');
  });
});

describe('data', () => {
  it('parses CSV with quotes, separators and numbers', () => {
    expect(parseCsv('a;b\n"x;y";3,5\nz;4')).toEqual([{ a: 'x;y', b: 3.5 }, { a: 'z', b: 4 }]);
  });
  it('formats numbers and picks nice ticks', () => {
    expect(fmtValue(1234567, {})).toBe('1,234,567');
    expect(fmtValue(1520, { compact: true, prefix: '$' })).toBe('$1.5k');
    expect(niceTicks(0, 260, 5)).toEqual([0, 50, 100, 150, 200, 250]);
  });
  it('compiles a bar race into snapshots over time', () => {
    const r = run({ scenes: [{ d: 6, layers: [{ type: 'chart', kind: 'race', time: 'y', data: 'y,c,v\n1,A,1\n1,B,2\n2,A,5\n2,B,3' }] }] });
    expect(r.errors).toEqual([]);
    const c = find(r.ir!.layers, (l) => l.type === 'chart')!;
    expect((c.data as any).values.length).toBe(2);
    expect((c.data as any).keyLabels).toEqual(['1', '2']);
  });
  it('lays out graphs deterministically inside their box', () => {
    const a = layoutGraph([{ id: 'a' }, { id: 'b' }, { id: 'c' }], [[0, 1], [1, 2]], 'force', 800, 600, 40);
    const b = layoutGraph([{ id: 'a' }, { id: 'b' }, { id: 'c' }], [[0, 1], [1, 2]], 'force', 800, 600, 40);
    expect(a).toEqual(b);
    for (const [x, y] of a) {
      expect(x).toBeGreaterThanOrEqual(39);
      expect(x).toBeLessThanOrEqual(761);
      expect(y).toBeGreaterThanOrEqual(39);
    }
  });
});

describe('simulations', () => {
  it('sorts with every algorithm', () => {
    for (const algorithm of ['bubble', 'insertion', 'selection', 'quick', 'merge']) {
      const r = run({ scenes: [{ d: 3, layers: [{ type: 'sim', kind: 'sort', algorithm, values: [5, 1, 4, 2, 3] }] }] });
      const s = find(r.ir!.layers, (l) => l.type === 'sim')!.data as any;
      const arr = [...s.values];
      for (const st of s.steps) if (st.op === 'swap') [arr[st.i], arr[st.j]] = [arr[st.j], arr[st.i]];
      expect(arr, algorithm).toEqual([1, 2, 3, 4, 5]);
    }
  });
  it('accepts keyframed physics parameters', () => {
    const r = run({ scenes: [{ d: 2, layers: [{ type: 'sim', kind: 'projectile', gravity: [[0, 9.8], [1, 1.6]] }] }] });
    expect(r.errors).toEqual([]);
    expect((find(r.ir!.layers, (l) => l.type === 'sim')!.data as any).states.length).toBeGreaterThan(30);
  });
});

describe('music montage', () => {
  const info: AudioInfo = { duration: 30, bpm: 120, beats: Array.from({ length: 60 }, (_, i) => i * 0.5), downbeats: Array.from({ length: 15 }, (_, i) => i * 2), onsets: [{ t: 7, s: 5 }] };
  it('snaps cuts to bars and adds beat markers and beat effects', () => {
    const r = run(
      { music: { src: 'asset:0123456789abcdef', snap: 'bar' }, scenes: [{ d: 2.3, layers: [{ type: 'rect', w: 10, h: 10, beat: 'pulse' }] }, { d: 3.1, layers: [] }] },
      { audioInfo: () => info, assetFile: () => '/dev/null' },
    );
    expect(r.errors).toEqual([]);
    expect(r.scenes.map((s) => s.d)).toEqual([2, 4]);
    expect(r.ir!.markers!.filter((m) => m.kind === 'beat' && m.name === 'downbeat').length).toBeGreaterThan(2);
    expect(find(r.ir!.layers, (l) => l.type === 'rect')!.anims.some((a) => a.n === 'beat:pulse')).toBe(true);
  });
});

describe('formats, pace, framing, templates', () => {
  it('adapts inline layers authored for another format with one uniform scale', () => {
    const r = run({ format: '9:16', adapt: { from: '16:9' }, scenes: [{ d: 2, layers: [{ type: 'rect', id: 'box', x: 1460, y: 540, w: 400, h: 200 }] }] });
    const box = find(r.ir!.layers, (l) => l.name === 'box' || l.id.endsWith(':box'))!;
    expect(box.x).toBeLessThan(1080);
    expect(box.scale).toBeCloseTo(0.5625, 3);
  });
  it('applies pace and framing', () => {
    const r = run({ pace: 0.5, framing: 1.2, scenes: [{ d: 4, layers: [] }] });
    expect(r.duration).toBe(2);
    expect(r.ir!.layers[0].scale).toBeCloseTo(1.2);
  });
  it('fills exposed params from props', () => {
    const r = run({ params: { who: 'string!' }, props: { who: 'Ada' }, scenes: [{ d: 1, layers: [{ type: 'text', text: 'Hi {{params.who}}' }] }] });
    expect(find(r.ir!.layers, (l) => l.type === 'text')!.text).toBe('Hi Ada');
  });
});

describe('3D', () => {
  it('builds stacks with explode offsets', () => {
    const r = run({ scenes: [{ d: 2, layers: [{ type: 'three', stack: { items: 3, step: [0, 0.3, 0], explode: [0, 1, 0] }, explode: { at: 0.5 } }] }] });
    const t = find(r.ir!.layers, (l) => l.type === 'three')!.data as any;
    expect(t.objects.map((o: any) => o.explode[1])).toEqual([-1, 0, 1]);
  });
});

describe('time maps', () => {
  it('maps parent frames to child frames', () => {
    expect(mapTime([[0, 10, 0, 20]], 5)).toBe(10);
  });
});
