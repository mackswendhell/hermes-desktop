import { build } from 'esbuild';
import { copyFileSync, mkdirSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dist = path.join(root, 'dist');
mkdirSync(dist, { recursive: true });

const common = {
  bundle: true,
  sourcemap: 'inline',
  logLevel: 'info',
  // .mjs como texto: o worker do pdf.js vira blob em runtime (a CSP não deixa buscar arquivo)
  loader: { '.svg': 'text', '.worker.min.mjs': 'text' },
};

await build({
  ...common,
  entryPoints: [path.join(root, 'src/main/main.ts')],
  outfile: path.join(dist, 'main.js'),
  platform: 'node',
  format: 'cjs',
  external: ['electron'],
});

await build({
  ...common,
  entryPoints: [path.join(root, 'src/preload/preload.ts')],
  outfile: path.join(dist, 'preload.js'),
  platform: 'node',
  format: 'cjs',
  external: ['electron'],
});

await build({
  ...common,
  entryPoints: [path.join(root, 'src/renderer/index.ts')],
  outfile: path.join(dist, 'renderer.js'),
  platform: 'browser',
  format: 'iife',
});

await build({
  ...common,
  entryPoints: [path.join(root, 'src/renderer/settings-ui.ts')],
  outfile: path.join(dist, 'settings-ui.js'),
  platform: 'browser',
  format: 'iife',
});

await build({
  ...common,
  entryPoints: [path.join(root, 'src/renderer/chat.ts')],
  outfile: path.join(dist, 'chat.js'),
  platform: 'browser',
  format: 'iife',
});

for (const f of ['index.html', 'settings.html', 'styles.css', 'theme.css', 'chat.html', 'chat.css']) {
  copyFileSync(path.join(root, 'src/renderer', f), path.join(dist, f));
}
// voice-server: só o código (12 KB). A venv (~1,2 GB) é montada na máquina do
// usuário pelo instalador — ver src/main/voiceInstall.ts
const vsOut = path.join(dist, 'voice-server');
mkdirSync(vsOut, { recursive: true });
for (const f of ['server.py', 'requirements.txt']) {
  copyFileSync(path.join(root, '..', 'voice-server', f), path.join(vsOut, f));
}
mkdirSync(path.join(dist, 'assets'), { recursive: true });
for (const f of readdirSync(path.join(root, 'assets'))) {
  copyFileSync(path.join(root, 'assets', f), path.join(dist, 'assets', f));
}
