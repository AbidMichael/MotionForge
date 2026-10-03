/**
 * stdio MCP bridge for clients that launch local servers (Claude Desktop, etc.).
 * It forwards every tool call to the MotionForge HTTP server, starting it in the background if needed,
 * so all agents share one registry, one render queue and one dashboard.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig, ROOT } from '../core/config';
import { buildMcpServer } from './http';
import type { Api } from './tools';

const cfg = loadConfig();
const base = process.env.MF_URL ?? `http://${cfg.host === '0.0.0.0' ? '127.0.0.1' : cfg.host}:${cfg.port}`;
const agent = process.env.MF_AGENT ?? 'claude-desktop';
const key = process.env.MF_KEY;

async function healthy(): Promise<boolean> {
  try {
    const r = await fetch(`${base}/v1/health`, { signal: AbortSignal.timeout(1500) });
    return r.ok;
  } catch {
    return false;
  }
}

let starting: Promise<void> | null = null;
async function ensureServer() {
  if (await healthy()) return;
  if (!starting) {
    starting = (async () => {
      const child = spawn(process.execPath, [path.join(ROOT, 'bin', 'motionforge.mjs'), 'start'], {
        cwd: ROOT,
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        env: { ...process.env, MF_LAUNCHED_BY: 'mcp-stdio' },
      });
      child.unref();
      for (let i = 0; i < 60; i++) {
        await new Promise((r) => setTimeout(r, 500));
        if (await healthy()) return;
      }
      throw new Error(`MotionForge server did not start at ${base} — run "npm start" in ${ROOT} and check its output`);
    })().finally(() => (starting = null));
  }
  return starting;
}

const api: Api = async (method, url, body) => {
  await ensureServer();
  const headers: Record<string, string> = { 'x-mf-agent': agent, 'x-mf-client': 'mcp', 'content-type': 'application/json' };
  if (key) headers.authorization = `Bearer ${key}`;
  const r = await fetch(base + url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let parsed: any = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* text */
  }
  return { status: r.status, body: parsed };
};

// stats for stdio sessions are recorded server-side through a lightweight endpoint-less path: the REST hook skips
// x-mf-client=mcp, so we report each tool call ourselves.
const server = buildMcpServer(api, (tool, inChars, outChars, ok, ms) => {
  fetch(`${base}/v1/stats/calls`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-mf-agent': agent, 'x-mf-client': 'mcp', ...(key ? { authorization: `Bearer ${key}` } : {}) },
    body: JSON.stringify({ tool, inChars, outChars, ok, ms }),
  }).catch(() => undefined);
});
await server.connect(new StdioServerTransport());
