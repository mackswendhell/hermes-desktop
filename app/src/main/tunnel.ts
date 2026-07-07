import { spawn, ChildProcess } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { Settings } from './settings';
import { log } from './logger';

const SSH_EXE = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'OpenSSH', 'ssh.exe');

let proc: ChildProcess | null = null;
let stopping = false;
let retryDelay = 2000;

export function startTunnel(settings: Settings): void {
  if (!settings.vpsHost) return;
  stopping = false;
  spawnTunnel(settings);
}

function spawnTunnel(settings: Settings): void {
  const keyPath = path.join(os.homedir(), '.ssh', 'id_ed25519_hermes');
  const localPort = 8642;

  proc = spawn(
    SSH_EXE,
    [
      '-N',
      '-i', keyPath,
      '-o', 'StrictHostKeyChecking=accept-new',
      '-o', 'ServerAliveInterval=30',
      '-o', 'ServerAliveCountMax=3',
      '-o', 'ExitOnForwardFailure=yes',
      '-o', 'ConnectTimeout=10',
      '-o', 'BatchMode=yes',
      '-L', `${localPort}:127.0.0.1:8642`,
      `${settings.vpsUser || 'root'}@${settings.vpsHost}`,
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );
  proc.stderr?.on('data', (d) => log(`[tunnel] ${d}`.trimEnd()));
  proc.on('error', (err) => {
    log(`[tunnel] erro ao iniciar ssh: ${err.message}`);
  });
  proc.on('exit', (code) => {
    proc = null;
    if (stopping) return;
    log(`[tunnel] caiu (código ${code}), reconectando em ${retryDelay / 1000}s`);
    setTimeout(() => {
      if (!stopping) spawnTunnel(settings);
    }, retryDelay);
    retryDelay = Math.min(retryDelay * 2, 60_000);
  });
  proc.on('spawn', () => {
    retryDelay = 2000;
    log(`[tunnel] túnel SSH ativo para ${settings.vpsHost}`);
  });
}

export function stopTunnel(): void {
  stopping = true;
  if (proc && !proc.killed) proc.kill();
  proc = null;
}
