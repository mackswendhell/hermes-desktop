import { spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { Settings } from './settings';
import { log } from './logger';
import { SSH_EXE } from './platform';

const POLL_MS = 60_000;
// o Hermes escreve mensagens aqui (uma por linha) quando quer avisar o desktop
const OUTBOX_CMD =
  'F="$HOME/.hermes/desktop-outbox.jsonl"; if [ -s "$F" ]; then cat "$F"; : > "$F"; fi';

let timer: ReturnType<typeof setInterval> | undefined;

export function startProactive(settings: Settings, onMessage: (text: string) => void): void {
  stopProactive();
  if (!settings.vpsHost) return;

  timer = setInterval(() => {
    const proc = spawn(
      SSH_EXE,
      [
        '-i', path.join(os.homedir(), '.ssh', 'id_ed25519_hermes'),
        '-o', 'BatchMode=yes',
        '-o', 'ConnectTimeout=10',
        '-o', 'StrictHostKeyChecking=accept-new',
        `${settings.vpsUser || 'root'}@${settings.vpsHost}`,
        OUTBOX_CMD,
      ],
      { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true },
    );
    let out = '';
    proc.stdout?.on('data', (d) => (out += String(d)));
    proc.on('error', () => undefined);
    proc.on('exit', () => {
      for (const line of out.split('\n')) {
        const raw = line.trim();
        if (!raw) continue;
        let text = raw;
        try {
          const j = JSON.parse(raw) as { message?: string; text?: string };
          text = j.message ?? j.text ?? raw;
        } catch {
          // linha em texto puro
        }
        log(`[proactive] mensagem do Hermes: ${text.slice(0, 80)}`);
        onMessage(text);
      }
    });
  }, POLL_MS);
}

export function stopProactive(): void {
  if (timer) clearInterval(timer);
  timer = undefined;
}
