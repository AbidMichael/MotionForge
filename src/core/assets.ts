import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { badRequest, notFound } from './errors';
import type { DB } from './db';
import { sha256 } from './util';
import { extractZip, inspectModel, MODEL_EXTS, zipDir, type ModelInfo } from './models';

const MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  svg: 'image/svg+xml',
  avif: 'image/avif',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  m4a: 'audio/mp4',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
  json: 'application/json',
  // 3D: models (or a zip of a model + textures), environment maps, compressed textures
  glb: 'model/gltf-binary',
  gltf: 'model/gltf+json',
  fbx: 'model/vnd.fbx',
  obj: 'model/obj',
  zip: 'application/zip',
  hdr: 'image/vnd.radiance',
  exr: 'image/x-exr',
  ktx2: 'image/ktx2',
};

/** Content types for files served from an extracted zip. */
export const FILE_MIME: Record<string, string> = { ...MIME, bin: 'application/octet-stream', mtl: 'text/plain', tga: 'image/x-tga', bmp: 'image/bmp', tif: 'image/tiff', tiff: 'image/tiff', dds: 'image/vnd-ms.dds' };

export interface AssetRow {
  id: string;
  sha: string;
  name: string;
  mime: string;
  bytes: number;
  tags: string | null;
  agent: string;
  path: string;
  created: string;
}

export interface AssetInfo {
  id: string;
  ref: string;
  name: string;
  mime: string;
  bytes: number;
  width?: number;
  height?: number;
  url: string;
  /** 3D models: what is inside (meshes, size, materials, animations, missing textures). */
  model?: ModelInfo;
}

const MAX_BYTES = 500 * 1024 * 1024;

/** Content-addressed asset store: the same file uploaded twice is stored once. */
export class AssetStore {
  /** Called after a new file is stored (music gets analysed for beats here). */
  onStored?: (row: AssetRow) => Promise<void> | void;

  constructor(
    private db: DB,
    private dir: string,
    private baseUrl: () => string,
  ) {}

  url(id: string): string | null {
    const row = this.db.prepare('SELECT id, mime, path FROM assets WHERE id = ?').get(id) as { id: string; mime: string; path: string } | undefined;
    if (!row) return null;
    // a zipped model is served as a folder so its relative texture paths resolve
    if (row.mime === 'application/zip') {
      const z = this.zip(row.path);
      if (z.main) return `${this.baseUrl()}/v1/assets/${row.id}/files/${z.main.split('/').map(encodeURIComponent).join('/')}`;
    }
    return `${this.baseUrl()}/v1/assets/${row.id}/raw`;
  }

  private zip(file: string) {
    return extractZip(file);
  }

  /** Local file of a model asset (the main model inside a zip), or null. */
  modelFile(id: string): string | null {
    const row = this.get(id);
    if (row.mime === 'application/zip') {
      const z = this.zip(row.path);
      return z.main ? path.join(z.dir, ...z.main.split('/')) : null;
    }
    return MODEL_EXTS.includes(path.extname(row.path).slice(1).toLowerCase()) ? row.path : null;
  }

  /** Model inspection (cached next to the file). */
  async modelInfo(id: string): Promise<ModelInfo> {
    const row = this.get(id);
    const file = this.modelFile(id);
    if (!file) throw badRequest(`asset ${id} is not a 3D model`);
    return inspectModel(file, row.path + '.model.json');
  }

  /** A file inside an extracted zip asset (path-traversal safe). */
  zipFile(id: string, rel: string): { file: string; mime: string } {
    const row = this.get(id);
    if (row.mime !== 'application/zip') throw notFound(`asset ${id} is not a zip`);
    const dir = zipDir(row.path);
    this.zip(row.path);
    const file = path.resolve(dir, ...decodeURIComponent(rel).split('/'));
    if (!file.startsWith(path.resolve(dir) + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) throw notFound(`${rel} in asset ${id}`);
    return { file, mime: FILE_MIME[path.extname(file).slice(1).toLowerCase()] ?? 'application/octet-stream' };
  }

  get(id: string): AssetRow {
    const row = this.db.prepare('SELECT * FROM assets WHERE id = ?').get(id.replace(/^asset:/, '')) as AssetRow | undefined;
    if (!row) throw notFound(`asset ${id}`);
    return row;
  }

  list(limit = 50): AssetRow[] {
    return this.db.prepare('SELECT * FROM assets ORDER BY created DESC LIMIT ?').all(limit) as AssetRow[];
  }

  async put(input: { path?: string; url?: string; base64?: string; name?: string; tags?: string[] }, agent: string): Promise<AssetInfo> {
    let buf: Buffer;
    let name = input.name ?? '';
    if (input.path) {
      const p = path.resolve(input.path);
      if (!fs.existsSync(p) || !fs.statSync(p).isFile()) throw badRequest(`file not found: ${input.path}`);
      const ext = path.extname(p).slice(1).toLowerCase();
      if (!MIME[ext]) throw badRequest(`unsupported file type .${ext} (allowed: ${Object.keys(MIME).join(', ')})`);
      if (fs.statSync(p).size > MAX_BYTES) throw badRequest('file larger than 500 MB');
      buf = fs.readFileSync(p);
      name = name || path.basename(p);
    } else if (input.url) {
      if (!/^https?:\/\//.test(input.url)) throw badRequest('url must be http(s)');
      const res = await fetch(input.url);
      if (!res.ok) throw badRequest(`download failed: HTTP ${res.status}`);
      buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > MAX_BYTES) throw badRequest('file larger than 500 MB');
      name = name || decodeURIComponent(new URL(input.url).pathname.split('/').pop() || 'download');
    } else if (input.base64) {
      buf = Buffer.from(input.base64.replace(/^data:[^,]+,/, ''), 'base64');
      if (!name) throw badRequest('name (with extension) is required with base64');
    } else throw badRequest('give one of: path, url, base64');

    let ext = path.extname(name).slice(1).toLowerCase();
    if (!MIME[ext]) {
      const sniff = await sniffExt(buf);
      if (!sniff) throw badRequest(`cannot tell the file type of "${name}"; include an extension`);
      ext = sniff;
      name = `${name || 'asset'}.${ext}`;
    }
    const sha = sha256(buf);
    const id = sha.slice(0, 16);
    const existing = this.db.prepare('SELECT * FROM assets WHERE id = ?').get(id) as AssetRow | undefined;
    if (!existing) {
      const file = path.join(this.dir, id.slice(0, 2), `${id}.${ext}`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, buf);
      if (ext === 'zip') {
        const z = extractZip(file);
        if (!z.main) {
          fs.rmSync(file, { force: true });
          fs.rmSync(zipDir(file), { recursive: true, force: true });
          throw badRequest('the zip holds no 3D model (.glb, .gltf, .fbx or .obj)');
        }
      }
      this.db
        .prepare('INSERT INTO assets (id, sha, name, mime, bytes, tags, agent, path) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(id, sha, name, MIME[ext], buf.length, input.tags?.join(' ') ?? null, agent, file);
      try {
        await this.onStored?.(this.get(id));
      } catch {
        /* analysis is best effort; it is retried when the asset is used */
      }
    }
    return this.info(id);
  }

  async info(id: string): Promise<AssetInfo> {
    const row = this.get(id);
    const out: AssetInfo = { id: row.id, ref: `asset:${row.id}`, name: row.name, mime: row.mime, bytes: row.bytes, url: this.url(row.id)! };
    if (this.modelFile(row.id)) {
      try {
        out.model = await this.modelInfo(row.id);
      } catch (e: any) {
        out.model = { error: e.message } as any;
      }
    }
    if (row.mime.startsWith('image/') && !['image/svg+xml', 'image/vnd.radiance', 'image/x-exr', 'image/ktx2'].includes(row.mime)) {
      try {
        const m = await sharp(row.path).metadata();
        out.width = m.width;
        out.height = m.height;
      } catch {
        /* not fatal */
      }
    }
    return out;
  }
}

async function sniffExt(buf: Buffer): Promise<string | null> {
  const h = buf.subarray(0, 16);
  if (h[0] === 0x89 && h[1] === 0x50) return 'png';
  if (h[0] === 0xff && h[1] === 0xd8) return 'jpg';
  if (h.toString('ascii', 0, 4) === 'RIFF' && h.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  if (h.toString('ascii', 0, 3) === 'GIF') return 'gif';
  if (h.toString('ascii', 4, 8) === 'ftyp') return 'mp4';
  if (h[0] === 0x1a && h[1] === 0x45) return 'webm';
  if (h.toString('ascii', 0, 4) === 'wOF2') return 'woff2';
  if (h.toString('ascii', 0, 4) === 'glTF') return 'glb';
  if (h[0] === 0x50 && h[1] === 0x4b && h[2] === 0x03 && h[3] === 0x04) return 'zip';
  if (buf.subarray(0, 18).toString('ascii') === 'Kaydara FBX Binary') return 'fbx';
  if (/^#\?(RADIANCE|RGBE)/.test(buf.subarray(0, 12).toString('ascii'))) return 'hdr';
  if (h[0] === 0x76 && h[1] === 0x2f && h[2] === 0x31 && h[3] === 0x01) return 'exr';
  if (buf.subarray(0, 200).toString('utf8').includes('<svg')) return 'svg';
  return null;
}
