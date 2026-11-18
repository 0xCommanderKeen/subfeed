import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const read = (name) => readFileSync(join(root, name), 'utf8');
const agents = read('AGENTS.md');

const slug = (heading) => heading.trim().toLowerCase().replace(/[^\w\- ]/g, '').replace(/ /g, '-');

test('CLAUDE.md only includes AGENTS.md', () => {
  assert.equal(read('CLAUDE.md').trim(), '@AGENTS.md');
});

test('AGENTS.md stays under 120 lines', () => {
  assert.ok(agents.split('\n').length < 120);
});

test('every doc and section AGENTS.md links to exists', () => {
  const links = [...agents.matchAll(/\]\(([\w/.-]+\.md)(?:#([^)]+))?\)/g)].map(([, file, anchor]) => ({ file, anchor }));
  assert.ok(links.some((link) => link.file.startsWith('docs/')));
  for (const { file, anchor } of links) {
    assert.ok(existsSync(join(root, file)), `${file} does not exist`);
    if (!anchor) continue;
    const anchors = new Set([...read(file).matchAll(/^#+ (.+)$/gm)].map((m) => slug(m[1])));
    assert.ok(anchors.has(anchor), `${file} has no section #${anchor}`);
  }
});

test('every file AGENTS.md names exists, unless git ignores it', () => {
  const ignored = new Set(read('.gitignore').split('\n').map((line) => line.trim()));
  const files = [...agents.matchAll(/`((?:public\/|test\/)?[\w.-]+\.(?:mjs|js|json|md))`/g)].map((m) => m[1]).filter((f) => !f.includes('*'));
  assert.ok(files.length > 0);
  for (const file of files) if (!ignored.has(file)) assert.ok(existsSync(join(root, file)), `${file} does not exist`);
});
