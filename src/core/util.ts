import crypto from 'node:crypto';

export const sha256 = (s: string | Buffer) => crypto.createHash('sha256').update(s).digest('hex');
export const shortId = (prefix: string, bytes = 4) => `${prefix}_${crypto.randomBytes(bytes).toString('hex')}`;

/** Deterministic JSON (sorted keys) for hashing. */
export function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
  const o = v as Record<string, unknown>;
  return '{' + Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => JSON.stringify(k) + ':' + stableStringify(o[k])).join(',') + '}';
}

export const clone = <T>(v: T): T => (v === undefined ? v : JSON.parse(JSON.stringify(v)));

export const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);

export const round = (n: number, d = 2) => Math.round(n * 10 ** d) / 10 ** d;

export const estTokens = (chars: number) => Math.ceil(chars / 4);
