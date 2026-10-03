/**
 * Capture real interfaces: load a page or local app, run a scripted path (clicks, typing, scrolling,
 * hovers, navigation) and record a screenshot after every step together with the positions of the
 * elements that were acted on. The result (cap_xxx) is used in compositions with {"type":"capture"}:
 * the screenshots are cut together and a synthetic cursor replays the path in sync.
 */
import fs from 'node:fs';
import path from 'node:path';
import puppeteer, { type Browser, type Page } from 'puppeteer-core';
import { ensureBrowser } from '@remotion/renderer';
import type { Ctx } from './context';
import { badRequest } from './errors';
import { isObj, shortId } from './util';

export interface CaptureStep {
  do: 'goto' | 'click' | 'type' | 'scroll' | 'hover' | 'wait' | 'press' | 'shot' | 'select';
  selector?: string;
  text?: string;
  url?: string;
  by?: number;
  to?: string;
  ms?: number;
  for?: string;
  key?: string;
  value?: string;
  label?: string;
}

export interface CaptureShot {
  /** Index of the step this shot follows (-1 = initial page). */
  step: number;
  asset: string;
  /** Typing progress: the shot shows the field with this many characters typed. */
  chars?: number;
  scrollY: number;
}

export interface CaptureRecord {
  id: string;
  url: string;
  width: number;
  height: number;
  dpr: number;
  created: string;
  steps: (CaptureStep & { rect?: { x: number; y: number; w: number; h: number }; error?: string })[];
  shots: CaptureShot[];
  title?: string;
}

const STEP_KINDS = ['goto', 'click', 'type', 'scroll', 'hover', 'wait', 'press', 'shot', 'select'];

let browserP: Promise<Browser> | null = null;

async function executable(ctx: Ctx): Promise<string> {
  if (ctx.cfg.render.browserExecutable) return ctx.cfg.render.browserExecutable;
  const st = await ensureBrowser({ logLevel: 'error' } as any);
  if (st.type === 'local-puppeteer-browser' || st.type === 'user-defined-path') return st.path;
  throw new Error('no Chrome found for captures: set render.browserExecutable in motionforge.config.json');
}

async function browser(ctx: Ctx): Promise<Browser> {
  if (!browserP) {
    browserP = (async () =>
      puppeteer.launch({
        executablePath: await executable(ctx),
        headless: true,
        args: ['--no-sandbox', '--disable-dev-shm-usage', '--hide-scrollbars', ...(process.env.MF_IGNORE_CERT_ERRORS === '1' ? ['--ignore-certificate-errors'] : [])],
      }))().catch((e) => {
      browserP = null;
      throw e;
    });
  }
  return browserP;
}

export async function closeCaptureBrowser() {
  if (browserP) (await browserP.catch(() => null))?.close().catch(() => undefined);
  browserP = null;
}

function capDir(ctx: Ctx) {
  return path.join(ctx.paths.root, 'captures');
}

export function loadCapture(ctx: Ctx, id: string): CaptureRecord | null {
  const f = path.join(capDir(ctx), `${id.replace(/[^a-z0-9_]/gi, '')}.json`);
  if (!fs.existsSync(f)) return null;
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch {
    return null;
  }
}

export function listCaptures(ctx: Ctx) {
  const d = capDir(ctx);
  if (!fs.existsSync(d)) return [];
  return fs
    .readdirSync(d)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      const r = JSON.parse(fs.readFileSync(path.join(d, f), 'utf8')) as CaptureRecord;
      return { id: r.id, url: r.url, title: r.title, steps: r.steps.length, shots: r.shots.length, created: r.created, size: `${r.width}x${r.height}` };
    })
    .sort((a, b) => b.created.localeCompare(a.created));
}

async function rectOf(page: Page, sel: string) {
  const h = await page.$(sel);
  if (!h) return null;
  await h.evaluate((el) => el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' as ScrollBehavior })).catch(() => undefined);
  const b = await h.boundingBox();
  return b ? { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) } : null;
}

export async function runCapture(
  ctx: Ctx,
  input: { url?: string; html?: string; width?: number; height?: number; dpr?: number; steps?: unknown[]; title?: string; typingShots?: number; settle?: number },
  agent: string,
): Promise<CaptureRecord> {
  if (!input.url && !input.html) throw badRequest('give "url" (http(s):// or file://) or "html"');
  if (input.url && !/^(https?|file):\/\//.test(input.url)) throw badRequest('url must start with http://, https:// or file://');
  const width = Math.max(320, Math.min(3840, Number(input.width ?? 1440)));
  const height = Math.max(240, Math.min(2400, Number(input.height ?? 900)));
  const dpr = Math.max(1, Math.min(3, Number(input.dpr ?? 1)));
  const steps = (input.steps ?? []) as CaptureStep[];
  steps.forEach((s, i) => {
    if (!isObj(s) || !STEP_KINDS.includes((s as any).do)) throw badRequest(`steps[${i}]: "do" is one of ${STEP_KINDS.join(', ')}`);
    if (['click', 'type', 'hover', 'select'].includes(s.do) && !s.selector) throw badRequest(`steps[${i}]: ${s.do} needs a CSS "selector"`);
  });
  const settle = Number(input.settle ?? 350);
  const typingShots = Math.max(1, Math.min(12, Number(input.typingShots ?? 5)));
  const b = await browser(ctx);
  const page = await b.newPage();
  const id = shortId('cap');
  const rec: CaptureRecord = { id, url: input.url ?? 'inline:html', width, height, dpr, created: new Date().toISOString(), steps: [], shots: [], title: input.title };
  const shot = async (step: number, chars?: number) => {
    await new Promise((r) => setTimeout(r, 60));
    const buf = (await page.screenshot({ type: 'png' })) as Buffer;
    const info = await ctx.assets.put({ base64: Buffer.from(buf).toString('base64'), name: `${id}-${rec.shots.length}.png`, tags: ['capture', id] }, agent);
    const scrollY = await page.evaluate(() => window.scrollY);
    rec.shots.push({ step, asset: info.id, chars, scrollY });
  };
  try {
    await page.setViewport({ width, height, deviceScaleFactor: dpr });
    if (input.html) await page.setContent(input.html, { waitUntil: 'load', timeout: 30000 });
    else await page.goto(input.url!, { waitUntil: 'networkidle2', timeout: 45000 });
    rec.title = rec.title ?? (await page.title());
    await new Promise((r) => setTimeout(r, settle));
    await shot(-1);
    for (const [i, s] of steps.entries()) {
      const out: CaptureRecord['steps'][number] = { ...s };
      rec.steps.push(out);
      try {
        switch (s.do) {
          case 'goto':
            await page.goto(String(s.url), { waitUntil: 'networkidle2', timeout: 45000 });
            break;
          case 'wait':
            if (s.for) await page.waitForSelector(s.for, { timeout: Number(s.ms ?? 10000) });
            else await new Promise((r) => setTimeout(r, Number(s.ms ?? 800)));
            break;
          case 'hover':
          case 'click': {
            out.rect = (await rectOf(page, s.selector!)) ?? undefined;
            if (!out.rect) throw new Error(`no element matches ${s.selector}`);
            if (s.do === 'hover') await page.hover(s.selector!);
            else await page.click(s.selector!);
            break;
          }
          case 'select':
            out.rect = (await rectOf(page, s.selector!)) ?? undefined;
            await page.select(s.selector!, String(s.value ?? ''));
            break;
          case 'type': {
            out.rect = (await rectOf(page, s.selector!)) ?? undefined;
            if (!out.rect) throw new Error(`no element matches ${s.selector}`);
            await page.click(s.selector!);
            const text = String(s.text ?? '');
            // intermediate shots so the typing can be shown progressively
            const cuts = Array.from({ length: typingShots }, (_, k) => Math.round(((k + 1) * text.length) / typingShots)).filter((v, k, a) => v > 0 && a.indexOf(v) === k);
            let done = 0;
            for (const c of cuts) {
              await page.keyboard.type(text.slice(done, c), { delay: 0 });
              done = c;
              if (c < text.length) await shot(i, c);
            }
            break;
          }
          case 'press':
            await page.keyboard.press((s.key ?? 'Enter') as any);
            break;
          case 'scroll':
            if (s.to) {
              const r = await page.$(s.to);
              if (!r) throw new Error(`no element matches ${s.to}`);
              await r.evaluate((el) => el.scrollIntoView({ block: 'start', behavior: 'instant' as ScrollBehavior }));
            } else await page.evaluate((by) => window.scrollBy({ top: by, behavior: 'instant' as ScrollBehavior }), Number(s.by ?? height * 0.8));
            break;
          case 'shot':
            break;
        }
      } catch (e) {
        out.error = (e as Error).message.split('\n')[0];
      }
      await new Promise((r) => setTimeout(r, settle));
      await shot(i);
    }
  } finally {
    await page.close().catch(() => undefined);
  }
  fs.mkdirSync(capDir(ctx), { recursive: true });
  fs.writeFileSync(path.join(capDir(ctx), `${id}.json`), JSON.stringify(rec, null, 1));
  return rec;
}
