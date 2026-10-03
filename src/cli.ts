/** Small CLI: talks to a running server (starting one in-process when none is running). */
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from './core/config';
import { createContext } from './core/context';

const [cmd, file, quality = 'draft'] = process.argv.slice(2);
const cfg = loadConfig();
const base = process.env.MF_URL ?? `http://127.0.0.1:${cfg.port}`;
const headers = { 'content-type': 'application/json', 'x-mf-agent': process.env.MF_AGENT ?? 'cli' };

async function up() {
  try {
    return (await fetch(`${base}/v1/health`, { signal: AbortSignal.timeout(1500) })).ok;
  } catch {
    return false;
  }
}

if (cmd === 'reindex') {
  const ctx = createContext({}, () => undefined);
  console.log(`indexed ${ctx.store.libs.size} libraries`);
  for (const i of ctx.store.loadIssues) console.log(`  ! ${i.path}: ${i.msg}`);
  process.exit(0);
}

if (!file) {
  console.error('usage: motionforge render <composition.json> [draft|hq|gif|alpha|webm]   |   motionforge validate <composition.json>');
  process.exit(1);
}
if (!(await up())) {
  console.error(`MotionForge is not running at ${base}. Start it first: npm start`);
  process.exit(1);
}
const composition = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));
const v = await (await fetch(`${base}/v1/compositions`, { method: 'POST', headers, body: JSON.stringify({ composition, title: path.basename(file), summary: true }) })).json();
console.log(`${v.id} r${v.rev} · ${v.ok ? 'OK' : 'ERRORS'} · ${v.duration}s`);
for (const e of v.errors ?? []) console.log(`  ✗ ${e.path}: ${e.msg}`);
for (const w of v.warnings ?? []) console.log(`  ! ${w.path}: ${w.msg}`);
if (v.summary) console.log(v.summary);
if (!v.ok || cmd === 'validate') process.exit(v.ok ? 0 : 1);
const job = await (await fetch(`${base}/v1/renders`, { method: 'POST', headers, body: JSON.stringify({ composition: v.id, quality }) })).json();
if (job.error) {
  console.error(job.error);
  process.exit(1);
}
process.stdout.write(`rendering ${job.job} (${quality})`);
for (;;) {
  const j = await (await fetch(`${base}/v1/jobs/${job.job}?wait=5`, { headers })).json();
  if (j.status === 'done') {
    console.log(`\ndone in ${(j.result.ms / 1000).toFixed(1)}s → ${j.result.path}`);
    break;
  }
  if (j.status === 'failed' || j.status === 'cancelled') {
    console.error(`\n${j.status}: ${j.error}`);
    process.exit(1);
  }
  process.stdout.write(` ${Math.round(j.progress * 100)}%`);
}
