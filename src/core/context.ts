import { AssetStore } from './assets';
import { dataPaths, loadConfig, type MotionForgeConfig } from './config';
import { openDb, type DB } from './db';
import { EventBus } from './events';
import type { CompileOptions } from '../dsl/compile';
import { SearchIndex } from '../registry/search';
import { LibraryStore } from '../registry/store';
import { RegistryService } from '../registry/service';
import { CompositionService } from './compositions';
import { JobQueue } from '../render/queue';
import { RemotionAdapter, type RenderAdapter } from '../render/remotion';
import { registerJobHandlers } from '../render/jobs';
import { sfxFile } from '../render/sfx';
import { analyzeAsset, readAudioInfo } from '../render/beats';
import { loadCapture } from './capture';
import path from 'node:path';

export interface Ctx {
  cfg: MotionForgeConfig;
  paths: ReturnType<typeof dataPaths>;
  db: DB;
  events: EventBus;
  store: LibraryStore;
  index: SearchIndex;
  assets: AssetStore;
  compileOpts: CompileOptions;
  registry: RegistryService;
  comps: CompositionService;
  jobs: JobQueue;
  adapter: RenderAdapter;
  baseUrl: () => string;
  log: (msg: string) => void;
}

export function createContext(overrides: Partial<MotionForgeConfig> = {}, log: (m: string) => void = (m) => console.log(`[motionforge] ${m}`)): Ctx {
  const cfg = loadConfig(overrides);
  const paths = dataPaths(cfg);
  const db = openDb(paths.db);
  const events = new EventBus(db);
  const store = new LibraryStore(cfg.librariesDir);
  store.scan();
  for (const i of store.loadIssues) log(`library issue: ${i.path}: ${i.msg}`);
  const index = new SearchIndex(db, store, paths.thumbs);
  index.reindex();
  let base = `http://${cfg.host === '0.0.0.0' ? '127.0.0.1' : cfg.host}:${cfg.port}`;
  const baseUrl = () => base;
  const assets = new AssetStore(db, paths.assets, baseUrl);
  const compileOpts: CompileOptions = {
    store,
    defaultFormat: cfg.defaultFormat,
    defaultTheme: cfg.defaultTheme,
    assetUrl: (id) => assets.url(id),
    assetFile: (id) => {
      try {
        return assets.get(id).path;
      } catch {
        return null;
      }
    },
    sfxFile: (name) => sfxFile(path.join(paths.root, 'sfx'), name),
    loadCapture: (id) => loadCapture(ctx, id),
    audioInfo: (id) => {
      const hit = readAudioInfo(ctx, id);
      if (!hit) analyzeAsset(ctx, id).catch((e) => log(`audio analysis of ${id} failed: ${(e as Error).message}`));
      return hit;
    },
    loadComposition: (id, rev) => {
      try {
        const c = ctx.comps.get(id, rev);
        return { composition: c.composition, lock: c.lock };
      } catch {
        return null;
      }
    },
  };
  const adapter = new RemotionAdapter({
    bundlesDir: paths.bundles,
    browserExecutable: cfg.render.browserExecutable,
    concurrency: cfg.render.concurrency,
    log,
    ignoreCertificateErrors: process.env.MF_IGNORE_CERT_ERRORS === '1',
    gl: cfg.render.gl as any,
  });
  const ctx = { cfg, paths, db, events, store, index, assets, compileOpts, adapter, baseUrl, log } as unknown as Ctx;
  ctx.jobs = new JobQueue(db, events, { render: cfg.render.jobs, fast: 1 }, log);
  ctx.registry = new RegistryService(ctx);
  ctx.comps = new CompositionService(ctx);
  registerJobHandlers(ctx);
  assets.onStored = (row) => {
    if (row.mime.startsWith('audio/')) return analyzeAsset(ctx, row.id).then(() => undefined);
  };
  (ctx as any).setBaseUrl = (u: string) => (base = u);
  return ctx;
}
