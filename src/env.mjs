import { existsSync } from 'node:fs';
import { join } from 'node:path';

// Entry points call this first. Variables already set in the environment win over the file.
export function loadEnv(path = join(import.meta.dirname, '..', '.env')) {
  if (existsSync(path)) process.loadEnvFile(path);
}
