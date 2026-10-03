import fs from 'node:fs';
import path from 'node:path';
import semver from 'semver';
import { badRequest, didYouMean, forbidden, notFound, type Issue } from '../core/errors';
import {
  LibraryManifest,
  normalizeParams,
  PresetFile,
  RESERVED_PARAM_NAMES,
  zodIssues,
  type LibraryManifestT,
  type PresetDef,
} from '../dsl/schema';

export interface LibVersion {
  name: string;
  alias: string;
  version: string; // semver or 'draft'
  manifest: LibraryManifestT;
  presets: Map<string, PresetDef>;
  /** slug → preset file on disk (raw JSON, before normalisation). */
  files: Map<string, string>;
  dir: string;
}

export interface LibraryEntry {
  name: string;
  versions: Map<string, LibVersion>; // published only
  draft?: LibVersion;
}

export interface AgentCtx {
  id: string;
  admin: boolean;
  projects: string[];
}

export const SYSTEM_AGENT: AgentCtx = { id: 'system', admin: true, projects: [] };

export const defaultAlias = (name: string) => name.split('/')[1].replace(/^(lib-|mf-)/, '');

export function canSee(lib: LibVersion, agent: AgentCtx): boolean {
  const v = lib.manifest.visibility;
  if (v === 'public' || agent.admin) return true;
  if (lib.manifest.owner && lib.manifest.owner === agent.id) return true;
  if (lib.name.startsWith(`@${agent.id}/`)) return true;
  if (v.startsWith('project:')) return agent.projects.includes(v.slice(8));
  return false;
}

export function canWrite(name: string, agent: AgentCtx, lib?: LibVersion): boolean {
  if (agent.admin) return true;
  if (name.startsWith('@core/') || name.startsWith('@shared/')) return false;
  if (name.startsWith(`@${agent.id}/`)) return true;
  if (lib?.manifest.owner === agent.id) return true;
  const v = lib?.manifest.visibility ?? '';
  return v.startsWith('project:') && agent.projects.includes(v.slice(8));
}

const readJson = (f: string) => JSON.parse(fs.readFileSync(f, 'utf8'));
const writeJson = (f: string, v: unknown) => {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(v, null, 2) + '\n');
};

/** Libraries live on disk as plain folders: libraries/@scope/name/<version|draft>/{library.json,presets/*.json}. */
export class LibraryStore {
  libs = new Map<string, LibraryEntry>();
  loadIssues: Issue[] = [];

  constructor(public root: string) {}

  scan() {
    this.libs.clear();
    this.loadIssues = [];
    if (!fs.existsSync(this.root)) fs.mkdirSync(this.root, { recursive: true });
    for (const scope of fs.readdirSync(this.root)) {
      if (!scope.startsWith('@')) continue;
      const scopeDir = path.join(this.root, scope);
      if (!fs.statSync(scopeDir).isDirectory()) continue;
      for (const lname of fs.readdirSync(scopeDir)) {
        const libDir = path.join(scopeDir, lname);
        if (!fs.statSync(libDir).isDirectory()) continue;
        const name = `${scope}/${lname}`;
        const entry: LibraryEntry = { name, versions: new Map() };
        for (const ver of fs.readdirSync(libDir)) {
          const vdir = path.join(libDir, ver);
          if (!fs.existsSync(path.join(vdir, 'library.json'))) continue;
          const lv = this.loadVersion(name, ver, vdir);
          if (!lv) continue;
          if (ver === 'draft') entry.draft = lv;
          else entry.versions.set(ver, lv);
        }
        if (entry.draft || entry.versions.size) this.libs.set(name, entry);
      }
    }
  }

  private loadVersion(name: string, ver: string, dir: string): LibVersion | null {
    const where = path.relative(this.root, dir);
    let raw: any;
    try {
      raw = readJson(path.join(dir, 'library.json'));
    } catch (e) {
      this.loadIssues.push({ path: where, msg: `library.json: ${(e as Error).message}` });
      return null;
    }
    raw.version = ver;
    raw.name = name;
    const r = LibraryManifest.safeParse(raw);
    if (!r.success) {
      this.loadIssues.push(...zodIssues(r.error, where));
      return null;
    }
    if (ver !== 'draft' && !semver.valid(ver)) {
      this.loadIssues.push({ path: where, msg: 'version folders must be semver (1.0.0) or "draft"' });
      return null;
    }
    const presets = new Map<string, PresetDef>();
    const files = new Map<string, string>();
    const pdir = path.join(dir, 'presets');
    if (fs.existsSync(pdir)) {
      for (const f of walkJson(pdir)) {
        const rel = path.relative(this.root, f);
        try {
          const p = parsePreset(readJson(f), rel);
          if (p.issues.length) this.loadIssues.push(...p.issues);
          if (p.preset) {
            if (presets.has(p.preset.slug)) this.loadIssues.push({ path: rel, msg: `duplicate slug '${p.preset.slug}'` });
            presets.set(p.preset.slug, p.preset);
            files.set(p.preset.slug, f);
          }
        } catch (e) {
          this.loadIssues.push({ path: rel, msg: (e as Error).message });
        }
      }
    }
    return { name, alias: r.data.alias ?? defaultAlias(name), version: ver, manifest: r.data, presets, files, dir };
  }

  get(name: string) {
    return this.libs.get(name);
  }

  /** Latest published version (or the draft if nothing is published yet). */
  latest(name: string): LibVersion | undefined {
    const e = this.libs.get(name);
    if (!e) return undefined;
    const vs = [...e.versions.keys()].sort(semver.rcompare);
    return vs.length ? e.versions.get(vs[0]) : e.draft;
  }

  /** Resolve a library by range: '^1', '1.2.0', 'latest', 'draft', '*', undefined. */
  resolve(name: string, range?: string, agent?: AgentCtx): LibVersion {
    const e = this.libs.get(name);
    const visible = (lv: LibVersion | undefined) => (lv && (!agent || canSee(lv, agent)) ? lv : undefined);
    if (!e || (agent && !visible(this.latest(name)) && !visible(e.draft))) {
      const names = [...this.libs.values()].filter((l) => !agent || visible(this.latest(l.name)) || visible(l.draft)).map((l) => l.name);
      const dym = didYouMean(name, names);
      throw notFound(`library ${name}`, dym.length ? `did you mean ${dym.join(', ')}?` : 'mf_search or mf_library lists libraries');
    }
    if (range === 'draft') {
      const d = visible(e.draft);
      if (!d) throw notFound(`draft of ${name}`);
      return d;
    }
    if (!range || range === 'latest' || range === '*') {
      const lv = visible(this.latest(name));
      if (!lv) throw notFound(`library ${name}`);
      return lv;
    }
    const match = semver.maxSatisfying([...e.versions.keys()], range);
    if (!match) {
      throw notFound(`${name}@${range}`, `published versions: ${[...e.versions.keys()].sort(semver.rcompare).join(', ') || 'none (use @draft)'}`);
    }
    return visible(e.versions.get(match))!;
  }

  libDir(name: string, version: string) {
    const [scope, lname] = name.split('/');
    return path.join(this.root, scope, lname, version);
  }

  // ---------- writes (drafts only; published versions are immutable) ----------

  createLibrary(m: Partial<LibraryManifestT> & { name: string; summary: string }, agent: AgentCtx): LibVersion {
    if (this.libs.has(m.name)) throw badRequest(`library ${m.name} already exists`, [], 'use mf_preset_put to add presets to it');
    if (!canWrite(m.name, agent)) {
      throw forbidden(`agent '${agent.id}' can only create libraries named @${agent.id}/<name>`);
    }
    const manifest = { ...m, version: 'draft', owner: m.owner ?? agent.id };
    const r = LibraryManifest.safeParse(manifest);
    if (!r.success) throw badRequest('invalid library manifest', zodIssues(r.error));
    for (const [dep, range] of Object.entries(r.data.depends)) {
      if (!this.libs.has(dep)) throw badRequest(`dependency ${dep} not found`);
      if (!semver.validRange(range) && range !== 'draft' && range !== 'latest') throw badRequest(`bad range '${range}' for ${dep}`);
    }
    const dir = this.libDir(m.name, 'draft');
    const { version: _v, ...toWrite } = r.data;
    writeJson(path.join(dir, 'library.json'), toWrite);
    fs.mkdirSync(path.join(dir, 'presets'), { recursive: true });
    this.reloadLibrary(m.name);
    return this.libs.get(m.name)!.draft!;
  }

  /** Ensure a draft exists (copying the latest published version when needed). */
  ensureDraft(name: string): LibVersion {
    const e = this.libs.get(name);
    if (!e) throw notFound(`library ${name}`);
    if (e.draft) return e.draft;
    const latest = this.latest(name)!;
    const dir = this.libDir(name, 'draft');
    copyDir(latest.dir, dir);
    this.reloadLibrary(name);
    return this.libs.get(name)!.draft!;
  }

  updateManifest(name: string, patch: Partial<LibraryManifestT>) {
    const d = this.ensureDraft(name);
    const next = { ...d.manifest, ...patch, name, version: 'draft' };
    const r = LibraryManifest.safeParse(next);
    if (!r.success) throw badRequest('invalid library manifest', zodIssues(r.error));
    const { version: _v, ...toWrite } = r.data;
    writeJson(path.join(d.dir, 'library.json'), toWrite);
    this.reloadLibrary(name);
  }

  /** Write a preset into the draft. Returns the previous file content (for rollback) or null. */
  writePreset(name: string, preset: Record<string, unknown>): { file: string; previous: string | null } {
    const d = this.ensureDraft(name);
    const file = d.files.get(String(preset.slug)) ?? path.join(d.dir, 'presets', `${preset.slug}.json`);
    const previous = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
    writeJson(file, preset);
    this.reloadLibrary(name);
    return { file, previous };
  }

  rollback(name: string, w: { file: string; previous: string | null }) {
    if (w.previous === null) fs.rmSync(w.file, { force: true });
    else fs.writeFileSync(w.file, w.previous);
    this.reloadLibrary(name);
  }

  rawPreset(lv: LibVersion, slug: string): Record<string, unknown> | null {
    const f = lv.files.get(slug);
    return f && fs.existsSync(f) ? readJson(f) : null;
  }

  deletePreset(name: string, slug: string) {
    const d = this.ensureDraft(name);
    const f = d.files.get(slug);
    if (!f || !fs.existsSync(f)) throw notFound(`draft preset ${slug} in ${name}`);
    fs.renameSync(f, f + '.deleted');
    this.reloadLibrary(name);
  }

  /** Copy the draft into an immutable version folder. */
  publishDraft(name: string, version: string) {
    const d = this.ensureDraft(name);
    const target = this.libDir(name, version);
    if (fs.existsSync(target)) throw badRequest(`${name}@${version} already exists`);
    copyDir(d.dir, target, (f) => !f.endsWith('.deleted'));
    const m = readJson(path.join(target, 'library.json'));
    m.publishedAt = new Date().toISOString();
    writeJson(path.join(target, 'library.json'), m);
    this.reloadLibrary(name);
    return this.libs.get(name)!.versions.get(version)!;
  }

  reloadLibrary(name: string) {
    const [scope, lname] = name.split('/');
    const libDir = path.join(this.root, scope, lname);
    const entry: LibraryEntry = { name, versions: new Map() };
    if (fs.existsSync(libDir)) {
      for (const ver of fs.readdirSync(libDir)) {
        const vdir = path.join(libDir, ver);
        if (!fs.existsSync(path.join(vdir, 'library.json'))) continue;
        const lv = this.loadVersion(name, ver, vdir);
        if (!lv) continue;
        if (ver === 'draft') entry.draft = lv;
        else entry.versions.set(ver, lv);
      }
    }
    if (entry.draft || entry.versions.size) this.libs.set(name, entry);
    else this.libs.delete(name);
  }
}

export function parsePreset(raw: unknown, where: string): { preset?: PresetDef; issues: Issue[] } {
  const issues: Issue[] = [];
  const r = PresetFile.safeParse(raw);
  if (!r.success) return { issues: zodIssues(r.error, where) };
  const params = normalizeParams(r.data.params, `${where}.params`, issues);
  for (const k of Object.keys(params)) {
    if (RESERVED_PARAM_NAMES.has(k)) {
      issues.push({ path: `${where}.params.${k}`, msg: `'${k}' is reserved for layout/timing; pick another name` });
    }
  }
  if (issues.length) return { issues };
  const preset: PresetDef = { ...r.data, params };
  if (!preset.body && !preset.extends) issues.push({ path: where, msg: 'a preset needs a body or extends' });
  return { preset: issues.length ? undefined : preset, issues };
}

function* walkJson(dir: string): Generator<string> {
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f);
    if (fs.statSync(p).isDirectory()) yield* walkJson(p);
    else if (f.endsWith('.json')) yield p;
  }
}

function copyDir(src: string, dst: string, filter: (f: string) => boolean = () => true) {
  fs.mkdirSync(dst, { recursive: true });
  for (const f of fs.readdirSync(src)) {
    const s = path.join(src, f);
    const d = path.join(dst, f);
    if (!filter(s)) continue;
    if (fs.statSync(s).isDirectory()) copyDir(s, d, filter);
    else fs.copyFileSync(s, d);
  }
}
