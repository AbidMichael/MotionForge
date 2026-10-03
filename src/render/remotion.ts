import fs from 'node:fs';
import path from 'node:path';
import { bundle } from '@remotion/bundler';
import {
  ensureBrowser,
  openBrowser,
  renderMedia,
  renderStill,
  RenderInternals,
  makeCancelSignal,
  type ChromiumOptions,
} from '@remotion/renderer';
import type { VideoConfig } from 'remotion';
import { ROOT } from '../core/config';
import { sha256 } from '../core/util';
import type { IRDoc } from '../ir/types';
import { IR_PLAYER_VERSION } from '../ir/types';

type Browser = Awaited<ReturnType<typeof openBrowser>>;

export interface RenderAdapter {
  name: string;
  ready(): Promise<void>;
  renderStill(o: { ir: IRDoc; frame: number; out: string; scale?: number; transparent?: boolean }): Promise<void>;
  renderVideo(o: VideoRenderOpts): Promise<void>;
  concat(files: string[], out: string): Promise<void>;
  close(): Promise<void>;
}

export interface VideoRenderOpts {
  ir: IRDoc;
  out: string;
  codec: 'h264' | 'gif' | 'prores' | 'vp9';
  crf?: number;
  scale?: number;
  frameRange?: [number, number];
  transparent?: boolean;
  everyNthFrame?: number;
  x264Preset?: 'ultrafast' | 'superfast' | 'veryfast' | 'faster' | 'fast' | 'medium' | 'slow';
  onProgress?: (renderedFrames: number) => void;
  cancel?: { onCancel: (cb: () => void) => void };
}

/** Hash of the player source: a new bundle is built only when the player code changes. */
function playerHash(): string {
  const files: string[] = [];
  const walk = (d: string) => {
    for (const f of fs.readdirSync(d)) {
      const p = path.join(d, f);
      if (fs.statSync(p).isDirectory()) walk(p);
      else if (/\.(tsx?|css)$/.test(f)) files.push(p);
    }
  };
  walk(path.join(ROOT, 'src', 'remotion'));
  walk(path.join(ROOT, 'src', 'ir'));
  const h = files.sort().map((f) => sha256(fs.readFileSync(f))).join('');
  return sha256(h + IR_PLAYER_VERSION).slice(0, 16);
}

export class RemotionAdapter implements RenderAdapter {
  name = 'remotion';
  private serveUrl: string | null = null;
  private bundling: Promise<string> | null = null;
  private browser: Browser | null = null;
  private browserOpening: Promise<Browser> | null = null;
  private chromiumOptions: ChromiumOptions;

  constructor(
    private opts: {
      bundlesDir: string;
      browserExecutable: string | null;
      concurrency: number | null;
      log: (msg: string) => void;
      ignoreCertificateErrors?: boolean;
      /** WebGL backend for 3D layers: "angle" (GPU), "swangle" (software, servers without a GPU), "egl", "swiftshader", "vulkan" or null. */
      gl?: ChromiumOptions['gl'];
    },
  ) {
    this.chromiumOptions = { ignoreCertificateErrors: !!opts.ignoreCertificateErrors, gl: opts.gl ?? null };
  }

  async ready() {
    await Promise.all([this.getBundle(), this.getBrowser()]);
  }

  private async getBundle(): Promise<string> {
    if (this.serveUrl) return this.serveUrl;
    if (!this.bundling) {
      this.bundling = (async () => {
        const hash = playerHash();
        const outDir = path.join(this.opts.bundlesDir, hash);
        if (fs.existsSync(path.join(outDir, 'index.html'))) {
          this.serveUrl = outDir;
          return outDir;
        }
        this.opts.log(`bundling IR player (${hash})… first run only, ~20 s`);
        const t0 = Date.now();
        const tmp = outDir + '.tmp';
        fs.rmSync(tmp, { recursive: true, force: true });
        await bundle({ entryPoint: path.join(ROOT, 'src', 'remotion', 'index.ts'), outDir: tmp });
        fs.rmSync(outDir, { recursive: true, force: true });
        fs.renameSync(tmp, outDir);
        this.opts.log(`bundle ready in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
        this.serveUrl = outDir;
        return outDir;
      })().catch((e) => {
        this.bundling = null;
        throw e;
      });
    }
    return this.bundling;
  }

  private async getBrowser(): Promise<Browser> {
    if (this.browser) return this.browser;
    if (!this.browserOpening) {
      this.browserOpening = (async () => {
        if (!this.opts.browserExecutable) {
          await ensureBrowser({ logLevel: 'error', onBrowserDownload: () => {
            this.opts.log('downloading Chrome Headless Shell for rendering (first run only)…');
            return { version: null, onProgress: () => undefined };
          } });
        }
        const b = await openBrowser('chrome', {
          browserExecutable: this.opts.browserExecutable,
          chromiumOptions: this.chromiumOptions,
          logLevel: 'error',
        });
        this.browser = b;
        return b;
      })().catch((e) => {
        this.browserOpening = null;
        throw e;
      });
    }
    return this.browserOpening;
  }

  /** Drop a crashed browser so the next call opens a fresh one. */
  private async resetBrowser() {
    const b = this.browser;
    this.browser = null;
    this.browserOpening = null;
    try {
      await b?.close({ silent: true } as any);
    } catch {
      /* ignore */
    }
  }

  private composition(ir: IRDoc, transparent?: boolean): VideoConfig {
    return {
      id: 'MotionForge',
      width: ir.width,
      height: ir.height,
      fps: ir.fps,
      durationInFrames: Math.max(1, ir.duration),
      defaultProps: {},
      props: { ir, transparent: !!transparent },
      defaultCodec: null,
      defaultOutName: null,
      defaultVideoImageFormat: null,
      defaultPixelFormat: null,
      defaultProResProfile: null,
      defaultSampleRate: null,
    };
  }

  private async withBrowser<T>(fn: (b: Browser, serveUrl: string) => Promise<T>): Promise<T> {
    const serveUrl = await this.getBundle();
    try {
      return await fn(await this.getBrowser(), serveUrl);
    } catch (e) {
      const msg = String((e as Error)?.message ?? e);
      if (/Target closed|Browser closed|Session closed|Protocol error|disconnected/i.test(msg)) {
        await this.resetBrowser();
        return fn(await this.getBrowser(), serveUrl);
      }
      throw e;
    }
  }

  async renderStill(o: { ir: IRDoc; frame: number; out: string; scale?: number; transparent?: boolean }) {
    fs.mkdirSync(path.dirname(o.out), { recursive: true });
    const inputProps = { ir: o.ir, transparent: !!o.transparent };
    await this.withBrowser((puppeteerInstance, serveUrl) =>
      renderStill({
        serveUrl,
        composition: this.composition(o.ir, o.transparent),
        inputProps,
        frame: Math.max(0, Math.min(o.ir.duration - 1, Math.round(o.frame))),
        output: o.out,
        imageFormat: o.out.endsWith('.png') ? 'png' : 'jpeg',
        jpegQuality: 88,
        scale: o.scale ?? 1,
        puppeteerInstance,
        chromiumOptions: this.chromiumOptions,
        logLevel: 'error',
        overwrite: true,
      }),
    );
  }

  async renderVideo(o: VideoRenderOpts) {
    fs.mkdirSync(path.dirname(o.out), { recursive: true });
    const inputProps = { ir: o.ir, transparent: !!o.transparent };
    const { cancelSignal, cancel } = makeCancelSignal();
    o.cancel?.onCancel(cancel);
    const prores = o.codec === 'prores';
    const alphaWebm = o.codec === 'vp9' && o.transparent;
    await this.withBrowser((puppeteerInstance, serveUrl) =>
      renderMedia({
        serveUrl,
        composition: this.composition(o.ir, o.transparent),
        inputProps,
        codec: o.codec,
        outputLocation: o.out,
        crf: o.codec === 'h264' || o.codec === 'vp9' ? o.crf ?? null : null,
        scale: o.scale ?? 1,
        frameRange: o.frameRange ?? null,
        everyNthFrame: o.everyNthFrame ?? 1,
        imageFormat: prores || alphaWebm || o.transparent ? 'png' : 'jpeg',
        jpegQuality: 92,
        pixelFormat: prores && o.transparent ? 'yuva444p10le' : alphaWebm ? 'yuva420p' : 'yuv420p',
        proResProfile: prores ? '4444' : undefined,
        x264Preset: o.codec === 'h264' ? o.x264Preset ?? 'medium' : null,
        concurrency: this.opts.concurrency,
        muted: true,
        enforceAudioTrack: false,
        puppeteerInstance,
        chromiumOptions: this.chromiumOptions,
        cancelSignal,
        logLevel: 'error',
        overwrite: true,
        onProgress: (p) => o.onProgress?.(p.renderedFrames),
      }),
    );
  }

  /** Stitch H.264 segments without re-encoding. */
  async concat(files: string[], out: string) {
    fs.mkdirSync(path.dirname(out), { recursive: true });
    if (files.length === 1) {
      fs.copyFileSync(files[0], out);
      return;
    }
    const list = out + '.txt';
    fs.writeFileSync(list, files.map((f) => `file '${path.resolve(f).replace(/\\/g, '/').replace(/'/g, "'\\''")}'`).join('\n'));
    try {
      await ffmpeg(['-hide_banner', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', '-movflags', '+faststart', '-y', path.resolve(out)]);
    } finally {
      fs.rmSync(list, { force: true });
    }
  }

  async close() {
    await this.resetBrowser();
  }
}

/** Run Remotion's bundled ffmpeg (or MF_FFMPEG when set). */
export async function ffmpeg(args: string[]) {
  if (process.env.MF_FFMPEG) {
    const { execFile } = await import('node:child_process');
    await new Promise<void>((res, rej) =>
      execFile(process.env.MF_FFMPEG!, args, (err, _o, stderr) => (err ? rej(new Error(stderr || err.message)) : res())),
    );
    return;
  }
  const task = (RenderInternals as any).callFf({
    args,
    bin: 'ffmpeg',
    indent: false,
    logLevel: 'error',
    binariesDirectory: null,
    cancelSignal: undefined,
  });
  await task;
}
