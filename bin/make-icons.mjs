// Run `node bin/make-icons.mjs` after changing the favicon.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { crc32, deflateSync } from 'node:zlib';

const TILE = [0x0c, 0x0b, 0x0a];
const SLASH = [0xff, 0x5b, 0x2e];
// In the favicon's 64-unit box.
const RADIUS = 14;
const FROM = [40, 10];
const TO = [24, 54];
const HALF_WIDTH = 5.5;
const SAMPLES = 4;

function insideRoundedSquare(x, y, radius) {
  const dx = Math.max(radius - x, x - (64 - radius), 0);
  const dy = Math.max(radius - y, y - (64 - radius), 0);
  return dx * dx + dy * dy <= radius * radius;
}

function nearSlash(x, y, scale) {
  const [ax, ay] = FROM.map((v) => 32 + (v - 32) * scale);
  const [bx, by] = TO.map((v) => 32 + (v - 32) * scale);
  const [vx, vy] = [bx - ax, by - ay];
  const t = Math.min(1, Math.max(0, ((x - ax) * vx + (y - ay) * vy) / (vx * vx + vy * vy)));
  return Math.hypot(x - ax - t * vx, y - ay - t * vy) <= HALF_WIDTH * scale;
}

// A maskable icon fills the square and keeps the slash inside the central safe circle, 80% of its width.
function render(size, maskable) {
  const radius = maskable ? 0 : RADIUS;
  const scale = maskable ? 0.8 : 1;
  const rgba = Buffer.alloc(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let tile = 0;
      let slash = 0;
      for (let sy = 0; sy < SAMPLES; sy++) {
        for (let sx = 0; sx < SAMPLES; sx++) {
          const x = ((px + (sx + 0.5) / SAMPLES) * 64) / size;
          const y = ((py + (sy + 0.5) / SAMPLES) * 64) / size;
          if (!insideRoundedSquare(x, y, radius)) continue;
          tile++;
          if (nearSlash(x, y, scale)) slash++;
        }
      }
      const i = (py * size + px) * 4;
      for (let c = 0; c < 3; c++) rgba[i + c] = tile && Math.round((TILE[c] * (tile - slash) + SLASH[c] * slash) / tile);
      rgba[i + 3] = Math.round((255 * tile) / SAMPLES ** 2);
    }
  }
  return rgba;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function png(size, rgba) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 6, 0, 0, 0], 8);
  const rows = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) rgba.copy(rows, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(rows, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const ICONS = [
  ['icon-192.png', 192, false],
  ['icon-512.png', 512, false],
  ['icon-maskable-512.png', 512, true],
];

for (const [name, size, maskable] of ICONS) writeFileSync(join(import.meta.dirname, '..', 'public', name), png(size, render(size, maskable)));
