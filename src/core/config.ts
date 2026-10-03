import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export interface AgentConfig {
  id: string;
  key?: string;
  admin?: boolean;
  projects?: string[];
}

export interface MotionForgeConfig {
  host: string;
  port: number;
  /** "none": trust the x-mf-agent header (local default). "keys": require a Bearer key from `agents`. */
  auth: 'none' | 'keys';
  agents: AgentConfig[];
  dataDir: string;
  librariesDir: string;
  defaultFormat: string;
  defaultTheme: string;
  render: {
    /** Chromium tabs per render (null = Remotion default, half the cores). */
    concurrency: number | null;
    /** Parallel jobs. 1 is right for most machines: each render already uses several tabs. */
    jobs: number;
    browserExecutable: string | null;
    segmentCache: boolean;
    /** WebGL backend for 3D layers ("angle", "swangle", "egl", "swiftshader", "vulkan", or null for Chrome's default). */
    gl: string | null;
  };
  promotion: {
    /** Automatic promotion to @shared happens when ALL of these are met (or a human promotes it). */
    minRatings: number;
    minAverage: number;
    minRenders: number;
    minSuccessRate: number;
  };
}

const DEFAULTS: MotionForgeConfig = {
  host: '127.0.0.1',
  port: 7420,
  auth: 'none',
  agents: [],
  dataDir: 'data',
  librariesDir: 'libraries',
  defaultFormat: '1920x1080@30',
  defaultTheme: 'core:dark',
  render: { concurrency: null, jobs: 1, browserExecutable: null, segmentCache: true, gl: process.platform === 'linux' ? 'swangle' : 'angle' },
  promotion: { minRatings: 3, minAverage: 4, minRenders: 5, minSuccessRate: 0.9 },
};

function deepMerge<T>(base: T, over: any): T {
  if (!over || typeof over !== 'object' || Array.isArray(over)) return (over ?? base) as T;
  const out: any = Array.isArray(base) ? [...(base as any)] : { ...(base as any) };
  for (const k of Object.keys(over)) {
    const b = (base as any)?.[k];
    out[k] = b && typeof b === 'object' && !Array.isArray(b) ? deepMerge(b, over[k]) : over[k];
  }
  return out;
}

let cached: MotionForgeConfig | null = null;

export function loadConfig(overrides: Partial<MotionForgeConfig> = {}): MotionForgeConfig {
  if (cached && !Object.keys(overrides).length) return cached;
  const file = process.env.MF_CONFIG ?? path.join(ROOT, 'motionforge.config.json');
  let fromFile = {};
  if (fs.existsSync(file)) fromFile = JSON.parse(fs.readFileSync(file, 'utf8'));
  let cfg = deepMerge(DEFAULTS, fromFile);
  cfg = deepMerge(cfg, overrides);
  if (process.env.MF_PORT) cfg.port = Number(process.env.MF_PORT);
  if (process.env.MF_HOST) cfg.host = process.env.MF_HOST;
  if (process.env.MF_DATA_DIR) cfg.dataDir = process.env.MF_DATA_DIR;
  if (process.env.MF_LIBRARIES_DIR) cfg.librariesDir = process.env.MF_LIBRARIES_DIR;
  if (process.env.MF_GL) cfg.render.gl = process.env.MF_GL === 'default' ? null : (process.env.MF_GL as any);
  if (process.env.MF_BROWSER_EXECUTABLE) cfg.render.browserExecutable = process.env.MF_BROWSER_EXECUTABLE;
  cfg.dataDir = path.resolve(ROOT, cfg.dataDir);
  cfg.librariesDir = path.resolve(ROOT, cfg.librariesDir);
  if (!Object.keys(overrides).length) cached = cfg;
  return cfg;
}

export function dataPaths(cfg: MotionForgeConfig) {
  const d = cfg.dataDir;
  const p = {
    root: d,
    db: path.join(d, 'motionforge.db'),
    assets: path.join(d, 'assets'),
    cache: path.join(d, 'cache'),
    bundles: path.join(d, 'cache', 'bundles'),
    segments: path.join(d, 'cache', 'segments'),
    previews: path.join(d, 'previews'),
    thumbs: path.join(d, 'thumbs'),
    renders: path.join(d, 'renders'),
  };
  for (const dir of Object.values(p)) if (!path.extname(dir)) fs.mkdirSync(dir, { recursive: true });
  return p;
}
