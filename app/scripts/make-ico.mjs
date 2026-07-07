import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const png = readFileSync(path.join(root, 'assets', 'icon.png'));

const header = Buffer.alloc(6 + 16);
header.writeUInt16LE(0, 0); // reservado
header.writeUInt16LE(1, 2); // tipo: ícone
header.writeUInt16LE(1, 4); // quantidade de imagens
header.writeUInt8(0, 6); // largura 256
header.writeUInt8(0, 7); // altura 256
header.writeUInt8(0, 8); // paleta
header.writeUInt8(0, 9); // reservado
header.writeUInt16LE(1, 10); // planos
header.writeUInt16LE(32, 12); // bits por pixel
header.writeUInt32LE(png.length, 14); // tamanho dos dados
header.writeUInt32LE(22, 18); // offset dos dados

writeFileSync(path.join(root, 'assets', 'icon.ico'), Buffer.concat([header, png]));
console.log('assets/icon.ico gerado');
