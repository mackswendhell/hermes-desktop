import { app } from 'electron';
import { spawn, execFile } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, readdirSync, writeFileSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { log } from './logger';
import { isWin, TAR_EXE } from './platform';

// STT leve: whisper.cpp em CPU — no Windows baixado uma única vez para %APPDATA%;
// no macOS/Linux usa o whisper-cli instalado (ex.: brew install whisper-cpp)
const WHISPER_ZIP_URL =
  'https://github.com/ggml-org/whisper.cpp/releases/download/v1.9.1/whisper-bin-x64.zip';
const MODEL_BASE = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/';

// 'leve' = o modelo pequeno do motor de voz leve. 'medio' = o mesmo porte de modelo que o
// voice-server usa (medium), para o STT acelerado por Metal no Mac não perder qualidade.
const MODELOS = {
  leve: 'ggml-small-q5_1.bin',
  medio: 'ggml-medium-q5_0.bin',
} as const;
export type ModeloWhisper = keyof typeof MODELOS;

function whisperDir(): string {
  return path.join(app.getPath('userData'), 'whisper');
}

function modelPath(modelo: ModeloWhisper = 'leve'): string {
  return path.join(whisperDir(), MODELOS[modelo]);
}

// apps GUI no macOS não herdam o PATH do shell — checar os locais conhecidos
const UNIX_CLI_PATHS = [
  '/opt/homebrew/bin/whisper-cli',
  '/usr/local/bin/whisper-cli',
  '/usr/bin/whisper-cli',
];

function findExe(): string | null {
  if (!isWin) return UNIX_CLI_PATHS.find((p) => existsSync(p)) ?? null;
  const dir = whisperDir();
  if (!existsSync(dir)) return null;
  for (const name of ['whisper-cli.exe', 'main.exe']) {
    const hit = readdirSync(dir, { recursive: true })
      .map(String)
      .find((f) => f.toLowerCase().endsWith(name));
    if (hit) return path.join(dir, hit);
  }
  return null;
}

export function whisperReady(modelo: ModeloWhisper = 'leve'): boolean {
  return findExe() !== null && existsSync(modelPath(modelo));
}

/** STT local acelerado: no Apple Silicon o whisper.cpp roda o medium na GPU (Metal) e faz
 *  em ~1/3 do tempo do faster-whisper em CPU. Onde há CUDA o voice-server já é rápido. */
export function fastSttReady(): boolean {
  return process.platform === 'darwin' && whisperReady('medio');
}

// no Windows o binário é baixado sob demanda; fora, depende do whisper-cli instalado
export function whisperAvailable(): boolean {
  return isWin || findExe() !== null;
}

async function download(url: string, dest: string, onProgress: (pct: number) => void): Promise<void> {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`download falhou (${res.status}) para ${url}`);
  const total = Number(res.headers.get('content-length') ?? 0);
  const out = createWriteStream(dest);
  const reader = res.body.getReader();
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.length;
    if (total > 0) onProgress(Math.round((received / total) * 100));
    await new Promise<void>((resolve, reject) =>
      out.write(Buffer.from(value), (err) => (err ? reject(err) : resolve())),
    );
  }
  await new Promise<void>((resolve) => out.end(resolve));
}

const installing = new Map<ModeloWhisper, Promise<void>>();

export function ensureWhisper(
  onProgress: (msg: string) => void,
  modelo: ModeloWhisper = 'leve',
): Promise<void> {
  if (whisperReady(modelo)) return Promise.resolve();
  const emCurso = installing.get(modelo);
  if (emCurso) return emCurso;

  const tarefa = (async () => {
    const dir = whisperDir();
    mkdirSync(dir, { recursive: true });

    if (!findExe()) {
      if (!isWin) throw new Error('voz leve requer o whisper.cpp: brew install whisper-cpp');
      const zip = path.join(dir, 'whisper.zip');
      onProgress('baixando voz leve…');
      await download(WHISPER_ZIP_URL, zip, (p) => onProgress(`baixando voz leve… ${p}%`));
      // tar extrai zip
      await new Promise<void>((resolve, reject) => {
        execFile(TAR_EXE, ['-xf', zip, '-C', dir], (err) => (err ? reject(err) : resolve()));
      });
      unlinkSync(zip);
    }

    if (!existsSync(modelPath(modelo))) {
      onProgress('baixando modelo de audição…');
      await download(MODEL_BASE + MODELOS[modelo], modelPath(modelo), (p) =>
        onProgress(`baixando modelo… ${p}%`),
      );
    }
    onProgress('');
    log(`[whisper] modelo ${modelo} instalado`);
  })().finally(() => installing.delete(modelo));

  installing.set(modelo, tarefa);
  return tarefa;
}

export async function transcribeLocal(wav: Buffer, modelo: ModeloWhisper = 'leve'): Promise<string> {
  const exe = findExe();
  if (!exe || !existsSync(modelPath(modelo))) throw new Error('voz leve ainda não instalada');

  const tmp = path.join(os.tmpdir(), `hermes-stt-${Date.now()}.wav`);
  writeFileSync(tmp, wav);
  try {
    return await new Promise<string>((resolve, reject) => {
      const proc = spawn(exe, ['-m', modelPath(modelo), '-f', tmp, '-l', 'pt', '-nt', '-np'], {
        windowsHide: true,
      });
      let out = '';
      let err = '';
      proc.stdout.on('data', (d) => (out += String(d)));
      proc.stderr.on('data', (d) => (err += String(d)));
      proc.on('error', reject);
      proc.on('exit', (code) => {
        if (code === 0) resolve(out.replace(/\s+/g, ' ').trim());
        else reject(new Error(`whisper saiu com ${code}: ${err.slice(-200)}`));
      });
    });
  } finally {
    try {
      unlinkSync(tmp);
    } catch {
      // temp já removido
    }
  }
}
