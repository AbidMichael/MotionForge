/**
 * Music montage. With "music": {"src": "asset:<id>", "snap": "bar"} the cuts between scenes move
 * onto the nearest beat / bar / phrase / hit of the analysed track; beats become markers
 * ("@beat:8", "@bar:2", "@hit:1", audio "on": "beats") and layers can react to them:
 *   "beat": "pulse" | {"kind": "flash", "every": 2, "on": "bar", "amount": 1.5}
 * snap may also be {"to": "bar", "end": true, "tolerance": 0.6}.
 */
import { isObj } from '../../core/util';
import type { IRAnim, IRLayer, IRMarker, Keyframe } from '../../ir/types';
import type { AudioInfo, Session } from '../compile';
import { hooks, registerDocPass } from '../registry';

function musicInfo(S: Session, comp: Record<string, any>, warn: boolean): { info: AudioInfo; trim: number } | null {
  const m = comp.music;
  if (!isObj(m) || typeof m.src !== 'string') return null;
  const a = /^asset:([a-f0-9]{8,64})$/.exec(m.src);
  if (!a) {
    if (warn && m.snap) S.warn('music.snap', 'beat snapping needs an uploaded track ("asset:<id>")');
    return null;
  }
  const info = S.opts.audioInfo?.(a[1]) ?? null;
  if (!info) {
    if (warn) S.warn('music', 'the track is being analysed for beats; validate again in a few seconds (or call mf_audio) to snap cuts and get beat markers');
    return null;
  }
  return { info, trim: Number(m.trim ?? 0) };
}

function gridOf(info: AudioInfo, to: string): number[] {
  if (to === 'beat') return info.beats;
  if (to === 'phrase') return info.downbeats.filter((_, i) => i % 4 === 0);
  if (to === 'hit') return info.onsets.map((o) => o.t);
  return info.downbeats;
}

hooks.snap = (S, comp, plan) => {
  const mi = musicInfo(S, comp, true);
  if (!mi) return null;
  const spec = isObj(comp.music.snap) ? comp.music.snap : { to: comp.music.snap };
  const to = String(spec.to ?? 'bar');
  if (!['beat', 'bar', 'phrase', 'hit'].includes(to)) {
    S.err('music.snap', 'snap is "beat", "bar", "phrase", "hit" or {"to", "end", "tolerance"}');
    return null;
  }
  const fps = S.fps;
  const grid = gridOf(mi.info, to).map((t) => Math.round((t - mi.trim) * fps)).filter((f) => f > 0);
  if (grid.length < 2) {
    S.warn('music.snap', `the track has too few ${to}s to snap to`);
    return null;
  }
  const tol = Number(spec.tolerance ?? 0.6); // max relative change of a scene's length
  const frames = [...plan.frames];
  let start = 0;
  let moved = 0;
  for (let i = 0; i < frames.length; i++) {
    const ov = plan.overlaps[i] ?? 0;
    const last = i === frames.length - 1;
    if (last && spec.end === false) break;
    // the visible cut is the middle of the transition (or the end of the last scene)
    const cut = last ? start + frames[i] : start + frames[i] - ov / 2;
    let best: number | null = null;
    for (const g of grid) {
      const len = last ? g - start : g + ov / 2 - start;
      if (len < Math.max(plan.mins[i], ov + 2)) continue;
      if (Math.abs(len - frames[i]) > frames[i] * tol) continue;
      if (best === null || Math.abs(g - cut) < Math.abs(best - cut)) best = g;
    }
    if (best !== null) {
      const len = Math.round(last ? best - start : best + ov / 2 - start);
      if (len !== frames[i]) moved++;
      frames[i] = len;
    }
    start += frames[i] - ov;
  }
  return moved ? frames : null;
};

const BEAT_FX: Record<string, (a: number) => Record<string, Keyframe[]>> = {
  pulse: (a) => ({ scale: [[0, 1], [0.12, 1 + 0.07 * a, 'out'], [1, 1, 'inOut']] }),
  flash: (a) => ({ brightness: [[0, 1 + 0.7 * a], [1, 1, 'out']] }),
  shake: (a) => ({ dx: [[0, 0], [0.12, 9 * a], [0.3, -7 * a], [0.5, 4 * a], [0.75, -2 * a], [1, 0]] }),
  bounce: (a) => ({ dy: [[0, 0], [0.3, -16 * a, 'out'], [1, 0, 'outBounce']] }),
  blink: (a) => ({ opacity: [[0, 1], [0.05, Math.max(0, 1 - 0.8 * a)], [0.6, 1, 'out']] }),
};

registerDocPass({
  name: 'music',
  order: 10,
  run(S, { ir, comp }) {
    const mi = musicInfo(S, comp, false);
    if (!mi) return;
    const fps = ir.fps;
    const toF = (t: number) => Math.round((t - mi.trim) * fps);
    const down = new Set(mi.info.downbeats.map(toF));
    const markers: IRMarker[] = [];
    const beatFrames = mi.info.beats.map(toF).filter((f) => f >= 0 && f < ir.duration);
    for (const f of beatFrames) markers.push({ t: f, kind: 'beat', name: down.has(f) ? 'downbeat' : 'beat' });
    for (const o of mi.info.onsets) {
      const f = toF(o.t);
      if (f >= 0 && f < ir.duration) markers.push({ t: f, kind: 'beat', name: 'hit' });
    }
    ir.markers = [...(ir.markers ?? []), ...markers].sort((a, b) => a.t - b.t);
    const period = beatFrames.length > 1 ? (beatFrames[beatFrames.length - 1] - beatFrames[0]) / (beatFrames.length - 1) : fps / 2;
    // beat-reactive layers
    const walk = (l: IRLayer, abs: number) => {
      const a0 = abs + l.from;
      const fx = l.fx?.beat;
      if (fx && BEAT_FX[fx.kind]) {
        const on = fx.on === 'bar' ? 'bar' : fx.on === 'hit' ? 'hit' : 'beat';
        const list = on === 'hit' ? markers.filter((m) => m.name === 'hit') : markers.filter((m) => m.name !== 'hit' && (on === 'beat' || m.name === 'downbeat'));
        const span = Math.max(3, Math.round(Math.min(on === 'beat' ? period * 0.9 : period * 2, fps * 0.45)));
        const every = Math.max(1, Math.round(fx.every || 1));
        let k = 0;
        for (const m of list) {
          if (m.t < a0 || m.t >= abs + l.to) continue;
          if (k++ % every) continue;
          const s = m.t - a0;
          const anim: IRAnim = { s, e: Math.min(l.to - l.from, s + span), tracks: BEAT_FX[fx.kind](fx.amount || 1), n: `beat:${fx.kind}` };
          if (anim.e > anim.s) l.anims.push(anim);
        }
      }
      if (l.time) return; // remapped time inside sub-compositions
      l.children?.forEach((c) => walk(c, a0));
    };
    ir.layers.forEach((l) => walk(l, 0));
  },
});
