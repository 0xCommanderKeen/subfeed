import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { after, before, test } from 'node:test';
import { withErrorBoundary } from '../src/error-boundary.mjs';
import { mcpHandler } from '../src/mcp.mjs';

const handleMcp = mcpHandler({ name: 'test', version: '1.0.0', tools: [] });

let server;
let base;
let port;

before(async () => {
  server = http.createServer(
    withErrorBoundary(async (req, res) => {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname === '/mcp') return handleMcp(req, res);
      if (url.pathname === '/boom') throw new Error('boom');
      res.end();
    }),
  );
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
  base = `http://127.0.0.1:${port}`;
});

after(() => server.close());

const ping = () =>
  fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
    signal: AbortSignal.timeout(2000),
  });

test('a handler that throws answers 500, is logged and the server keeps serving', async (t) => {
  const logged = t.mock.method(console, 'error', () => {});
  const res = await fetch(`${base}/boom`, { signal: AbortSignal.timeout(2000) });
  assert.equal(res.status, 500);
  assert.equal(await res.text(), 'Internal error');
  assert.match(logged.mock.calls[0].arguments[0], /GET \/boom failed: Error: boom/);
  assert.equal((await ping()).status, 200);
});

test('an MCP request aborted mid-body is logged and the server keeps serving', { timeout: 2000 }, async (t) => {
  const logged = t.mock.method(console, 'error', () => {});
  const failed = new Promise((resolve) => logged.mock.mockImplementation(resolve));
  const socket = net.connect(port, '127.0.0.1');
  socket.on('error', () => {});
  socket.write('POST /mcp HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: 1000\r\n\r\n{"jsonrpc"');
  await new Promise((resolve) => setTimeout(resolve, 50));
  socket.resetAndDestroy();
  assert.match(await failed, /POST \/mcp failed/);
  assert.equal((await ping()).status, 200);
});
