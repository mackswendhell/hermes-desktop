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

  return encodePng(px, size);
}

function encodePng(px, size) {
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

// ícone da menu bar do macOS: template image (preto + alpha, o sistema pinta
// branco/preto conforme o tema) — clipe minimalista com olhos grandes
function makeTrayTemplate(size) {
  const px = Buffer.alloc(size * size * 4);
  const s = size / 24; // grade de 24 unidades
  const W = 2.3; // espessura do arame do clipe

  // traço do clipe: laterais + arcos (espiral aberta)
  const segs = [
    [7, 8, 7, 17],   // externa esquerda
    [17, 17, 17, 10], // externa direita
    [10, 10, 10, 15], // interna esquerda
  ];
  const arcs = [
    [12, 8, 5, 180, 360],    // topo externo
    [12, 17, 5, 0, 180],     // fundo externo
    [13.5, 10, 3.5, 180, 360], // topo interno
    [12, 15, 2, 0, 180],     // fundo interno
  ];
  const eyes = [
    [9.6, 8.5],
    [14.4, 8.5],
  ];

  const distSeg = (px_, py, x1, y1, x2, y2) => {
    const dx = x2 - x1, dy = y2 - y1;
    const t = Math.max(0, Math.min(1, ((px_ - x1) * dx + (py - y1) * dy) / (dx * dx + dy * dy)));
    return Math.hypot(px_ - (x1 + t * dx), py - (y1 + t * dy));
  };
  const distArc = (px_, py, cx, cy, r, a0, a1) => {
    let a = (Math.atan2(py - cy, px_ - cx) * 180) / Math.PI;
    if (a < 0) a += 360;
    if (a >= a0 && a <= a1) return Math.abs(Math.hypot(px_ - cx, py - cy) - r);
    // fora do arco: distância até as pontas
    const rad = (deg) => (deg * Math.PI) / 180;
    return Math.min(
      Math.hypot(px_ - (cx + r * Math.cos(rad(a0))), py - (cy + r * Math.sin(rad(a0)))),
      Math.hypot(px_ - (cx + r * Math.cos(rad(a1))), py - (cy + r * Math.sin(rad(a1)))),
    );
  };

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const ux = (x + 0.5) / s, uy = (y + 0.5) / s;
      let d = Infinity;
      for (const [x1, y1, x2, y2] of segs) d = Math.min(d, distSeg(ux, uy, x1, y1, x2, y2));
      for (const [cx, cy, r, a0, a1] of arcs) d = Math.min(d, distArc(ux, uy, cx, cy, r, a0, a1));
      let alpha = Math.max(0, Math.min(1, W / 2 + 0.5 - d));

      for (const [ex, ey] of eyes) {
        const de = Math.hypot(ux - ex, uy - ey);
        if (de < 3.0) alpha = 0; // limpa o arame atrás do olho
        alpha = Math.max(alpha, Math.max(0, Math.min(1, 1.05 - Math.abs(de - 2.3)))); // contorno do olho
        const dp = Math.hypot(ux - ex, uy - (ey + 0.6));
        alpha = Math.max(alpha, Math.max(0, Math.min(1, 1.3 - dp))); // pupila
      }

      const i = (y * size + x) * 4;
      px[i] = 0; px[i + 1] = 0; px[i + 2] = 0;
      px[i + 3] = Math.round(alpha * 255);
    }
  }
  return encodePng(px, size);
}

writeFileSync(path.join(root, 'assets', 'tray.png'), makePng(32));
writeFileSync(path.join(root, 'assets', 'icon.png'), makePng(256));
writeFileSync(path.join(root, 'assets', 'icon-mac.png'), makePng(1024));
writeFileSync(path.join(root, 'assets', 'trayTemplate.png'), makeTrayTemplate(18));
writeFileSync(path.join(root, 'assets', 'trayTemplate@2x.png'), makeTrayTemplate(36));
console.log('icons written to assets/');
