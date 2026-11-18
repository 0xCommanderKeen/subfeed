import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = join(import.meta.dirname, '..');

function sources(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (e.name.startsWith('.') || e.name === 'node_modules' || e.name === 'fixtures') return [];
    const path = join(dir, e.name);
    if (e.isDirectory()) return sources(path);
    return /\.(mjs|js|html)$/.test(e.name) ? [path] : [];
  });
}

test('every export is used by another file', () => {
  const files = sources(root).map((path) => ({ path: relative(root, path), text: readFileSync(path, 'utf8') }));
  const unused = [];
  for (const { path, text } of files) {
    if (path.startsWith('test/')) continue;
    for (const [, name] of text.matchAll(/^export (?:async )?(?:function\*?|const|let|class) ([\w$]+)/gm)) {
      const word = new RegExp(`\\b${name.replace('$', '\\$')}\\b`);
      if (!files.some((f) => f.path !== path && word.test(f.text))) unused.push(`${path} ${name}`);
    }
  }
  assert.deepEqual(unused, []);
});
