/**
 * Music analysis for montage: onset envelope (spectral flux), tempo (autocorrelation with a
 * preference around 120 BPM), beat tracking (dynamic programming, Ellis 2007), downbeats (4/4,
 * phase with the strongest low-end onsets), hits (strong isolated onsets) and an energy curve.
 * Results are cached per file in data/cache/audio-info/<key>.json and read synchronously by the compiler.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Ctx } from '../core/context';
import type { AudioInfo } from '../dsl/compile';
import { decode } from './audio';

const SR = 48000;
const HOP = 512;
const WIN = 2048;
const FPS_ENV = SR / HOP; // onset envelope frames per second (93.75)

function fft(re: Float64Array, im: Float64Array) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k;
        const b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci;
        const ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
        const nr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = nr;
      }
    }
  }
}

/** Onset strength (full band and low band) and RMS per hop. */
function envelopes(mono: Float32Array) {
  const frames = Math.max(1, Math.floor((mono.length - WIN) / HOP) + 1);
  const win = new Float64Array(WIN);
  for (let i = 0; i < WIN; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / WIN);
  const bins = WIN / 2;
  // ~40 log-spaced bands
  const bandOf = new Int16Array(bins);
  const NB = 40;
  for (let k = 0; k < bins; k++) {
    const f = (k * SR) / WIN;
    bandOf[k] = f < 30 ? -1 : Math.min(NB - 1, Math.floor((Math.log2(f / 30) / Math.log2(16000 / 30)) * NB));
  }
  const lowBands = Math.floor((Math.log2(200 / 30) / Math.log2(16000 / 30)) * NB);
  let prev = new Float64Array(NB);
  const onset = new Float32Array(frames);
  const low = new Float32Array(frames);
  const rms = new Float32Array(frames);
  const re = new Float64Array(WIN);
  const im = new Float64Array(WIN);
  for (let f = 0; f < frames; f++) {
    const off = f * HOP;
    let e = 0;
    for (let i = 0; i < WIN; i++) {
      const v = mono[off + i] ?? 0;
      e += v * v;
      re[i] = v * win[i];
      im[i] = 0;
    }
    rms[f] = Math.sqrt(e / WIN);
    fft(re, im);
    const band = new Float64Array(NB);
    for (let k = 1; k < bins; k++) {
      const b = bandOf[k];
      if (b >= 0) band[b] += Math.sqrt(re[k] * re[k] + im[k] * im[k]);
    }
    let s = 0;
    let sl = 0;
    for (let b = 0; b < NB; b++) {
      const lv = Math.log1p(100 * band[b]);
      const d = lv - Math.log1p(100 * prev[b]);
      if (d > 0) {
        s += d;
        if (b < lowBands) sl += d;
      }
    }
    onset[f] = s;
    low[f] = sl;
    prev = band;
  }
  // remove slow trend and normalise
  const norm = (x: Float32Array) => {
    const w = Math.round(FPS_ENV * 1.5);
    const out = new Float32Array(x.length);
    let acc = 0;
    const q: number[] = [];
    for (let i = 0; i < x.length; i++) {
      q.push(x[i]);
      acc += x[i];
      if (q.length > w) acc -= q.shift()!;
      out[i] = Math.max(0, x[i] - acc / q.length);
    }
    let sd = 0;
    for (const v of out) sd += v * v;
    sd = Math.sqrt(sd / Math.max(1, out.length)) || 1;
    for (let i = 0; i < out.length; i++) out[i] /= sd;
    return out;
  };
  return { onset: norm(onset), low: norm(low), rms };
}

function estimateTempo(env: Float32Array): number {
  const minLag = Math.round((60 / 200) * FPS_ENV);
  const maxLag = Math.round((60 / 55) * FPS_ENV);
  let best = 0;
  let bestLag = Math.round((60 / 120) * FPS_ENV);
  const n = env.length;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let s = 0;
    for (let i = lag; i < n; i++) s += env[i] * env[i - lag];
    s /= n - lag;
    const bpm = (60 * FPS_ENV) / lag;
    const w = Math.exp(-0.5 * (Math.log2(bpm / 120) / 0.9) ** 2);
    if (s * w > best) {
      best = s * w;
      bestLag = lag;
    }
  }
  return (60 * FPS_ENV) / bestLag;
}

function trackBeats(env: Float32Array, bpm: number): number[] {
  const period = (60 / bpm) * FPS_ENV;
  const n = env.length;
  const score = new Float64Array(n);
  const back = new Int32Array(n).fill(-1);
  const alpha = 100;
  for (let i = 0; i < n; i++) {
    let best = 0;
    let arg = -1;
    const lo = Math.max(0, Math.round(i - 2 * period));
    const hi = Math.round(i - period / 2);
    for (let j = lo; j <= hi; j++) {
      const pen = -alpha * Math.log((i - j) / period) ** 2;
      const v = score[j] + pen;
      if (v > best || arg < 0) {
        best = v;
        arg = j;
      }
    }
    score[i] = env[i] + (arg >= 0 ? Math.max(0, best) : 0);
    back[i] = arg >= 0 && best > 0 ? arg : -1;
  }
  // start from the best score in the last period
  let i = n - 1;
  let bestEnd = -Infinity;
  for (let k = Math.max(0, Math.round(n - period)); k < n; k++) if (score[k] > bestEnd) {
    bestEnd = score[k];
    i = k;
  }
  const beats: number[] = [];
  while (i >= 0) {
    beats.push(i);
    i = back[i];
  }
  beats.reverse();
  // extend to the start with the period if the tracker stopped early
  while (beats.length && beats[0] - period > 0) beats.unshift(Math.round(beats[0] - period));
  return beats;
}

export async function analyzeFile(ctx: Ctx, file: string): Promise<AudioInfo> {
  const inter = await decode(ctx, file);
  const n = inter.length / 2;
  const mono = new Float32Array(n);
  for (let i = 0; i < n; i++) mono[i] = (inter[i * 2] + inter[i * 2 + 1]) / 2;
  const duration = n / SR;
  if (duration < 1) return { duration, bpm: 0, beats: [], downbeats: [], onsets: [] };
  const { onset, low, rms } = envelopes(mono);
  let bpm = estimateTempo(onset);
  const beatFrames = trackBeats(onset, bpm);
  const beats = beatFrames.map((f) => +((f * HOP + WIN / 2) / SR).toFixed(3)).filter((t) => t < duration);
  if (beats.length > 4) {
    const ints = beats.slice(1).map((t, i) => t - beats[i]).sort((a, b) => a - b);
    bpm = 60 / ints[Math.floor(ints.length / 2)];
  }
  // downbeat phase: the phase whose beats carry the most low-end attack and energy
  const at = (arr: Float32Array, t: number) => {
    const f = Math.round(t * FPS_ENV - WIN / 2 / HOP);
    let m = 0;
    for (let k = f - 2; k <= f + 2; k++) m = Math.max(m, arr[k] ?? 0);
    return m;
  };
  let phase = 0;
  let bestP = -1;
  for (let p = 0; p < 4; p++) {
    let s = 0;
    for (let b = p; b < beats.length; b += 4) s += at(low, beats[b]) * 1.5 + at(onset, beats[b]);
    if (s > bestP) {
      bestP = s;
      phase = p;
    }
  }
  const downbeats = beats.filter((_, i) => i >= phase && (i - phase) % 4 === 0);
  // strong onsets ("hits"): local maxima well above the average
  const onsets: { t: number; s: number }[] = [];
  const minGap = Math.round(0.2 * FPS_ENV);
  for (let f = 1; f < onset.length - 1; f++) {
    const v = onset[f];
    if (v < 2.2 || v < onset[f - 1] || v < onset[f + 1]) continue;
    const t = (f * HOP + WIN / 2) / SR;
    const last = onsets[onsets.length - 1];
    if (last && f - Math.round(last.t * FPS_ENV - WIN / 2 / HOP) < minGap) {
      if (v > last.s) {
        last.t = +t.toFixed(3);
        last.s = +v.toFixed(2);
      }
      continue;
    }
    onsets.push({ t: +t.toFixed(3), s: +v.toFixed(2) });
  }
  onsets.sort((a, b) => b.s - a.s);
  const hits = onsets.slice(0, Math.max(4, Math.round(duration / 4))).sort((a, b) => a.t - b.t);
  // energy per bar (0..1)
  const sections: { t: number; energy: number }[] = [];
  const marks = downbeats.length > 1 ? downbeats : Array.from({ length: Math.ceil(duration / 2) }, (_, i) => i * 2);
  let maxE = 0;
  for (let i = 0; i < marks.length; i++) {
    const a = Math.floor(marks[i] * FPS_ENV);
    const b = Math.min(rms.length, Math.floor((marks[i + 1] ?? duration) * FPS_ENV));
    let s = 0;
    for (let k = a; k < b; k++) s += rms[k];
    const e = b > a ? s / (b - a) : 0;
    maxE = Math.max(maxE, e);
    sections.push({ t: +marks[i].toFixed(3), energy: e });
  }
  for (const s of sections) s.energy = +(maxE ? s.energy / maxE : 0).toFixed(3);
  return { duration: +duration.toFixed(3), bpm: +bpm.toFixed(2), beats, downbeats, onsets: hits, sections };
}

function infoPath(ctx: Ctx, assetId: string) {
  return path.join(ctx.paths.cache, 'audio-info', `${assetId}.json`);
}

/** Cached analysis of an audio asset (sync), or null when it hasn't been analysed yet. */
export function readAudioInfo(ctx: Ctx, assetId: string): AudioInfo | null {
  const f = infoPath(ctx, assetId);
  if (!fs.existsSync(f)) return null;
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch {
    return null;
  }
}

const running = new Map<string, Promise<AudioInfo>>();

export function analyzeAsset(ctx: Ctx, assetId: string, force = false): Promise<AudioInfo> {
  const id = assetId.replace(/^asset:/, '');
  if (!force) {
    const hit = readAudioInfo(ctx, id);
    if (hit) return Promise.resolve(hit);
  }
  const r = running.get(id);
  if (r) return r;
  const p = (async () => {
    const row = ctx.assets.get(id);
    if (!/^(audio|video)\//.test(row.mime)) throw new Error(`asset ${id} is ${row.mime}, not audio`);
    const info = await analyzeFile(ctx, row.path);
    fs.mkdirSync(path.dirname(infoPath(ctx, id)), { recursive: true });
    fs.writeFileSync(infoPath(ctx, id), JSON.stringify(info));
    return info;
  })().finally(() => running.delete(id));
  running.set(id, p);
  return p;
}

/** Suggested cut points: downbeats grouped into phrases, plus the strongest hits. */
export function cutSuggestions(info: AudioInfo, every: 'beat' | 'bar' | 'phrase' = 'bar') {
  const grid = every === 'beat' ? info.beats : every === 'bar' ? info.downbeats : info.downbeats.filter((_, i) => i % 4 === 0);
  return { grid, hits: info.onsets.map((o) => o.t) };
}
