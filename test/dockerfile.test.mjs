import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

const root = join(import.meta.dirname, '..');

// The sources of every COPY line: files or folders at the root.
const copied = [...readFileSync(join(root, 'Dockerfile'), 'utf8').matchAll(/^COPY (.+)$/gm)].flatMap((m) => m[1].trim().split(/\s+/).slice(0, -1));
const inImage = (file) => copied.includes(file.split('/')[0]);

test('the image copies every module the server and the CLI scripts import', () => {
  const seen = new Set();
  const visit = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    for (const [, target] of readFileSync(join(root, file), 'utf8').matchAll(/^(?:import|export)\s[^;]*?from\s*'(\.{1,2}\/[^']+)';/gm)) {
      visit(relative(root, join(root, dirname(file), target)));
    }
  };
  visit('src/server.mjs');
  for (const f of readdirSync(join(root, 'bin'))) visit(`bin/${f}`);
  assert.ok(seen.has('src/db/listing.mjs') && seen.has('public/vocab.js'), `only found ${[...seen].join(', ')}`);
  assert.deepEqual([...seen].filter((f) => !inImage(f)), []);
});
