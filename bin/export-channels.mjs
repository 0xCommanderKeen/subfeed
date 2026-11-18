import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { CHANNELS_PATH, exportChannels, openSeededDb } from '../src/channels-file.mjs';

const target = process.argv[2] ? resolve(process.argv[2]) : CHANNELS_PATH;
const db = openSeededDb();
writeFileSync(target, exportChannels(db));
console.log(`Wrote ${db.listChannels().length} channels and ${db.listTopics().length} topics to ${target}`);
db.close();
