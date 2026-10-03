import type { Issue } from '../core/errors';
import { evaluate, type Scope } from './expr';

export type Tokens = Record<string, any>;

const WHOLE_EXPR = /^\{\{([\s\S]+?)\}\}$/;
const ANY_EXPR = /\{\{([\s\S]+?)\}\}/g;
const TOKEN_REF = /^\$([a-zA-Z_][a-zA-Z0-9_]*(?:\.[a-zA-Z0-9_-]+)+)$/;

export function lookupToken(tokens: Tokens, ref: string): unknown {
  const parts = ref.split('.');
  let cur: any = tokens;
  for (const p of parts) {
    if (cur == null || typeof cur !== 'object' || !Object.prototype.hasOwnProperty.call(cur, p)) return undefined;
    cur = cur[p];
  }
  return cur;
}

export interface BindCtx {
  scope: Scope;
  tokens: Tokens;
  issues: Issue[];
}

/** Scope with token groups exposed as `$color`, `$font`… so expressions can read them. */
export function tokenScope(tokens: Tokens): Scope {
  const s: Scope = {};
  for (const k of Object.keys(tokens)) s['$' + k] = tokens[k];
  return s;
}

function bindString(s: string, ctx: BindCtx, path: string): unknown {
  const whole = WHOLE_EXPR.exec(s);
  if (whole && whole[1].indexOf('{{') < 0 && s.indexOf('}}') === s.length - 2) {
    try {
      const v = evaluate(whole[1], ctx.scope);
      return typeof v === 'string' ? bindToken(v, ctx, path) : v;
    } catch (e) {
      ctx.issues.push({ path, msg: `{{${whole[1].trim()}}}: ${(e as Error).message}` });
      return undefined;
    }
  }
  if (s.includes('{{')) {
    return s.replace(ANY_EXPR, (_m, src: string) => {
      try {
        const v = evaluate(src, ctx.scope);
        return v == null ? '' : String(v);
      } catch (e) {
        ctx.issues.push({ path, msg: `{{${src.trim()}}}: ${(e as Error).message}` });
        return '';
      }
    });
  }
  return bindToken(s, ctx, path);
}

function bindToken(s: string, ctx: BindCtx, path: string): unknown {
  if (s.startsWith('\\$')) return s.slice(1);
  const m = TOKEN_REF.exec(s);
  if (!m) return s;
  const v = lookupToken(ctx.tokens, m[1]);
  if (v === undefined) {
    const group = m[1].split('.')[0];
    const avail = ctx.tokens[group] && typeof ctx.tokens[group] === 'object' ? Object.keys(ctx.tokens[group]).join(', ') : Object.keys(ctx.tokens).join(', ');
    ctx.issues.push({ path, msg: `unknown token $${m[1]} (available: ${avail})` });
    return undefined;
  }
  return v;
}

/** Bind params/expressions/tokens in a JSON value. `skip` keys are left untouched (bound later in another scope). */
export function bindValue(v: unknown, ctx: BindCtx, path: string, skip?: Set<string>): unknown {
  if (typeof v === 'string') return bindString(v, ctx, path);
  if (Array.isArray(v)) return v.map((x, i) => bindValue(x, ctx, `${path}[${i}]`));
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) out[k] = skip?.has(k) ? x : bindValue(x, ctx, path ? `${path}.${k}` : k);
    return out;
  }
  return v;
}

const UNIT = /^(-?\d*\.?\d+)(px|%|vw|vh|vmin|vmax)?$/;

/** Convert a length to px. Axis decides what % means. */
export function toPx(v: unknown, axis: 'x' | 'y' | 'min', W: number, H: number, ref?: number): number | undefined {
  if (typeof v === 'number') return v;
  if (typeof v !== 'string') return undefined;
  const m = UNIT.exec(v.trim());
  if (!m) return undefined;
  const n = parseFloat(m[1]);
  switch (m[2]) {
    case undefined:
    case 'px':
      return n;
    case '%':
      return (n / 100) * (ref ?? (axis === 'x' ? W : axis === 'y' ? H : Math.min(W, H)));
    case 'vw':
      return (n / 100) * W;
    case 'vh':
      return (n / 100) * H;
    case 'vmin':
      return (n / 100) * Math.min(W, H);
    case 'vmax':
      return (n / 100) * Math.max(W, H);
  }
  return undefined;
}
