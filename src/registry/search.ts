import fs from 'node:fs';
import path from 'node:path';
import type { DB } from '../core/db';
import type { PresetDef } from '../dsl/schema';
import { canSee, type AgentCtx, type LibraryStore, type LibVersion } from './store';

export interface PresetCard {
  id: string; // alias:slug
  ref: string; // @scope/name/slug
  library: string;
  version: string;
  kind: string;
  summary: string;
  tags: string[];
  required: string[];
  params: string[];
  duration?: number;
  uses: number;
  rating?: number;
  renders: number;
  deprecated?: string;
  draft: boolean;
  thumb?: string;
  score?: number;
}

const SYNONYMS: Record<string, string[]> = {
  punchy: ['impact', 'slam', 'bold', 'pop', 'energetic'],
  impact: ['slam', 'punchy', 'shake', 'flash'],
  intro: ['title', 'opening', 'hero', 'reveal'],
  opening: ['intro', 'title'],
  outro: ['end', 'closing', 'cta'],
  ending: ['end', 'outro', 'closing'],
  number: ['stat', 'counter', 'kpi', 'metric'],
  numbers: ['stat', 'counter', 'data'],
  metric: ['stat', 'kpi', 'counter'],
  big: ['hero', 'large', 'slam'],
  fade: ['dissolve', 'opacity'],
  dissolve: ['crossfade', 'fade'],
  text: ['heading', 'title', 'typography', 'kinetic'],
  typography: ['text', 'kinetic', 'heading'],
  words: ['text', 'kinetic', 'statement'],
  logo: ['brand', 'mark'],
  brand: ['logo', 'theme'],
  list: ['bullets', 'points', 'items'],
  chart: ['graph', 'data', 'bars'],
  graph: ['chart', 'data'],
  glitch: ['digital', 'cyber'],
  smooth: ['soft', 'ease'],
  fast: ['quick', 'whip', 'energetic'],
  background: ['backdrop', 'bg', 'ambient'],
  particles: ['dots', 'ambient', 'bokeh'],
  name: ['lower-third', 'caption'],
  caption: ['lower-third', 'subtitle'],
  photo: ['image', 'media'],
  video: ['media', 'b-roll'],
  appear: ['in', 'reveal', 'enter'],
  disappear: ['out', 'exit'],
  zoom: ['scale', 'push'],
  type: ['typewriter'],
  color: ['colour', 'theme', 'tint'],
  colour: ['color', 'tint'],
  dark: ['theme', 'night'],
  quote: ['testimonial', 'review'],
  cta: ['button', 'call-to-action'],
};

const STOP = new Set(['a', 'an', 'the', 'for', 'with', 'and', 'or', 'of', 'to', 'in', 'on', 'that', 'some', 'something', 'thing', 'me', 'i', 'my', 'is']);

/** Structural + text signature used for duplicate detection. */
export function signature(p: PresetDef): string[] {
  const toks = new Set<string>();
  for (const w of `${p.slug} ${p.summary} ${p.tags.join(' ')}`.toLowerCase().split(/[^a-z0-9]+/)) if (w.length > 2 && !STOP.has(w)) toks.add('w:' + w);
  const walk = (v: unknown, key?: string) => {
    if (typeof v === 'string') {
      if (key === 'type') toks.add('t:' + v);
      else if (key === 'use' || key === 'p' || key === 'extends') toks.add('u:' + v);
      for (const m of v.matchAll(/\b([a-z][a-z0-9-]*:[a-z0-9-]+)\b/g)) toks.add('u:' + m[1]);
    } else if (Array.isArray(v)) v.forEach((x) => walk(x, key));
    else if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) {
        if (key === 'tracks') toks.add('c:' + k);
        walk(x, k);
      }
    }
  };
  walk(p.body);
  if (p.extends) toks.add('u:' + p.extends);
  toks.add('k:' + p.kind);
  return [...toks];
}

export function similarity(a: string[], b: string[]): number {
  const split = (s: string[]) => [new Set(s.filter((x) => x.startsWith('w:'))), new Set(s.filter((x) => !x.startsWith('w:')))];
  const jac = (x: Set<string>, y: Set<string>) => {
    if (!x.size && !y.size) return 0;
    let i = 0;
    for (const v of x) if (y.has(v)) i++;
    return i / (x.size + y.size - i);
  };
  const [aw, as] = split(a);
  const [bw, bs] = split(b);
  return 0.4 * jac(aw, bw) + 0.6 * jac(as, bs);
}

export class SearchIndex {
  constructor(
    private db: DB,
    private store: LibraryStore,
    private thumbsDir: string,
  ) {}

  reindex() {
    const tx = this.db.transaction(() => {
      this.db.exec('DELETE FROM presets; DELETE FROM presets_fts;');
      for (const entry of this.store.libs.values()) {
        const latest = this.store.latest(entry.name);
        const all = [...entry.versions.values(), ...(entry.draft ? [entry.draft] : [])];
        for (const lv of all) this.indexVersion(lv, lv === latest);
      }
    });
    tx();
  }

  reindexLibrary(name: string) {
    const tx = this.db.transaction(() => {
      const keys = this.db.prepare('SELECT key FROM presets WHERE library = ?').all(name) as { key: string }[];
      const del = this.db.prepare('DELETE FROM presets_fts WHERE key = ?');
      for (const k of keys) del.run(k.key);
      this.db.prepare('DELETE FROM presets WHERE library = ?').run(name);
      const entry = this.store.get(name);
      if (!entry) return;
      const latest = this.store.latest(name);
      for (const lv of [...entry.versions.values(), ...(entry.draft ? [entry.draft] : [])]) this.indexVersion(lv, lv === latest);
    });
    tx();
  }

  private indexVersion(lv: LibVersion, isLatest: boolean) {
    const ins = this.db.prepare(
      `INSERT INTO presets (key, library, version, is_latest, slug, alias, kind, summary, tags, required, params, duration, owner, visibility, deprecated, signature)
       VALUES (@key, @library, @version, @is_latest, @slug, @alias, @kind, @summary, @tags, @required, @params, @duration, @owner, @visibility, @deprecated, @signature)`,
    );
    const fts = this.db.prepare('INSERT INTO presets_fts (key, slug, summary, tags, kind, library) VALUES (?, ?, ?, ?, ?, ?)');
    for (const p of lv.presets.values()) {
      const key = `${lv.name}/${p.slug}@${lv.version}`;
      const required = Object.entries(p.params).filter(([, d]) => d.required).map(([k]) => k);
      ins.run({
        key,
        library: lv.name,
        version: lv.version,
        is_latest: isLatest ? 1 : 0,
        slug: p.slug,
        alias: lv.alias,
        kind: p.kind,
        summary: p.summary,
        tags: p.tags.join(' '),
        required: JSON.stringify(required),
        params: JSON.stringify(Object.keys(p.params)),
        duration: p.duration?.default ?? null,
        owner: lv.manifest.owner ?? null,
        visibility: lv.manifest.visibility,
        deprecated: p.deprecated ? p.deprecated.successor ?? p.deprecated.reason ?? 'yes' : null,
        signature: JSON.stringify(signature(p)),
      });
      fts.run(key, p.slug.replace(/-/g, ' '), p.summary, p.tags.join(' '), p.kind, `${lv.name} ${lv.alias}`);
    }
  }

  thumbPath(library: string, slug: string, version: string) {
    return path.join(this.thumbsDir, library.replace('/', '__'), `${slug}@${version}.jpg`);
  }

  search(o: {
    q?: string;
    kind?: string;
    library?: string;
    tags?: string[];
    limit?: number;
    drafts?: boolean;
    deprecated?: boolean;
    agent: AgentCtx;
    imported?: string[];
  }): PresetCard[] {
    const limit = Math.max(1, Math.min(50, o.limit ?? 8));
    const where: string[] = [];
    const args: unknown[] = [];
    if (o.kind) {
      where.push('p.kind = ?');
      args.push(o.kind);
    }
    if (o.library) {
      where.push('(p.library = ? OR p.alias = ?)');
      args.push(o.library, o.library);
    }
    const draftClause = o.drafts ? "(p.is_latest = 1 OR p.version = 'draft')" : 'p.is_latest = 1';
    where.push(draftClause);
    if (!o.deprecated) where.push('p.deprecated IS NULL');

    let rows: any[];
    const terms = (o.q ?? '')
      .toLowerCase()
      .split(/[^a-z0-9-]+/)
      .filter((w) => w && !STOP.has(w));
    if (terms.length) {
      const expanded = new Set<string>();
      for (const t of terms) {
        expanded.add(t);
        for (const s of SYNONYMS[t] ?? []) expanded.add(s);
        if (t.includes('-')) t.split('-').forEach((x) => x && expanded.add(x));
      }
      const match = [...expanded].map((t) => `"${t.replace(/"/g, '')}"*`).join(' OR ');
      rows = this.db
        .prepare(
          `SELECT p.*, bm25(presets_fts, 0, 4.0, 1.5, 2.5, 0.5, 0.5) AS rank FROM presets_fts f JOIN presets p ON p.key = f.key
           WHERE presets_fts MATCH ? AND ${where.join(' AND ')} ORDER BY rank LIMIT 200`,
        )
        .all(match, ...args);
      // boost exact term hits so "stat" beats synonyms
      for (const r of rows) {
        const hay = `${r.slug} ${r.tags} ${r.summary}`.toLowerCase();
        const direct = terms.filter((t) => hay.includes(t)).length;
        r.rel = -r.rank * (1 + direct);
      }
    } else {
      rows = this.db.prepare(`SELECT p.* FROM presets p WHERE ${where.join(' AND ')} LIMIT 500`).all(...args);
      for (const r of rows) r.rel = 1;
    }
    if (o.tags?.length) rows = rows.filter((r) => o.tags!.every((t) => r.tags.split(' ').includes(t)));

    const statQ = this.db.prepare('SELECT * FROM preset_stats WHERE library = ? AND slug = ?');
    const cards: PresetCard[] = [];
    const seen = new Set<string>();
    for (const r of rows) {
      const lv = this.store.get(r.library);
      const version = r.version === 'draft' ? lv?.draft : lv?.versions.get(r.version);
      if (!version || !canSee(version, o.agent)) continue;
      const dedupe = `${r.library}/${r.slug}`;
      if (seen.has(dedupe)) continue;
      seen.add(dedupe);
      const st = statQ.get(r.library, r.slug) as any;
      const uses = st?.uses ?? 0;
      const rating = st?.rating_n ? st.rating_sum / st.rating_n : undefined;
      const renders = (st?.renders_ok ?? 0) + (st?.renders_fail ?? 0);
      const successRate = renders ? (st.renders_ok ?? 0) / renders : 1;
      let score = r.rel * (1 + 0.12 * Math.log1p(uses)) * (rating ? 0.8 + rating / 12.5 : 1) * (0.7 + 0.3 * successRate);
      if (r.version === 'draft') score *= 0.8;
      if (o.imported?.includes(r.library)) score *= 1.25;
      if (r.library === '@core/base') score *= 1.02;
      const thumb = this.thumbPath(r.library, r.slug, r.version);
      cards.push({
        id: `${r.alias}:${r.slug}`,
        ref: `${r.library}/${r.slug}`,
        library: r.library,
        version: r.version,
        kind: r.kind,
        summary: r.summary,
        tags: r.tags ? r.tags.split(' ') : [],
        required: JSON.parse(r.required),
        params: JSON.parse(r.params),
        duration: r.duration ?? undefined,
        uses,
        rating: rating !== undefined ? Math.round(rating * 10) / 10 : undefined,
        renders,
        deprecated: r.deprecated ?? undefined,
        draft: r.version === 'draft',
        thumb: fs.existsSync(thumb) ? thumb : undefined,
        score,
      });
    }
    if (terms.length) cards.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
    else cards.sort((a, b) => b.uses - a.uses || a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id));
    return cards.slice(0, limit);
  }

  /** Presets most similar to a candidate, for "extend it instead?" hints. */
  similar(sig: string[], kind: string, excludeKey: string, agent: AgentCtx, limit = 3) {
    const rows = this.db.prepare("SELECT key, library, version, alias, slug, signature FROM presets WHERE kind = ? AND (is_latest = 1 OR version = 'draft')").all(kind) as any[];
    const out: { id: string; key: string; score: number }[] = [];
    for (const r of rows) {
      if (r.key === excludeKey || `${r.library}/${r.slug}` === excludeKey) continue;
      const lv = this.store.get(r.library);
      const v = r.version === 'draft' ? lv?.draft : lv?.versions.get(r.version);
      if (!v || !canSee(v, agent)) continue;
      out.push({ id: `${r.alias}:${r.slug}`, key: r.key, score: similarity(sig, JSON.parse(r.signature)) });
    }
    return out.sort((a, b) => b.score - a.score).slice(0, limit);
  }

  bumpStat(library: string, slug: string, field: 'uses' | 'renders_ok' | 'renders_fail', by = 1) {
    this.db
      .prepare(
        `INSERT INTO preset_stats (library, slug, ${field}, last_used) VALUES (?, ?, ?, datetime('now'))
         ON CONFLICT(library, slug) DO UPDATE SET ${field} = ${field} + excluded.${field}, last_used = datetime('now')`,
      )
      .run(library, slug, by);
  }

  stats(library: string, slug: string) {
    return (this.db.prepare('SELECT * FROM preset_stats WHERE library = ? AND slug = ?').get(library, slug) as any) ?? {
      uses: 0,
      renders_ok: 0,
      renders_fail: 0,
      rating_sum: 0,
      rating_n: 0,
    };
  }
}

export function cardLine(c: PresetCard): string {
  const bits = [`${c.id}@${c.version}`, c.kind, c.summary];
  if (c.required.length) bits.push(`req: ${c.required.join(', ')}`);
  const opt = c.params.filter((p) => !c.required.includes(p));
  if (opt.length) bits.push(`opt: ${opt.slice(0, 8).join(', ')}${opt.length > 8 ? '…' : ''}`);
  if (c.duration) bits.push(`${c.duration}s`);
  if (c.uses) bits.push(`used ${c.uses}`);
  if (c.rating) bits.push(`★${c.rating}`);
  if (c.deprecated) bits.push(`DEPRECATED → ${c.deprecated}`);
  return bits.join(' · ');
}
