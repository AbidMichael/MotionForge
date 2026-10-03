import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import type { Ctx } from '../core/context';
import { sha256, stableStringify } from '../core/util';
import { compile, presetExample } from '../dsl/compile';
import type { IRDoc } from '../ir/types';
import { SYSTEM_AGENT } from '../registry/store';
import { resolveFonts } from './fonts';
import { segmentRanges } from './segments';
import { pixelChecks, staticChecks, summarize, sceneLayouts } from '../core/qa';
import { mixInto } from './audio';
import type { IRLayer } from '../ir/types';
import type { Rect } from '../ir/geometry';

/** Which frames a preview shows: scenes, a transition, a time range, a layer in focus. */
export function previewPlan(ir: IRDoc, P: Record<string, any>): { frames: number[]; range: [number, number]; focus?: Rect; label: string } {
  const fps = ir.fps;
  const clampF = (f: number) => Math.max(0, Math.min(ir.duration - 1, Math.round(f)));
  const n = Math.max(1, Math.min(16, Number(P.n ?? P.frames ?? 0) || 0));
  let range: [number, number] = [0, ir.duration];
  let label = 'whole video';
  let frames: number[] | null = null;
  if (Array.isArray(P.at) && P.at.length) {
    frames = P.at.map((t: number) => clampF(Number(t) * fps));
    label = 'chosen times';
  }
  if (P.scene !== undefined) {
    const s = ir.scenes[Number(P.scene) - 1];
    if (!s) throw new Error(`scene ${P.scene} does not exist (1..${ir.scenes.length})`);
    range = [s.start, s.end];
    label = `scene ${P.scene}`;
  }
  if (P.transition !== undefined) {
    const k = Number(P.transition);
    const ms = (ir.markers ?? []).filter((m) => m.kind === 'transition');
    const m = ms[k - 1];
    if (!m) throw new Error(`transition ${k} does not exist (${ms.length} transitions)`);
    const pad = Math.round(fps * 0.25);
    range = [Math.max(0, m.t - pad), Math.min(ir.duration, m.t + (m.d ?? fps / 2) + pad)];
    label = `transition ${k} (${m.name})`;
  }
  if (Array.isArray(P.range) && P.range.length === 2) {
    range = [clampF(Number(P.range[0]) * fps), Math.min(ir.duration, Math.round(Number(P.range[1]) * fps))];
    label = `${P.range[0]}–${P.range[1]} s`;
  }
  let focus: Rect | undefined;
  const target = P.focus ?? P.solo;
  if (target) {
    const name = String(target).replace(/^#/, '');
    for (const sl of sceneLayouts(ir)) {
      const b = sl.layout.find(name);
      if (!b) continue;
      const info = ir.scenes[sl.index];
      if (P.scene === undefined && P.transition === undefined && !P.range) range = [info.start + b.abs0, Math.min(info.end, info.start + b.abs1)];
      if (P.focus) {
        const pad = Math.max(24, Math.min(b.rect.w, b.rect.h) * 0.15);
        focus = { x: b.rect.x - pad, y: b.rect.y - pad, w: b.rect.w + pad * 2, h: b.rect.h + pad * 2 };
      }
      label = `${label === 'whole video' ? '' : label + ', '}#${name}`;
      break;
    }
    if (!focus && P.focus) throw new Error(`no layer with id "${name}"`);
  }
  if (!frames) {
    if (label === 'whole video' && !n) frames = ir.scenes.map((s) => clampF(s.start + (s.end - s.start) * 0.6));
    else {
      const k = n || (P.transition !== undefined ? 5 : 4);
      frames = Array.from({ length: k }, (_, i) => clampF(range[0] + ((range[1] - 1 - range[0]) * (k === 1 ? 0.5 : i / (k - 1)))));
    }
  }
  return { frames, range, focus, label };
}

/** Keep only one named layer (and the path to it) — "solo" previews of a sub-composition or element. */
export function soloIR(ir: IRDoc, target: string): IRDoc {
  const name = target.replace(/^#/, '');
  const keep = (l: IRLayer): IRLayer | null => {
    if (l.name === name) return l;
    if (!l.children) return null;
    const kids = l.children.map(keep).filter(Boolean) as IRLayer[];
    return kids.length ? { ...l, children: kids, style: { ...l.style, bg: undefined as any } } : null;
  };
  const layers = ir.layers.map((l) => {
    const k = keep(l);
    return k ? { ...k, style: l.style } : null;
  }).filter(Boolean) as IRLayer[];
  if (!layers.length) throw new Error(`no layer with id "${name}"`);
  return { ...ir, layers };
}

export const QUALITY = {
  draft: { codec: 'h264', crf: 28, scale: 0.5, x264Preset: 'veryfast', ext: 'mp4', segments: true, desc: 'half resolution, fast — for checking' },
  hq: { codec: 'h264', crf: 18, scale: 1, x264Preset: 'medium', ext: 'mp4', segments: true, desc: 'full resolution H.264 — for delivery' },
  gif: { codec: 'gif', scale: 0.5, everyNthFrame: 2, ext: 'gif', segments: false, desc: 'half-res GIF at half frame rate — for chats and docs' },
  alpha: { codec: 'prores', scale: 1, transparent: true, ext: 'mov', segments: false, desc: 'ProRes 4444 with transparency — overlays for editors/OBS (avoid backdrops)' },
  webm: { codec: 'vp9', crf: 32, scale: 1, ext: 'webm', segments: false, desc: 'VP9 WebM — for the web' },
} as const;
export type Quality = keyof typeof QUALITY;

/**
 * Sub-compositions marked "cache": true are rendered once to a transparent VP9 video, keyed by their
 * content (not by where they are used), and replaced by that video in the IR that gets rendered.
 */
export async function prerenderSubcomps(ctx: Ctx, ir: IRDoc, scale: number, onStage?: (s: string) => void): Promise<IRDoc> {
  let found = false;
  const visit = (l: IRLayer): boolean => !!(l.data as any)?.prerender || (l.children ?? []).some(visit);
  for (const l of ir.layers) if (visit(l)) found = true;
  if (!found) return ir;
  const out: IRDoc = JSON.parse(JSON.stringify(ir));
  const dir = path.join(ctx.paths.renders, 'prerender');
  fs.mkdirSync(dir, { recursive: true });
  const jobs: Promise<void>[] = [];
  const walk = async (l: IRLayer) => {
    const pr = (l.data as any)?.prerender;
    if (pr && l.children?.[0]?.children) {
      const inner = l.children[0];
      const childIR: IRDoc = { v: ir.v, width: pr.w, height: pr.h, fps: pr.fps, duration: pr.duration, bg: 'transparent', fonts: ir.fonts, layers: inner.children!, scenes: [{ index: 0, id: 'pr', start: 0, end: pr.duration }], markers: [] } as any;
      const s = Math.max(0.25, Math.min(1, scale * (inner.scale ?? 1)));
      const key = sha256(stableStringify(childIR).split(pr.prefix).join('') + `|${s}`).slice(0, 20);
      const file = path.join(dir, `${key}.webm`);
      if (!fs.existsSync(file)) {
        onStage?.('pre-rendering a sub-composition');
        const tmp = file.replace(/\.webm$/, '.part.webm');
        await ctx.adapter.renderVideo({ ir: childIR, out: tmp, codec: 'vp9', transparent: true, crf: 18, scale: s });
        fs.renameSync(tmp, file);
      }
      inner.children = [
        { id: `${inner.id}.video`, type: 'video', from: 0, to: pr.duration, x: 0, y: 0, w: pr.w, h: pr.h, anchor: [0, 0], src: fileUrl(ctx, file), style: { alpha: 1, fit: 'fill', rate: ir.fps / pr.fps }, anims: [] } as IRLayer,
      ];
      return;
    }
    for (const c of l.children ?? []) await walk(c);
  };
  for (const l of out.layers) await walk(l);
  await Promise.all(jobs);
  return out;
}

export function prepareIR(ir: IRDoc, ctx: Ctx): IRDoc {
  return { ...ir, fonts: resolveFonts(ir.fonts, ctx.baseUrl(), (id) => ctx.assets.url(id)) as any };
}

const fileUrl = (ctx: Ctx, abs: string) => `${ctx.baseUrl()}/files/${path.relative(ctx.paths.root, abs).split(path.sep).join('/')}`;

export async function contactSheet(files: { path: string; label: string }[], out: string) {
  const metas = await Promise.all(files.map((f) => sharp(f.path).metadata()));
  const w = metas[0].width!;
  const h = metas[0].height!;
  const n = files.length;
  const cols = n <= 2 ? n : n <= 4 ? 2 : n <= 9 ? 3 : 4;
  const rows = Math.ceil(n / cols);
  const gap = 6;
  const W = cols * w + (cols + 1) * gap;
  const H = rows * h + (rows + 1) * gap;
  const esc = (s: string) => s.replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c]!);
  const composites: { input: string | Buffer; left: number; top: number }[] = [];
  files.forEach((f, i) => {
    const left = gap + (i % cols) * (w + gap);
    const top = gap + Math.floor(i / cols) * (h + gap);
    composites.push({ input: f.path, left, top });
    const fs2 = Math.max(12, Math.round(h / 20));
    const label = `<svg width="${w}" height="${fs2 * 2 + 10}"><rect x="6" y="6" rx="6" width="${Math.round(f.label.length * fs2 * 0.6 + 20)}" height="${fs2 * 1.8}" fill="rgba(0,0,0,0.65)"/><text x="16" y="${Math.round(6 + fs2 * 1.25)}" font-size="${fs2}" font-family="Arial, Helvetica, sans-serif" fill="#ffffff">${esc(f.label)}</text></svg>`;
    composites.push({ input: Buffer.from(label), left, top });
  });
  fs.mkdirSync(path.dirname(out), { recursive: true });
  await sharp({ create: { width: W, height: H, channels: 3, background: '#111111' } }).composite(composites).jpeg({ quality: 82 }).toFile(out);
}

export function registerJobHandlers(ctx: Ctx) {
  const { jobs, adapter, paths, comps } = ctx;

  jobs.on('render', async (job, jc) => {
    const quality = (job.params.quality ?? 'draft') as Quality;
    const Q = QUALITY[quality];
    if (!Q) throw new Error(`unknown quality ${quality} (${Object.keys(QUALITY).join(', ')})`);
    const { r, rev } = comps.compiled(job.comp_id!, job.rev ?? undefined);
    if (!r.ok || !r.ir) throw new Error(`composition does not compile: ${r.errors.map((e) => `${e.path}: ${e.msg}`).join('; ')}`);
    const scale = Number(job.params.scale ?? Q.scale);
    const ir = await prerenderSubcomps(ctx, prepareIR(r.ir, ctx), scale, (st) => jc.progress(0, st));
    const t0 = Date.now();
    const outDir = path.join(paths.renders, job.id);
    const name = `${job.comp_id}-r${rev}-${quality}.${Q.ext}`;
    const out = path.join(outDir, name);
    let segmentsTotal = 0;
    let cacheHits = 0;
    jc.progress(0, 'preparing');
    try {
      if (Q.segments && ctx.cfg.render.segmentCache) {
        const ranges = segmentRanges(ir, `${quality}|${scale}`);
        segmentsTotal = ranges.length;
        const todo = ranges.filter((s) => !fs.existsSync(path.join(paths.segments, `${s.hash}.mp4`)));
        cacheHits = ranges.length - todo.length;
        const totalFrames = todo.reduce((n, s) => n + (s.b - s.a), 0) || 1;
        let done = 0;
        for (const [i, seg] of todo.entries()) {
          if (jc.cancelled()) throw new Error('cancelled');
          const f = path.join(paths.segments, `${seg.hash}.mp4`);
          const tmp = f.replace(/\.mp4$/, '.part.mp4');
          await adapter.renderVideo({
            ir,
            out: tmp,
            codec: 'h264',
            crf: (Q as any).crf,
            scale,
            x264Preset: (Q as any).x264Preset,
            frameRange: [seg.a, seg.b - 1],
            onProgress: (n) => jc.progress(((done + n) / totalFrames) * 0.95, `segment ${i + 1}/${todo.length} (${cacheHits} cached)`),
            cancel: { onCancel: jc.onCancel },
          });
          fs.renameSync(tmp, f);
          done += seg.b - seg.a;
        }
        jc.progress(0.96, 'stitching');
        await adapter.concat(
          ranges.map((s) => path.join(paths.segments, `${s.hash}.mp4`)),
          out,
        );
      } else {
        await adapter.renderVideo({
          ir,
          out,
          codec: Q.codec as any,
          crf: (Q as any).crf,
          scale,
          everyNthFrame: (Q as any).everyNthFrame,
          transparent: (Q as any).transparent,
          onProgress: (n) => jc.progress((n / Math.max(1, ir.duration / ((Q as any).everyNthFrame ?? 1))) * 0.97, 'rendering'),
          cancel: { onCancel: jc.onCancel },
        });
      }
      if (ir.audio?.length && quality !== 'gif') {
        jc.progress(0.97, 'mixing audio');
        await mixInto(ctx, ir, out);
      }
      const s0 = ir.scenes[0];
      const posterFrame = Math.round(s0.start + (s0.end - s0.start) * 0.6);
      const poster = path.join(outDir, 'poster.jpg');
      await adapter.renderStill({ ir, frame: posterFrame, out: poster, scale: 0.5 });
      ctx.registry.recordUsage(r.used, 'renders_ok');
      const ms = Date.now() - t0;
      const report = {
        quality,
        path: out,
        url: fileUrl(ctx, out),
        poster: fileUrl(ctx, poster),
        posterPath: poster,
        bytes: fs.statSync(out).size,
        duration: r.duration,
        frames: ir.duration,
        size: `${Math.round(ir.width * scale)}x${Math.round(ir.height * scale)}`,
        segments: segmentsTotal,
        cacheHits,
        ms,
      };
      fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify({ ...report, comp: job.comp_id, rev, lock: r.lock, warnings: r.warnings }, null, 2));
      return report;
    } catch (e) {
      if (!jc.cancelled()) ctx.registry.recordUsage(r.used, 'renders_fail');
      throw e;
    }
  });

  jobs.on('preview', async (job, jc) => {
    const { r, rev } = comps.compiled(job.comp_id!, job.rev ?? undefined);
    if (!r.ok || !r.ir) throw new Error(`composition does not compile: ${r.errors.map((e) => `${e.path}: ${e.msg}`).join('; ')}`);
    let ir = prepareIR(r.ir, ctx);
    const P = job.params;
    const scale = Math.max(0.1, Math.min(1, Number(P.scale ?? 0.5)));
    const plan = previewPlan(ir, P);
    if (P.solo) ir = soloIR(ir, String(P.solo));
    const irHash = sha256(stableStringify(ir)).slice(0, 12);
    const dir = path.join(paths.previews, `${job.comp_id}-r${rev}`);
    fs.mkdirSync(dir, { recursive: true });
    // a short low-res clip of the range (with sound when the composition has audio)
    if (P.clip) {
      const [a, b] = plan.range;
      const out = path.join(dir, `${irHash}-clip-${a}-${b}-${Math.round(scale * 100)}.${P.clip === 'gif' ? 'gif' : 'mp4'}`);
      if (!fs.existsSync(out)) {
        await adapter.renderVideo({ ir, out, codec: P.clip === 'gif' ? 'gif' : 'h264', crf: 28, scale, x264Preset: 'veryfast', frameRange: [a, Math.max(a, b - 1)], everyNthFrame: P.clip === 'gif' ? 2 : 1, onProgress: (n) => jc.progress(n / Math.max(1, b - a)) });
        if (P.clip !== 'gif' && ir.audio?.length) await mixInto(ctx, ir, out, a, b);
      }
      return { comp: job.comp_id, rev, clip: { path: out, url: fileUrl(ctx, out), from: +(a / ir.fps).toFixed(2), to: +(b / ir.fps).toFixed(2) }, label: plan.label };
    }
    const frames: { t: number; frame: number; scene: number; path: string; url: string }[] = [];
    for (const [i, frame] of plan.frames.entries()) {
      let f = path.join(dir, `${irHash}-${frame}-${Math.round(scale * 100)}.jpg`);
      if (!fs.existsSync(f)) await adapter.renderStill({ ir, frame, out: f, scale });
      if (plan.focus) {
        const rc = plan.focus;
        const cf = path.join(dir, `${irHash}-${frame}-${Math.round(scale * 100)}-focus-${Math.round(rc.x)}_${Math.round(rc.y)}.jpg`);
        if (!fs.existsSync(cf)) {
          const meta = await sharp(f).metadata();
          const left = Math.max(0, Math.floor(rc.x * scale));
          const top = Math.max(0, Math.floor(rc.y * scale));
          const width = Math.max(8, Math.min(meta.width! - left, Math.ceil(rc.w * scale)));
          const height = Math.max(8, Math.min(meta.height! - top, Math.ceil(rc.h * scale)));
          await sharp(f).extract({ left, top, width, height }).resize({ width: Math.max(width, 640), withoutEnlargement: false }).jpeg({ quality: 86 }).toFile(cf);
        }
        f = cf;
      }
      const scene = ir.scenes.findIndex((s) => frame >= s.start && frame < s.end) + 1;
      frames.push({ t: +(frame / ir.fps).toFixed(2), frame, scene, path: f, url: fileUrl(ctx, f) });
      jc.progress((i + 1) / (plan.frames.length + 1), `frame ${i + 1}/${plan.frames.length}`);
    }
    let sheet: { path: string; url: string } | undefined;
    if (P.sheet !== false && frames.length > 1) {
      const f = path.join(dir, `${irHash}-sheet-${Math.round(scale * 100)}${plan.focus ? '-f' : ''}-${frames.map((x) => x.frame).join('_').slice(0, 80)}.jpg`);
      if (!fs.existsSync(f)) await contactSheet(frames.map((x) => ({ path: x.path, label: `S${x.scene} · ${x.t}s` })), f);
      sheet = { path: f, url: fileUrl(ctx, f) };
    }
    return { comp: job.comp_id, rev, frames, sheet, label: plan.label };
  });

  jobs.on('check', async (job, jc) => {
    const { r, rev } = comps.compiled(job.comp_id!, job.rev ?? undefined);
    if (!r.ok || !r.ir) throw new Error(`composition does not compile: ${r.errors.map((e) => `${e.path}: ${e.msg}`).join('; ')}`);
    const ir = prepareIR(r.ir, ctx);
    const issues = staticChecks(ir);
    let frames: { scene: number; frame: number; path: string }[] = [];
    if (job.params.pixels !== false) {
      const scale = 0.5;
      const irHash = sha256(stableStringify(ir)).slice(0, 12);
      const dir = path.join(paths.previews, `${job.comp_id}-r${rev}`);
      let n = 0;
      const px = await pixelChecks(
        ir,
        async (frame) => {
          const f = path.join(dir, `${irHash}-${frame}-50.jpg`);
          if (!fs.existsSync(f)) await adapter.renderStill({ ir, frame, out: f, scale });
          jc.progress(++n / (ir.scenes.length + 1), 'rendering frames');
          return f;
        },
        scale,
      );
      issues.push(...px.issues);
      frames = px.frames;
    }
    const order = { error: 0, warning: 1, info: 2 };
    issues.sort((a, b) => order[a.severity] - order[b.severity] || a.scene - b.scene);
    return { comp: job.comp_id, rev, summary: summarize(issues), issues, frames: frames.map((f) => ({ ...f, url: fileUrl(ctx, f.path) })) };
  });

  jobs.on('thumb', async (job) => {
    const { library, version, slug } = job.params;
    const lv = ctx.store.resolve(library, version);
    const p = lv.presets.get(slug);
    if (!p) throw new Error(`${library}/${slug}@${version} not found`);
    const comp = presetExample(lv, p, ctx.compileOpts, SYSTEM_AGENT);
    const r = compile({ composition: comp, agent: SYSTEM_AGENT }, ctx.compileOpts);
    if (!r.ok || !r.ir) throw new Error(`example does not compile: ${r.errors[0]?.msg}`);
    const ir = prepareIR(r.ir, ctx);
    const out = ctx.index.thumbPath(library, slug, version);
    const frac = p.kind === 'transition' ? 0.5 : p.kind === 'animation' ? 0.35 : 0.65;
    await adapter.renderStill({ ir, frame: Math.round(ir.duration * frac), out, scale: 1 / 3 });
    return { path: out, url: fileUrl(ctx, out) };
  });
}
