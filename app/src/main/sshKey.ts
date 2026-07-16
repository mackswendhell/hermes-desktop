import { execFile } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { SSH_KEYGEN_EXE as SSH_KEYGEN } from './platform';

export function keyPath(): string {
  return path.join(os.homedir(), '.ssh', 'id_ed25519_hermes');
}

export async function ensureSshKey(): Promise<{ publicKey: string; authorizeCommand: string }> {
  const priv = keyPath();
  if (!existsSync(priv)) {
    await new Promise<void>((resolve, reject) => {
      execFile(
        SSH_KEYGEN,
        ['-t', 'ed25519', '-f', priv, '-N', '', '-C', 'assistente-hermes-desktop'],
        (err) => (err ? reject(err) : resolve()),
      );
    });
  }
  const publicKey = readFileSync(`${priv}.pub`, 'utf-8').trim();
  // terminais de navegador corrompem colagens longas; o comando confere a chave
  // gravada pelo fingerprint — se a colagem alterar a chave, o grep não bate e avisa
  const fingerprint = await new Promise<string>((resolve, reject) => {
    execFile(SSH_KEYGEN, ['-lf', `${priv}.pub`], (err, out) => {
      const hash = out?.match(/SHA256:\S+/)?.[0];
      if (err || !hash) reject(err ?? new Error('fingerprint não encontrado'));
      else resolve(hash);
    });
  });
  const authorizeCommand =
    `mkdir -p ~/.ssh && chmod 700 ~/.ssh && echo '${publicKey}' >> ~/.ssh/authorized_keys ` +
    `&& chmod 600 ~/.ssh/authorized_keys && ssh-keygen -lf ~/.ssh/authorized_keys | grep -qF '${fingerprint}' ` +
    `&& echo CHAVE-AUTORIZADA || echo 'ERRO: a chave chegou corrompida — copie e cole o comando de novo'`;
  return { publicKey, authorizeCommand };
}
