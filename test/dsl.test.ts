import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { compile, parseFormat, presetExample } from '../src/dsl/compile';
import { evaluate } from '../src/dsl/expr';
import { parseParamShorthand } from '../src/dsl/schema';
import { motionSummary } from '../src/dsl/summary';
import { evaluateAnims } from '../src/ir/evaluate';
import { LibraryStore, SYSTEM_AGENT } from '../src/registry/store';
import { segmentRanges } from '../src/render/segments';

const store = new LibraryStore(path.resolve('libraries'));
store.scan();
const opts = { store, defaultFormat: '1920x1080@30', defaultTheme: 'core:dark', assetUrl: () => null };
const run = (composition: unknown) => compile({ composition, agent: SYSTEM_AGENT }, opts);

describe('expressions', () => {
  it('evaluates arithmetic, ternaries, functions and objects', () => {
    expect(evaluate('W / 2 - 10', { W: 1920 })).toBe(950);
    expect(evaluate("sub ? 'a' : 'b'", { sub: '' })).toBe('b');
    expect(evaluate('upper(t) + "!"', { t: 'hi' })).toBe('HI!');
    expect(evaluate("{p: 'core:fade-in', d: 0.4}", {})).toEqual({ p: 'core:fade-in', d: 0.4 });
    expect(evaluate('maxOf(d, "v")', { d: [{ v: 2 }, { v: 9 }] })).toBe(9);
    expect(evaluate('rand(3, 1)', {})).toBe(evaluate('rand(3, 1)', {}));
  });
  it('refuses prototype access and unknown names', () => {
    expect(() => evaluate('x.constructor', { x: {} })).toThrow();
    expect(() => evaluate('nope', {})).toThrow(/unknown name/);
  });
});

describe('param shorthand', () => {
  it('parses required, defaults, enums and arrays', () => {
    expect(parseParamShorthand('string!')).toEqual({ type: 'string', required: true });
    expect(parseParamShorthand('number=0.5')).toEqual({ type: 'number', default: 0.5 });
    expect(parseParamShorthand('enum:a|b=b')).toEqual({ type: 'enum', values: ['a', 'b'], default: 'b' });
    expect(parseParamShorthand('array<string>!')).toEqual({ type: 'array', items: 'string', required: true });
    expect(parseParamShorthand('string=> ')).toEqual({ type: 'string', default: '> ' });
  });
});

describe('compiler', () => {
  it('has no broken core presets', () => {
    expect(store.loadIssues).toEqual([]);
  });
  it('parses formats', () => {
    expect(parseFormat('9:16@60')).toEqual({ width: 1080, height: 1920, fps: 60 });
    expect(parseFormat('nope')).toBeNull();
  });
  it('compiles scenes and overlaps transitions', () => {
    const r = run({ scenes: [{ p: 'core:title-card', title: 'Hi', d: 3 }, { t: 'core:crossfade', d: 0.5 }, { p: 'core:stat', value: 5, label: 'x', d: 2 }] });
    expect(r.errors).toEqual([]);
    expect(r.duration).toBe(4.5);
    expect(r.ir!.scenes.map((s) => [s.start, s.end])).toEqual([[0, 90], [75, 135]]);
    expect(motionSummary(r.ir!)).toContain('core:crossfade');
  });
  it('reports unknown params with suggestions and keeps going', () => {
    const r = run({ scenes: [{ p: 'core:stat', value: 3, labl: 'x' }] });
    expect(r.ok).toBe(false);
    expect(r.errors.map((e) => e.msg).join('\n')).toMatch(/did you mean 'label'/);
  });
  it('suggests close preset ids', () => {
    const r = run({ scenes: [{ p: 'core:title-crad', title: 'x' }] });
    expect(r.errors[0].msg).toMatch(/did you mean core:title-card/);
  });
  it('scales scene duration with words', () => {
    const short = run({ scenes: [{ p: 'core:statement', text: 'Two words' }] });
    const long = run({ scenes: [{ p: 'core:statement', text: 'This sentence has quite a lot more words in it' }] });
    expect(long.duration).toBeGreaterThan(short.duration);
  });
  it('expands repeat, if and tokens', () => {
    const r = run({ scenes: [{ d: 1, layers: [{ repeat: 3, layer: { type: 'rect', x: '{{index * 100}}', fill: '$color.accent' } }, { if: '{{false}}', type: 'rect' }] }] });
    expect(r.errors).toEqual([]);
    const kids = r.ir!.layers[0].children!;
    expect(kids.map((k) => k.x)).toEqual([0, 100, 200]);
    expect(kids[0].style.fill).toBe('#7c8cff');
  });
  it('pins library versions in the lockfile', () => {
    const r = run({ use: ['@core/kinetic@^1'], scenes: [{ p: 'kinetic:title-slam', text: 'Go' }] });
    expect(r.lock).toMatchObject({ '@core/base': '1.1.0', '@core/kinetic': '1.0.0' });
  });
  it('compiles every core preset through its example', () => {
    for (const name of ['@core/base', '@core/kinetic']) {
      const lv = store.latest(name)!;
      for (const p of lv.presets.values()) {
        const r = run(presetExample(lv, p, opts, SYSTEM_AGENT));
        expect(r.errors, `${name}/${p.slug}`).toEqual([]);
      }
    }
  });
});

describe('player maths', () => {
  it('multiplies and adds channels', () => {
    const st = evaluateAnims([{ s: 0, e: 10, tracks: { opacity: [[0, 0], [1, 1]], dx: [[0, 100], [1, 0]] } }], 5);
    expect(st.opacity).toBeCloseTo(0.5);
    expect(st.dx).toBeCloseTo(50);
  });
});

describe('segments', () => {
  it('only changes the hash of edited scenes', () => {
    const a = run({ scenes: [{ p: 'core:statement', text: 'One', d: 2 }, { p: 'core:statement', text: 'Two', d: 2 }] }).ir!;
    const b = run({ scenes: [{ p: 'core:statement', text: 'One', d: 2 }, { p: 'core:statement', text: 'Changed', d: 2 }] }).ir!;
    const sa = segmentRanges(a, 'q');
    const sb = segmentRanges(b, 'q');
    expect(sa[0].hash).toBe(sb[0].hash);
    expect(sa[1].hash).not.toBe(sb[1].hash);
  });
});
