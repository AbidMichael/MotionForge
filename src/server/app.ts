import fs from 'node:fs';
import path from 'node:path';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import fastifyStatic from '@fastify/static';
import type { Ctx } from '../core/context';
import { ROOT } from '../core/config';
import { badRequest, MFError } from '../core/errors';
import { estTokens } from '../core/util';
import type { AgentCtx } from '../registry/store';
import { fontsourceDir } from '../render/fonts';
import { QUALITY, type Quality } from '../render/jobs';
import { registerMcpHttp } from '../mcp/http';
import { adapt, applyEdits, layoutAt, storyboard, storyboardEdit, templateRun, variants } from '../core/studio';
import { listCaptures, loadCapture, runCapture } from '../core/capture';
import { analyzeAsset, cutSuggestions } from '../render/beats';

declare module 'fastify' {
  interface FastifyRequest {
    agent: AgentCtx;
    t0: number;
  }
}

const SAFE_ID = (s: string) => s.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'local';

export function agentFrom(ctx: Ctx, req: FastifyRequest): AgentCtx {
  const q = req.query as Record<string, string | undefined>;
  if (ctx.cfg.auth === 'keys') {
    const auth = req.headers.authorization;
    const key = auth?.startsWith('Bearer ') ? auth.slice(7) : q.key;
    const a = ctx.cfg.agents.find((x) => x.key && x.key === key);
    if (!a) throw new MFError(401, 'missing or unknown API key (Authorization: Bearer <key>)');
    return { id: SAFE_ID(a.id), admin: !!a.admin, projects: a.projects ?? [] };
  }
  const raw = (req.headers['x-mf-agent'] as string | undefined) ?? q.agent ?? 'local';
  const id = SAFE_ID(raw);
  const conf = ctx.cfg.agents.find((x) => SAFE_ID(x.id) === id);
  return { id, admin: conf?.admin ?? id === 'local', projects: conf?.projects ?? [] };
}

const wantsJson = (s: string | undefined) => {
  if (!s) return [];
  return s.split(',').map((x) => x.trim()).filter(Boolean);
};

export async function buildApp(ctx: Ctx): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, bodyLimit: 60 * 1024 * 1024 });

  app.decorateRequest('agent', null as unknown as AgentCtx);
  app.decorateRequest('t0', 0);

  app.addHook('onRequest', async (req) => {
    req.t0 = Date.now();
    if (req.url.startsWith('/v1/') || req.url.startsWith('/mcp')) req.agent = agentFrom(ctx, req);
  });

  // the render page runs on Remotion's own port: fonts/assets/files are fetched cross-origin
  app.addHook('onSend', async (req, reply, payload) => {
    if (/^\/(v1\/fonts|v1\/assets|files)\//.test(req.url)) reply.header('access-control-allow-origin', '*');
    return payload;
  });

  // token accounting for direct REST clients (MCP calls are measured by the MCP layer)
  app.addHook('onSend', async (req, reply, payload) => {
    if (!req.url.startsWith('/v1/') || req.headers['x-mf-client'] === 'mcp' || req.headers['x-mf-client'] === 'dashboard') return payload;
    if (/^\/v1\/(events|fonts|assets\/[^/]+\/raw|overview|activity|stats)/.test(req.url)) return payload;
    const inChars = req.body ? JSON.stringify(req.body).length : 0;
    const outChars = typeof payload === 'string' ? payload.length : Buffer.isBuffer(payload) ? payload.length : 0;
    try {
      ctx.db
        .prepare('INSERT INTO calls (agent, client, tool, in_chars, out_chars, ok, ms) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(req.agent?.id ?? 'local', 'rest', `${req.method} ${req.routeOptions.url ?? req.url}`, inChars, outChars, reply.statusCode < 400 ? 1 : 0, Date.now() - req.t0);
    } catch {
      /* stats are best-effort */
    }
    return payload;
  });

  app.setErrorHandler((err: any, _req, reply) => {
    if (err instanceof MFError) {
      reply.status(err.status).send({ error: err.message, issues: err.issues.length ? err.issues : undefined, hint: err.hint });
      return;
    }
    if (err.validation) {
      reply.status(400).send({ error: err.message });
      return;
    }
    const status = err.statusCode && err.statusCode < 500 ? err.statusCode : 500;
    if (status >= 500) ctx.log(`error: ${err.stack ?? err}`);
    reply.status(status).send({ error: err.message ?? String(err) });
  });

  // ---------- static ----------
  for (const [prefix, dir] of [
    ['/files/renders/', ctx.paths.renders],
    ['/files/previews/', ctx.paths.previews],
    ['/files/thumbs/', ctx.paths.thumbs],
  ] as const) {
    await app.register(fastifyStatic, { root: dir, prefix, decorateReply: prefix === '/files/renders/', index: false });
  }

  app.get('/editor', async (_req, reply) => reply.type('text/html').send(fs.readFileSync(path.join(ROOT, 'src', 'server', 'dashboard', 'editor.html'), 'utf8')));
  app.get('/', async (_req, reply) => {
    return reply.type('text/html').send(fs.readFileSync(path.join(ROOT, 'src', 'server', 'dashboard', 'index.html'), 'utf8'));
  });

  app.get('/v1/health', async () => ({ ok: true, name: 'motionforge', version: '0.1.0' }));

  app.get<{ Params: { pkg: string; file: string } }>('/v1/fonts/:pkg/:file', async (req, reply) => {
    const { pkg, file } = req.params;
    if (!/^[a-z0-9-]+$/.test(pkg) || !/^[a-z0-9-]+\.woff2?$/.test(file)) throw badRequest('bad font path');
    const f = path.join(fontsourceDir(pkg), file);
    if (!fs.existsSync(f)) throw new MFError(404, 'font not found');
    reply.header('cache-control', 'public, max-age=31536000, immutable');
    return reply.type(file.endsWith('2') ? 'font/woff2' : 'font/woff').send(fs.createReadStream(f));
  });

  // ---------- discovery ----------
  app.get('/v1/search', async (req) => {
    const q = req.query as Record<string, string>;
    const imported = wantsJson(q.imported);
    const cards = ctx.index.search({
      q: q.q,
      kind: q.kind,
      library: q.library,
      tags: wantsJson(q.tags),
      limit: q.limit ? Number(q.limit) : undefined,
      drafts: q.drafts === '1' || q.drafts === 'true',
      deprecated: q.deprecated === '1',
      agent: req.agent,
      imported,
    });
    return {
      results: cards.map((c) => ({ ...c, score: undefined, thumb: c.thumb ? `${ctx.baseUrl()}/files/thumbs/${path.relative(ctx.paths.thumbs, c.thumb).split(path.sep).join('/')}` : undefined })),
    };
  });

  app.get('/v1/libraries', async (req) => ({ libraries: ctx.registry.listLibraries(req.agent) }));
  app.get<{ Params: { name: string } }>('/v1/libraries/:name', async (req) => {
    const q = req.query as Record<string, string>;
    return ctx.registry.library(decodeURIComponent(req.params.name), req.agent, q.version);
  });
  app.get<{ Params: { id: string } }>('/v1/presets/:id', async (req) => ctx.registry.preset(decodeURIComponent(req.params.id), req.agent));

  // ---------- authoring ----------
  app.post('/v1/libraries', async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, any>;
    const exists = typeof body.name === 'string' && ctx.store.get(body.name);
    if (exists) return ctx.registry.updateLibrary(body.name, body, req.agent);
    reply.status(201);
    return ctx.registry.createLibrary(body, req.agent);
  });
  app.patch<{ Params: { name: string } }>('/v1/libraries/:name', async (req) => ctx.registry.updateLibrary(decodeURIComponent(req.params.name), req.body as any, req.agent));
  app.put<{ Params: { name: string; slug: string } }>('/v1/libraries/:name/presets/:slug', async (req) => {
    const body = { ...((req.body ?? {}) as Record<string, any>) };
    body.slug = body.slug ?? req.params.slug;
    if (body.slug !== req.params.slug) throw badRequest(`slug in body (${body.slug}) differs from URL (${req.params.slug})`);
    return ctx.registry.putPreset(decodeURIComponent(req.params.name), body, req.agent);
  });
  app.delete<{ Params: { name: string; slug: string } }>('/v1/libraries/:name/presets/:slug', async (req) =>
    ctx.registry.deletePreset(decodeURIComponent(req.params.name), req.params.slug, req.agent),
  );
  app.get<{ Params: { name: string } }>('/v1/libraries/:name/diff', async (req) => ctx.registry.diff(decodeURIComponent(req.params.name)));
  app.post<{ Params: { name: string } }>('/v1/libraries/:name/publish', async (req) => {
    const b = (req.body ?? {}) as Record<string, any>;
    return ctx.registry.publish(decodeURIComponent(req.params.name), { bump: b.bump, version: b.version }, req.agent);
  });
  app.post<{ Params: { id: string } }>('/v1/presets/:id/deprecate', async (req) => {
    const b = (req.body ?? {}) as Record<string, any>;
    return ctx.registry.deprecate(decodeURIComponent(req.params.id), { successor: b.successor, reason: b.reason }, req.agent);
  });
  app.post<{ Params: { id: string } }>('/v1/presets/:id/rate', async (req) => {
    const b = (req.body ?? {}) as Record<string, any>;
    return ctx.registry.rate(decodeURIComponent(req.params.id), Number(b.score), b.note, req.agent);
  });

  // ---------- promotion (either rating threshold, or a human here) ----------
  app.get('/v1/promotion', async () => ctx.registry.promotionBoard());
  app.post<{ Params: { id: string } }>('/v1/presets/:id/promote', async (req) => {
    if (!req.agent.admin) throw new MFError(403, 'only a human/admin can promote by hand (agents earn it through ratings)');
    return ctx.registry.promote(decodeURIComponent(req.params.id), 'human', req.agent.id);
  });
  app.post<{ Params: { id: string } }>('/v1/presets/:id/demote', async (req) => {
    if (!req.agent.admin) throw new MFError(403, 'only a human/admin can demote');
    const b = (req.body ?? {}) as Record<string, any>;
    return ctx.registry.demote(decodeURIComponent(req.params.id), req.agent.id, b.reason);
  });

  // ---------- compositions ----------
  app.post('/v1/compositions', async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, any>;
    const composition = b.composition ?? (b.scenes ? b : undefined);
    const out = ctx.comps.submit({ composition, file: b.file, id: b.id, title: b.title, relock: b.relock, summary: b.summary }, req.agent);
    reply.status(out.ok ? 200 : 422);
    return out;
  });
  app.get('/v1/compositions', async (req) => {
    const q = req.query as Record<string, string>;
    return { compositions: ctx.comps.list(q.limit ? Number(q.limit) : 30, q.agent) };
  });
  app.get<{ Params: { id: string } }>('/v1/compositions/:id', async (req) => {
    const q = req.query as Record<string, string>;
    return ctx.comps.get(req.params.id, q.rev ? Number(q.rev) : undefined);
  });
  app.get<{ Params: { id: string } }>('/v1/compositions/:id/summary', async (req) => {
    const q = req.query as Record<string, string>;
    return { summary: ctx.comps.summary(req.params.id, q.rev ? Number(q.rev) : undefined) };
  });
  app.get<{ Params: { id: string } }>('/v1/compositions/:id/ir', async (req) => {
    const q = req.query as Record<string, string>;
    const { r } = ctx.comps.compiled(req.params.id, q.rev ? Number(q.rev) : undefined);
    return r.ir ?? { errors: r.errors };
  });
  app.post<{ Params: { id: string } }>('/v1/compositions/:id/patch', async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, any>;
    const out = ctx.comps.patch(req.params.id, b.ops, req.agent, { relock: b.relock, summary: b.summary, file: b.file, writeBack: b.writeBack });
    reply.status(out.ok ? 200 : 422);
    return out;
  });
  app.post<{ Params: { id: string } }>('/v1/compositions/:id/preview', async (req) => {
    const b = (req.body ?? {}) as Record<string, any>;
    const comp = ctx.comps.get(req.params.id, b.rev);
    if (!comp.ok) throw badRequest(`${req.params.id} r${comp.rev} has errors; fix them first`, comp.errors);
    const P: Record<string, unknown> = {};
    for (const k of ['at', 'scale', 'sheet', 'scene', 'transition', 'range', 'focus', 'solo', 'n', 'clip']) if (b[k] !== undefined) P[k] = b[k];
    const job = ctx.jobs.enqueue('preview', req.agent.id, P, { compId: req.params.id, rev: comp.rev, priority: 10 });
    if (b.wait === false) return { job: job.id, status: job.status };
    const done = await ctx.jobs.wait(job.id, 180_000);
    if (done.status === 'failed') throw new MFError(500, `preview failed: ${done.error}`);
    if (done.status !== 'done') return { job: done.id, status: done.status, progress: done.progress };
    return done.result;
  });
  app.post<{ Params: { id: string } }>('/v1/compositions/:id/save-as-preset', async (req) => {
    const b = (req.body ?? {}) as Record<string, any>;
    return ctx.comps.saveAsPreset({ ...(b as any), id: req.params.id }, req.agent);
  });

  // ---------- quality, storyboard, variants, formats, templates, editor ----------
  app.post<{ Params: { id: string } }>('/v1/compositions/:id/check', async (req) => {
    const b = (req.body ?? {}) as Record<string, any>;
    const comp = ctx.comps.get(req.params.id, b.rev);
    if (!comp.ok) throw badRequest(`${req.params.id} r${comp.rev} has errors; fix them first`, comp.errors);
    const job = ctx.jobs.enqueue('check', req.agent.id, { pixels: b.pixels }, { compId: req.params.id, rev: comp.rev, priority: 10 });
    const done = await ctx.jobs.wait(job.id, 300_000);
    if (done.status === 'failed') throw new MFError(500, `check failed: ${done.error}`);
    return done.result;
  });
  app.get<{ Params: { id: string } }>('/v1/compositions/:id/storyboard', async (req) => storyboard(ctx, req.params.id, (req.query as any).rev ? Number((req.query as any).rev) : undefined));
  app.post<{ Params: { id: string } }>('/v1/compositions/:id/storyboard', async (req) => {
    const b = (req.body ?? {}) as Record<string, any>;
    if (!Array.isArray(b.edits)) throw badRequest('edits must be an array');
    const r = storyboardEdit(ctx, req.params.id, b.edits, req.agent);
    return { revision: r, storyboard: r.ok ? storyboard(ctx, req.params.id) : undefined };
  });
  app.post<{ Params: { id: string } }>('/v1/compositions/:id/variants', async (req) => {
    const b = (req.body ?? {}) as Record<string, any>;
    return variants(ctx, req.params.id, b.variants, req.agent, { preview: b.preview, frames: b.frames });
  });
  app.post<{ Params: { id: string } }>('/v1/compositions/:id/adapt', async (req) => {
    const b = (req.body ?? {}) as Record<string, any>;
    return adapt(ctx, req.params.id, b.formats, req.agent, { preview: b.preview, text: b.text });
  });
  app.post<{ Params: { id: string } }>('/v1/compositions/:id/template', async (req) => {
    const b = (req.body ?? {}) as Record<string, any>;
    return templateRun(ctx, req.params.id, b.data, req.agent, { render: !!b.render, quality: b.quality, titleField: b.titleField, limit: b.limit });
  });
  app.get<{ Params: { id: string } }>('/v1/compositions/:id/layout', async (req) => {
    const q = req.query as Record<string, string>;
    return layoutAt(ctx, req.params.id, Number(q.t ?? 0), q.rev ? Number(q.rev) : undefined);
  });
  app.post<{ Params: { id: string } }>('/v1/compositions/:id/edit', async (req) => {
    const b = (req.body ?? {}) as Record<string, any>;
    if (!Array.isArray(b.edits)) throw badRequest('edits must be an array');
    return applyEdits(ctx, req.params.id, b.edits, req.agent);
  });

  // ---------- captures & audio analysis ----------
  app.post('/v1/captures', async (req) => runCapture(ctx, (req.body ?? {}) as any, req.agent.id));
  app.get('/v1/captures', async () => ({ captures: listCaptures(ctx) }));
  app.get<{ Params: { id: string } }>('/v1/captures/:id', async (req) => {
    const c = loadCapture(ctx, req.params.id);
    if (!c) throw new MFError(404, `capture ${req.params.id} not found`);
    return c;
  });
  app.post('/v1/audio/analyze', async (req) => {
    const b = (req.body ?? {}) as Record<string, any>;
    const id = String(b.asset ?? '').replace(/^asset:/, '');
    if (!id) throw badRequest('asset is required ("asset:<id>")');
    const info = await analyzeAsset(ctx, id, !!b.force);
    const cuts = cutSuggestions(info, (b.every ?? 'bar') as any);
    return { asset: `asset:${id}`, ...info, beats: info.beats.length > 400 ? undefined : info.beats, beatCount: info.beats.length, suggestedCuts: cuts.grid.filter((_, i) => i % Math.max(1, Math.round(cuts.grid.length / 24)) === 0).slice(0, 40), hits: cuts.hits };
  });

  // ---------- renders ----------
  app.post('/v1/renders', async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, any>;
    const id = b.composition ?? b.id;
    if (typeof id !== 'string') throw badRequest('composition (id) is required');
    const quality = (b.quality ?? 'draft') as Quality;
    if (!QUALITY[quality]) throw badRequest(`quality must be one of ${Object.keys(QUALITY).join(', ')}`);
    const comp = ctx.comps.get(id, b.rev);
    if (!comp.ok) throw badRequest(`${id} r${comp.rev} has errors; fix them first`, comp.errors);
    const job = ctx.jobs.enqueue('render', req.agent.id, { quality, scale: b.scale }, { compId: id, rev: comp.rev, lane: 'render' });
    reply.status(202);
    return { job: job.id, status: job.status, composition: id, rev: comp.rev, quality, duration: comp.duration };
  });
  app.get('/v1/renders', async (req) => {
    const q = req.query as Record<string, string>;
    return { jobs: ctx.jobs.list({ limit: q.limit ? Number(q.limit) : 30, type: q.type ?? 'render', agent: q.agent, status: q.status }) };
  });
  app.get<{ Params: { id: string } }>('/v1/renders/:id', async (req) => {
    const q = req.query as Record<string, string>;
    const wait = Math.max(0, Math.min(120, Number(q.wait ?? 0)));
    return ctx.jobs.wait(req.params.id, wait * 1000);
  });
  app.get<{ Params: { id: string } }>('/v1/jobs/:id', async (req) => {
    const q = req.query as Record<string, string>;
    return ctx.jobs.wait(req.params.id, Math.max(0, Math.min(120, Number(q.wait ?? 0))) * 1000);
  });
  app.post<{ Params: { id: string } }>('/v1/renders/:id/cancel', async (req) => ctx.jobs.cancel(req.params.id));

  // ---------- assets ----------
  app.post('/v1/assets', async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, any>;
    const info = await ctx.assets.put(b, req.agent.id);
    ctx.events.publish('asset', req.agent.id, { id: info.id, name: info.name, mime: info.mime, bytes: info.bytes });
    reply.status(201);
    return info;
  });
  app.get('/v1/assets', async () => ({ assets: ctx.assets.list().map((a) => ({ id: a.id, ref: `asset:${a.id}`, name: a.name, mime: a.mime, bytes: a.bytes, created: a.created })) }));
  app.get<{ Params: { id: string } }>('/v1/assets/:id', async (req) => ctx.assets.info(req.params.id));
  app.get<{ Params: { id: string } }>('/v1/assets/:id/raw', async (req, reply) => {
    const a = ctx.assets.get(req.params.id);
    reply.header('cache-control', 'public, max-age=31536000, immutable');
    reply.header('content-length', a.bytes);
    return reply.type(a.mime).send(fs.createReadStream(a.path));
  });

  // ---------- activity / dashboard ----------
  app.get('/v1/events', (req: FastifyRequest, reply: FastifyReply) => {
    reply.raw.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'access-control-allow-origin': '*' });
    reply.raw.write(': connected\n\n');
    const send = (ev: unknown) => reply.raw.write(`data: ${JSON.stringify(ev)}\n\n`);
    ctx.events.on('event', send);
    const hb = setInterval(() => reply.raw.write(': ping\n\n'), 20000);
    req.raw.on('close', () => {
      clearInterval(hb);
      ctx.events.off('event', send);
    });
    reply.hijack();
  });
  app.get('/v1/activity', async (req) => {
    const q = req.query as Record<string, string>;
    return { events: ctx.events.recent(q.limit ? Number(q.limit) : 80, wantsJson(q.kinds)) };
  });
  app.get('/v1/stats/tokens', async () => {
    const byTool = ctx.db
      .prepare(
        `SELECT tool, client, COUNT(*) AS calls, AVG(in_chars) AS avg_in, AVG(out_chars) AS avg_out, SUM(in_chars) AS sum_in, SUM(out_chars) AS sum_out
         FROM calls GROUP BY tool, client ORDER BY sum_in + sum_out DESC`,
      )
      .all() as any[];
    const byAgent = ctx.db
      .prepare(`SELECT agent, COUNT(*) AS calls, SUM(in_chars) AS sum_in, SUM(out_chars) AS sum_out, MAX(ts) AS last FROM calls GROUP BY agent ORDER BY last DESC`)
      .all() as any[];
    const perComp = ctx.db
      .prepare(
        `SELECT COUNT(DISTINCT comp_id) AS comps FROM revisions`,
      )
      .get() as any;
    const totals = ctx.db.prepare('SELECT SUM(in_chars) AS i, SUM(out_chars) AS o FROM calls').get() as any;
    return {
      note: 'tokens ≈ characters / 4',
      byTool: byTool.map((r) => ({ tool: r.tool, client: r.client, calls: r.calls, avgInTokens: estTokens(r.avg_in), avgOutTokens: estTokens(r.avg_out), totalTokens: estTokens(r.sum_in + r.sum_out) })),
      byAgent: byAgent.map((r) => ({ agent: r.agent, calls: r.calls, inTokens: estTokens(r.sum_in), outTokens: estTokens(r.sum_out), last: r.last })),
      perComposition: perComp.comps ? estTokens(((totals?.i ?? 0) + (totals?.o ?? 0)) / perComp.comps) : null,
    };
  });
  app.post('/v1/stats/calls', async (req) => {
    const b = (req.body ?? {}) as Record<string, any>;
    ctx.db
      .prepare('INSERT INTO calls (agent, client, tool, in_chars, out_chars, ok, ms) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(req.agent.id, 'mcp', String(b.tool ?? '?').slice(0, 60), Number(b.inChars) || 0, Number(b.outChars) || 0, b.ok ? 1 : 0, Number(b.ms) || 0);
    ctx.events.publish('tool', req.agent.id, { tool: b.tool, ok: !!b.ok, inTokens: estTokens(Number(b.inChars) || 0), outTokens: estTokens(Number(b.outChars) || 0), ms: b.ms });
    return { ok: true };
  });
  app.get('/v1/overview', async () => {
    const libs = ctx.store.libs.size;
    let presets = 0;
    for (const e of ctx.store.libs.values()) presets += ctx.store.latest(e.name)?.presets.size ?? 0;
    const count = (sql: string) => (ctx.db.prepare(sql).get() as any).n as number;
    return {
      libraries: libs,
      presets,
      compositions: count('SELECT COUNT(*) AS n FROM compositions'),
      renders: count("SELECT COUNT(*) AS n FROM jobs WHERE type = 'render' AND status = 'done'"),
      queued: count("SELECT COUNT(*) AS n FROM jobs WHERE status = 'queued'"),
      running: count("SELECT COUNT(*) AS n FROM jobs WHERE status = 'running'"),
      agents: count("SELECT COUNT(DISTINCT agent) AS n FROM calls WHERE ts > datetime('now', '-1 day')"),
      tokens: estTokens(((ctx.db.prepare('SELECT SUM(in_chars) + SUM(out_chars) AS n FROM calls').get() as any).n ?? 0)),
      libraryIssues: ctx.store.loadIssues,
      qualities: Object.fromEntries(Object.entries(QUALITY).map(([k, v]) => [k, v.desc])),
    };
  });
  app.post('/v1/admin/thumbs', async (req) => {
    if (!req.agent.admin) throw new MFError(403, 'admin only');
    const b = (req.body ?? {}) as Record<string, any>;
    const names = b.library ? [b.library] : [...ctx.store.libs.keys()];
    const jobs: string[] = [];
    for (const name of names) {
      const lv = ctx.store.resolve(name, b.version);
      for (const p of lv.presets.values()) jobs.push(ctx.jobs.enqueue('thumb', req.agent.id, { library: name, version: lv.version, slug: p.slug }, { lane: 'fast' }).id);
    }
    return { queued: jobs.length };
  });
  app.post('/v1/admin/reindex', async (req) => {
    if (!req.agent.admin) throw new MFError(403, 'admin only');
    ctx.store.scan();
    ctx.index.reindex();
    return { libraries: ctx.store.libs.size, issues: ctx.store.loadIssues };
  });

  await registerMcpHttp(app, ctx);
  return app;
}
