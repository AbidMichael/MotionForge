/**
 * A small, safe expression language for preset bodies: `{{ value * 2 }}`, `{{ index * 0.15 }}`,
 * `{{ subtitle ? 1 : 0 }}`, `{{ upper(label) }}`, `{{ $color.accent }}`.
 * No eval, no prototype access, whitelisted functions only.
 */

type Node =
  | { t: 'num'; v: number }
  | { t: 'str'; v: string }
  | { t: 'lit'; v: boolean | null }
  | { t: 'id'; name: string }
  | { t: 'arr'; items: Node[] }
  | { t: 'obj'; entries: [string, Node][] }
  | { t: 'mem'; obj: Node; prop: Node }
  | { t: 'call'; fn: string; args: Node[] }
  | { t: 'un'; op: string; a: Node }
  | { t: 'bin'; op: string; a: Node; b: Node }
  | { t: 'cond'; c: Node; a: Node; b: Node };

import { mixColor, withAlpha } from '../ir/evaluate';

const BLOCKED = new Set(['__proto__', 'constructor', 'prototype']);

type Tok = { k: 'num' | 'str' | 'id' | 'op'; v: string };

const OPS = ['**', '==', '!=', '<=', '>=', '&&', '||', '??', '+', '-', '*', '/', '%', '<', '>', '!', '?', ':', '(', ')', '[', ']', '{', '}', ',', '.'];

function lex(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] ?? ''))) {
      let j = i;
      while (j < src.length && /[0-9._eE]/.test(src[j])) {
        if ((src[j] === 'e' || src[j] === 'E') && /[+-]/.test(src[j + 1] ?? '')) j++;
        j++;
      }
      out.push({ k: 'num', v: src.slice(i, j).replace(/_/g, '') });
      i = j;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      let s = '';
      while (j < src.length && src[j] !== c) {
        if (src[j] === '\\' && j + 1 < src.length) {
          j++;
          s += src[j] === 'n' ? '\n' : src[j];
        } else s += src[j];
        j++;
      }
      if (j >= src.length) throw new Error('unterminated string');
      out.push({ k: 'str', v: s });
      i = j + 1;
      continue;
    }
    if (/[A-Za-z_$]/.test(c)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_$]/.test(src[j])) j++;
      out.push({ k: 'id', v: src.slice(i, j) });
      i = j;
      continue;
    }
    const op = OPS.find((o) => src.startsWith(o, i));
    if (!op) throw new Error(`unexpected '${c}'`);
    out.push({ k: 'op', v: op });
    i += op.length;
  }
  return out;
}

class Parser {
  i = 0;
  constructor(private toks: Tok[]) {}
  peek(v?: string) {
    const t = this.toks[this.i];
    return t && (v === undefined || (t.k === 'op' && t.v === v)) ? t : undefined;
  }
  eat(v: string) {
    if (!this.peek(v)) throw new Error(`expected '${v}'`);
    this.i++;
  }
  parse(): Node {
    const n = this.ternary();
    if (this.i < this.toks.length) throw new Error(`unexpected '${this.toks[this.i].v}'`);
    return n;
  }
  ternary(): Node {
    const c = this.binary(0);
    if (this.peek('?')) {
      this.i++;
      const a = this.ternary();
      this.eat(':');
      const b = this.ternary();
      return { t: 'cond', c, a, b };
    }
    return c;
  }
  static PREC: [string[], number][] = [
    [['??'], 1],
    [['||'], 2],
    [['&&'], 3],
    [['==', '!='], 4],
    [['<', '<=', '>', '>='], 5],
    [['+', '-'], 6],
    [['*', '/', '%'], 7],
  ];
  binary(minLevel: number): Node {
    let left = this.unary();
    for (;;) {
      const t = this.toks[this.i];
      if (!t || t.k !== 'op') break;
      const entry = Parser.PREC.find(([ops]) => ops.includes(t.v));
      if (!entry || entry[1] <= minLevel) break;
      this.i++;
      const right = this.binary(entry[1]);
      left = { t: 'bin', op: t.v, a: left, b: right };
    }
    return left;
  }
  unary(): Node {
    const t = this.toks[this.i];
    if (t && t.k === 'op' && (t.v === '!' || t.v === '-' || t.v === '+')) {
      this.i++;
      return { t: 'un', op: t.v, a: this.unary() };
    }
    const base = this.postfix();
    if (this.peek('**')) {
      this.i++;
      return { t: 'bin', op: '**', a: base, b: this.unary() };
    }
    return base;
  }
  postfix(): Node {
    let n = this.primary();
    for (;;) {
      if (this.peek('.')) {
        this.i++;
        const id = this.toks[this.i++];
        if (!id || id.k !== 'id') throw new Error('expected property name');
        n = { t: 'mem', obj: n, prop: { t: 'str', v: id.v } };
      } else if (this.peek('[')) {
        this.i++;
        const p = this.ternary();
        this.eat(']');
        n = { t: 'mem', obj: n, prop: p };
      } else if (this.peek('(')) {
        if (n.t !== 'id') throw new Error('only named functions can be called');
        this.i++;
        const args: Node[] = [];
        if (!this.peek(')')) {
          do args.push(this.ternary());
          while (this.peek(',') && ++this.i);
        }
        this.eat(')');
        n = { t: 'call', fn: n.name, args };
      } else break;
    }
    return n;
  }
  primary(): Node {
    const t = this.toks[this.i++];
    if (!t) throw new Error('unexpected end');
    if (t.k === 'num') {
      const v = Number(t.v);
      if (Number.isNaN(v)) throw new Error(`bad number '${t.v}'`);
      return { t: 'num', v };
    }
    if (t.k === 'str') return { t: 'str', v: t.v };
    if (t.k === 'id') {
      if (t.v === 'true') return { t: 'lit', v: true };
      if (t.v === 'false') return { t: 'lit', v: false };
      if (t.v === 'null') return { t: 'lit', v: null };
      return { t: 'id', name: t.v };
    }
    if (t.v === '(') {
      const n = this.ternary();
      this.eat(')');
      return n;
    }
    if (t.v === '{') {
      const entries: [string, Node][] = [];
      if (!this.peek('}')) {
        do {
          const k = this.toks[this.i++];
          if (!k || (k.k !== 'id' && k.k !== 'str')) throw new Error('expected object key');
          if (BLOCKED.has(k.v)) throw new Error(`key '${k.v}' is not allowed`);
          this.eat(':');
          entries.push([k.v, this.ternary()]);
        } while (this.peek(',') && ++this.i);
      }
      this.eat('}');
      return { t: 'obj', entries };
    }
    if (t.v === '[') {
      const items: Node[] = [];
      if (!this.peek(']')) {
        do items.push(this.ternary());
        while (this.peek(',') && ++this.i);
      }
      this.eat(']');
      return { t: 'arr', items };
    }
    throw new Error(`unexpected '${t.v}'`);
  }
}

const toNum = (v: unknown) => (typeof v === 'number' ? v : Number(v));

export const FUNCTIONS: Record<string, (...a: any[]) => unknown> = {
  min: (...a) => Math.min(...a.map(toNum)),
  max: (...a) => Math.max(...a.map(toNum)),
  clamp: (v, lo, hi) => Math.min(toNum(hi), Math.max(toNum(lo), toNum(v))),
  round: (v, d = 0) => Math.round(toNum(v) * 10 ** d) / 10 ** d,
  floor: (v) => Math.floor(toNum(v)),
  ceil: (v) => Math.ceil(toNum(v)),
  abs: (v) => Math.abs(toNum(v)),
  sqrt: (v) => Math.sqrt(toNum(v)),
  sin: (v) => Math.sin(toNum(v)),
  cos: (v) => Math.cos(toNum(v)),
  len: (v) => (v == null ? 0 : typeof v === 'string' || Array.isArray(v) ? v.length : Object.keys(v).length),
  words: (v) => String(v ?? '').trim().split(/\s+/).filter(Boolean).length,
  upper: (v) => String(v ?? '').toUpperCase(),
  lower: (v) => String(v ?? '').toLowerCase(),
  str: (v) => String(v ?? ''),
  num: (v) => toNum(v),
  split: (v, sep = ' ') => String(v ?? '').split(String(sep)),
  join: (v, sep = ' ') => (Array.isArray(v) ? v.join(String(sep)) : String(v ?? '')),
  first: (v) => (Array.isArray(v) ? v[0] : String(v ?? '')[0]),
  last: (v) => (Array.isArray(v) ? v[v.length - 1] : String(v ?? '').slice(-1)),
  pluck: (arr, key) => (Array.isArray(arr) ? arr.map((x) => (x && typeof x === 'object' ? (x as any)[String(key)] : x)) : []),
  pick: (i, ...opts) => opts[((Math.round(toNum(i)) % opts.length) + opts.length) % opts.length],
  fixed: (v, d = 0) => toNum(v).toFixed(d),
  alpha: (c, a) => withAlpha(String(c), Math.max(0, Math.min(1, toNum(a)))),
  mix: (a, b, t) => mixColor(String(a), String(b), toNum(t)),
  lerp: (a, b, t) => toNum(a) + (toNum(b) - toNum(a)) * toNum(t),
  /** Deterministic pseudo-random in [0,1) from a seed (same seed → same value, so renders are stable). */
  rand: (seed, salt = 0) => {
    const x = Math.sin(toNum(seed) * 12.9898 + toNum(salt) * 78.233) * 43758.5453;
    return x - Math.floor(x);
  },
  maxOf: (arr, key) => (Array.isArray(arr) && arr.length ? Math.max(...arr.map((x) => toNum(key ? x?.[key] : x))) : 0),
  minOf: (arr, key) => (Array.isArray(arr) && arr.length ? Math.min(...arr.map((x) => toNum(key ? x?.[key] : x))) : 0),
  sumOf: (arr, key) => (Array.isArray(arr) ? arr.reduce((n: number, x) => n + toNum(key ? x?.[key] : x), 0) : 0),
  rep: (v, n = 2, sep = '') => Array.from({ length: Math.max(0, Math.min(200, Math.floor(toNum(n)))) }, () => String(v ?? '')).join(String(sep)),
  pad: (v, n = 2, ch = '0') => String(v ?? '').padStart(toNum(n), String(ch)),
};

function getMember(obj: any, prop: unknown) {
  if (obj == null) return undefined;
  const key = String(prop);
  if (BLOCKED.has(key)) throw new Error(`property '${key}' is not allowed`);
  if (typeof obj === 'string') return key === 'length' ? obj.length : obj[Number(key)];
  if (typeof obj !== 'object') return undefined;
  return Object.prototype.hasOwnProperty.call(obj, key) ? obj[key] : undefined;
}

export type Scope = Record<string, unknown>;

function evalNode(n: Node, scope: Scope): any {
  switch (n.t) {
    case 'num':
    case 'str':
    case 'lit':
      return n.v;
    case 'arr':
      return n.items.map((x) => evalNode(x, scope));
    case 'obj': {
      const o: Record<string, unknown> = {};
      for (const [k, v] of n.entries) o[k] = evalNode(v, scope);
      return o;
    }
    case 'id':
      if (BLOCKED.has(n.name)) throw new Error(`'${n.name}' is not allowed`);
      if (!Object.prototype.hasOwnProperty.call(scope, n.name)) {
        throw new Error(`unknown name '${n.name}'`);
      }
      return scope[n.name];
    case 'mem':
      return getMember(evalNode(n.obj, scope), evalNode(n.prop, scope));
    case 'call': {
      const f = FUNCTIONS[n.fn];
      if (!f) throw new Error(`unknown function '${n.fn}'`);
      return f(...n.args.map((a) => evalNode(a, scope)));
    }
    case 'un': {
      const a = evalNode(n.a, scope);
      return n.op === '!' ? !a : n.op === '-' ? -toNum(a) : toNum(a);
    }
    case 'cond':
      return evalNode(n.c, scope) ? evalNode(n.a, scope) : evalNode(n.b, scope);
    case 'bin': {
      if (n.op === '&&') return evalNode(n.a, scope) && evalNode(n.b, scope);
      if (n.op === '||') return evalNode(n.a, scope) || evalNode(n.b, scope);
      if (n.op === '??') return evalNode(n.a, scope) ?? evalNode(n.b, scope);
      const a = evalNode(n.a, scope);
      const b = evalNode(n.b, scope);
      switch (n.op) {
        case '+':
          return typeof a === 'string' || typeof b === 'string' ? String(a ?? '') + String(b ?? '') : toNum(a) + toNum(b);
        case '-':
          return toNum(a) - toNum(b);
        case '*':
          return toNum(a) * toNum(b);
        case '/':
          return toNum(a) / toNum(b);
        case '%':
          return toNum(a) % toNum(b);
        case '**':
          return toNum(a) ** toNum(b);
        case '==':
          return a == b; // eslint-disable-line eqeqeq
        case '!=':
          return a != b; // eslint-disable-line eqeqeq
        case '<':
          return a < b;
        case '<=':
          return a <= b;
        case '>':
          return a > b;
        case '>=':
          return a >= b;
      }
    }
  }
  throw new Error('bad expression');
}

const astCache = new Map<string, Node>();

export function parseExpr(src: string): Node {
  let ast = astCache.get(src);
  if (!ast) {
    ast = new Parser(lex(src)).parse();
    if (astCache.size > 5000) astCache.clear();
    astCache.set(src, ast);
  }
  return ast;
}

export function evaluate(src: string, scope: Scope): unknown {
  return evalNode(parseExpr(src), scope);
}

/** Names an expression reads from scope (for validation / dependency hints). */
export function freeNames(src: string): string[] {
  const out = new Set<string>();
  const walk = (n: Node) => {
    switch (n.t) {
      case 'id':
        out.add(n.name);
        break;
      case 'arr':
        n.items.forEach(walk);
        break;
      case 'obj':
        n.entries.forEach(([, v]) => walk(v));
        break;
      case 'mem':
        walk(n.obj);
        if (n.prop.t !== 'str') walk(n.prop);
        break;
      case 'call':
        n.args.forEach(walk);
        break;
      case 'un':
        walk(n.a);
        break;
      case 'bin':
        walk(n.a);
        walk(n.b);
        break;
      case 'cond':
        walk(n.c);
        walk(n.a);
        walk(n.b);
        break;
    }
  };
  walk(parseExpr(src));
  return [...out];
}
