import { spawn, ChildProcess } from 'node:child_process';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { log } from './logger';

const VOICE_URL = 'http://127.0.0.1:8756';

let proc: ChildProcess | null = null;
let configuredDir = '';
let configuredIdleMin = 10;
let stopping = false;
let restartDelay = 3000;

export function setVoiceServerDir(dir: string): void {
  configuredDir = dir;
}

export function setVoiceIdleMinutes(min: number): void {
  configuredIdleMin = min;
}

function voiceServerDir(): string {
  return configuredDir || path.resolve(__dirname, '..', '..', 'voice-server');
}

export function hasVoiceServerVenv(): boolean {
  return existsSync(path.join(voiceServerDir(), '.venv', 'Scripts', 'python.exe'));
}

export async function isVoiceServerUp(): Promise<boolean> {
  try {
    const res = await fetch(`${VOICE_URL}/health`, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

export async function startVoiceServer(): Promise<void> {
  stopping = false;
  if (proc || (await isVoiceServerUp())) return;

  const dir = voiceServerDir();
  const python = path.join(dir, '.venv', 'Scripts', 'python.exe');
  if (!existsSync(python)) {
    log(`[voice] venv não encontrado em ${python}`);
    return;
  }

  proc = spawn(python, [path.join(dir, 'server.py')], {
    cwd: dir,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, IDLE_UNLOAD_S: String(configuredIdleMin * 60) },
  });
  proc.stdout?.on('data', (d) => log(`[voice] ${d}`.trimEnd()));
  proc.stderr?.on('data', (d) => log(`[voice] ${d}`.trimEnd()));
  proc.on('error', (err) => log(`[voice] erro ao iniciar python: ${err.message}`));
  proc.on('exit', (code) => {
    proc = null;
    if (stopping) return;
    log(`[voice] servidor caiu (código ${code}), reiniciando em ${restartDelay / 1000}s`);
    setTimeout(() => {
      if (!stopping) {
        startVoiceServer();
        restartDelay = Math.min(restartDelay * 2, 60_000);
      }
    }, restartDelay);
  });
  proc.on('spawn', () => {
    restartDelay = 3000;
  });

  // aquece os modelos em background sem bloquear a inicialização
  waitUntilUp(120_000).then((up) => {
    if (up) fetch(`${VOICE_URL}/warmup`, { method: 'POST' }).catch(() => undefined);
  });
}

async function waitUntilUp(timeoutMs: number): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (await isVoiceServerUp()) return true;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

export function stopVoiceServer(): void {
  stopping = true;
  if (proc && !proc.killed) proc.kill();
  proc = null;
}
