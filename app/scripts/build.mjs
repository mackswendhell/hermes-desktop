import { build } from 'esbuild';
import { copyFileSync, mkdirSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dist = path.join(root, 'dist');
mkdirSync(dist, { recursive: true });

const common = { bundle: true, sourcemap: 'inline', logLevel: 'info' };

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

copyFileSync(path.join(root, 'src/renderer/index.html'), path.join(dist, 'index.html'));
copyFileSync(path.join(root, 'src/renderer/settings.html'), path.join(dist, 'settings.html'));
copyFileSync(path.join(root, 'src/renderer/styles.css'), path.join(dist, 'styles.css'));
mkdirSync(path.join(dist, 'assets'), { recursive: true });
for (const f of readdirSync(path.join(root, 'assets'))) {
  copyFileSync(path.join(root, 'assets', f), path.join(dist, 'assets', f));
}
