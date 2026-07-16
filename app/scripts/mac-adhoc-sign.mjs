import { execFileSync } from 'node:child_process';
import path from 'node:path';

// assinatura ad-hoc (sem conta Apple): sem ela o macOS não persiste as permissões
// de TCC (microfone) e o diálogo de permissão entra em loop
export default async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  // no build universal, o afterPack roda também nos packs temporários por arquitetura;
  // assiná-los quebra o merge (SHAs divergem) — só o app final recebe assinatura
  if (context.appOutDir.endsWith('-temp')) return;
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' });
}
