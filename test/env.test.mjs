import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadEnv } from '../src/env.mjs';

test('loadEnv reads the file, keeps variables already set, and ignores a missing file', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'subfeed-env-')), '.env');
  writeFileSync(path, 'SUBFEED_TEST_NEW=from-file\nSUBFEED_TEST_SET=from-file\n');
  process.env.SUBFEED_TEST_SET = 'from-env';
  try {
    loadEnv(path);
    assert.equal(process.env.SUBFEED_TEST_NEW, 'from-file');
    assert.equal(process.env.SUBFEED_TEST_SET, 'from-env');
    loadEnv(join(path, '..', 'missing.env'));
  } finally {
    delete process.env.SUBFEED_TEST_NEW;
    delete process.env.SUBFEED_TEST_SET;
  }
});
