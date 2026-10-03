import jsonpatch from 'fast-json-patch';
import type { Ctx } from './context';
import { badRequest, forbidden, notFound, type Issue } from './errors';
import { clone, isObj, shortId } from './util';
import { compile, type CompileResult } from '../dsl/compile';
import { motionSummary } from '../dsl/summary';
import { SCENE_KEYS } from '../dsl/schema';
import type { AgentCtx } from '../registry/store';

export interface RevisionOut {
  id: string;
  rev: number;
  ok: boolean;
  duration: number;
  format: string;
  scenes: { i: number; preset?: string; start: number; d: number }[];
  errors: Issue[];
  warnings: Issue[];
  lock: Record<string, string>;
  summary?: string;
}

interface RevRow {
  comp_id: string;
  rev: number;
  json: string;
  lock: string;
  ok: number;
  errors: string | null;
  warnings: string | null;
  duration: number | null;
  agent: string;
  created: string;
}

export class CompositionService {
  private cache = new Map<string, CompileResult>();

  constructor(private c: Ctx) {}

  private compileWith(json: unknown, agent: AgentCtx, lock?: Record<string, string>) {
    return compile({ composition: json, agent, lock }, this.c.compileOpts);
  }

  private out(id: string, rev: number, r: CompileResult, summary: boolean): RevisionOut {
    return {
      id,
      rev,
      ok: r.ok,
      duration: r.duration,
      format: `${r.format.width}x${r.format.height}@${r.format.fps}`,
      scenes: r.scenes.map((s) => ({ i: s.i, preset: s.preset, start: s.start, d: s.d })),
      errors: r.errors,
      warnings: r.warnings,
      lock: r.lock,
      summary: summary && r.ir ? motionSummary(r.ir) : undefined,
    };
  }

  /** Validate and store a composition (new, or a new revision of `id`). Invalid ones are stored too, so they can be patched. */
  submit(input: { composition: unknown; id?: string; title?: string; relock?: boolean; summary?: boolean }, agent: AgentCtx): RevisionOut {
    if (!isObj(input.composition)) throw badRequest('composition must be a JSON object');
    let id = input.id;
    let prevLock: Record<string, string> | undefined;
    if (id) {
      const head = this.headRow(id);
      this.assertOwner(id, agent);
      if (!input.relock) prevLock = JSON.parse(head.lock);
    } else {
      id = shortId('cmp');
      this.c.db.prepare('INSERT INTO compositions (id, agent, title) VALUES (?, ?, ?)').run(id, agent.id, input.title ?? (input.composition as any).title ?? null);
    }
    const r = this.compileWith(input.composition, agent, prevLock);
    const rev = ((this.c.db.prepare('SELECT MAX(rev) AS m FROM revisions WHERE comp_id = ?').get(id) as any)?.m ?? 0) + 1;
    this.c.db
      .prepare('INSERT INTO revisions (comp_id, rev, json, lock, ok, errors, warnings, duration, agent) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, rev, JSON.stringify(input.composition), JSON.stringify(r.lock), r.ok ? 1 : 0, JSON.stringify(r.errors), JSON.stringify(r.warnings), r.duration, agent.id);
    this.c.db.prepare("UPDATE compositions SET head = ?, updated = datetime('now'), title = COALESCE(?, title) WHERE id = ?").run(rev, input.title ?? null, id);
    if (r.ok) {
      this.cache.set(`${id}:${rev}`, r);
      this.c.registry.recordUsage(r.used, 'uses');
    }
    this.c.events.publish('composition', agent.id, {
      id,
      rev,
      ok: r.ok,
      duration: r.duration,
      scenes: r.scenes.length,
      errors: r.errors.length,
      title: input.title ?? (input.composition as any).title,
    });
    return this.out(id, rev, r, !!input.summary);
  }

  patch(id: string, ops: unknown, agent: AgentCtx, opts: { relock?: boolean; summary?: boolean } = {}): RevisionOut {
    if (!Array.isArray(ops) || ops.length === 0) throw badRequest('ops must be a non-empty JSON Patch array, e.g. [{"op":"replace","path":"/scenes/1/d","value":4}]');
    const head = this.headRow(id);
    this.assertOwner(id, agent);
    const doc = JSON.parse(head.json);
    const err = jsonpatch.validate(ops as any, doc);
    if (err) throw badRequest(`patch failed at op ${err.index}: ${err.message.split('\n')[0]}`, [{ path: (err.operation as any)?.path ?? '', msg: err.name }]);
    const next = jsonpatch.applyPatch(clone(doc), ops as any, false, false).newDocument;
    return this.submit({ composition: next, id, relock: opts.relock, summary: opts.summary }, agent);
  }

  get(id: string, rev?: number) {
    const comp = this.c.db.prepare('SELECT * FROM compositions WHERE id = ?').get(id) as any;
    if (!comp) throw notFound(`composition ${id}`);
    const row = this.row(id, rev ?? comp.head);
    return {
      id,
      title: comp.title,
      agent: comp.agent,
      head: comp.head,
      rev: row.rev,
      ok: !!row.ok,
      duration: row.duration,
      composition: JSON.parse(row.json),
      lock: JSON.parse(row.lock),
      errors: JSON.parse(row.errors ?? '[]'),
      warnings: JSON.parse(row.warnings ?? '[]'),
      created: row.created,
    };
  }

  list(limit = 30, agent?: string) {
    const rows = agent
      ? this.c.db.prepare('SELECT * FROM compositions WHERE agent = ? ORDER BY updated DESC LIMIT ?').all(agent, limit)
      : this.c.db.prepare('SELECT * FROM compositions ORDER BY updated DESC LIMIT ?').all(limit);
    return (rows as any[]).map((c) => {
      const r = this.row(c.id, c.head);
      return { id: c.id, title: c.title, agent: c.agent, rev: c.head, ok: !!r.ok, duration: r.duration, updated: c.updated };
    });
  }

  /** Compile a stored revision (deterministic thanks to its lockfile). */
  compiled(id: string, rev?: number): { r: CompileResult; rev: number; agent: string } {
    const comp = this.c.db.prepare('SELECT * FROM compositions WHERE id = ?').get(id) as any;
    if (!comp) throw notFound(`composition ${id}`);
    const n = rev ?? comp.head;
    const key = `${id}:${n}`;
    const row = this.row(id, n);
    let r = this.cache.get(key);
    if (!r) {
      r = this.compileWith(JSON.parse(row.json), { id: row.agent, admin: true, projects: [] }, JSON.parse(row.lock));
      if (this.cache.size > 50) this.cache.delete(this.cache.keys().next().value!);
      this.cache.set(key, r);
    }
    return { r, rev: n, agent: row.agent };
  }

  summary(id: string, rev?: number) {
    const { r, rev: n } = this.compiled(id, rev);
    if (!r.ok || !r.ir) throw badRequest(`${id} r${n} does not compile`, r.errors);
    return motionSummary(r.ir);
  }

  /**
   * Turn something that worked into a reusable preset.
   * scene: index → a scene macro; omitted → a template of the whole composition.
   * expose: paths whose current values become params (defaults = current values), e.g. ["title"] or ["0.title:headline", "2.value"].
   */
  saveAsPreset(
    input: { id: string; rev?: number; scene?: number; library: string; slug: string; summary: string; tags?: string[]; expose?: string[] },
    agent: AgentCtx,
  ) {
    const comp = this.get(input.id, input.rev);
    if (!comp.ok) throw badRequest(`${input.id} r${comp.rev} has errors; fix it before saving it as a preset`);
    const doc = comp.composition as Record<string, any>;
    const lib = this.c.store.get(input.library);
    if (!lib) throw notFound(`library ${input.library}`, 'create it with mf_library_create');
    let scenes: any[] = clone(doc.scenes);
    const single = input.scene !== undefined;
    if (single) {
      const s = scenes[input.scene!];
      if (!isObj(s) || s.t) throw badRequest(`scenes[${input.scene}] is not a scene`);
      scenes = [s];
    }
    // custom import aliases cannot be carried into a library
    const uses: string[] = (Array.isArray(doc.use) ? doc.use : doc.use ? [doc.use] : []).map(String);
    if (uses.some((u) => /\sas\s/.test(u))) throw badRequest('the composition imports a library "as" another alias; use default aliases before saving as a preset');
    const params: Record<string, any> = {};
    for (const spec of input.expose ?? []) {
      const [pathPart, nameOverride] = spec.split(':');
      const segs = pathPart.split(/[./]/).filter(Boolean);
      if (segs[0] === 'scenes') segs.shift();
      if (single && /^\d+$/.test(segs[0] ?? '') && Number(segs[0]) === input.scene) segs.shift();
      const idx = single ? 0 : Number(segs.shift());
      if (!Number.isInteger(idx) || !scenes[idx]) throw badRequest(`expose "${spec}": no scene ${idx}`);
      let parent: any = scenes[idx];
      for (let i = 0; i < segs.length - 1; i++) parent = parent?.[segs[i]];
      const key = segs[segs.length - 1];
      if (!isObj(parent) && !Array.isArray(parent)) throw badRequest(`expose "${spec}": path not found`);
      if (!key || (parent as any)[key] === undefined) throw badRequest(`expose "${spec}": no value at that path`);
      let name = (nameOverride ?? key).replace(/[^a-zA-Z0-9_]/g, '_');
      if (/^\d/.test(name)) name = 'p' + name;
      if (SCENE_KEYS.has(name) || ['x', 'y', 'at', 'dur', 'in', 'out', 'id', 'z'].includes(name)) name = name + '_';
      while (params[name]) name += '_';
      const value = (parent as any)[key];
      params[name] = {
        type: typeof value === 'number' ? 'number' : typeof value === 'boolean' ? 'boolean' : Array.isArray(value) ? 'array' : isObj(value) ? 'object' : 'string',
        default: value,
      };
      (parent as any)[key] = `{{${name}}}`;
    }
    // the library must depend on what the composition imported
    const deps: Record<string, string> = { ...(lib.draft ?? this.c.store.latest(input.library)!).manifest.depends };
    for (const u of uses) {
      const m = /^(@[a-z0-9-]+\/[a-z0-9-]+)(?:@(\S+))?$/.exec(u.trim());
      if (!m || m[1] === input.library) continue;
      if (!deps[m[1]]) {
        const locked = comp.lock[m[1]];
        deps[m[1]] = locked && locked !== 'draft' ? `^${locked.split('.')[0]}.0.0` : m[2] ?? 'latest';
      }
    }
    const theme = doc.theme;
    const preset: Record<string, any> = {
      slug: input.slug,
      kind: single ? 'scene' : 'template',
      summary: input.summary,
      tags: input.tags ?? [],
      params,
      body: { scenes },
    };
    if (single && scenes[0].d !== undefined && !params.d) {
      preset.duration = { default: scenes[0].d };
    }
    this.c.registry.updateLibrary(input.library, { depends: deps }, agent);
    const res = this.c.registry.putPreset(input.library, preset, agent);
    return {
      ...res,
      params: Object.keys(params),
      note: theme ? `theme (${typeof theme === 'string' ? theme : 'custom'}) is not part of the preset; set it on the composition that uses it` : undefined,
    };
  }

  private headRow(id: string): RevRow {
    const comp = this.c.db.prepare('SELECT head FROM compositions WHERE id = ?').get(id) as any;
    if (!comp) throw notFound(`composition ${id}`, 'mf_validate creates compositions');
    return this.row(id, comp.head);
  }

  private row(id: string, rev: number): RevRow {
    const r = this.c.db.prepare('SELECT * FROM revisions WHERE comp_id = ? AND rev = ?').get(id, rev) as RevRow | undefined;
    if (!r) throw notFound(`${id} revision ${rev}`);
    return r;
  }

  private assertOwner(id: string, agent: AgentCtx) {
    const comp = this.c.db.prepare('SELECT agent FROM compositions WHERE id = ?').get(id) as any;
    if (comp.agent !== agent.id && !agent.admin) throw forbidden(`${id} belongs to agent '${comp.agent}'`);
  }
}
