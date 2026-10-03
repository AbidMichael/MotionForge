import fs from 'node:fs';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { DSL_REFERENCE } from './reference';

/** Transport-agnostic API caller: in-process (fastify.inject) or over HTTP (stdio bridge). */
export type Api = (method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, body?: unknown) => Promise<{ status: number; body: any }>;
export type Recorder = (tool: string, inChars: number, outChars: number, ok: boolean, ms: number) => void;

type Content = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };
type ToolResult = { content: Content[]; isError?: boolean };

const enc = encodeURIComponent;

const issues = (list: { path: string; msg: string }[] | undefined, mark: string) =>
  (list ?? []).slice(0, 25).map((i) => `  ${mark} ${i.path ? i.path + ': ' : ''}${i.msg}`).join('\n') + ((list?.length ?? 0) > 25 ? `\n  … ${list!.length - 25} more` : '');

function errorText(body: any, status: number): string {
  if (!body || typeof body !== 'object') return `error ${status}`;
  const lines = [`error: ${body.error ?? status}`];
  if (body.issues?.length) lines.push(issues(body.issues, '✗'));
  if (body.hint) lines.push(`hint: ${body.hint}`);
  return lines.join('\n');
}

function revisionText(r: any): string {
  const head = `${r.id} r${r.rev} · ${r.ok ? 'OK' : `${r.errors.length} error(s)`}${r.ok ? ` · ${r.duration}s · ${r.format} · ${r.scenes.length} scenes` : ''}`;
  const lines = [head];
  if (r.ok && r.scenes.length) lines.push(r.scenes.map((s: any) => `  S${s.i + 1} ${s.start}s ${s.preset ?? 'inline'} ${s.d}s`).join('\n'));
  if (r.errors?.length) lines.push(issues(r.errors, '✗'));
  if (r.warnings?.length) lines.push(issues(r.warnings, '!'));
  if (!r.ok) lines.push(`fix with mf_patch {"id":"${r.id}","ops":[…]} — no need to resend the whole composition`);
  if (r.summary) lines.push('motion:\n' + r.summary);
  return lines.join('\n');
}

function paramLine(name: string, d: any): string {
  let t = d.type === 'enum' ? (d.values ?? []).join('|') : d.type === 'array' && d.items ? `array<${d.items}>` : d.type === 'preset' && d.kind ? `preset:${d.kind}` : d.type;
  if (d.required) t += '!';
  if (d.default !== undefined) t += '=' + (typeof d.default === 'string' ? d.default : JSON.stringify(d.default));
  if (d.min !== undefined || d.max !== undefined) t += ` [${d.min ?? ''}..${d.max ?? ''}]`;
  return `  ${name}: ${t}${d.desc ? ` — ${d.desc}` : ''}`;
}

function jobText(j: any): string {
  if (j.status === 'done' && j.result) {
    const r = j.result;
    if (j.type === 'render') {
      return `${j.id} done · ${r.duration}s · ${r.size} · ${r.quality} · ${(r.bytes / 1e6).toFixed(1)} MB · ${r.segments ? `${r.segments} segments (${r.cacheHits} cached) · ` : ''}${(r.ms / 1000).toFixed(1)}s render\n  file: ${r.path}\n  url: ${r.url}\n  poster: ${r.posterPath}`;
    }
    return `${j.id} done\n${JSON.stringify(r)}`;
  }
  if (j.status === 'failed') return `${j.id} failed: ${j.error}`;
  return `${j.id} ${j.status}${j.status === 'running' ? ` · ${Math.round(j.progress * 100)}%${j.stage ? ` · ${j.stage}` : ''}` : ''} — call mf_job {"id":"${j.id}","wait":60}`;
}

export const SERVER_INSTRUCTIONS = `MotionForge renders motion-design videos from short JSON compositions built from reusable presets. Compose with presets; don't write animation code.
Workflow: mf_search → (mf_get if unsure of params) → mf_validate (stores cmp_x, even with errors) → fix with mf_patch (JSON Patch) → mf_preview (contact sheet, one frame per scene) → mf_render {quality:"draft"|"hq"} → mf_job {wait:60}.
Composition: {"use":["@scope/lib@^1"],"theme":"core:dark"|{"p":"core:neon","accent":"#ff3d71"},"format":"1920x1080@30" (default; "9:16","1:1"),"scenes":[{"p":"core:title-card","title":"Hi"},{"t":"core:crossfade"},{"p":"core:stat","value":98,"suffix":"%","label":"Uptime","d":3},{"d":2,"layers":[…]}]}
Scene entry = "p" + the preset's params (+ optional "d" seconds, "layers" overlay, "bg"). Transition entry {"t":…} goes between scenes. Values may use tokens "$color.accent" and expressions "{{W/2}}".
Reuse instead of rebuilding: save what worked with mf_save_as_preset; write presets with mf_preset_put into your own library (@<agent-id>/<name>, created with mf_library_create); version with mf_library_publish; rate presets you used with mf_rate.
Beyond scenes: sub-compositions, stateful components, gestures (cursor, clicks, typing, drag), connectors, morph/expand transitions, audio & music sync (mf_audio), charts/maps/networks from data (@core/data), simulations (@core/explain), 3D (@core/3d), UI kits (@core/ui), art directions (@core/directions), real interface captures (mf_capture).
Production: mf_check (visual QA), mf_storyboard, mf_variants, mf_adapt (formats), mf_template (one video per data row), mf_edit (visual edits → source).
Official libraries need no "use" (core, dir, three, data, ui, explain, kinetic resolve by alias).
Full DSL (layers, animations, preset files): mf_library {"name":"dsl"}. Library guides: mf_library {"name":"@core/base"} (or @core/data, @core/3d…).`;

export function registerTools(server: McpServer, api: Api, record?: Recorder) {
  const tool = <S extends z.ZodRawShape>(name: string, description: string, shape: S, fn: (a: z.infer<z.ZodObject<S>>) => Promise<ToolResult | string>) => {
    (server.tool as any)(name, description, shape, async (args: any) => {
      const t0 = Date.now();
      let res: ToolResult;
      try {
        const r = await fn(args);
        res = typeof r === 'string' ? { content: [{ type: 'text', text: r }] } : r;
      } catch (e: any) {
        res = { content: [{ type: 'text', text: e?.mfText ?? `error: ${e?.message ?? e}` }], isError: true };
      }
      const outChars = res.content.reduce((n, c) => n + (c.type === 'text' ? c.text.length : 1600 * 4), 0);
      record?.(name, JSON.stringify(args ?? {}).length, outChars, !res.isError, Date.now() - t0);
      return res as any;
    });
  };
  const call = async (method: Parameters<Api>[0], url: string, body?: unknown, okStatuses: number[] = []) => {
    const r = await api(method, url, body);
    if (r.status >= 400 && !okStatuses.includes(r.status)) {
      const err: any = new Error('api');
      err.mfText = errorText(r.body, r.status);
      throw err;
    }
    return r.body;
  };

  tool(
    'mf_search',
    'Find presets (scenes, elements, animations, transitions, themes, templates) before building anything. One line per result: id@version · kind · summary · required/optional params.',
    {
      query: z.string().describe('what you need, e.g. "punchy title reveal", "number counter", "glitch transition"'),
      kind: z.enum(['scene', 'element', 'animation', 'transition', 'theme', 'template']).optional(),
      library: z.string().optional().describe('restrict to a library name or alias'),
      limit: z.number().int().min(1).max(30).optional(),
      drafts: z.boolean().optional().describe('include unpublished drafts'),
    },
    async (a) => {
      const qs = new URLSearchParams({ q: a.query, limit: String(a.limit ?? 8) });
      if (a.kind) qs.set('kind', a.kind);
      if (a.library) qs.set('library', a.library);
      if (a.drafts) qs.set('drafts', '1');
      const b = await call('GET', `/v1/search?${qs}`);
      if (!b.results.length) return 'no presets match — try broader words, another kind, or mf_library to browse';
      return b.results
        .map((c: any) => {
          const bits = [`${c.id}@${c.version}`, c.kind, c.summary];
          if (c.required.length) bits.push(`req: ${c.required.join(', ')}`);
          const opt = c.params.filter((p: string) => !c.required.includes(p));
          if (opt.length) bits.push(`opt: ${opt.slice(0, 8).join(', ')}${opt.length > 8 ? '…' : ''}`);
          if (c.uses) bits.push(`used ${c.uses}`);
          if (c.rating) bits.push(`★${c.rating}`);
          return bits.join(' · ');
        })
        .join('\n');
    },
  );

  tool(
    'mf_get',
    'Get one preset: params (name: type[!required][=default]), duration rule, example. Add fields ["body"] or ["raw"] only when you need to read or copy its implementation.',
    { id: z.string().describe('e.g. "core:stat", "brand:hook@draft", "@acme/brand/hook@^2"'), fields: z.array(z.enum(['body', 'raw', 'stats'])).optional() },
    async (a) => {
      const p = await call('GET', `/v1/presets/${enc(a.id)}`);
      const lines = [`${p.id}@${p.version} · ${p.kind} · ${p.summary}`];
      if (p.chain.length > 1) lines.push(`extends: ${p.chain.slice(1).join(' → ')}`);
      if (p.deprecated) lines.push(`DEPRECATED${p.deprecated.successor ? ` → use ${p.deprecated.successor}` : ''}`);
      const params = Object.entries(p.params);
      lines.push(params.length ? 'params:\n' + params.map(([k, d]) => paramLine(k, d)).join('\n') : 'params: none');
      if (p.duration) lines.push(`duration: ${JSON.stringify(p.duration)}`);
      if (p.slots?.length) lines.push(`slots: ${p.slots.join(', ')}`);
      if (p.example) lines.push(`example: ${JSON.stringify(p.example)}`);
      if (a.fields?.includes('stats')) lines.push(`stats: ${JSON.stringify(p.stats)}`);
      if (a.fields?.includes('body')) lines.push(`body: ${JSON.stringify(p.body)}`);
      if (a.fields?.includes('raw')) lines.push(`raw: ${JSON.stringify(p.raw)}`);
      return lines.join('\n');
    },
  );

  tool(
    'mf_library',
    'No name: list libraries. With a name: its guide (house rules, key presets) and preset ids by kind. name "dsl" returns the full composition/preset language reference.',
    { name: z.string().optional().describe('"@core/base", "@acme/brand", or "dsl"'), version: z.string().optional() },
    async (a) => {
      if (a.name === 'dsl') return DSL_REFERENCE;
      if (!a.name) {
        const b = await call('GET', '/v1/libraries');
        return b.libraries
          .map((l: any) => `${l.name} (${l.alias}) ${l.latest}${l.hasDraft ? ' +draft' : ''} · ${l.presets} presets · ${l.visibility} · ${l.summary}`)
          .join('\n');
      }
      const l = await call('GET', `/v1/libraries/${enc(a.name)}${a.version ? `?version=${enc(a.version)}` : ''}`);
      const lines = [`${l.name} (alias ${l.alias}) ${l.version} · ${l.visibility}${l.owner ? ` · owner ${l.owner}` : ''} · versions: ${l.versions.join(', ') || 'none'}${l.hasDraft ? ' +draft' : ''}`, l.summary];
      if (Object.keys(l.depends ?? {}).length) lines.push(`depends: ${JSON.stringify(l.depends)}`);
      if (l.guide) lines.push('guide:\n' + l.guide);
      for (const [k, ids] of Object.entries(l.presetsByKind)) lines.push(`${k}: ${(ids as string[]).join(', ')}`);
      return lines.join('\n');
    },
  );

  tool(
    'mf_library_create',
    'Create your own library (or update its manifest if it exists). Name it @<your-agent-id>/<name>. depends: other libraries it builds on, e.g. {"@core/kinetic":"^1"}. guide: ≤300 tokens of house rules for other agents.',
    {
      name: z.string(),
      summary: z.string().optional(),
      alias: z.string().optional().describe('short prefix for its presets, default = name after the slash'),
      guide: z.string().optional(),
      depends: z.record(z.string()).optional(),
      visibility: z.string().optional().describe('private (default) | public | project:<id>'),
      tags: z.array(z.string()).optional(),
    },
    async (a) => {
      const l = await call('POST', '/v1/libraries', a);
      return `${l.name} (alias ${l.alias}) ready · ${l.visibility} · ${l.presets} presets${l.hasDraft ? ' (draft)' : ''}\nadd presets with mf_preset_put {"library":"${l.name}","preset":{…}}; use drafts with "use":["${l.name}@draft"]`;
    },
  );

  tool(
    'mf_preset_put',
    'Write a preset into your library draft (create or replace). It is test-compiled with its example before it lands; you get errors, near-duplicate warnings and usage. Set delete:true with a slug to remove a draft preset.',
    {
      library: z.string(),
      preset: z.record(z.any()).optional().describe('{"slug","kind","summary","tags","params","duration","body"|"extends"+"addLayers","example"} — see mf_library {"name":"dsl"}'),
      slug: z.string().optional(),
      delete: z.boolean().optional(),
    },
    async (a) => {
      if (a.delete) {
        if (!a.slug) throw Object.assign(new Error(), { mfText: 'slug is required with delete' });
        const r = await call('DELETE', `/v1/libraries/${enc(a.library)}/presets/${enc(a.slug)}`);
        return `${r.deleted} deleted (${r.note})`;
      }
      if (!a.preset) throw Object.assign(new Error(), { mfText: 'preset is required' });
      const slug = a.preset.slug ?? a.slug;
      const r = await call('PUT', `/v1/libraries/${enc(a.library)}/presets/${enc(slug)}`, { ...a.preset, slug });
      const lines = [`${r.created ? 'created' : 'updated'} ${r.id} (draft) · compiles · example ${r.duration}s`];
      if (r.warnings?.length) lines.push(issues(r.warnings, '!'));
      if (r.similar?.length) lines.push(`similar: ${r.similar.map((s: any) => `${s.id} ${s.score}`).join(', ')}`);
      lines.push(r.usage);
      return lines.join('\n');
    },
  );

  tool(
    'mf_library_publish',
    'Publish your library draft as an immutable semver version. The bump is checked against what changed (removed/renamed params need major). Omit bump to use the minimum required.',
    { library: z.string(), bump: z.enum(['major', 'minor', 'patch']).optional(), version: z.string().optional() },
    async (a) => {
      const r = await call('POST', `/v1/libraries/${enc(a.library)}/publish`, { bump: a.bump, version: a.version });
      return `${r.library}@${r.version} published (was ${r.previous ?? 'unpublished'})\n${r.changes.map((c: any) => `  ${c.level}: ${c.msg}`).join('\n')}\nimport with ${r.use}`;
    },
  );

  tool(
    'mf_save_as_preset',
    'Turn a composition that worked into a reusable preset in your library. scene: index of one scene → scene preset; omit → template of the whole video. expose: paths that become params (current values become defaults), e.g. ["title"] or ["0.title:headline","2.value"].',
    {
      composition: z.string().describe('cmp_… id'),
      rev: z.number().int().optional(),
      scene: z.number().int().min(0).optional(),
      library: z.string(),
      slug: z.string(),
      summary: z.string(),
      tags: z.array(z.string()).optional(),
      expose: z.array(z.string()).optional(),
    },
    async (a) => {
      const r = await call('POST', `/v1/compositions/${enc(a.composition)}/save-as-preset`, { ...a, composition: undefined });
      const lines = [`saved ${r.id} (draft) · params: ${r.params.join(', ') || 'none'}`];
      if (r.warnings?.length) lines.push(issues(r.warnings, '!'));
      if (r.note) lines.push(r.note);
      lines.push(r.usage);
      return lines.join('\n');
    },
  );

  tool(
    'mf_asset_put',
    'Register an image, video, font or audio file (local path on the server machine, URL, or base64). Returns asset:<id> to use as "src". Same file twice = same id.',
    { path: z.string().optional(), url: z.string().optional(), base64: z.string().optional(), name: z.string().optional(), tags: z.array(z.string()).optional() },
    async (a) => {
      const r = await call('POST', '/v1/assets', a);
      return `${r.ref} · ${r.name} · ${r.mime}${r.width ? ` ${r.width}x${r.height}` : ''} · ${(r.bytes / 1024).toFixed(0)} KB`;
    },
  );

  tool(
    'mf_validate',
    'Validate and store a composition. Returns cmp_<id> rN with scene timings, errors (path: message) and warnings. Pass id to store a new revision of an existing composition. summary:true adds a text motion summary (what moves when).',
    { composition: z.record(z.any()), id: z.string().optional(), title: z.string().optional(), summary: z.boolean().optional() },
    async (a) => {
      const r = await call('POST', '/v1/compositions', a, [422]);
      return { content: [{ type: 'text', text: revisionText(r) }], isError: !r.ok };
    },
  );

  tool(
    'mf_patch',
    'Edit a stored composition with JSON Patch ops instead of resending it: [{"op":"replace","path":"/scenes/2/d","value":4}], add/remove/move/copy also work. Returns the new revision, validated.',
    {
      id: z.string(),
      ops: z.array(z.object({ op: z.enum(['add', 'remove', 'replace', 'move', 'copy', 'test']), path: z.string(), value: z.any().optional(), from: z.string().optional() })),
      relock: z.boolean().optional().describe('re-resolve library versions (pick up newly published versions)'),
      summary: z.boolean().optional(),
    },
    async (a) => {
      const r = await call('POST', `/v1/compositions/${enc(a.id)}/patch`, { ops: a.ops, relock: a.relock, summary: a.summary }, [422]);
      return { content: [{ type: 'text', text: revisionText(r) }], isError: !r.ok };
    },
  );

  tool(
    'mf_preview',
    'Render still frames to check a composition without a full render. Default: one frame per scene, combined in a contact sheet. Target a scene, a transition, a time range or one layer (focus crops to it, solo isolates it); clip renders a short clip instead. Returns file paths; inline:true also returns the sheet as an image (costs image tokens).',
    {
      id: z.string(),
      at: z.array(z.number()).optional().describe('times in seconds'),
      scale: z.number().min(0.1).max(1).optional().describe('default 0.5'),
      scene: z.number().int().min(1).optional().describe('only this scene (1-based), n frames across it'),
      transition: z.number().int().min(1).optional().describe('frames across transition k'),
      range: z.array(z.number()).length(2).optional().describe('[from, to] seconds'),
      focus: z.string().optional().describe('"#id": crop the frames to that layer'),
      solo: z.string().optional().describe('"#id": hide everything else'),
      n: z.number().int().min(1).max(16).optional(),
      clip: z.enum(['mp4', 'gif']).optional().describe('a short low-res clip of the selected range instead of stills (mp4 has the sound mix)'),
      inline: z.boolean().optional(),
      rev: z.number().int().optional(),
    },
    async (a) => {
      const r = await call('POST', `/v1/compositions/${enc(a.id)}/preview`, { at: a.at, scale: a.scale, rev: a.rev, scene: a.scene, transition: a.transition, range: a.range, focus: a.focus, solo: a.solo, n: a.n, clip: a.clip });
      if (r.clip) return `${r.comp} r${r.rev} · ${r.label} · clip ${r.clip.from}–${r.clip.to}s\n  file: ${r.clip.path}\n  url: ${r.clip.url}`;
      if (!r.frames) return `preview still running (${r.job}) — try again`;
      const lines = [`${r.comp} r${r.rev} · ${r.frames.length} frame(s)`];
      if (r.sheet) lines.push(`sheet: ${r.sheet.path}`);
      lines.push(r.frames.map((f: any) => `  S${f.scene} ${f.t}s: ${f.path}`).join('\n'));
      const content: Content[] = [{ type: 'text', text: lines.join('\n') }];
      if (a.inline) {
        const file = r.sheet?.path ?? r.frames[0]?.path;
        try {
          const data = fs.existsSync(file) ? fs.readFileSync(file).toString('base64') : Buffer.from(await (await fetch(r.sheet?.url ?? r.frames[0].url)).arrayBuffer()).toString('base64');
          content.push({ type: 'image', data, mimeType: 'image/jpeg' });
        } catch {
          content.push({ type: 'text', text: '(could not attach image)' });
        }
      }
      return { content };
    },
  );

  tool(
    'mf_render',
    'Queue a video render. quality: draft (half-res, fast), hq (full-res H.264), gif, alpha (ProRes 4444 transparent), webm. Unchanged scenes are reused from cache. Returns a job id for mf_job.',
    { id: z.string(), quality: z.enum(['draft', 'hq', 'gif', 'alpha', 'webm']).optional(), rev: z.number().int().optional(), scale: z.number().min(0.1).max(2).optional() },
    async (a) => {
      const r = await call('POST', '/v1/renders', { composition: a.id, quality: a.quality, rev: a.rev, scale: a.scale });
      return `${r.job} queued · ${r.composition} r${r.rev} · ${r.quality} · ${r.duration}s video — mf_job {"id":"${r.job}","wait":60}`;
    },
  );

  tool(
    'mf_job',
    'Status of a render job. wait: seconds to wait for completion (max 120) so you need fewer calls.',
    { id: z.string(), wait: z.number().min(0).max(120).optional(), cancel: z.boolean().optional() },
    async (a) => {
      if (a.cancel) return jobText(await call('POST', `/v1/renders/${enc(a.id)}/cancel`));
      return jobText(await call('GET', `/v1/jobs/${enc(a.id)}?wait=${a.wait ?? 0}`));
    },
  );

  tool(
    'mf_rate',
    'Rate a preset you used (1–5) with an optional short note. Ratings rank search results; well-rated presets are promoted to the shared hub automatically.',
    { id: z.string(), score: z.number().int().min(1).max(5), note: z.string().max(280).optional() },
    async (a) => {
      const r = await call('POST', `/v1/presets/${enc(a.id)}/rate`, { score: a.score, note: a.note });
      return `rated ${r.preset} · ${r.ratings} rating(s), avg ${r.average}${r.promoted ? ` · promoted to ${r.promoted}` : ''}`;
    },
  );
  tool(
    'mf_check',
    'Visual quality check of a composition: cut or overflowing text, overlapping texts, things outside the frame or too close to the edge, low contrast, tiny text, reading speed, near-identical shots, empty frames. Each issue has scene, time, layer, JSON pointer and a fix.',
    { id: z.string(), rev: z.number().int().optional(), pixels: z.boolean().optional().describe('false = layout checks only (no frames rendered)') },
    async (a) => {
      const r = await call('POST', `/v1/compositions/${enc(a.id)}/check`, { rev: a.rev, pixels: a.pixels });
      const lines = [`${r.comp} r${r.rev} · ${r.summary.error} error(s), ${r.summary.warning} warning(s), ${r.summary.info} note(s)`];
      for (const i of r.issues.slice(0, 30)) lines.push(`  ${i.severity === 'error' ? '✗' : i.severity === 'warning' ? '!' : '·'} S${i.scene + 1} ${i.t ?? ''}s ${i.kind}${i.layer ? ` ${i.layer}` : ''}: ${i.msg}${i.fix ? ` → ${i.fix}` : ''}${i.ptr ? ` (${i.ptr})` : ''}`);
      if (r.issues.length > 30) lines.push(`  … ${r.issues.length - 30} more`);
      return lines.join('\n');
    },
  );

  tool(
    'mf_storyboard',
    'The composition as a storyboard: each scene with its intent (hook, demonstration, explanation, breathing, conclusion — set with "intent" on a scene, otherwise inferred), duration, words, energy; flags repetitive scenes, scenes too long or too short to read, missing hook/conclusion/pauses. With edits it rewrites the order: [{"move":[3,1]}, {"swap":[1,2]}, {"remove":4}, {"duplicate":2}, {"set":{"i":2,"d":3,"intent":"breathing"}}, {"insert":{"at":3,"scene":{…},"transition":{"t":"core:crossfade"}}}].',
    { id: z.string(), edits: z.array(z.record(z.any())).optional() },
    async (a) => {
      let sb: any;
      let head = '';
      if (a.edits?.length) {
        const r = await call('POST', `/v1/compositions/${enc(a.id)}/storyboard`, { edits: a.edits });
        head = revisionText(r.revision) + '\n';
        sb = r.storyboard;
        if (!sb) return head;
      } else sb = await call('GET', `/v1/compositions/${enc(a.id)}/storyboard`);
      const lines = [`${head}${sb.id} r${sb.rev} · ${sb.duration}s · ${sb.rhythm.scenes} scenes · avg shot ${sb.rhythm.avgShot}s · ${sb.rhythm.cutsPerMin} cuts/min`, `arc: ${sb.arc}`];
      for (const s of sb.scenes) lines.push(`  ${s.i}. ${s.start}s ${s.d}s ${s.intent}${s.intentSet ? '' : '?'} · ${s.preset} · ${s.words} words · energy ${s.energy}${s.text ? ` · "${s.text}"` : ''}`);
      if (sb.issues.length) lines.push('issues:', ...sb.issues.map((i: any) => `  S${i.scene} ${i.kind}: ${i.msg}${i.fix ? ` → ${i.fix}` : ''}`));
      return lines.join('\n');
    },
  );

  tool(
    'mf_variants',
    'Make comparable variants of a composition (same content): other art directions ("dir:cinematic", "dir:tech"…), theme, pace (×durations), framing (1.1 = tighter), format, music, or any top-level fields in set. Each variant is stored as its own composition; you get metrics (duration, cuts/min, energy, words/s, quality summary) and one comparison sheet (rows = variants, same relative moments).',
    {
      id: z.string(),
      variants: z.array(z.object({ name: z.string().optional(), direction: z.any().optional(), theme: z.any().optional(), pace: z.number().optional(), framing: z.number().optional(), format: z.string().optional(), music: z.any().optional(), set: z.record(z.any()).optional() })).min(1).max(8),
      frames: z.number().int().min(2).max(6).optional(),
      preview: z.boolean().optional(),
    },
    async (a) => {
      const r = await call('POST', `/v1/compositions/${enc(a.id)}/variants`, { variants: a.variants, frames: a.frames, preview: a.preview });
      const lines = r.variants.map((v: any) => (v.ok ? `  ${v.name}: ${v.id} · ${v.metrics.duration}s · ${v.metrics.cutsPerMin} cuts/min · energy ${v.metrics.energy} · ${v.metrics.wordsPerSec} words/s · qa ${v.qa.error}✗ ${v.qa.warning}!` : `  ${v.name}: ${v.id} errors: ${v.errors.map((e: any) => e.msg).join('; ')}`));
      if (r.sheet) lines.push(`comparison: ${r.sheet}`);
      return lines.join('\n');
    },
  );

  tool(
    'mf_adapt',
    'Adapt a composition to other formats (e.g. ["9:16","1:1"]) keeping hierarchy and legibility: scene presets re-layout themselves, inline layers are mapped with one uniform scale, then every result is checked (overflow, overlap, out of frame). Returns one new composition per format with its issues and a preview sheet.',
    { id: z.string(), formats: z.array(z.string()).min(1).max(4), text: z.number().min(0.6).max(2).optional().describe('extra scale for text in the new format'), preview: z.boolean().optional() },
    async (a) => {
      const r = await call('POST', `/v1/compositions/${enc(a.id)}/adapt`, { formats: a.formats, text: a.text, preview: a.preview });
      const lines: string[] = [];
      for (const x of r.adapted) {
        lines.push(`${x.format}: ${x.id} ${x.ok ? `· qa ${x.qa.error}✗ ${x.qa.warning}!` : 'errors'}${x.sheet ? ` · sheet ${x.sheet}` : ''}`);
        for (const i of x.issues ?? []) lines.push(`  S${i.scene} ${i.kind}${i.layer ? ` ${i.layer}` : ''}: ${i.msg}${i.fix ? ` → ${i.fix}` : ''}`);
        for (const e of x.errors ?? []) lines.push(`  ✗ ${e.path}: ${e.msg}`);
      }
      lines.push(r.note);
      return lines.join('\n');
    },
  );

  tool(
    'mf_template',
    'Data-driven rendering: a composition with "params" is a template; give it data (one row object, an array of rows, CSV text or "asset:<id>" JSON/CSV) and it is validated — and with render:true rendered — once per row. Scenes that do not depend on the data are rendered once and reused.',
    { id: z.string(), data: z.any(), render: z.boolean().optional(), quality: z.enum(['draft', 'hq', 'gif', 'alpha', 'webm']).optional(), titleField: z.string().optional(), limit: z.number().int().min(1).max(500).optional() },
    async (a) => {
      const r = await call('POST', `/v1/compositions/${enc(a.id)}/template`, a);
      const lines = [`${r.template} · ${r.ok}/${r.rows} rows ok · ${r.note}`];
      for (const x of r.results.slice(0, 40)) lines.push(`  ${x.label}: ${x.id}${x.ok ? ` · ${x.duration}s${x.job ? ` · ${x.job}` : ''}` : ` ✗ ${x.errors.map((e: any) => `${e.path}: ${e.msg}`).join('; ')}`}`);
      return lines.join('\n');
    },
  );

  tool(
    'mf_edit',
    'Visual-editor operations on a composition. No edits: the boxes visible at time t (layer id, name, type, text, rect, editable?). With edits: [{"layer":"<id>","dx":40,"dy":-20}, {"layer":…,"text":"New title"}, {"layer":…,"scale":1.1}, {"layer":…,"shift":0.3}, {"scene":2,"d":4}] — written back into the source (direct values, or scene "tweaks" for layers made by presets).',
    { id: z.string(), t: z.number().optional(), edits: z.array(z.record(z.any())).optional() },
    async (a) => {
      if (a.edits?.length) {
        const r = await call('POST', `/v1/compositions/${enc(a.id)}/edit`, { edits: a.edits });
        return `ops: ${JSON.stringify(r.ops)}\n${revisionText(r.result)}`;
      }
      const l = await call('GET', `/v1/compositions/${enc(a.id)}/layout?t=${a.t ?? 0}`);
      const lines = [`${l.id} r${l.rev} · scene ${l.scene + 1} (${l.sceneStart.toFixed(2)}–${l.sceneEnd.toFixed(2)}s) · t=${a.t ?? 0}s`];
      for (const b of l.boxes.slice(0, 60)) lines.push(`  ${b.id}${b.name ? ` (${b.name})` : ''} ${b.type}${b.preset ? ` ${b.preset}` : ''} [${b.rect.x},${b.rect.y} ${b.rect.w}×${b.rect.h}]${b.text ? ` "${b.text.slice(0, 40)}"` : ''}${b.textPtr ? ' ✎text' : ''}${b.ptr ? ' ✎pos' : ''}`);
      return lines.join('\n');
    },
  );

  tool(
    'mf_capture',
    'Capture a real interface: load a URL (or html) in a headless browser, run steps and screenshot after each one. Steps: {"do":"click","selector":"#buy"}, {"do":"type","selector":"input[name=q]","text":"hello"}, {"do":"scroll","by":600 | "to":"#pricing"}, {"do":"hover","selector":…}, {"do":"wait","ms":800 | "for":"#result"}, {"do":"press","key":"Enter"}, {"do":"goto","url":…}, {"do":"select","selector","value"}, {"do":"shot"}. Use the result in a scene: {"type":"capture","src":"cap_…","w":1500,"zoom":1.4} — screenshots are cut together and a cursor replays the path, in sync with sounds.',
    {
      url: z.string().optional(),
      html: z.string().optional(),
      width: z.number().int().optional(),
      height: z.number().int().optional(),
      dpr: z.number().optional(),
      steps: z.array(z.record(z.any())).optional(),
      title: z.string().optional(),
      list: z.boolean().optional().describe('list existing captures instead'),
    },
    async (a) => {
      if (a.list) {
        const r = await call('GET', '/v1/captures');
        return r.captures.map((c: any) => `${c.id} · ${c.title ?? c.url} · ${c.steps} steps · ${c.shots} shots · ${c.size}`).join('\n') || 'no captures yet';
      }
      const r = await call('POST', '/v1/captures', a);
      const lines = [`${r.id} · ${r.title ?? r.url} · ${r.width}x${r.height} · ${r.shots.length} screenshots`];
      r.steps.forEach((s: any, i: number) => lines.push(`  ${i + 1}. ${s.do}${s.selector ? ` ${s.selector}` : ''}${s.rect ? ` @${s.rect.x},${s.rect.y} ${s.rect.w}×${s.rect.h}` : ''}${s.error ? ` ✗ ${s.error}` : ''}`));
      lines.push(`use: {"type":"capture","src":"${r.id}","w":1500}`);
      return lines.join('\n');
    },
  );

  tool(
    'mf_audio',
    'Analyse a music asset for montage: tempo, beats, downbeats (bars), strong hits, energy per bar and suggested cut points. Then in the composition: "music": {"src":"asset:<id>","snap":"bar"} moves the cuts onto bars; "@beat:8", "@bar:4", "@hit:1" are usable times; audio {"src":"impact","on":"downbeats"}; layers get "beat": "pulse|flash|shake|bounce|blink".',
    { asset: z.string(), every: z.enum(['beat', 'bar', 'phrase']).optional(), force: z.boolean().optional() },
    async (a) => {
      const r = await call('POST', '/v1/audio/analyze', a);
      const fmt = (xs: number[]) => xs.map((x) => x.toFixed(2)).join(' ');
      const energy = (r.sections ?? []).map((s: any) => ' ▁▂▃▄▅▆▇█'[Math.round(s.energy * 8)]).join('');
      return [
        `${r.asset} · ${r.duration}s · ${r.bpm} BPM · ${r.beatCount} beats · ${r.downbeats.length} bars`,
        `suggested cuts (${a.every ?? 'bar'}): ${fmt(r.suggestedCuts)}`,
        `hits: ${fmt(r.hits)}`,
        energy ? `energy by bar: ${energy}` : '',
      ].filter(Boolean).join('\n');
    },
  );
}
