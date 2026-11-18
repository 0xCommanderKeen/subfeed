import http from 'node:http';
import { openDb } from '../src/db.mjs';
import { allowedHosts } from '../src/http-guard.mjs';
import { createApp } from '../src/server.mjs';

// A video as fetchFeeds returns it and db.upsertVideos stores it. The title defaults to the id.
export const feedVideo = (fields) => ({ title: fields.id, published: '2025-01-01T00:00:00.000Z', thumbnail: null, isShort: false, views: null, durationS: null, ...fields });

// No test reaches youtube.com: by default every feed is empty and every channel and watch page is missing.
export const testApp = (opts) =>
  createApp({ fetchFeeds: async () => ({ videos: [], error: null }), fetchPage: async () => new Response('', { status: 404 }), hosts: new Set(), ...opts });

export async function callTool(url, name, args = {}) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  return (await res.json()).result;
}

// createApp on a free port over `db`, closed after the test. `now` is the clock of the default database; a db passed
// in brings its own.
export async function startApp(t, { now, db, ...opts } = {}) {
  if (db && now) throw new Error('startApp: pass now to openDb for your own db, not to startApp');
  db ??= openDb(':memory:', { now });
  let app;
  const server = http.createServer((req, res) => app.handle(req, res));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const { port } = server.address();
  app = testApp({ db, hosts: allowedHosts(null, port), ...opts });
  const base = `http://127.0.0.1:${port}`;
  const request = (method, path, body, headers = {}) =>
    fetch(base + path, {
      method,
      // Like public/dom.js, every request but a GET says JSON, which the request guard requires.
      headers: method === 'GET' ? headers : { 'Content-Type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const json = async (method, path, body) => {
    const res = await request(method, path, body);
    return { status: res.status, body: res.status === 204 ? null : await res.json() };
  };
  // The text of an MCP tool's answer; a tool's error message rejects.
  const mcp = async (name, args) => {
    const { content, isError } = await callTool(`${base}/mcp`, name, args);
    if (isError) throw new Error(content[0].text);
    return content[0].text;
  };
  return { app, db, port, request, json, mcp };
}
