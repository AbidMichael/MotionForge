/**
 * Integrated audio. Composition:
 *  "music": {"src": "asset:<id>", "volume": 0.8, "fadeIn": 0.5, "fadeOut": 1.5, "trim": 0, "duck": 8, "snap": "beat|bar|phrase"},
 *  "audio": [
 *    {"src": "asset:<id>", "kind": "voice", "at": "@scene:2+0.3", "volume": "-3dB"},
 *    {"src": "whoosh", "on": "transitions"},          ← one sound per event: transitions, clicks, typing, drags, scenes, states, beats, downbeats, hits
 *    {"src": "pop", "at": "@click:2"}, {"src": "impact", "at": "@beat:16"}
 *  ]
 * and per layer: "sfx": "pop" (plays when the layer enters), per transition: "sfx": "whoosh",
 * per art direction: {"sfx": {"transitions": "whoosh", "clicks": "click"}}.
 * Music ducks under voice tracks. Times resolve against the markers of the timeline.
 */
import { isObj } from '../../core/util';
import type { IRAudio, IRDoc, IRLayer, IRMarker } from '../../ir/types';
import type { Session } from '../compile';
import { registerDocPass, type SceneCtx } from '../registry';
import { SFX_NAMES } from '../../render/sfx';

export const EVENT_KINDS: Record<string, (m: IRMarker) => boolean> = {
  transitions: (m) => m.kind === 'transition',
  clicks: (m) => m.kind === 'click',
  typing: (m) => m.kind === 'type',
  drags: (m) => m.kind === 'drag',
  scenes: (m) => m.kind === 'scene',
  states: (m) => m.kind === 'state',
  beats: (m) => m.kind === 'beat' && m.name !== 'hit',
  downbeats: (m) => m.kind === 'beat' && m.name === 'downbeat',
  hits: (m) => m.kind === 'beat' && m.name === 'hit',
};

const KIND_OF_AT: Record<string, string> = { scene: 'scenes', transition: 'transitions', click: 'clicks', type: 'typing', drag: 'drags', state: 'states', beat: 'beats', bar: 'downbeats', hit: 'hits' };

export function gainOf(v: unknown, path: string, S: Session): number {
  if (v === undefined) return 1;
  if (typeof v === 'number') return v;
  const m = /^(-?\d*\.?\d+)\s*db$/i.exec(String(v).trim());
  if (m) return Math.pow(10, Number(m[1]) / 20);
  S.err(path, 'volume is a number (1 = unchanged) or decibels like "-6dB"');
  return 1;
}

/** "@scene:2+0.5", "@click:3", "@beat:16", "@end-2", or seconds → absolute frame. */
export function resolveAt(S: Session, ir: IRDoc, v: unknown, path: string): number | null {
  if (v === undefined) return 0;
  if (typeof v === 'number') return Math.round(v * ir.fps);
  const s = String(v).trim();
  let m = /^@end\s*(?:-\s*(\d*\.?\d+))?$/.exec(s);
  if (m) return ir.duration - Math.round(Number(m[1] ?? 0) * ir.fps);
  m = /^@([a-z]+):(\d+)\s*(?:([+-])\s*(\d*\.?\d+))?$/.exec(s);
  if (!m) {
    S.err(path, `bad time ${JSON.stringify(v)} — seconds, "@scene:2", "@transition:1", "@click:3", "@type:1", "@beat:8", "@bar:2", "@hit:1", "@end-2", with an optional "+0.5"`);
    return null;
  }
  const kind = KIND_OF_AT[m[1]];
  if (!kind) {
    S.err(path, `unknown event "${m[1]}" (scene, transition, click, type, drag, state, beat, bar, hit)`);
    return null;
  }
  const list = (ir.markers ?? []).filter(EVENT_KINDS[kind]);
  const mk = list[Number(m[2]) - 1];
  if (!mk) {
    S.err(path, `there is no ${m[1]} #${m[2]} (${list.length} found)${['beats', 'downbeats', 'hits'].includes(kind) ? ' — beats come from "music" once it has been analysed' : ''}`);
    return null;
  }
  const off = m[3] ? (m[3] === '-' ? -1 : 1) * Number(m[4]) : 0;
  return Math.max(0, Math.round(mk.t + off * ir.fps));
}

export function resolveSrc(S: Session, src: unknown, path: string): { src: string; file: string | null } | null {
  if (typeof src !== 'string' || !src) {
    S.err(path, 'src is a built-in sound ("whoosh", "click", "pop"…), "asset:<id>" or an https URL');
    return null;
  }
  const a = /^asset:([a-f0-9]{8,64})$/.exec(src);
  if (a) {
    if (!S.opts.assetFile) return { src, file: null }; // no asset store (offline compile)
    const file = S.opts.assetFile(a[1]);
    if (!file) {
      S.err(path, `unknown asset ${src} — upload it with mf_asset_put`);
      return null;
    }
    return { src, file };
  }
  if (/^https?:/.test(src)) return { src, file: null };
  if (!S.opts.sfxFile && SFX_NAMES.includes(src.replace(/^sfx:/, ''))) return { src: src.startsWith('sfx:') ? src : `sfx:${src}`, file: null };
  const file = S.opts.sfxFile?.(src) ?? null;
  if (file) return { src: src.startsWith('sfx:') ? src : `sfx:${src}`, file };
  S.err(path, `unknown sound "${src}" (built-in: whoosh, swoosh, swipe, click, tick, typing, pop, impact, rise, ding, success, error, glitch, bass)`);
  return null;
}

function track(S: Session, ir: IRDoc, a: Record<string, any>, from: number, path: string, defaults: Partial<IRAudio> = {}): IRAudio | null {
  const src = resolveSrc(S, a.src, `${path}.src`);
  if (!src) return null;
  const kind = a.kind ?? defaults.kind ?? (src.src.startsWith('sfx:') ? 'sfx' : 'music');
  if (!['music', 'sfx', 'voice'].includes(kind)) {
    S.err(`${path}.kind`, 'kind is music, sfx or voice');
    return null;
  }
  const t: IRAudio = {
    kind,
    src: src.src,
    file: src.file ?? undefined,
    from,
    volume: gainOf(a.volume ?? defaults.volume, `${path}.volume`, S),
  };
  if (a.d !== undefined) t.to = from + Math.round(Number(a.d) * ir.fps);
  else if (defaults.to !== undefined) t.to = defaults.to;
  for (const k of ['fadeIn', 'fadeOut', 'trim', 'rate'] as const) {
    const v = a[k] ?? defaults[k];
    if (v !== undefined) t[k] = Number(v);
  }
  if (a.loop ?? defaults.loop) t.loop = true;
  if (kind === 'music') {
    const d = a.duck ?? defaults.duck;
    if (d !== undefined && d !== false) t.duck = Number(d === true ? 8 : d);
  }
  return t;
}

/** Absolute start frames of every layer with a sound effect. */
function layerSounds(scenes: SceneCtx[], starts: number[]): { at: number; sfx: { name: string; at: number; gain: number }; path: string }[] {
  const out: { at: number; sfx: { name: string; at: number; gain: number }; path: string }[] = [];
  const walk = (l: IRLayer, abs: number, path: string) => {
    const a = abs + l.from;
    if (l.fx?.sfx) out.push({ at: a + l.fx.sfx.at, sfx: l.fx.sfx, path });
    if (l.time) return; // inside sub-compositions times are remapped; their sounds come through markers
    l.children?.forEach((k) => walk(k, a, path));
  };
  scenes.forEach((sc, i) => walk(sc.group, starts[i], sc.path));
  return out;
}

registerDocPass({
  name: 'audio',
  order: 20,
  run(S, { ir, comp, scenes, starts }) {
    const tracks: IRAudio[] = [];
    // music bed
    if (comp.music !== undefined && comp.music !== null) {
      if (!isObj(comp.music)) S.err('music', 'music is {"src": "asset:<id>", "volume", "fadeIn", "fadeOut", "trim", "duck", "snap"}');
      else {
        const m = comp.music;
        const t = track(S, ir, { ...m, kind: 'music' }, 0, 'music', { volume: 0.8, fadeIn: 0.4, fadeOut: 1.5, loop: true, to: ir.duration });
        if (t) {
          if (m.duck === undefined) t.duck = 8;
          if (m.duck === false) delete t.duck;
          tracks.push(t);
        }
      }
    }
    // explicit tracks
    const list = comp.audio === undefined ? [] : Array.isArray(comp.audio) ? comp.audio : null;
    if (!list) S.err('audio', 'audio must be an array of tracks');
    (list ?? []).forEach((a: unknown, i: number) => {
      const p = `audio[${i}]`;
      if (!isObj(a)) return S.err(p, 'audio track must be an object');
      if (a.on !== undefined) {
        const sel = EVENT_KINDS[String(a.on)];
        if (!sel) return S.err(`${p}.on`, `on is one of ${Object.keys(EVENT_KINDS).join(', ')}`);
        const ms = (ir.markers ?? []).filter(sel);
        const every = Math.max(1, Number(a.every ?? 1));
        const off = Math.round(Number(a.offset ?? 0) * ir.fps);
        ms.forEach((mk, k) => {
          if (k % every) return;
          const defaults: Partial<IRAudio> = { kind: 'sfx' };
          // typing loops the sound for as long as the typing lasts
          if (mk.kind === 'type' && mk.d) Object.assign(defaults, { loop: true, to: mk.t + off + mk.d });
          const t = track(S, ir, a, Math.max(0, mk.t + off), p, defaults);
          if (t) tracks.push(t);
        });
        return;
      }
      const at = resolveAt(S, ir, a.at, `${p}.at`);
      if (at === null) return;
      const t = track(S, ir, a, at, p);
      if (t) tracks.push(t);
    });
    // sounds attached to layers, transitions and sub-compositions
    for (const ls of layerSounds(scenes, starts)) {
      const t = track(S, ir, { src: ls.sfx.name, volume: ls.sfx.gain }, Math.max(0, ls.at), `${ls.path}.sfx`, { kind: 'sfx' });
      if (t) tracks.push(t);
    }
    for (const mk of ir.markers ?? []) {
      if (!mk.sfx) continue;
      const t = track(S, ir, { src: mk.sfx, volume: mk.gain ?? 1 }, Math.max(0, mk.t), `markers.${mk.kind}`, { kind: 'sfx' });
      if (t) tracks.push(t);
    }
    // art direction's default sounds
    const dir = S.scratch.direction as { sfx?: Record<string, string>; id: string } | undefined;
    if (dir?.sfx && comp.sfx !== false) {
      for (const [on, src] of Object.entries(dir.sfx)) {
        const sel = EVENT_KINDS[on];
        if (!sel) continue;
        for (const mk of (ir.markers ?? []).filter(sel)) {
          const defaults: Partial<IRAudio> = { kind: 'sfx', volume: 0.7 };
          if (mk.kind === 'type' && mk.d) Object.assign(defaults, { loop: true, to: mk.t + mk.d });
          const t = track(S, ir, { src }, mk.t, `direction(${dir.id}).sfx.${on}`, defaults);
          if (t) tracks.push(t);
        }
      }
    }
    for (const t of tracks) {
      if (t.from >= ir.duration) S.warn('audio', `a ${t.kind} track (${t.src}) starts after the video ends`);
    }
    if (tracks.length) ir.audio = tracks.filter((t) => t.from < ir.duration);
  },
});
