/**
 * Composition files: agents keep the JSON on disk and edit it with their own file tools,
 * MotionForge reads it (mf_validate/mf_patch {"file"}) and writes JSON Patch results back.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { MotionForgeConfig } from './config';
import { badRequest, forbidden } from './errors';

export const hashText = (s: string) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 16);

export function resolveFile(cfg: MotionForgeConfig, p: string, mode: 'read' | 'write'): string {
  if (typeof p !== 'string' || !p.trim()) throw badRequest('file must be a path to a .json file');
  if (!cfg.files[mode]) throw forbidden(`file ${mode} is disabled (config files.${mode})`);
  const abs = path.resolve(p.trim().replace(/^~(?=$|[\\/])/, process.env.HOME ?? process.env.USERPROFILE ?? '~'));
  if (path.extname(abs).toLowerCase() !== '.json') throw badRequest(`file must end with .json: ${abs}`);
  const roots = cfg.files.roots.map((r) => path.resolve(r));
  if (roots.length && !roots.some((r) => abs === r || abs.startsWith(r + path.sep))) {
    throw forbidden(`file is outside the allowed folders (config files.roots: ${roots.join(', ')})`);
  }
  return abs;
}

/** Line and column of a character offset, for JSON syntax errors. */
function lineCol(text: string, pos: number) {
  const before = text.slice(0, pos).split('\n');
  return `line ${before.length}, column ${before[before.length - 1].length + 1}`;
}

export function readJsonFile(abs: string): { json: unknown; text: string; hash: string } {
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) throw badRequest(`file not found: ${abs}`);
  if (fs.statSync(abs).size > 20 * 1024 * 1024) throw badRequest('file larger than 20 MB');
  const text = fs.readFileSync(abs, 'utf8').replace(/^﻿/, '');
  try {
    return { json: JSON.parse(text), text, hash: hashText(text) };
  } catch (e: any) {
    const m = /position (\d+)/.exec(e.message);
    const where = m ? ` (${lineCol(text, Number(m[1]))})` : '';
    throw badRequest(`${path.basename(abs)} is not valid JSON${where}: ${e.message.split('\n')[0]}`);
  }
}

/** Write JSON keeping the file's indentation style (2 spaces by default). */
export function writeJsonFile(abs: string, value: unknown, previous?: string): string {
  const ind = previous ? /\n([ \t]+)"/.exec(previous)?.[1] : undefined;
  const text = JSON.stringify(value, null, ind ?? 2) + '\n';
  const crlf = previous?.includes('\r\n');
  const out = crlf ? text.replace(/\n/g, '\r\n') : text;
  fs.writeFileSync(abs, out);
  return out;
}
