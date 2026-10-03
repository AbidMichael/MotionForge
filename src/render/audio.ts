/**
 * Audio mixer. Every track is decoded to 48 kHz stereo float with ffmpeg, then mixed in JS:
 * per-track gain, fades, trims, loops, playback rate, music ducking under voice, loudness
 * normalisation (~-16 LUFS) and a peak limiter. The result is muxed into the rendered video.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Ctx } from '../core/context';
import { sha256 } from '../core/util';
import type { IRAudio, IRDoc } from '../ir/types';
import { ffmpeg } from './remotion';

const SR = 48000;
const decoded = new Map<string, Float32Array>();

async function localFile(ctx: Ctx, t: IRAudio): Promise<string> {
  if (t.file && fs.existsSync(t.file)) return t.file;
  if (/^https?:/.test(t.src)) {
    const f = path.join(ctx.paths.cache, 'audio-dl', sha256(t.src).slice(0, 20));
    if (!fs.existsSync(f)) {
      const res = await fetch(t.src);
      if (!res.ok) throw new Error(`audio download failed (${res.status}): ${t.src}`);
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, Buffer.from(await res.arrayBuffer()));
    }
    return f;
  }
  throw new Error(`audio source not found: ${t.src}`);
}

/** Interleaved stereo float32 at 48 kHz. */
export async function decode(ctx: Ctx, file: string): Promise<Float32Array> {
  const st = fs.statSync(file);
  const key = `${file}|${st.size}|${st.mtimeMs}`;
  const hit = decoded.get(key);
  if (hit) return hit;
  // Remotion's ffmpeg has the wav muxer and pcm_s16le, which is all we need
  const raw = path.join(ctx.paths.cache, 'audio-raw', sha256(key).slice(0, 24) + '.wav');
  if (!fs.existsSync(raw)) {
    fs.mkdirSync(path.dirname(raw), { recursive: true });
    await ffmpeg(['-hide_banner', '-loglevel', 'error', '-i', path.resolve(file), '-vn', '-ac', '2', '-ar', String(SR), '-c:a', 'pcm_s16le', '-f', 'wav', '-y', path.resolve(raw)]);
  }
  const buf = fs.readFileSync(raw);
  // find the "data" chunk
  let p = 12;
  let dataStart = 44;
  let dataLen = buf.length - 44;
  while (p + 8 <= buf.length) {
    const id = buf.toString('ascii', p, p + 4);
    const sz = buf.readUInt32LE(p + 4);
    if (id === 'data') {
      dataStart = p + 8;
      dataLen = Math.min(sz, buf.length - dataStart);
      break;
    }
    p += 8 + sz + (sz % 2);
  }
  const count = Math.floor(dataLen / 2);
  const out = new Float32Array(count);
  for (let i = 0; i < count; i++) out[i] = buf.readInt16LE(dataStart + i * 2) / 32768;
  if (decoded.size > 40) decoded.delete(decoded.keys().next().value!);
  decoded.set(key, out);
  return out;
}

const smooth = (x: number) => (x <= 0 ? 0 : x >= 1 ? 1 : 0.5 - 0.5 * Math.cos(Math.PI * x));

/** Mix the IR's tracks over [fromFrame, toFrame) into an interleaved stereo buffer. */
export async function mix(ctx: Ctx, ir: IRDoc, fromFrame = 0, toFrame = ir.duration): Promise<Float32Array> {
  const t0 = fromFrame / ir.fps;
  const n = Math.max(1, Math.round(((toFrame - fromFrame) / ir.fps) * SR));
  const bus = { music: new Float32Array(n * 2), voice: new Float32Array(n * 2), sfx: new Float32Array(n * 2) };
  let ducks = 0;
  for (const t of ir.audio ?? []) {
    let src: Float32Array;
    try {
      src = await decode(ctx, await localFile(ctx, t));
    } catch (e) {
      ctx.log(`audio: ${(e as Error).message}`);
      continue;
    }
    const srcFrames = src.length / 2;
    if (!srcFrames) continue;
    const rate = t.rate ?? 1;
    const start = t.from / ir.fps; // seconds (absolute)
    const end = (t.to ?? (t.loop ? ir.duration : t.from + Math.ceil(((srcFrames / SR) * ir.fps) / rate))) / ir.fps;
    const dur = Math.max(0, end - start);
    const trim = t.trim ?? 0;
    const fi = t.fadeIn ?? 0;
    const fo = t.fadeOut ?? (t.to !== undefined || t.loop ? 0.05 : 0);
    const out = bus[t.kind] ?? bus.sfx;
    if (t.kind === 'music' && t.duck) ducks = Math.max(ducks, t.duck);
    const i0 = Math.max(0, Math.round((start - t0) * SR));
    const i1 = Math.min(n, Math.round((end - t0) * SR));
    for (let i = i0; i < i1; i++) {
      const local = i / SR + t0 - start; // seconds into this track
      let pos = (trim + local * rate) * SR;
      if (pos >= srcFrames) {
        if (!t.loop) break;
        pos = pos % srcFrames;
      }
      const k = Math.floor(pos);
      const f = pos - k;
      const k2 = (k + 1) % srcFrames;
      let g = t.volume;
      if (fi > 0 && local < fi) g *= smooth(local / fi);
      if (fo > 0 && local > dur - fo) g *= smooth((dur - local) / fo);
      out[i * 2] += (src[k * 2] * (1 - f) + src[k2 * 2] * f) * g;
      out[i * 2 + 1] += (src[k * 2 + 1] * (1 - f) + src[k2 * 2 + 1] * f) * g;
    }
  }
  // ducking: follow the voice level, pull the music down while someone speaks
  if (ducks > 0) {
    const depth = 1 - Math.pow(10, -ducks / 20);
    const att = Math.exp(-1 / (0.03 * SR));
    const rel = Math.exp(-1 / (0.35 * SR));
    let env = 0;
    for (let i = 0; i < n; i++) {
      const v = Math.max(Math.abs(bus.voice[i * 2]), Math.abs(bus.voice[i * 2 + 1]));
      env = v > env ? att * env + (1 - att) * v : rel * env + (1 - rel) * v;
      const amt = Math.min(1, env / 0.05);
      const g = 1 - depth * amt;
      bus.music[i * 2] *= g;
      bus.music[i * 2 + 1] *= g;
    }
  }
  const outBuf = new Float32Array(n * 2);
  for (let i = 0; i < n * 2; i++) outBuf[i] = bus.music[i] + bus.voice[i] + bus.sfx[i];
  // loudness: gated RMS over 400 ms blocks towards -16 LUFS (approximation of BS.1770 without K-weighting)
  const block = Math.round(0.4 * SR);
  const powers: number[] = [];
  for (let s = 0; s + block <= n; s += Math.round(block / 4)) {
    let p = 0;
    for (let i = s; i < s + block; i++) p += outBuf[i * 2] ** 2 + outBuf[i * 2 + 1] ** 2;
    powers.push(p / (block * 2));
  }
  const gated = powers.filter((p) => 10 * Math.log10(p + 1e-12) > -70);
  if (gated.length) {
    const mean = gated.reduce((a, b) => a + b, 0) / gated.length;
    const rel = gated.filter((p) => p > mean * 0.1);
    const loud = 10 * Math.log10((rel.reduce((a, b) => a + b, 0) / Math.max(1, rel.length)) + 1e-12) - 0.691;
    const gain = Math.min(Math.pow(10, 12 / 20), Math.pow(10, (-16 - loud) / 20));
    for (let i = 0; i < outBuf.length; i++) outBuf[i] *= gain;
  }
  // look-ahead peak limiter at -1 dBFS
  const ceil = Math.pow(10, -1 / 20);
  const look = Math.round(0.005 * SR);
  const relLim = Math.exp(-1 / (0.08 * SR));
  let g = 1;
  const peaks = new Float32Array(n);
  for (let i = 0; i < n; i++) peaks[i] = Math.max(Math.abs(outBuf[i * 2]), Math.abs(outBuf[i * 2 + 1]));
  for (let i = 0; i < n; i++) {
    let p = 0;
    for (let k = i; k < Math.min(n, i + look); k += 8) p = Math.max(p, peaks[k]);
    const target = p > ceil ? ceil / p : 1;
    g = target < g ? target : relLim * g + (1 - relLim) * target;
    outBuf[i * 2] *= g;
    outBuf[i * 2 + 1] *= g;
  }
  return outBuf;
}

export function writeWav(file: string, inter: Float32Array) {
  const n = inter.length / 2;
  const buf = Buffer.alloc(44 + n * 4);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + n * 4, 4);
  buf.write('WAVEfmt ', 8);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(2, 22);
  buf.writeUInt32LE(SR, 24);
  buf.writeUInt32LE(SR * 4, 28);
  buf.writeUInt16LE(4, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(n * 4, 40);
  for (let i = 0; i < inter.length; i++) buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(inter[i] * 32767))), 44 + i * 2);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, buf);
}

/** Mix the audio for a frame range and put it into an existing video file (replacing it in place). */
export async function mixInto(ctx: Ctx, ir: IRDoc, video: string, fromFrame = 0, toFrame = ir.duration) {
  if (!ir.audio?.length) return false;
  const wav = video.replace(/\.[a-z0-9]+$/i, '') + '.mix.wav';
  writeWav(wav, await mix(ctx, ir, fromFrame, toFrame));
  const tmp = video.replace(/(\.[a-z0-9]+)$/i, '.withaudio$1');
  const isWebm = /\.webm$/i.test(video);
  const isMov = /\.mov$/i.test(video);
  await ffmpeg([
    '-hide_banner', '-loglevel', 'error', '-i', path.resolve(video), '-i', path.resolve(wav),
    '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy',
    ...(isWebm ? ['-c:a', 'libopus', '-b:a', '160k'] : isMov ? ['-c:a', 'pcm_s16le'] : ['-c:a', 'aac', '-b:a', '192k']),
    '-shortest', ...(isWebm || isMov ? [] : ['-movflags', '+faststart']), '-y', path.resolve(tmp),
  ]);
  fs.renameSync(tmp, video);
  fs.rmSync(wav, { force: true });
  return true;
}
