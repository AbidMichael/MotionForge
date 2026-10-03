import semver from 'semver';
import type { Ctx } from '../core/context';
import { badRequest, forbidden, MFError, notFound, type Issue } from '../core/errors';
import { clone, isObj } from '../core/util';
import { compile, inspectPreset, presetExample } from '../dsl/compile';
import type { LibraryManifestT, PresetDef } from '../dsl/schema';
import { cardLine, signature } from './search';
import { canSee, canWrite, defaultAlias, parsePreset, SYSTEM_AGENT, type AgentCtx, type LibVersion } from './store';

export const HUB = '@shared/hub';

export interface LibraryCard {
  name: string;
  alias: string;
  latest: string;
  versions: string[];
  hasDraft: boolean;
  summary: string;
  presets: number;
  visibility: string;
  owner?: string;
  depends: Record<string, string>;
}

const KIND_BODY_CHECK: Record<string, (b: Record<string, any>) => string | null> = {
  animation: (b) => (isObj(b.tracks) ? null : 'animation body needs "tracks": { channel: keyframes }'),
  element: (b) => (Array.isArray(b.layers) ? null : 'element body needs "layers": [...]'),
  scene: (b) => (Array.isArray(b.layers) || Array.isArray(b.scenes) ? null : 'scene body needs "layers": [...] (or "scenes": [...] for a macro)'),
  template: (b) => (Array.isArray(b.scenes) ? null : 'template body needs "scenes": [...]'),
  transition: (b) => (b.in || b.out || b.overlay ? null : 'transition body needs "in", "out" and/or "overlay"'),
  theme: (b) => (isObj(b.tokens) ? null : 'theme body needs "tokens": {...}'),
};

export class RegistryService {
  constructor(private c: Ctx) {}

  // ---------- read ----------
  card(lv: LibVersion): LibraryCard {
    const e = this.c.store.get(lv.name)!;
    return {
      name: lv.name,
      alias: lv.alias,
      latest: lv.version,
      versions: [...e.versions.keys()].sort(semver.rcompare),
      hasDraft: !!e.draft,
      summary: lv.manifest.summary,
      presets: lv.presets.size,
      visibility: lv.manifest.visibility,
      owner: lv.manifest.owner,
      depends: lv.manifest.depends,
    };
  }

  listLibraries(agent: AgentCtx): LibraryCard[] {
    const out: LibraryCard[] = [];
    for (const e of this.c.store.libs.values()) {
      const lv = this.c.store.latest(e.name);
      const visible = (lv && canSee(lv, agent)) || (e.draft && canSee(e.draft, agent));
      if (!visible) continue;
      out.push(this.card(lv ?? e.draft!));
    }
    return out.sort((a, b) => (a.name.startsWith('@core/') ? -1 : 0) - (b.name.startsWith('@core/') ? -1 : 0) || a.name.localeCompare(b.name));
  }

  library(name: string, agent: AgentCtx, version?: string) {
    const lv = this.c.store.resolve(name, version, agent);
    const byKind: Record<string, string[]> = {};
    for (const p of lv.presets.values()) (byKind[p.kind] ??= []).push(`${lv.alias}:${p.slug}${p.deprecated ? ' (deprecated)' : ''}`);
    for (const k of Object.keys(byKind)) byKind[k].sort();
    return { ...this.card(lv), version: lv.version, guide: lv.manifest.guide, tags: lv.manifest.tags, presetsByKind: byKind };
  }

  preset(ref: string, agent: AgentCtx) {
    const { info, errors } = inspectPreset(ref, agent, this.c.compileOpts);
    if (!info) throw new MFError(404, errors.map((e) => e.msg).join('; ') || `preset ${ref} not found`);
    const p = info.preset;
    const st = this.c.index.stats(info.library, p.slug);
    return {
      id: info.id,
      ref: info.ref,
      version: info.version,
      kind: p.kind,
      summary: p.summary,
      tags: p.tags,
      params: info.params,
      duration: p.duration,
      extends: p.extends,
      chain: info.chain,
      slots: p.slots,
      example: p.example,
      deprecated: p.deprecated,
      stats: { uses: st.uses, renders: st.renders_ok + st.renders_fail, rating: st.rating_n ? +(st.rating_sum / st.rating_n).toFixed(2) : null },
      body: info.body,
      raw: (() => {
        const lv = this.c.store.resolve(info.library, info.version, agent);
        return this.c.store.rawPreset(lv, p.slug);
      })(),
    };
  }

  // ---------- write ----------
  createLibrary(input: Record<string, any>, agent: AgentCtx) {
    if (typeof input.name !== 'string') throw badRequest('name is required, e.g. "@' + agent.id + '/promo"');
    const name = input.name.trim();
    const lv = this.c.store.createLibrary(
      {
        name,
        summary: input.summary ?? `${name} presets`,
        alias: input.alias,
        guide: input.guide,
        depends: input.depends ?? {},
        visibility: input.visibility ?? 'private',
        tags: input.tags,
        owner: agent.id,
      } as any,
      agent,
    );
    this.c.index.reindexLibrary(name);
    this.c.events.publish('library', agent.id, { action: 'create', library: name, alias: lv.alias });
    return this.card(lv);
  }

  updateLibrary(name: string, patch: Partial<LibraryManifestT>, agent: AgentCtx) {
    const e = this.c.store.get(name);
    if (!e) throw notFound(`library ${name}`);
    if (!canWrite(name, agent, e.draft ?? this.c.store.latest(name))) throw forbidden(`agent '${agent.id}' cannot edit ${name}`);
    const allowed: (keyof LibraryManifestT)[] = ['summary', 'guide', 'depends', 'visibility', 'tags', 'alias'];
    const clean: Record<string, unknown> = {};
    for (const k of allowed) if ((patch as any)[k] !== undefined) clean[k] = (patch as any)[k];
    this.c.store.updateManifest(name, clean);
    this.c.index.reindexLibrary(name);
    this.c.events.publish('library', agent.id, { action: 'update', library: name, fields: Object.keys(clean) });
    return this.card(this.c.store.get(name)!.draft!);
  }

  putPreset(name: string, raw: Record<string, any>, agent: AgentCtx) {
    const e = this.c.store.get(name);
    if (!e) throw notFound(`library ${name}`, `create it first with mf_library_create`);
    const lvAny = e.draft ?? this.c.store.latest(name)!;
    if (!canWrite(name, agent, lvAny)) throw forbidden(`agent '${agent.id}' cannot write to ${name}`);
    if (name === HUB) throw forbidden(`${HUB} is filled by promotion only`);
    if (!isObj(raw)) throw badRequest('preset must be an object');
    const input = { ...raw };
    if (!input.slug && typeof input.id === 'string') input.slug = input.id.split(':').pop();
    delete input.id;
    delete input.version;
    const parsed = parsePreset(input, 'preset');
    if (!parsed.preset) throw badRequest('invalid preset', parsed.issues);
    const p = parsed.preset;
    if (p.body) {
      const msg = KIND_BODY_CHECK[p.kind]?.(p.body as Record<string, any>);
      if (msg) throw badRequest(msg);
    }
    const draft = this.c.store.ensureDraft(name);
    const id = `${draft.alias}:${p.slug}`;
    const write = this.c.store.writePreset(name, input);
    // test-compile the example so broken presets never land
    const comp = presetExample(this.c.store.get(name)!.draft!, p, this.c.compileOpts, agent);
    const r = compile({ composition: comp, agent }, this.c.compileOpts);
    if (!r.ok) {
      this.c.store.rollback(name, write);
      throw badRequest(
        `preset ${id} does not compile with its example${p.example ? '' : ' (synthesised from required params)'}`,
        r.errors.map((x) => ({ path: x.path.replace(/^scenes\[\d+\](\.layers\[\d+\])?/, 'example'), msg: x.msg })),
        'fix the body or give an "example" that uses realistic params',
      );
    }
    this.c.index.reindexLibrary(name);
    const sim = this.c.index.similar(signature(p), p.kind, `${name}/${p.slug}`, agent);
    const warnings: Issue[] = [...r.warnings];
    const near = sim.filter((s) => s.score >= 0.82);
    if (near.length) warnings.push({ path: id, msg: `near-duplicate of ${near.map((s) => `${s.id} (${s.score.toFixed(2)})`).join(', ')} — consider "extends" instead` });
    const thumbJob = this.c.jobs.enqueue('thumb', agent.id, { library: name, version: 'draft', slug: p.slug }, { lane: 'fast', priority: 1 });
    this.c.events.publish('library', agent.id, { action: 'preset_put', library: name, preset: id, kind: p.kind, version: 'draft', created: write.previous === null });
    return {
      id,
      version: 'draft',
      created: write.previous === null,
      duration: r.duration,
      warnings,
      similar: sim.filter((s) => s.score >= 0.45).map((s) => ({ id: s.id, score: +s.score.toFixed(2) })),
      thumbJob: thumbJob.id,
      usage: `use it now with "use": ["${name}@draft"] and "${id}"; publish with mf_library_publish`,
    };
  }

  deletePreset(name: string, slug: string, agent: AgentCtx) {
    const e = this.c.store.get(name);
    if (!e) throw notFound(`library ${name}`);
    if (!canWrite(name, agent, e.draft ?? this.c.store.latest(name))) throw forbidden(`agent '${agent.id}' cannot write to ${name}`);
    this.c.store.deletePreset(name, slug);
    this.c.index.reindexLibrary(name);
    this.c.events.publish('library', agent.id, { action: 'preset_delete', library: name, slug });
    return { deleted: `${name}/${slug}`, note: 'removed from the draft; published versions keep it' };
  }

  /** Compare the draft against the latest published version → required semver bump. */
  diff(name: string) {
    const e = this.c.store.get(name)!;
    const draft = e.draft;
    if (!draft) throw badRequest(`${name} has no draft changes`);
    const prevVer = [...e.versions.keys()].sort(semver.rcompare)[0];
    const prev = prevVer ? e.versions.get(prevVer)! : null;
    const changes: { level: 'major' | 'minor' | 'patch'; msg: string }[] = [];
    if (!prev) return { prev: null, required: 'major' as const, changes: [{ level: 'major' as const, msg: 'first release' }] };
    for (const [slug, old] of prev.presets) {
      const now = draft.presets.get(slug);
      if (!now) {
        changes.push({ level: 'major', msg: `removed ${slug}` });
        continue;
      }
      if (now.kind !== old.kind) changes.push({ level: 'major', msg: `${slug}: kind ${old.kind} → ${now.kind}` });
      for (const [k, d] of Object.entries(old.params)) {
        const nd = now.params[k];
        if (!nd) changes.push({ level: 'major', msg: `${slug}: removed param ${k}` });
        else if (nd.type !== d.type && !(nd as any).__partial) changes.push({ level: 'major', msg: `${slug}: param ${k} ${d.type} → ${nd.type}` });
      }
      for (const [k, d] of Object.entries(now.params)) {
        if (!old.params[k]) {
          if (d.required && d.default === undefined) changes.push({ level: 'major', msg: `${slug}: new required param ${k}` });
          else changes.push({ level: 'minor', msg: `${slug}: new param ${k}` });
        }
      }
      const a = JSON.stringify(this.c.store.rawPreset(prev, slug));
      const b = JSON.stringify(this.c.store.rawPreset(draft, slug));
      if (a !== b && !changes.some((c) => c.msg.startsWith(slug + ':'))) changes.push({ level: 'patch', msg: `${slug}: changed` });
    }
    for (const slug of draft.presets.keys()) if (!prev.presets.has(slug)) changes.push({ level: 'minor', msg: `added ${slug}` });
    const pm = JSON.stringify({ ...prev.manifest, version: 0, publishedAt: 0 });
    const dm = JSON.stringify({ ...draft.manifest, version: 0, publishedAt: 0 });
    if (pm !== dm) changes.push({ level: 'patch', msg: 'library manifest changed' });
    const required = changes.some((c) => c.level === 'major') ? 'major' : changes.some((c) => c.level === 'minor') ? 'minor' : 'patch';
    return { prev: prevVer, required: required as 'major' | 'minor' | 'patch', changes };
  }

  publish(name: string, opts: { bump?: 'major' | 'minor' | 'patch'; version?: string }, agent: AgentCtx, internal = false) {
    const e = this.c.store.get(name);
    if (!e) throw notFound(`library ${name}`);
    if (!internal && !canWrite(name, agent, e.draft ?? this.c.store.latest(name))) throw forbidden(`agent '${agent.id}' cannot publish ${name}`);
    if (!internal && name === HUB) throw forbidden(`${HUB} is published by promotion only`);
    const d = this.diff(name);
    if (d.prev && d.changes.length === 0) throw badRequest('nothing changed since ' + d.prev);
    const order = { patch: 0, minor: 1, major: 2 };
    let version: string;
    if (opts.version) {
      if (!semver.valid(opts.version)) throw badRequest('version must be semver like 1.2.0');
      version = opts.version;
    } else if (!d.prev) version = '1.0.0';
    else {
      const bump = opts.bump ?? d.required;
      if (order[bump] < order[d.required]) {
        throw badRequest(`these changes need a ${d.required} bump, not ${bump}`, d.changes.filter((c) => c.level === d.required).map((c) => ({ path: name, msg: c.msg })));
      }
      version = semver.inc(d.prev, bump)!;
    }
    if (d.prev && !semver.gt(version, d.prev)) throw badRequest(`version must be greater than ${d.prev}`);
    // every preset must compile before the version becomes immutable
    const draft = e.draft!;
    const failures: Issue[] = [];
    for (const p of draft.presets.values()) {
      const comp = presetExample(draft, p, this.c.compileOpts, SYSTEM_AGENT);
      const r = compile({ composition: comp, agent: SYSTEM_AGENT }, this.c.compileOpts);
      if (!r.ok) failures.push(...r.errors.slice(0, 3).map((x) => ({ path: `${draft.alias}:${p.slug}`, msg: x.msg })));
    }
    if (failures.length) throw badRequest('some presets do not compile; fix them before publishing', failures);
    const lv = this.c.store.publishDraft(name, version);
    this.c.index.reindexLibrary(name);
    for (const p of lv.presets.values()) this.c.jobs.enqueue('thumb', agent.id, { library: name, version, slug: p.slug }, { lane: 'fast', priority: 0 });
    this.c.events.publish('library', agent.id, { action: 'publish', library: name, version, changes: d.changes.length });
    return { library: name, version, previous: d.prev, changes: d.changes, use: `"use": ["${name}@^${semver.major(version)}"]` };
  }

  deprecate(ref: string, opts: { successor?: string; reason?: string }, agent: AgentCtx) {
    const info = this.preset(ref, agent);
    const [lib] = [info.ref.slice(0, info.ref.lastIndexOf('/'))];
    const e = this.c.store.get(lib)!;
    if (!canWrite(lib, agent, e.draft ?? this.c.store.latest(lib))) throw forbidden(`agent '${agent.id}' cannot edit ${lib}`);
    const draft = this.c.store.ensureDraft(lib);
    const raw = this.c.store.rawPreset(draft, info.ref.split('/').pop()!);
    if (!raw) throw notFound(`${ref} in the draft of ${lib}`);
    raw.deprecated = { successor: opts.successor, reason: opts.reason };
    this.c.store.writePreset(lib, raw);
    this.c.index.reindexLibrary(lib);
    this.c.events.publish('library', agent.id, { action: 'deprecate', preset: info.id, successor: opts.successor });
    return { deprecated: info.id, note: 'marked in the draft; publish a patch to ship it' };
  }

  // ---------- usage signals ----------
  rate(ref: string, score: number, note: string | undefined, agent: AgentCtx) {
    if (!(score >= 1 && score <= 5)) throw badRequest('score must be 1..5');
    const info = this.preset(ref, agent);
    const lib = info.ref.slice(0, info.ref.lastIndexOf('/'));
    const slug = info.ref.split('/').pop()!;
    this.c.db.prepare('INSERT INTO ratings (library, slug, agent, score, note) VALUES (?, ?, ?, ?, ?)').run(lib, slug, agent.id, Math.round(score), note ?? null);
    this.c.db
      .prepare(
        `INSERT INTO preset_stats (library, slug, rating_sum, rating_n) VALUES (?, ?, ?, 1)
         ON CONFLICT(library, slug) DO UPDATE SET rating_sum = rating_sum + excluded.rating_sum, rating_n = rating_n + 1`,
      )
      .run(lib, slug, Math.round(score));
    this.c.events.publish('rating', agent.id, { preset: info.id, score: Math.round(score), note });
    const promoted = this.maybeAutoPromote(lib, slug);
    const st = this.c.index.stats(lib, slug);
    return { preset: info.id, ratings: st.rating_n, average: +(st.rating_sum / st.rating_n).toFixed(2), promoted };
  }

  recordUsage(used: string[], field: 'uses' | 'renders_ok' | 'renders_fail') {
    for (const u of used) {
      const i = u.lastIndexOf('/');
      const lib = u.slice(0, i);
      const slug = u.slice(i + 1);
      this.c.index.bumpStat(lib, slug, field);
      if (field === 'renders_ok') this.maybeAutoPromote(lib, slug);
    }
  }

  // ---------- promotion to @shared (either rating threshold OR human) ----------
  promotionStatus(lib: string, slug: string) {
    const P = this.c.cfg.promotion;
    const st = this.c.index.stats(lib, slug);
    const renders = st.renders_ok + st.renders_fail;
    const avg = st.rating_n ? st.rating_sum / st.rating_n : 0;
    const checks = {
      ratings: { have: st.rating_n, need: P.minRatings, ok: st.rating_n >= P.minRatings },
      average: { have: +avg.toFixed(2), need: P.minAverage, ok: avg >= P.minAverage },
      renders: { have: st.renders_ok, need: P.minRenders, ok: st.renders_ok >= P.minRenders },
      successRate: { have: renders ? +(st.renders_ok / renders).toFixed(2) : 0, need: P.minSuccessRate, ok: renders > 0 && st.renders_ok / renders >= P.minSuccessRate },
    };
    return { checks, eligible: Object.values(checks).every((c) => c.ok) };
  }

  activePromotion(source: string) {
    return this.c.db.prepare("SELECT * FROM promotions WHERE source LIKE ? AND status = 'active'").get(source + '@%') as any;
  }

  maybeAutoPromote(lib: string, slug: string): string | null {
    if (lib.startsWith('@core/') || lib === HUB) return null;
    const e = this.c.store.get(lib);
    const latest = e && [...e.versions.keys()].sort(semver.rcompare)[0];
    if (!latest || !e!.versions.get(latest)!.presets.has(slug)) return null;
    if (this.activePromotion(`${lib}/${slug}`)) return null;
    if (!this.promotionStatus(lib, slug).eligible) return null;
    try {
      const r = this.promote(`${lib}/${slug}`, 'auto', 'system');
      return r.shared;
    } catch (err) {
      this.c.events.publish('promotion', 'system', { action: 'skipped', source: `${lib}/${slug}`, reason: (err as Error).message });
      return null;
    }
  }

  private ensureHub(): LibVersion {
    if (!this.c.store.get(HUB)) {
      this.c.store.createLibrary(
        {
          name: HUB,
          alias: 'shared',
          summary: 'Shared hub: proven presets promoted from agent and project libraries.',
          guide: 'Presets here were promoted because they rated well or a human approved them. Use them like any other: "use": ["@shared/hub@^1"], then "shared:<slug>".',
          depends: {},
          visibility: 'public',
          owner: 'system',
        } as any,
        SYSTEM_AGENT,
      );
    }
    return this.c.store.ensureDraft(HUB);
  }

  promote(ref: string, mode: 'auto' | 'human', by: string) {
    const info = this.preset(ref, SYSTEM_AGENT);
    const lib = info.ref.slice(0, info.ref.lastIndexOf('/'));
    const slug = info.ref.split('/').pop()!;
    if (lib.startsWith('@core/') || lib === HUB) throw badRequest(`${info.id} is already shared`);
    if (info.version === 'draft') throw badRequest(`publish ${lib} before promoting ${info.id}`);
    if (this.activePromotion(`${lib}/${slug}`)) throw badRequest(`${info.id} is already promoted`);
    const source = this.c.store.resolve(lib, info.version);
    const raw = clone(this.c.store.rawPreset(source, slug)) as Record<string, any>;
    if (!raw) throw notFound(`${ref} file`);
    const hub = this.ensureHub();
    const depends: Record<string, string> = { ...hub.manifest.depends };
    // dependencies: public libraries are added to the hub; same-library refs must already be promoted
    const problems: string[] = [];
    const rewrite = (s: string) =>
      s.replace(/\b([a-z][a-z0-9-]*):([a-z0-9][a-z0-9-]*)\b/g, (m, alias: string, target: string) => {
        if (alias === 'core' || alias === 'shared') return m;
        if (alias === source.alias) {
          const promoted = this.activePromotion(`${lib}/${target}`);
          if (promoted) return promoted.shared_id;
          if (target !== slug) problems.push(`${m} (promote it first)`);
          return m;
        }
        const dep = [...Object.keys(source.manifest.depends)].map((n) => this.c.store.latest(n)).find((lv) => lv?.alias === alias);
        if (!dep) return m;
        if (dep.manifest.visibility !== 'public') problems.push(`${m} lives in non-public ${dep.name}`);
        else depends[dep.name] = source.manifest.depends[dep.name];
        return m;
      });
    const walk = (v: unknown): unknown => {
      if (typeof v === 'string') return rewrite(v);
      if (Array.isArray(v)) return v.map(walk);
      if (isObj(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
      return v;
    };
    const out = walk(raw) as Record<string, any>;
    if (problems.length) throw badRequest(`cannot promote ${info.id}`, problems.map((m) => ({ path: info.id, msg: m })));
    let target = slug;
    for (let i = 2; hub.presets.has(target); i++) target = `${slug}-${i}`;
    out.slug = target;
    out.promotedFrom = `${lib}/${slug}@${info.version}`;
    delete out.deprecated;
    if (out.example) {
      const ex = JSON.stringify(out.example).replace(new RegExp(`"${source.alias}:${slug}"`, 'g'), `"shared:${target}"`);
      out.example = JSON.parse(ex);
    }
    this.c.store.updateManifest(HUB, { depends });
    this.c.store.writePreset(HUB, out);
    const pub = this.publish(HUB, { bump: this.c.store.get(HUB)!.versions.size ? 'minor' : undefined }, SYSTEM_AGENT, true);
    const sharedId = `shared:${target}`;
    this.c.db.prepare('INSERT INTO promotions (source, shared_id, mode, by) VALUES (?, ?, ?, ?)').run(`${lib}/${slug}@${info.version}`, sharedId, mode, by);
    this.c.events.publish('promotion', by, { action: 'promoted', mode, source: info.id, shared: sharedId, version: pub.version });
    return { shared: sharedId, hubVersion: pub.version, mode };
  }

  demote(sharedRef: string, by: string, reason?: string) {
    const slug = sharedRef.replace(/^shared:/, '').replace(/^@shared\/hub\//, '');
    const hub = this.c.store.get(HUB);
    if (!hub) throw notFound('shared hub');
    const draft = this.c.store.ensureDraft(HUB);
    const raw = this.c.store.rawPreset(draft, slug);
    if (!raw) throw notFound(`shared:${slug}`);
    raw.deprecated = { reason: reason ?? `demoted by ${by}` };
    this.c.store.writePreset(HUB, raw);
    const pub = this.publish(HUB, { bump: 'patch' }, SYSTEM_AGENT, true);
    this.c.db.prepare("UPDATE promotions SET status = 'demoted' WHERE shared_id = ? AND status = 'active'").run(`shared:${slug}`);
    this.c.events.publish('promotion', by, { action: 'demoted', shared: `shared:${slug}`, version: pub.version });
    return { demoted: `shared:${slug}`, hubVersion: pub.version };
  }

  /** Presets with usage signals that are not promoted yet, plus recent promotions (dashboard). */
  promotionBoard() {
    const rows = this.c.db
      .prepare(
        `SELECT s.* FROM preset_stats s WHERE s.library NOT LIKE '@core/%' AND s.library != ? AND (s.rating_n > 0 OR s.renders_ok > 0) ORDER BY s.rating_n DESC, s.renders_ok DESC LIMIT 50`,
      )
      .all(HUB) as any[];
    const candidates = rows
      .filter((r) => !this.activePromotion(`${r.library}/${r.slug}`))
      .map((r) => {
        const lv = this.c.store.latest(r.library);
        const published = !!lv && lv.version !== 'draft' && lv.presets.has(r.slug);
        return { id: `${lv?.alias ?? defaultAlias(r.library)}:${r.slug}`, ref: `${r.library}/${r.slug}`, published, ...this.promotionStatus(r.library, r.slug) };
      });
    const promotions = this.c.db.prepare('SELECT * FROM promotions ORDER BY id DESC LIMIT 30').all();
    return { rule: this.c.cfg.promotion, candidates, promotions };
  }

  cards(q: Parameters<Ctx['index']['search']>[0]) {
    const cards = this.c.index.search(q);
    return { cards, text: cards.map(cardLine).join('\n') };
  }
}

export type { PresetDef };
