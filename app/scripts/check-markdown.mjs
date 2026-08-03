// Checagem do renderer de markdown sem test runner: compila o módulo com o esbuild
// que já é devDep e roda asserts contra um DOM de mentira.
import assert from 'node:assert';
import { build } from 'esbuild';
import { readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'dist', '_markdown-check.mjs');

function makeEl(tag) {
  return {
    tagName: tag.toUpperCase(),
    children: [],
    className: '',
    href: '',
    set textContent(v) {
      this.children = [String(v)];
    },
    get textContent() {
      return this.children.map((c) => (typeof c === 'string' ? c : c.textContent)).join('');
    },
    append(...nodes) {
      this.children.push(...nodes);
    },
    appendChild(node) {
      this.children.push(node);
      return node;
    },
    addEventListener() {},
  };
}

globalThis.document = {
  createElement: makeEl,
  createTextNode: (t) => ({ tagName: '#text', children: [String(t)], textContent: String(t) }),
};
globalThis.window = { hermes: { openExternal() {} } };
// o Node 24 já expõe navigator como getter — só falta o clipboard
Object.defineProperty(globalThis.navigator, 'clipboard', {
  value: { writeText: async () => {} },
  configurable: true,
});

const dump = (node) => {
  if (typeof node === 'string') return node;
  if (node.tagName === '#text') return node.textContent;
  const tag = node.tagName.toLowerCase();
  return `<${tag}>${node.children.map(dump).join('')}</${tag}>`;
};

await build({
  entryPoints: [path.join(root, 'src', 'renderer', 'markdown.ts')],
  outfile: out,
  bundle: true,
  format: 'esm',
  platform: 'neutral',
});

const { renderMarkdown } = await import(pathToFileURL(out).href);
const render = (md) => renderMarkdown(md).map(dump).join('');

// cerca com linguagem vira bloco de código com o texto intacto
const py = render('```python\nprint("oi")\n```');
assert.ok(py.includes('<div><div><span>python</span>'), py);
assert.ok(py.includes('print("oi")'), py);

// cerca não fechada (resposta cortada no meio) ainda rende um bloco
assert.ok(render('```js\nconst a = 1').includes('const a = 1'));

// markup no texto sai como texto, nunca como nó
const perigo = render('olha isso: <script>alert(1)</script>');
assert.ok(perigo.includes('<script>alert(1)</script>'.replace('<', '<')), perigo);
assert.ok(!perigo.toLowerCase().includes('<script><'), 'script virou elemento');

// negrito, itálico e código inline
assert.ok(render('um **forte** aqui').includes('<strong>forte</strong>'));
assert.ok(render('um *leve* aqui').includes('<em>leve</em>'));
assert.ok(render('use `npm start`').includes('<code>npm start</code>'));

// asterisco solto no meio da palavra não vira itálico
assert.ok(!render('2 * 3 * 4 = 24').includes('<em>'), render('2 * 3 * 4 = 24'));

// títulos e listas
assert.ok(render('## Passos').includes('<h2>Passos</h2>'));
assert.ok(render('- um\n- dois').includes('<ul><li>um</li><li>dois</li></ul>'));
assert.ok(render('1. um\n2. dois').includes('<ol><li>um</li><li>dois</li></ol>'));
assert.ok(render('> citado').includes('<blockquote>citado</blockquote>'));

// link markdown vira <a> com o rótulo
assert.ok(render('veja [o site](https://exemplo.com)').includes('<a>o site</a>'));

// texto e código convivem na mesma resposta
const misto = render('Segue:\n\n```sh\nls -la\n```\n\nPronto.');
assert.ok(misto.includes('<p>Segue:</p>') && misto.includes('ls -la') && misto.includes('<p>Pronto.</p>'), misto);

rmSync(out, { force: true });
rmSync(out + '.map', { force: true });
console.log('markdown ok');
