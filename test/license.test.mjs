import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const read = (name) => readFileSync(join(root, name), 'utf8');

test('LICENSE is the MIT license with its copyright line first, and package.json names it', () => {
  const license = read('LICENSE');
  assert.equal(license.split('\n')[0], 'Copyright (c) 2026 Miha');
  assert.match(license, /^Permission is hereby granted, free of charge, to any person obtaining a copy$/m);
  assert.match(license, /^THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR$/m);
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.license, 'MIT');
  assert.equal(pkg.private, true);
});

test('the README ends with Security, Contributing and License', () => {
  const readme = read('README.md');
  const headings = [...readme.matchAll(/^## (.+)$/gm)].map((m) => m[1]);
  assert.deepEqual(headings.slice(-3), ['Security', 'Contributing', 'License']);
  assert.match(readme, /MIT\. See \[LICENSE\]\(LICENSE\)\.\n$/);
});

test('the README and docs name no personal host or channel', () => {
  const docs = readdirSync(join(root, 'docs')).filter((name) => name.endsWith('.md'));
  assert.ok(docs.length > 0);
  const text = ['README.md', ...docs.map((name) => `docs/${name}`)].map(read).join('\n');
  assert.doesNotMatch(text, /\bNAS\b/);
  const ips = [...text.matchAll(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g)].map((m) => m[0]);
  assert.deepEqual([...new Set(ips)].filter((ip) => !['127.0.0.1', '0.0.0.0', '192.168.1.50'].includes(ip)), []);
  const tailnets = [...text.matchAll(/[\w.-]+\.ts\.net/g)].map((m) => m[0]);
  assert.deepEqual([...new Set(tailnets)], ['subfeed.example.ts.net']);
  const handles = [...text.matchAll(/(?<!\w)@([A-Za-z][\w.-]*)/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(handles)].filter((h) => !['handle', 'examplechannel'].includes(h)), []);
});
