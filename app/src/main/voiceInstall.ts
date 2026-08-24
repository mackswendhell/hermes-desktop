import { app } from 'electron';
import { spawn } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, rmSync, copyFileSync, chmodSync } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { log } from './logger';
import { isWin } from './platform';

/**
 * Instala o voice-server na pasta de dados do usuário. Os 12 KB de código vêm
 * embutidos no app; o peso (~1,2 GB) é a venv, montada aqui na máquina dele.
 * Python só é baixado se não houver um 3.10+ no sistema — standalone, dentro da
 * própria pasta, para não mexer no PATH nem pedir admin.
 */

// python-build-standalone: versão fixa. Bump manual — uma URL que envelhece é
// mais previsível que resolver a release mais nova a cada download.
// 3.11 é a versão em que a pilha de voz (coqui-tts + torch) é sabidamente boa;
// 3.13+ ainda não tem wheels para tudo. Daí o teto no aceite abaixo.
const PY = '3.11.11';
const PY_TAG = '20241219';
const PY_BUILD: Record<string, string> = {
  'darwin-arm64': 'aarch64-apple-darwin-install_only',
  'darwin-x64': 'x86_64-apple-darwin-install_only',
  'win32-x64': 'x86_64-pc-windows-msvc-install_only',
  'linux-x64': 'x86_64-unknown-linux-gnu-install_only',
};

export function voiceInstallDir(): string {
  return path.join(app.getPath('userData'), 'voice-server');
}

const venvPython = (dir: string) =>
  isWin ? path.join(dir, '.venv', 'Scripts', 'python.exe') : path.join(dir, '.venv', 'bin', 'python');

type Progress = (etapa: string, detalhe?: string) => void;

function run(cmd: string, args: string[], cwd: string, onLine: (l: string) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd, env: { ...process.env, PIP_DISABLE_PIP_VERSION_CHECK: '1' } });
    const feed = (b: Buffer) => b.toString().split('\n').filter(Boolean).forEach(onLine);
    p.stdout.on('data', feed);
    p.stderr.on('data', feed);
    p.on('error', reject);
    p.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`${path.basename(cmd)} saiu com código ${code}`)),
    );
  });
}

/** primeiro python3 do sistema entre 3.10 e 3.12 */
async function systemPython(): Promise<string | null> {
  for (const cmd of isWin ? ['py', 'python'] : ['python3', 'python']) {
    try {
      const out = await new Promise<string>((resolve, reject) => {
        const p = spawn(cmd, ['-c', 'import sys;print("%d.%d"%sys.version_info[:2])']);
        let s = '';
        p.stdout.on('data', (b) => (s += b));
        p.on('error', reject);
        p.on('close', () => resolve(s.trim()));
      });
      const [maj, min] = out.split('.').map(Number);
      if (maj === 3 && min >= 10 && min <= 12) return cmd;
    } catch {
      // tenta o próximo
    }
  }
  return null;
}

async function baixarPython(dir: string, prog: Progress): Promise<string> {
  const key = `${process.platform}-${process.arch}`;
  const build = PY_BUILD[key];
  if (!build) throw new Error(`Sem Python standalone para ${key}. Instale o Python 3.10+ manualmente.`);

  const url = `https://github.com/astral-sh/python-build-standalone/releases/download/${PY_TAG}/cpython-${PY}+${PY_TAG}-${build}.tar.gz`;
  const tgz = path.join(dir, 'python.tar.gz');
  prog('Baixando Python', `${PY} (~30 MB)`);

  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`Download do Python falhou (HTTP ${res.status})`);
  await pipeline(Readable.fromWeb(res.body as never), createWriteStream(tgz));

  prog('Extraindo Python');
  // tar existe no macOS, no Linux e no Windows 10+ (bsdtar em System32)
  await run('tar', ['-xzf', tgz, '-C', dir], dir, (l) => log(`[voice-install] ${l}`));
  rmSync(tgz, { force: true });

  const py = isWin ? path.join(dir, 'python', 'python.exe') : path.join(dir, 'python', 'bin', 'python3');
  if (!existsSync(py)) throw new Error('Python extraído, mas o executável não apareceu onde era esperado');
  if (!isWin) chmodSync(py, 0o755);
  return py;
}

export async function instalarVoiceServer(prog: Progress): Promise<string> {
  const dir = voiceInstallDir();
  // venv pela metade é pior que nenhuma: recomeça limpo
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });

  try {
    prog('Procurando Python');
    const python = (await systemPython()) ?? (await baixarPython(dir, prog));
    prog('Copiando arquivos');
    const origem = path.join(__dirname, 'voice-server');
    for (const f of ['server.py', 'requirements.txt']) {
      const src = path.join(origem, f);
      if (!existsSync(src)) throw new Error(`Asset ausente no app: ${f}`);
      copyFileSync(src, path.join(dir, f));
    }

    prog('Criando ambiente');
    await run(python, ['-m', 'venv', '.venv'], dir, (l) => log(`[voice-install] ${l}`));

    prog('Instalando dependências', 'pode levar alguns minutos (~1,2 GB)');
    await run(
      venvPython(dir),
      ['-m', 'pip', 'install', '-r', 'requirements.txt'],
      dir,
      (l) => prog('Instalando dependências', l.slice(0, 160)),
    );

    if (!existsSync(venvPython(dir))) throw new Error('A venv não foi criada');
    prog('Pronto', dir);
    log(`[voice-install] concluído em ${dir}`);
    return dir;
  } catch (e) {
    rmSync(dir, { recursive: true, force: true });
    throw e;
  }
}
