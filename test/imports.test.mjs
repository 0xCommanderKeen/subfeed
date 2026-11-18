import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// The page's entry modules run the page when imported, so no other test loads them. This reads their imports instead.
const dir = join(import.meta.dirname, '..', 'public');
const read = (file) => readFileSync(join(dir, file), 'utf8');
const exportsOf = (text) => new Set([...text.matchAll(/^export (?:async )?(?:function\*?|const|let|class) ([\w$]+)/gm)].map((m) => m[1]));

test('every name a browser module imports is exported by the module it names', () => {
  const missing = [];
  let checked = 0;
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.js'))) {
    for (const [, names, target] of read(file).matchAll(/^import\s*\{([^}]*)\}\s*from\s*'\.\/([^']+)';/gm)) {
      if (!existsSync(join(dir, target))) {
        missing.push(`${file} imports from ${target}, which does not exist`);
        continue;
      }
      const exported = exportsOf(read(target));
      for (const name of names.split(',').map((n) => n.trim().split(/\s+as\s+/)[0]).filter(Boolean)) {
        checked++;
        if (!exported.has(name)) missing.push(`${file} imports ${name} from ${target}, which does not export it`);
      }
    }
  }
  assert.deepEqual(missing, []);
  assert.ok(checked > 50, `only ${checked} imported names found`);
});
