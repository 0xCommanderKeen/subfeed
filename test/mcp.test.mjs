import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, test } from 'node:test';
import { mcpHandler } from '../src/mcp.mjs';
import { subfeedTools } from '../src/mcp-tools.mjs';
import { callTool } from './helpers.mjs';

const tools = [
  {
    name: 'echo',
    title: 'Echo',
    description: 'Says the text back.',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    annotations: { readOnlyHint: true },
    run: async ({ text }) => `echo: ${text}`,
  },
  {
    name: 'fail',
    title: 'Fail',
    description: 'Always fails.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true },
    run: () => {
      throw new Error('no such group');
    },
  },
];

let server;
let url;

before(async () => {
  server = http.createServer(mcpHandler({ name: 'test', version: '1.2.3', instructions: 'Be brief.', tools }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${server.address().port}/mcp`;
});

after(() => server.close());

const post = (body, headers = {}) =>
  fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

async function rpc(method, params) {
  const res = await post({ jsonrpc: '2.0', id: 7, method, params });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /^application\/json/);
  const body = await res.json();
  assert.equal(body.id, 7);
  return body;
}

test('initialize echoes a supported protocol version and answers the newest otherwise', async () => {
  const old = await rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'c', version: '1' } });
  assert.deepEqual(old.result, {
    protocolVersion: '2025-03-26',
    capabilities: { tools: {} },
    serverInfo: { name: 'test', version: '1.2.3' },
    instructions: 'Be brief.',
  });
  const future = await rpc('initialize', { protocolVersion: '2099-01-01' });
  assert.equal(future.result.protocolVersion, '2025-06-18');
  assert.deepEqual((await rpc('ping')).result, {});
});

test('a notification or a client response is accepted with 202 and no body', async () => {
  for (const message of [{ jsonrpc: '2.0', method: 'notifications/initialized' }, { jsonrpc: '2.0', id: 3, result: {} }]) {
    const r = await post(message);
    assert.equal(r.status, 202);
    assert.equal(await r.text(), '');
  }
});

test('tools/list describes every tool without its run function', async () => {
  const { result } = await rpc('tools/list');
  assert.deepEqual(result.tools.map((t) => t.name), ['echo', 'fail']);
  assert.ok(result.tools.every((t) => !('run' in t)));
  assert.deepEqual(result.tools[0].inputSchema, tools[0].inputSchema);
  assert.deepEqual(result.tools[0].annotations, { readOnlyHint: true });
});

test('tools/call returns the tool text, and a throwing tool is logged and returns its message as isError', async (t) => {
  const logged = t.mock.method(console, 'error', () => {});
  const ok = await rpc('tools/call', { name: 'echo', arguments: { text: 'hi' } });
  assert.deepEqual(ok.result, { content: [{ type: 'text', text: 'echo: hi' }] });
  const failed = await rpc('tools/call', { name: 'fail', arguments: {} });
  assert.equal(failed.error, undefined);
  assert.deepEqual(failed.result, { content: [{ type: 'text', text: 'no such group' }], isError: true });
  assert.equal(logged.mock.callCount(), 1);
  assert.match(logged.mock.calls[0].arguments[0], /^tool fail failed: Error: no such group\n {4}at /);
});

test('protocol faults are JSON-RPC errors', async () => {
  assert.equal((await rpc('tools/call', { name: 'nope', arguments: {} })).error.code, -32602);
  assert.equal((await rpc('resources/list')).error.code, -32601);
  const badJson = await post('{"jsonrpc":');
  assert.equal(badJson.status, 400);
  assert.deepEqual(await badJson.json(), { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'body must be JSON' } });
  const batch = await post([{ jsonrpc: '2.0', id: 1, method: 'ping' }]);
  assert.equal(batch.status, 400);
  assert.equal((await batch.json()).error.code, -32600);
});

test('GET is refused with Allow: POST', async () => {
  const r = await fetch(url, { headers: { Accept: 'text/event-stream' } });
  assert.equal(r.status, 405);
  assert.equal(r.headers.get('allow'), 'POST');
});

test('arguments that break the tool input schema return isError naming the argument, and the tool does not run', async () => {
  let ran = 0;
  const pick = {
    name: 'pick',
    title: 'Pick',
    description: 'Picks a size.',
    inputSchema: { type: 'object', properties: { size: { type: 'string', enum: ['small', 'large'] } }, additionalProperties: false },
    annotations: { readOnlyHint: true },
    run: () => String(++ran),
  };
  const guarded = subfeedTools({}).map((t) => ({ ...t, run: () => String(++ran) }));
  const app = http.createServer(mcpHandler({ name: 'subfeed', version: '0', tools: [...guarded, pick] }));
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  after(() => app.close());
  const call = (name, args) => callTool(`http://127.0.0.1:${app.address().port}/mcp`, name, args);

  for (const [name, args, message] of [
    ['favorite_video', {}, 'video is required'],
    ['new_videos', {}, 'group is required'],
    ['new_videos', { group: 'all', limit: 5 }, 'unknown argument limit; new_videos takes group, since, include_shorts, offset'],
    ['list_groups', { group: 'all' }, 'unknown argument group; list_groups takes no arguments'],
    ['new_videos', { group: 7 }, 'group must be a string'],
    ['watch_later', { video: 'dQw4w9WgXcQ', queued: 'no' }, 'queued must be true or false'],
    ['channel_videos', { channel: 'x', limit: 2.5 }, 'limit must be a whole number'],
    ['channel_videos', { channel: 'x', limit: 0 }, 'limit must be at least 1'],
    ['channel_videos', { channel: 'x', limit: 51 }, 'limit must be at most 50'],
    ['search', { query: 'x'.repeat(201) }, 'query must be at most 200 characters'],
    ['search', { query: 'x', offset: -1 }, 'offset must be at least 0'],
    ['new_videos', { group: 'all', offset: 1.5 }, 'offset must be a whole number'],
    ['search', { query: 'x', offset: 1e20 }, `offset must be at most ${Number.MAX_SAFE_INTEGER}`],
    ['add_channel', { input: '@x', groups: 'bb' }, 'groups must be a list'],
    ['add_channel', { input: '@x', groups: ['bb', 4] }, 'groups[1] must be a string'],
    ['pick', { size: 'huge' }, 'size must be one of small, large'],
  ]) {
    assert.deepEqual(await call(name, args), { content: [{ type: 'text', text: message }], isError: true }, `${name} ${JSON.stringify(args)}`);
  }
  assert.equal(ran, 0);
  assert.deepEqual(await call('channel_videos', { channel: 'x', limit: 50, include_shorts: true }), { content: [{ type: 'text', text: '1' }] });
});
