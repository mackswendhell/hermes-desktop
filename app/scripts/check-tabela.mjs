// Checagem dos geradores de tabela, no mesmo espírito do check-markdown: esbuild + asserts.
// O 'electron' vira stub porque o extract.ts arrasta o logger, que só o usa em disco.
import assert from 'node:assert';
import { build } from 'esbuild';
import { rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'dist', '_tabela-check.mjs');
const stub = path.join(root, 'dist', '_electron-stub.mjs');
writeFileSync(stub, 'export const app = { getPath: () => "." };\n');

await build({
  entryPoints: [path.join(root, 'src', 'main', 'extract.ts')],
  outfile: out,
  bundle: true,
  format: 'esm',
  platform: 'node',
  alias: { electron: stub },
});

const { tabelaXlsx, tabelaCsv } = await import(pathToFileURL(out).href);

const linhas = [
  ['Canal', 'Investimento', 'Obs'],
  ['E-mail', '0', 'sem custo'],
  ['Meta Ads', '4.500', 'verba do mês; revisar'],
  ['YouTube', 'R$ 1.200', 'aspas "assim"'],
];

// CSV: ponto e vírgula, BOM na frente e número como está na tela (o Excel pt-BR espera assim)
const csv = tabelaCsv(linhas);
assert.ok(csv.startsWith('﻿'), 'faltou o BOM');
assert.ok(csv.includes('Canal;Investimento;Obs'), csv);
assert.ok(csv.includes('Meta Ads;4.500;"verba do mês; revisar"'), csv);
assert.ok(csv.includes('YouTube;R$ 1.200;"aspas ""assim"""'), csv);

// XLSX: número puro vira número; texto com moeda ou palavra continua texto
const XLSX = await import('xlsx');
const ws = XLSX.read(await tabelaXlsx(linhas), { type: 'buffer' }).Sheets['Tabela'];
assert.strictEqual(ws['B2'].v, 0);
assert.strictEqual(ws['B2'].t, 'n');
assert.strictEqual(ws['B3'].v, 4500, JSON.stringify(ws['B3']));
assert.strictEqual(ws['B4'].t, 's', 'R$ 1.200 deveria continuar texto');
assert.strictEqual(ws['A1'].v, 'Canal');

// decimal com vírgula também vira número
const dec = XLSX.read(await tabelaXlsx([['x'], ['1.200,50']]), { type: 'buffer' }).Sheets['Tabela'];
assert.strictEqual(dec['A2'].v, 1200.5, JSON.stringify(dec['A2']));

rmSync(out, { force: true });
rmSync(out + '.map', { force: true });
rmSync(stub, { force: true });
console.log('tabela ok');
