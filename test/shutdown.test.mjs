import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { once } from 'node:events';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { openDb } from '../src/db.mjs';

const ROOT = join(import.meta.dirname, '..');
const dir = mkdtempSync(join(tmpdir(), 'subfeed-shutdown-'));
after(() => rmSync(dir, { recursive: true, force: true }));

// A database seeded with no channels, so the server's first refresh fetches nothing.
function emptyDb(name) {
  const file = join(dir, name);
  const db = openDb(file);
  db.seedChannels(() => ({ topics: [], channels: [] }));
  db.close();
  return file;
}

async function startServer(dbFile) {
  const server = spawn(process.execPath, ['src/server.mjs'], {
    cwd: ROOT,
    env: { PORT: '0', SUBFEED_DB: dbFile },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  let output = '';
  server.stdout.on('data', (chunk) => (output += chunk));
  const printed = (text) =>
    new Promise((resolve, reject) => {
      const check = () => output.includes(text) && resolve();
      server.stdout.on('data', check);
      server.on('exit', (code) => reject(new Error(`server exited with ${code} before printing "${text}"`)));
      check();
    });
  await printed('subfeed running');
  return { server, port: Number(output.match(/localhost:(\d+)/)[1]), printed };
}

// The keep-alive agent leaves the connection open, as a browser would.
async function getMeta(port, host = `localhost:${port}`) {
  const agent = new http.Agent({ keepAlive: true });
  const [res] = await once(http.get({ port, path: '/api/meta', agent, headers: { host } }), 'response');
  let body = '';
  for await (const chunk of res) body += chunk;
  return { status: res.statusCode, body: JSON.parse(body) };
}

async function exitWithin(child, ms) {
  const timer = setTimeout(() => child.kill('SIGKILL'), ms);
  const [code, signal] = await once(child, 'exit');
  clearTimeout(timer);
  return { code, signal };
}

for (const signal of ['SIGTERM', 'SIGINT']) {
  test(`the server exits with 0 within 2 s of ${signal} and uses the database SUBFEED_DB names`, async (t) => {
    const { server, port } = await startServer(emptyDb(`${signal}.db`));
    t.after(() => server.kill('SIGKILL'));
    const meta = await getMeta(port);
    assert.equal(meta.status, 200);
    assert.deepEqual(meta.body.topics, []);

    server.kill(signal);
    assert.deepEqual(await exitWithin(server, 2000), { code: 0, signal: null });
  });
}

test('with PORT=0 the server answers the Host that names the port it bound, and refuses localhost:0', async (t) => {
  const { server, port } = await startServer(emptyDb('port0.db'));
  t.after(() => server.kill('SIGKILL'));
  assert.equal((await getMeta(port)).status, 200);
  assert.equal((await getMeta(port, `127.0.0.1:${port}`)).status, 200);
  assert.equal((await getMeta(port, 'localhost:0')).status, 403);
});

test('a request still running at SIGTERM gets its answer and the server still exits with 0 within 2 s', async (t) => {
  const { server, port, printed } = await startServer(emptyDb('inflight.db'));
  t.after(() => server.kill('SIGKILL'));
  const agent = new http.Agent({ keepAlive: true });
  const body = '{}';
  const req = http.request({
    port,
    method: 'POST',
    path: '/api/import/preview',
    agent,
    headers: { host: `localhost:${port}`, 'content-type': 'application/json', 'content-length': body.length },
  });
  const response = once(req, 'response');
  req.flushHeaders();
  req.write(body.slice(0, 1));
  await sleep(100);

  server.kill('SIGTERM');
  await printed('SIGTERM: shutting down');
  req.end(body.slice(1));
  const [res] = await response;
  res.resume();
  await once(res, 'end');
  assert.ok(res.statusCode < 500, `answered ${res.statusCode}`);
  assert.deepEqual(await exitWithin(server, 2000), { code: 0, signal: null });
});
