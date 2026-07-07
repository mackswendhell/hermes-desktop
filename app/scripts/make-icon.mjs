import zlib from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
mkdirSync(path.join(root, 'assets'), { recursive: true });

function makePng(size) {
  const px = Buffer.alloc(size * size * 4);
  const set = (x, y, r, g, b, a) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const i = (y * size + x) * 4;
    px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = a;
  };
  const circle = (cx, cy, rad, r, g, b) => {
    for (let y = 0; y < size; y++)
      for (let x = 0; x < size; x++) {
        const d = Math.hypot(x - cx, y - cy);
        if (d <= rad) set(x, y, r, g, b, 255);
        else if (d <= rad + 1) set(x, y, r, g, b, Math.round(255 * (rad + 1 - d)));
      }
  };
  const s = size / 32;
  circle(16 * s, 16 * s, 14 * s, 91, 108, 255);
  circle(11 * s, 13 * s, 4.6 * s, 255, 255, 255);
  circle(21 * s, 13 * s, 4.6 * s, 255, 255, 255);
  circle(11.5 * s, 14 * s, 2.1 * s, 25, 28, 52);
  circle(21.5 * s, 14 * s, 2.1 * s, 25, 28, 52);

  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    px.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

writeFileSync(path.join(root, 'assets', 'tray.png'), makePng(32));
writeFileSync(path.join(root, 'assets', 'icon.png'), makePng(256));
console.log('icons written to assets/');
