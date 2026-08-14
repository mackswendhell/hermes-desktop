// Checagem do corte de resposta em duas mensagens, no mesmo esquema do check-markdown:
// compila o módulo com o esbuild que já é devDep e roda asserts. O 'electron' fica
// externo e é servido por um stub — o splitReply não encosta nele.
import assert from 'node:assert';
import { build } from 'esbuild';
import { rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'dist', '_split-check.mjs');

await build({
  entryPoints: [path.join(root, 'src', 'main', 'hermes.ts')],
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile: out,
  plugins: [
    {
      name: 'stub-electron',
      setup(b) {
        b.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'stub' }));
        b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
          contents: 'export const app = { getPath: () => "/tmp", getVersion: () => "0" };',
        }));
      },
    },
  ],
});

const { splitReply, SPLIT_MARK } = await import(pathToFileURL(out).href);

// sem marcador: uma mensagem só, como sempre foi
assert.deepStrictEqual(splitReply('Bom dia, tudo certo.'), ['Bom dia, tudo certo.']);

// caso real: contexto, marcador, e-mail
const dois = splitReply(`Escrevi respondendo ao prazo dele.\n\n${SPLIT_MARK}\n\nOlá João,\n\nFechado.`);
assert.deepStrictEqual(dois, ['Escrevi respondendo ao prazo dele.', 'Olá João,\n\nFechado.']);

// marcador com espaço em volta da linha ainda corta
assert.strictEqual(splitReply(`a\n  ${SPLIT_MARK}  \nb`).length, 2);

// marcador no meio de uma linha NÃO corta (senão citar o marcador quebraria a resposta)
assert.strictEqual(splitReply(`use ${SPLIT_MARK} para separar`).length, 1);

// marcador sem nada depois: não devolve mensagem vazia
assert.deepStrictEqual(splitReply(`só isso\n${SPLIT_MARK}\n`), ['só isso']);

rmSync(out, { force: true });
rmSync(out + '.map', { force: true });
console.log('split ok');
