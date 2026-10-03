/**
 * Built-in sound effects, synthesised (no samples to license, deterministic, offline).
 * Generated once into data/sfx/<name>.wav.
 */
import fs from 'node:fs';
import path from 'node:path';

const SR = 48000;

function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) / 4294967296) * 2 - 1;
  };
}

/** One-pole low/high pass and a simple state-variable band pass. */
function lowpass(x: Float32Array, cutoff: (i: number) => number) {
  let y = 0;
  for (let i = 0; i < x.length; i++) {
    const a = 1 - Math.exp((-2 * Math.PI * cutoff(i)) / SR);
    y += a * (x[i] - y);
    x[i] = y;
  }
}
function bandpass(x: Float32Array, freq: (i: number) => number, q = 1.2) {
  let low = 0;
  let band = 0;
  for (let i = 0; i < x.length; i++) {
    const f = 2 * Math.sin((Math.PI * Math.min(freq(i), SR / 6)) / SR);
    const high = x[i] - low - band / q;
    band += f * high;
    low += f * band;
    x[i] = band;
  }
}
const env = (t: number, a: number, d: number) => (t < a ? t / a : Math.exp(-(t - a) / d));

type Gen = () => Float32Array;

const len = (sec: number) => new Float32Array(Math.round(sec * SR));

const GENS: Record<string, Gen> = {
  whoosh: () => {
    const x = len(0.75);
    const r = rng(11);
    for (let i = 0; i < x.length; i++) x[i] = r();
    const n = x.length;
    bandpass(x, (i) => 300 + 3800 * Math.sin((Math.PI * i) / n), 0.9);
    for (let i = 0; i < n; i++) x[i] *= Math.sin((Math.PI * i) / n) ** 1.6 * 2.2;
    return x;
  },
  swoosh: () => {
    const x = len(0.32);
    const r = rng(5);
    for (let i = 0; i < x.length; i++) x[i] = r();
    const n = x.length;
    bandpass(x, (i) => 900 + 5000 * (i / n), 1.1);
    for (let i = 0; i < n; i++) x[i] *= Math.sin((Math.PI * i) / n) ** 1.2 * 2;
    return x;
  },
  swipe: () => {
    const x = len(0.22);
    const r = rng(23);
    for (let i = 0; i < x.length; i++) x[i] = r();
    const n = x.length;
    bandpass(x, (i) => 2500 - 1200 * (i / n), 1.6);
    for (let i = 0; i < n; i++) x[i] *= env(i / SR, 0.03, 0.06) * 1.8;
    return x;
  },
  click: () => {
    const x = len(0.06);
    const r = rng(3);
    for (let i = 0; i < x.length; i++) {
      const t = i / SR;
      x[i] = (Math.sin(2 * Math.PI * 2100 * t) * 0.6 + r() * 0.4) * Math.exp(-t / 0.008);
    }
    return x;
  },
  tick: () => {
    const x = len(0.03);
    const r = rng(7);
    for (let i = 0; i < x.length; i++) {
      const t = i / SR;
      x[i] = (r() * 0.7 + Math.sin(2 * Math.PI * 3200 * t) * 0.3) * Math.exp(-t / 0.004) * 0.7;
    }
    return x;
  },
  typing: () => {
    // two seconds of irregular key presses (loops cleanly)
    const x = len(2);
    const r = rng(41);
    let t = 0.02;
    while (t < 1.95) {
      const s = Math.round(t * SR);
      const gain = 0.45 + 0.35 * Math.abs(r());
      const tone = 1800 + 1600 * Math.abs(r());
      for (let k = 0; k < SR * 0.025 && s + k < x.length; k++) {
        const tt = k / SR;
        x[s + k] += (r() * 0.7 + Math.sin(2 * Math.PI * tone * tt) * 0.3) * Math.exp(-tt / 0.004) * gain;
      }
      t += 0.06 + 0.07 * Math.abs(r());
    }
    return x;
  },
  pop: () => {
    const x = len(0.16);
    let ph = 0;
    for (let i = 0; i < x.length; i++) {
      const t = i / SR;
      const f = 650 * Math.exp(-t / 0.03) + 180;
      ph += (2 * Math.PI * f) / SR;
      x[i] = Math.sin(ph) * env(t, 0.002, 0.04) * 0.9;
    }
    return x;
  },
  impact: () => {
    const x = len(1.1);
    const r = rng(9);
    let ph = 0;
    for (let i = 0; i < x.length; i++) {
      const t = i / SR;
      const f = 48 + 40 * Math.exp(-t / 0.08);
      ph += (2 * Math.PI * f) / SR;
      x[i] = Math.sin(ph) * Math.exp(-t / 0.35) * 1.1 + r() * Math.exp(-t / 0.04) * 0.6;
    }
    lowpass(x, () => 2200);
    return x;
  },
  rise: () => {
    const x = len(1.6);
    const r = rng(17);
    let ph = 0;
    const n = x.length;
    for (let i = 0; i < n; i++) {
      const t = i / SR;
      const k = i / n;
      ph += (2 * Math.PI * (180 + 900 * k * k)) / SR;
      x[i] = r() * 0.5 * k + Math.sin(ph) * 0.35 * k;
    }
    bandpass(x, (i) => 400 + 6000 * (i / n) ** 2, 0.8);
    for (let i = 0; i < n; i++) x[i] *= Math.min(1, (n - i) / (SR * 0.03)) * 2.2;
    return x;
  },
  ding: () => {
    const x = len(1.4);
    for (let i = 0; i < x.length; i++) {
      const t = i / SR;
      x[i] = (Math.sin(2 * Math.PI * 1318.5 * t) * 0.5 + Math.sin(2 * Math.PI * 2637 * t) * 0.18 + Math.sin(2 * Math.PI * 3955 * t) * 0.06) * env(t, 0.003, 0.35);
    }
    return x;
  },
  success: () => {
    const x = len(0.8);
    for (let i = 0; i < x.length; i++) {
      const t = i / SR;
      const f = t < 0.12 ? 784 : 1175;
      const t2 = t < 0.12 ? t : t - 0.12;
      x[i] = (Math.sin(2 * Math.PI * f * t) * 0.5 + Math.sin(2 * Math.PI * f * 2 * t) * 0.12) * env(t2, 0.004, t < 0.12 ? 0.08 : 0.25);
    }
    return x;
  },
  error: () => {
    const x = len(0.45);
    for (let i = 0; i < x.length; i++) {
      const t = i / SR;
      const f = t < 0.18 ? 220 : 165;
      const sq = Math.sign(Math.sin(2 * Math.PI * f * t)) * 0.3 + Math.sin(2 * Math.PI * f * t) * 0.3;
      x[i] = sq * env(t < 0.18 ? t : t - 0.2, 0.005, 0.12);
    }
    lowpass(x, () => 1800);
    return x;
  },
  glitch: () => {
    const x = len(0.35);
    const r = rng(29);
    let hold = 0;
    let v = 0;
    for (let i = 0; i < x.length; i++) {
      if (hold-- <= 0) {
        v = r() * (Math.abs(r()) > 0.4 ? 1 : 0.2);
        hold = Math.floor(30 + 400 * Math.abs(r()));
      }
      x[i] = Math.round(v * 6) / 6 * 0.6 * (1 - i / x.length);
    }
    return x;
  },
  bass: () => {
    const x = len(0.9);
    for (let i = 0; i < x.length; i++) {
      const t = i / SR;
      x[i] = Math.tanh(Math.sin(2 * Math.PI * 55 * t) * 2.5) * Math.exp(-t / 0.4) * 0.8;
    }
    return x;
  },
};

export const SFX_NAMES = Object.keys(GENS);

function writeWav(file: string, mono: Float32Array) {
  let peak = 0;
  for (const v of mono) peak = Math.max(peak, Math.abs(v));
  const g = peak > 0 ? 0.89 / peak : 1;
  const buf = Buffer.alloc(44 + mono.length * 4);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + mono.length * 4, 4);
  buf.write('WAVEfmt ', 8);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(2, 22);
  buf.writeUInt32LE(SR, 24);
  buf.writeUInt32LE(SR * 4, 28);
  buf.writeUInt16LE(4, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(mono.length * 4, 40);
  for (let i = 0; i < mono.length; i++) {
    const s = Math.max(-1, Math.min(1, mono[i] * g)) * 32767;
    buf.writeInt16LE(s | 0, 44 + i * 4);
    buf.writeInt16LE(s | 0, 46 + i * 4);
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, buf);
}

/** Local file of a built-in sound (generated on first use), or null when the name is unknown. */
export function sfxFile(dir: string, name: string): string | null {
  const n = name.replace(/^sfx:/, '');
  const gen = GENS[n];
  if (!gen) return null;
  const file = path.join(dir, `${n}.wav`);
  if (!fs.existsSync(file)) writeWav(file, gen());
  return file;
}
