import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { badRequest, notFound } from './errors';
import type { DB } from './db';
import { sha256 } from './util';

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
};

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
    const row = this.db.prepare('SELECT id FROM assets WHERE id = ?').get(id) as { id: string } | undefined;
    return row ? `${this.baseUrl()}/v1/assets/${row.id}/raw` : null;
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
    if (row.mime.startsWith('image/') && row.mime !== 'image/svg+xml') {
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
  if (buf.subarray(0, 200).toString('utf8').includes('<svg')) return 'svg';
  return null;
}
