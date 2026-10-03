import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createContext, type Ctx } from '../src/core/context';
import { buildApp } from '../src/server/app';

let app: FastifyInstance;
let ctx: Ctx;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mf-test-'));

beforeAll(async () => {
  fs.cpSync(path.resolve('libraries/@core'), path.join(tmp, 'libraries/@core'), { recursive: true });
  ctx = createContext({ dataDir: path.join(tmp, 'data'), librariesDir: path.join(tmp, 'libraries') } as any, () => undefined);
  app = await buildApp(ctx);
});
afterAll(async () => {
  await app.close();
  ctx.db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const call = async (method: any, url: string, payload?: unknown, agent = 'bot') => {
  const r = await app.inject({ method, url, payload: payload as any, headers: { 'x-mf-agent': agent } });
  return { status: r.statusCode, body: r.json() };
};

describe('REST flow', () => {
  it('searches presets', async () => {
    const r = await call('GET', '/v1/search?q=number%20counter');
    expect(r.body.results[0].id).toMatch(/core:(stat|counter)/);
  });
  it('creates, patches and summarises a composition', async () => {
    const v = await call('POST', '/v1/compositions', { composition: { scenes: [{ p: 'core:stat', value: 3 }] } });
    expect(v.status).toBe(422);
    const p = await call('POST', `/v1/compositions/${v.body.id}/patch`, { ops: [{ op: 'add', path: '/scenes/0/label', value: 'Users' }], summary: true });
    expect(p.body.ok).toBe(true);
    expect(p.body.rev).toBe(2);
    expect(p.body.summary).toContain('core:counter');
  });
  it('lets an agent build, publish and version its own library', async () => {
    expect((await call('POST', '/v1/libraries', { name: '@someone-else/x', summary: 'nope' })).status).toBe(403);
    const lib = await call('POST', '/v1/libraries', { name: '@bot/kit', summary: 'Bot kit' });
    expect(lib.status).toBe(201);
    const put = await call('PUT', '/v1/libraries/%40bot%2Fkit/presets/hello', {
      kind: 'scene', summary: 'Hello title', tags: ['title'], extends: 'core:title-card', params: { title: { default: 'Hello' } },
    });
    expect(put.status).toBe(200);
    const bad = await call('PUT', '/v1/libraries/%40bot%2Fkit/presets/bad', { kind: 'element', summary: 'Bad', body: { layers: [{ type: 'nope' }] } });
    expect(bad.status).toBe(400);
    const use = await call('POST', '/v1/compositions', { composition: { use: ['@bot/kit@draft'], scenes: [{ p: 'kit:hello' }] } });
    expect(use.body.ok).toBe(true);
    const pub = await call('POST', '/v1/libraries/%40bot%2Fkit/publish', {});
    expect(pub.body.version).toBe('1.0.0');
    // removing a param from a published preset needs a major bump
    const put2 = await call('PUT', '/v1/libraries/%40bot%2Fkit/presets/hello', { kind: 'scene', summary: 'Hello title v2', tags: ['title'], extends: 'core:title-card', example: { title: 'Hi' } });
    const minor = await call('POST', '/v1/libraries/%40bot%2Fkit/publish', { bump: 'minor' });
    expect(minor.status).toBe(400);
    const major = await call('POST', '/v1/libraries/%40bot%2Fkit/publish', {});
    expect(put2.status).toBe(200);
    expect(major.body.version).toBe('2.0.0');
    // other agents cannot see a private library
    const other = await call('GET', '/v1/search?q=hello&library=kit', undefined, 'stranger');
    expect(other.body.results).toEqual([]);
  });
  it('turns a scene that worked into a preset', async () => {
    const v = await call('POST', '/v1/compositions', { composition: { scenes: [{ p: 'core:stat', value: 42, label: 'Answers' }] } });
    const s = await call('POST', `/v1/compositions/${v.body.id}/save-as-preset`, { scene: 0, library: '@bot/kit', slug: 'answer', summary: 'The answer stat', expose: ['value'] });
    expect(s.status).toBe(200);
    expect(s.body.params).toEqual(['value']);
    const use = await call('POST', '/v1/compositions', { composition: { use: ['@bot/kit@draft'], scenes: [{ p: 'kit:answer', value: 7 }] } });
    expect(use.body.ok).toBe(true);
  });
});
