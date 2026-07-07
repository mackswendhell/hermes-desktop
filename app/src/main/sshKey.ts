import { execFile } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const SSH_KEYGEN = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'OpenSSH', 'ssh-keygen.exe');

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
  const authorizeCommand =
    `mkdir -p ~/.ssh && chmod 700 ~/.ssh && echo '${publicKey}' >> ~/.ssh/authorized_keys ` +
    `&& chmod 600 ~/.ssh/authorized_keys && echo CHAVE-AUTORIZADA`;
  return { publicKey, authorizeCommand };
}
