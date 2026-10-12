import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { openDb } from './db';
import { registry, openapi, help } from './registry';
import { Workloads } from './workloads';
import { invoke } from './invoke';
import { sqlitePool } from './sqlite-pool';

const command = process.argv[2] ?? 'serve';
if (command === '--help' || process.argv.includes('--help')) {
  process.stdout.write(help(command === '--help' ? undefined : command) + '\n');
} else if (command === 'openapi') {
  process.stdout.write(JSON.stringify(openapi(), null, 2) + '\n');
} else {
  const db = await openDb();
  const ctx = new Workloads(db);
  await ctx.init();
  if (command === 'mcp') {
    const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
    const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');
    const server = new McpServer({ name: 'casebook-ts-spike', version: '0.1.0' });
    for (const op of registry) {
      server.registerTool(op.name, {
        description: op.description, inputSchema: op.input, outputSchema: op.output,
        annotations: { readOnlyHint: op.effect === 'read', destructiveHint: false, idempotentHint: true, openWorldHint: false },
      }, async (input: unknown): Promise<CallToolResult> => {
        const result = await db.exclusive(() => op.invoke(ctx, input));
        return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
      });
    }
    await server.connect(new StdioServerTransport());
    process.on('SIGTERM', async () => { await server.close(); await db.close(); process.exit(0); });
  } else if (command !== 'serve') {
    const op = registry.find(op => op.name === command);
    if (!op) throw new Error(`Unknown command ${command}`);
    const jsonIndex = process.argv.indexOf('--json');
    const fileIndex = process.argv.indexOf('--file');
    const text = fileIndex >= 0 ? await readFile(process.argv[fileIndex + 1] ?? '', 'utf8') : process.argv[jsonIndex + 1] ?? '';
    const result = await db.exclusive(() => op.invoke(ctx, JSON.parse(text)));
    process.stdout.write(JSON.stringify(result) + '\n');
    await db.close();
  } else {
    const pool=(process.env.MODE??'embedded')==='embedded'&&process.env.SQLITE_WORKERS!=='0'?await sqlitePool(Number(process.env.SQLITE_READERS??4)):undefined;
    const handler = async (url: string, method: string, body: string): Promise<Response> => {
      try {
        const path = new URL(url, 'http://127.0.0.1').pathname;
        if (path === '/openapi.json') return Response.json(openapi());
        if (path === '/stats') return Response.json({ rssMB: process.memoryUsage().rss / 1048576, pid: process.pid });
        const raw:unknown=body?JSON.parse(body):undefined;
        const result=pool?await pool.execute(path,method,raw):await invoke(ctx,path,method,raw);
        return Response.json(result.value,{headers:{'x-process-pid':String(process.pid),'x-operation-ms':String(result.operationMs),'x-db-ms':String(result.dbMs),'x-queries':String(result.queries),'x-wait-ms':String(result.waitMs)}});
      } catch (error) {
        return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
      }
    };
    const port = Number(process.env.PORT ?? 30451);
    if (process.env.RUNTIME === 'node') {
      const server = createServer(async (request, response) => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        const result = await handler(request.url ?? '/', request.method ?? 'GET', Buffer.concat(chunks).toString('utf8'));
        response.writeHead(result.status, Object.fromEntries(result.headers));
        response.end(Buffer.from(await result.arrayBuffer()));
      });
      server.keepAliveTimeout = 60000;
      server.listen(port, '127.0.0.1');
      process.on('SIGTERM', () => server.close(async () => { await pool?.close(); await db.close(); process.exit(0); }));
    } else {
      const server = Bun.serve({ hostname: '127.0.0.1', port, maxRequestBodySize: 32 * 1024 * 1024,
        fetch: async request => handler(request.url, request.method, request.method === 'POST' ? await request.text() : '') });
      process.on('SIGTERM', async () => { server.stop(true); await pool?.close(); await db.close(); process.exit(0); });
    }
    process.stderr.write(JSON.stringify({ event: 'listening', port, mode: process.env.MODE ?? 'embedded', runtime: process.env.RUNTIME ?? 'bun' }) + '\n');
  }
}
