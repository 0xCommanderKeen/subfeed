import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, test } from 'node:test';
import { allowedHosts, refusal } from '../src/http-guard.mjs';
import { mcpHandler } from '../src/mcp.mjs';

let server;
let port;
const writes = [];

before(async () => {
  const mcp = mcpHandler({ name: 'test', version: '1', tools: [] });
  let hosts;
  server = http.createServer((req, res) => {
    const refused = refusal(req, hosts);
    if (refused) {
      res.writeHead(refused.status, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: refused.error }));
    }
    if (req.url === '/mcp') return mcp(req, res);
    if (req.method !== 'GET') writes.push(`${req.method} ${req.url}`);
    res.writeHead(204);
    res.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
  hosts = allowedHosts(' subfeed.example.ts.net , 192.168.1.50:8080 ', port);
});

after(() => server.close());

function request(method, path, headers = {}, body = '') {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers: { Host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.end(body);
  });
}

const json = { 'Content-Type': 'application/json' };
const ping = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' });

test('a DNS-rebound page is refused even though its Origin matches its Host', async () => {
  const rebound = { Host: 'evil.example:48231', Origin: 'http://evil.example:48231' };
  assert.equal(await request('POST', '/mcp', { ...json, ...rebound }, ping), 403);
  assert.equal(await request('DELETE', '/api/channels/UC1', { ...json, ...rebound }), 403);
  assert.equal(await request('GET', '/api/meta', { Host: 'evil.example:48231' }), 403);
  assert.deepEqual(writes, []);
});

test('a cross-site text/plain or form post is refused', async () => {
  const body = JSON.stringify({ name: 'Pwned' });
  assert.equal(await request('POST', '/api/topics', { Origin: 'http://evil.example', 'Content-Type': 'text/plain' }, body), 403);
  assert.equal(await request('POST', '/api/topics', { Origin: 'http://evil.example', ...json }, body), 403);
  assert.equal(await request('POST', '/api/topics', { Origin: 'null', ...json }, body), 403);
  assert.equal(await request('POST', '/api/refresh', { 'Content-Type': 'text/plain' }), 415);
  assert.equal(await request('POST', '/api/refresh', { 'Content-Type': 'application/x-www-form-urlencoded' }), 415);
  assert.equal(await request('POST', '/api/refresh'), 415);
  assert.deepEqual(writes, []);
});

test('the listed hosts and loopback are served, with their own Origin or none', async () => {
  assert.equal(await request('POST', '/mcp', { ...json, Host: 'subfeed.example.ts.net', Origin: 'https://subfeed.example.ts.net' }, ping), 200);
  assert.equal(await request('POST', '/mcp', json, ping), 200);
  assert.equal(await request('POST', '/api/topics', { 'Content-Type': 'application/json; charset=utf-8', Host: '192.168.1.50:8080', Origin: 'http://192.168.1.50:8080' }, '{}'), 204);
  assert.equal(await request('DELETE', '/api/topics/x', { ...json, Host: `localhost:${port}`, Origin: `http://localhost:${port}` }), 204);
  assert.equal(await request('GET', '/api/meta', { Host: '192.168.1.50:8080', Origin: 'http://evil.example' }), 204);
  assert.deepEqual(writes, ['POST /api/topics', 'DELETE /api/topics/x']);
});
