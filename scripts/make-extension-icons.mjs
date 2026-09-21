// Writes the extension's PNG icons (green rounded square with a white R) without any image library.
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const R = ['11110', '10001', '10001', '11110', '10100', '10010', '10001'];
const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = buffer => { let c = 0xffffffff; for (const byte of buffer) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => { const length = Buffer.alloc(4); length.writeUInt32BE(data.length); const body = Buffer.concat([Buffer.from(type), data]); const sum = Buffer.alloc(4); sum.writeUInt32BE(crc(body)); return Buffer.concat([length, body, sum]); };

function png(size) {
  const rows = [];
  const radius = size * 0.22, cell = size / 8, ox = (size - 5 * cell) / 2, oy = (size - 7 * cell) / 2;
  for (let y = 0; y < size; y++) {
    const row = [0];
    for (let x = 0; x < size; x++) {
      const dx = Math.max(radius - x, x - (size - 1 - radius), 0), dy = Math.max(radius - y, y - (size - 1 - radius), 0);
      const inside = dx * dx + dy * dy <= radius * radius;
      const gx = Math.floor((x - ox) / cell), gy = Math.floor((y - oy) / cell);
      const letter = gx >= 0 && gx < 5 && gy >= 0 && gy < 7 && R[gy][gx] === '1';
      row.push(...(!inside ? [0, 0, 0, 0] : letter ? [255, 255, 255, 255] : [40, 87, 64, 255]));
    }
    rows.push(Buffer.from(row));
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(size, 0); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 6; header[10] = 0; header[11] = 0; header[12] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))]);
}

const dir = join(process.cwd(), 'extension', 'icons');
mkdirSync(dir, { recursive: true });
for (const size of [16, 32, 48, 128]) writeFileSync(join(dir, `icon${size}.png`), png(size));
console.log('Wrote extension/icons/icon{16,32,48,128}.png');
