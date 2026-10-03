import type { FastifyInstance } from 'fastify';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Ctx } from '../core/context';
import { estTokens } from '../core/util';
import { registerTools, SERVER_INSTRUCTIONS, type Api } from './tools';

export function buildMcpServer(api: Api, record?: Parameters<typeof registerTools>[2]) {
  const server = new McpServer({ name: 'motionforge', version: '0.1.0' }, { instructions: SERVER_INSTRUCTIONS });
  registerTools(server, api, record);
  return server;
}

/** MCP over Streamable HTTP at /mcp (stateless: one server per request, tools call the REST API in-process). */
export async function registerMcpHttp(app: FastifyInstance, ctx: Ctx) {
  app.post('/mcp', async (req, reply) => {
    const agent = req.agent;
    const headers: Record<string, string> = { 'x-mf-agent': agent.id, 'x-mf-client': 'mcp' };
    if (req.headers.authorization) headers.authorization = req.headers.authorization;
    const api: Api = async (method, url, body) => {
      const r = await app.inject({ method, url, payload: body === undefined ? undefined : (body as any), headers });
      let parsed: any = r.body;
      try {
        parsed = JSON.parse(r.body);
      } catch {
        /* text */
      }
      return { status: r.statusCode, body: parsed };
    };
    const server = buildMcpServer(api, (tool, inChars, outChars, ok, ms) => {
      ctx.db.prepare('INSERT INTO calls (agent, client, tool, in_chars, out_chars, ok, ms) VALUES (?, ?, ?, ?, ?, ?, ?)').run(agent.id, 'mcp', tool, inChars, outChars, ok ? 1 : 0, ms);
      ctx.events.publish('tool', agent.id, { tool, ok, inTokens: estTokens(inChars), outTokens: estTokens(outChars), ms });
    });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    reply.raw.on('close', () => {
      transport.close().catch(() => undefined);
      server.close().catch(() => undefined);
    });
    await server.connect(transport);
    reply.hijack();
    await transport.handleRequest(req.raw, reply.raw, req.body);
  });
  const notAllowed = async (_req: unknown, reply: any) =>
    reply.status(405).header('allow', 'POST').send({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed (stateless server: POST only)' }, id: null });
  app.get('/mcp', notAllowed);
  app.delete('/mcp', notAllowed);
}
