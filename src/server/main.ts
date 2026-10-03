import { createContext } from '../core/context';
import { buildApp } from './app';

const ctx = createContext();
const app = await buildApp(ctx);
const { host, port } = ctx.cfg;

try {
  await app.listen({ host, port });
} catch (e: any) {
  if (e.code === 'EADDRINUSE') {
    console.error(`[motionforge] port ${port} is already in use — is MotionForge already running? (set MF_PORT to use another port)`);
    process.exit(1);
  }
  throw e;
}
const shown = host === '0.0.0.0' ? '127.0.0.1' : host;
(ctx as any).setBaseUrl(`http://${shown}:${port}`);
ctx.jobs.start();
ctx.log(`dashboard  http://${shown}:${port}/`);
ctx.log(`MCP        http://${shown}:${port}/mcp   (stdio bridge: node bin/motionforge.mjs mcp)`);
ctx.log(`REST       http://${shown}:${port}/v1/…   libraries: ${ctx.store.libs.size}, data: ${ctx.paths.root}`);

// warm up the renderer in the background (bundle the player, open the browser)
ctx.adapter.ready().then(
  () => ctx.log('renderer ready'),
  (e) => ctx.log(`renderer not ready yet: ${(e as Error).message}`),
);

const shutdown = async () => {
  ctx.jobs.stop();
  await app.close().catch(() => undefined);
  await ctx.adapter.close().catch(() => undefined);
  ctx.db.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
