import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, test } from 'node:test';
import { allowedHosts, guarded } from '../src/http-guard.mjs';
import { mcpHandler } from '../src/mcp.mjs';
import { startApp } from './helpers.mjs';

let server;
let port;
const writes = [];

before(async () => {
  const mcp = mcpHandler({ name: 'test', version: '1', tools: [] });
  const hosts = new Set();
  server = http.createServer(guarded((req, res) => {
    if (req.url === '/mcp') return mcp(req, res);
    if (req.method !== 'GET') writes.push(`${req.method} ${req.url}`);
    res.writeHead(204);
    res.end();
  }, { hosts }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
  for (const host of allowedHosts(' subfeed.example.ts.net , 192.168.1.50:8080 ', port)) hosts.add(host);
});

after(() => server.close());

// fetch() drops a Host header it is given, so these requests go through http.request.
function exchange(method, path, headers = {}, body = '', to = port) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: to, method, path, headers: { Host: `127.0.0.1:${to}`, ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

const request = async (...args) => (await exchange(...args)).status;

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

test('the app refuses a foreign Host on every path and a foreign Origin on every write before any handler runs', async (t) => {
  const { port: to } = await startApp(t);
  const paths = [
    { path: '/api/meta', get: 200, post: 405 },
    { path: '/mcp', get: 405, post: 200 },
    { path: '/', get: 200, post: 200 },
  ];
  const own = { ...json, Origin: `http://127.0.0.1:${to}` };
  const hostRefused = { status: 403, body: JSON.stringify({ error: 'host not allowed' }) };
  const originRefused = { status: 403, body: JSON.stringify({ error: 'origin not allowed' }) };
  for (const { path, get, post } of paths) {
    assert.deepEqual(await exchange('GET', path, { Host: 'evil.example' }, '', to), hostRefused, `GET ${path} with a foreign Host`);
    assert.deepEqual(await exchange('POST', path, { ...json, Host: 'evil.example' }, ping, to), hostRefused, `POST ${path} with a foreign Host`);
    assert.deepEqual(await exchange('POST', path, { ...json, Origin: 'http://evil.example' }, ping, to), originRefused, `POST ${path} with a foreign Origin`);
    assert.equal(await request('GET', path, {}, '', to), get, `GET ${path} from loopback`);
    assert.equal(await request('POST', path, own, ping, to), post, `POST ${path} from its own Origin`);
  }
});
