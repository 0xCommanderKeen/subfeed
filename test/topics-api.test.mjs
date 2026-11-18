import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

const ROOT = join(import.meta.dirname, '..');
const SKIPPED = new Set(['.git', 'data', 'node_modules', 'test', '.env', 'channels.json']);

let dir;
let server;
let base;

const freePort = () =>
  new Promise((resolve) => {
    const probe = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });

// The real server, run from a copy with its own database. The seed has topics but no channels, so refresh fetches nothing.
before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'subfeed-api-'));
  cpSync(ROOT, dir, { recursive: true, filter: (src) => src === ROOT || !SKIPPED.has(src.slice(ROOT.length + 1).split(/[\\/]/)[0]) });
  writeFileSync(join(dir, 'channels.json'), JSON.stringify({ topics: { print: 'Printing', paint: 'Painting' }, hiddenTopics: ['paint'], channels: [] }));
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, ['src/server.mjs'], { cwd: dir, env: { PORT: String(port) }, stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((resolve, reject) => {
    server.on('exit', (code) => reject(new Error(`server exited with ${code}`)));
    server.stdout.on('data', (chunk) => String(chunk).includes('subfeed running') && resolve());
  });
});

after(() => {
  server.kill();
  rmSync(dir, { recursive: true, force: true });
});

const meta = async () => (await fetch(`${base}/api/meta`)).json();
const hiddenIds = (m) => m.topics.filter((t) => t.hidden).map((t) => t.id);

const patch = (id, body) =>
  fetch(`${base}/api/topics/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

test('/api/meta lists the hidden topics from the seed', async () => {
  const m = await meta();
  assert.deepEqual(m.topics, [{ id: 'print', name: 'Printing', hidden: false }, { id: 'paint', name: 'Painting', hidden: true }]);
});

test('PATCH hidden hides and shows a topic, and /api/meta follows', async () => {
  const hide = await patch('print', { hidden: true });
  assert.equal(hide.status, 200);
  assert.deepEqual(await hide.json(), { id: 'print', name: 'Printing', position: 0, hidden: true });
  assert.deepEqual(hiddenIds(await meta()), ['print', 'paint']);

  const show = await patch('paint', { hidden: false, position: 0 });
  assert.deepEqual(await show.json(), { id: 'paint', name: 'Painting', position: 0, hidden: false });
  const m = await meta();
  assert.deepEqual(m.topics.map((t) => t.id), ['paint', 'print']);
  assert.deepEqual(hiddenIds(m), ['print']);
});

test('PATCH refuses a hidden value that is not a boolean and changes nothing', async () => {
  for (const hidden of ['true', 1, null]) {
    const res = await patch('paint', { hidden });
    assert.equal(res.status, 400, `hidden: ${JSON.stringify(hidden)}`);
    assert.deepEqual(await res.json(), { error: 'hidden must be true or false' });
  }
  assert.deepEqual(hiddenIds(await meta()), ['print']);
});

test('PATCH hidden on an unknown topic is a 404', async () => {
  assert.equal((await patch('nope', { hidden: true })).status, 404);
});
