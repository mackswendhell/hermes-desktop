// Benchmark do caminho de voz: mede as 5 etapas da resposta falada, com p50/p95.
//
//   node scripts/bench-voz.mjs --modo local,nuvem,leve --estado quente,frio --n 10 --pipeline antes|depois
//
// Etapas (as do pedido):
//   1 fim da fala → transcrição   = espera de silêncio + STT
//   2 transcrição → 1º token      = TTFT do Hermes (VPS, fora do controle do app)
//   3 1º token → resposta completa
//   4 resposta → 1º áudio         = síntese do primeiro trecho (0 quando ela já terminou antes)
//   5 fim da fala → 1º áudio      = soma das anteriores
//
// O que é medido de verdade: STT (voice-server/Groq/whisper.cpp), Hermes pelo túnel e
// TTS (XTTS/Edge/voz do sistema). O que é constante declarada: a espera de silêncio do
// MediaRecorder (SILENCE_STOP_MS) e a decodificação do WAV no renderer, medidas à parte.
//
// --pipeline antes  = v0.3.3: STT pelo voice-server, sem aquecimento antecipado
// --pipeline depois = atual: STT acelerado (whisper.cpp) e /warmup em estágios
//
// Segredos (token da ponte, chave Groq) saem do settings.json e nunca são impressos.

import { build } from 'esbuild';
import { execFile, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = path.join(os.tmpdir(), 'hermes-bench');
const VOICE_URL = 'http://127.0.0.1:8756';

// espera de silêncio antes de parar de gravar (renderer/conversation.ts)
const SILENCE_STOP_MS = 1400;

// ---------------------------------------------------------------- argumentos
const argv = process.argv.slice(2);
const arg = (nome, padrao) => {
  const i = argv.indexOf(`--${nome}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : padrao;
};
const MODOS = arg('modo', 'local,nuvem,leve').split(',');
const ESTADOS = arg('estado', 'quente,frio').split(',');
const N = Number(arg('n', '10'));
const PIPELINE = arg('pipeline', 'antes');
const SAIDA = arg('out', path.join(CACHE, `bench-${PIPELINE}-${Date.now()}.json`));

// ---------------------------------------------------------------- utilidades
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pct = (xs, p) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};
const ms = (v) => (v === null || v === undefined ? '—' : `${Math.round(v)}`);

function settings() {
  const p = path.join(
    os.homedir(),
    process.platform === 'darwin'
      ? 'Library/Application Support/hermes-assistente/settings.json'
      : 'AppData/Roaming/hermes-assistente/settings.json',
  );
  return JSON.parse(readFileSync(p, 'utf8').replace(/^﻿/, ''));
}

// ------------------------------------------------- código real do app, via esbuild
// mesmo esquema do check-markdown/check-split: compila o módulo e importa o resultado.
async function moduloDoApp(entrada, saida, plugins) {
  // fora do dist/: o electron-builder empacota tudo que estiver lá dentro do .asar
  const out = path.join(CACHE, saida);
  mkdirSync(path.dirname(out), { recursive: true });
  await build({ entryPoints: [entrada], bundle: true, format: 'esm', platform: 'node', outfile: out, plugins, logLevel: 'silent' });
  return import(pathToFileURL(out).href + `?t=${Date.now()}`);
}

const stub = (nome, filtro, conteudo) => ({
  name: `stub-${nome}`,
  setup(b) {
    b.onResolve({ filter: filtro }, (a) => ({ path: a.path, namespace: `s-${nome}` }));
    b.onLoad({ filter: /.*/, namespace: `s-${nome}` }, () => ({ contents: conteudo, loader: 'js' }));
  },
});

const { askHermes } = await moduloDoApp(
  path.join(root, 'src/main/hermes.ts'),
  '_bench-hermes.mjs',
  [stub('electron', /^electron$/, 'export const app = { getPath: () => "/tmp", getVersion: () => "0" };')],
);
const { splitSentences } = await moduloDoApp(
  path.join(root, 'src/renderer/tts.ts'),
  '_bench-tts.mjs',
  [stub('audio', /\.\/audio$/, 'export const ctx = () => { throw new Error("sem AudioContext no bench"); };')],
);

// ---------------------------------------------------------------- amostras de fala
const FRASES = {
  curta: 'Que horas são agora?',
  media: 'Me lembra o que a gente combinou de fazer amanhã de manhã antes da reunião.',
  longa:
    'Preciso que você me explique rapidamente qual a diferença entre memória de curto prazo e ' +
    'memória de longo prazo num assistente, e como isso muda o jeito que eu deveria organizar ' +
    'as minhas anotações do dia a dia.',
};

async function amostras() {
  mkdirSync(CACHE, { recursive: true });
  const saida = {};
  for (const [nome, texto] of Object.entries(FRASES)) {
    const webm = path.join(CACHE, `${nome}.webm`);
    const wav = path.join(CACHE, `${nome}.wav`);
    if (!existsSync(webm) || !existsSync(wav)) {
      const aiff = path.join(CACHE, `${nome}.aiff`);
      await execFileP('say', ['-v', 'Luciana', '-o', aiff, texto]);
      await execFileP('ffmpeg', ['-loglevel', 'error', '-y', '-i', aiff, '-c:a', 'libopus', '-b:a', '32k', '-ar', '48000', '-ac', '1', webm]);
      await execFileP('ffmpeg', ['-loglevel', 'error', '-y', '-i', aiff, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', wav]);
    }
    const dur = await execFileP('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', webm]);
    saida[nome] = {
      webm: readFileSync(webm),
      wav: readFileSync(wav),
      wavPath: wav,
      texto,
      duracaoMs: Math.round(Number(dur.stdout.trim()) * 1000),
    };
  }
  return saida;
}

// ---------------------------------------------------------------- STT por modo
async function sttVoiceServer(webm) {
  const fd = new FormData();
  fd.append('audio', new Blob([webm]), 'fala.webm');
  const r = await fetch(`${VOICE_URL}/stt`, { method: 'POST', body: fd });
  if (!r.ok) throw new Error(`STT ${r.status}`);
  return (await r.json()).text;
}

// no pipeline novo o motor local usa o whisper.cpp (GPU no Mac) com o mesmo porte de
// modelo; CONV_WAV_MS é o custo do blobToWav16k no renderer, medido pelo check-renderer
const CONV_WAV_MS = Number(arg('conv-wav', '0'));

async function sttLocal(amostra) {
  if (PIPELINE !== 'depois') return sttVoiceServer(amostra.webm);
  await new Promise((r) => setTimeout(r, CONV_WAV_MS));
  return sttWhisperCpp(amostra.wavPath, MODELO_MEDIO);
}

async function sttGroq(webm, cfg, frio) {
  const fd = new FormData();
  fd.append('file', new Blob([webm]), 'fala.webm');
  fd.append('model', 'whisper-large-v3-turbo');
  fd.append('language', 'pt');
  const r = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
    method: 'POST',
    // frio = conexão nova (TLS do zero), como no primeiro pedido depois de um tempo parado
    headers: { Authorization: `Bearer ${cfg.groqApiKey}`, ...(frio ? { connection: 'close' } : {}) },
    body: fd,
  });
  if (!r.ok) throw new Error(`Groq ${r.status}`);
  return (await r.json()).text;
}

const WHISPER_CLI = ['/opt/homebrew/bin/whisper-cli', '/usr/local/bin/whisper-cli'].find((p) => existsSync(p));
const MODELO_LEVE = path.join(CACHE, 'ggml-small-q5_1.bin');
const MODELO_MEDIO = path.join(CACHE, 'ggml-medium-q5_0.bin');

async function baixarModelo(destino) {
  if (existsSync(destino) && statSync(destino).size > 1e6) return;
  const url = `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${path.basename(destino)}`;
  process.stderr.write(`baixando ${path.basename(destino)}…\n`);
  const r = await fetch(url, { redirect: 'follow' });
  writeFileSync(destino, Buffer.from(await r.arrayBuffer()));
}

function sttWhisperCpp(wavPath, modelo) {
  return new Promise((resolve, reject) => {
    const p = spawn(WHISPER_CLI, ['-m', modelo, '-f', wavPath, '-l', 'pt', '-nt', '-np']);
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('error', reject);
    p.on('exit', (c) => (c === 0 ? resolve(out.replace(/\s+/g, ' ').trim()) : reject(new Error(err.slice(-160)))));
  });
}

// ---------------------------------------------------------------- TTS por modo
// o renderer só toca com o AudioBuffer inteiro na mão, nos dois pipelines
async function ttsLocal(texto, cfg) {
  const r = await fetch(`${VOICE_URL}/tts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: texto, speaker: cfg.ttsSpeaker || undefined }),
  });
  if (!r.ok) throw new Error(`TTS ${r.status}`);
  return { resto: r.arrayBuffer() };
}

let edgeMod = null;
let edgeReuso = null;
async function ttsEdge(texto, cfg) {
  edgeMod ??= await import('msedge-tts');
  const { MsEdgeTTS, OUTPUT_FORMAT } = edgeMod;
  // depois = versão atual, que mantém uma conexão só (v0.3.3 abria um websocket por trecho)
  let tts = PIPELINE === 'depois' ? edgeReuso : null;
  if (!tts) {
    tts = new MsEdgeTTS();
    await tts.setMetadata(cfg.edgeVoice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
    if (PIPELINE === 'depois') edgeReuso = tts;
  }
  try {
    const safe = texto.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const { audioStream } = tts.toStream(safe);
    let bytes = 0;
    for await (const c of audioStream) bytes += c.length;
    if (!bytes) throw new Error('Edge sem áudio');
    return { resto: Promise.resolve() };
  } finally {
    if (tts !== edgeReuso) tts.close();
  }
}

async function ttsSistema(texto) {
  // proxy do speechSynthesis: síntese do trecho pela mesma voz do sistema
  const out = path.join(CACHE, 'say.aiff');
  await execFileP('say', ['-v', 'Luciana', '-o', out, texto.replace(/[*_#`]/g, '')]);
  return { resto: Promise.resolve() };
}

// ---------------------------------------------------------------- pipeline
const MODO = {
  local: { stt: (a) => sttLocal(a), tts: ttsLocal, nome: 'local (faster-whisper + XTTS)' },
  nuvem: { stt: (a, c, frio) => sttGroq(a.webm, c, frio), tts: ttsEdge, nome: 'nuvem (Groq + Edge TTS)' },
  leve: { stt: (a) => sttWhisperCpp(a.wavPath, MODELO_LEVE), tts: ttsSistema, nome: 'leve (whisper.cpp + voz do sistema)' },
};

/** Um turno completo. Devolve as 5 etapas em ms. */
async function turno({ modo, amostra, cfg, sessao, pipeline, frio }) {
  const m = MODO[modo];
  // O app novo manda carregar o modelo de audição quando começa a gravar; o tempo de
  // cobertura é a fala inteira mais a espera de silêncio, que é o que o sleep representa.
  if (pipeline === 'depois' && modo === 'local') {
    // com o STT acelerado o whisper do voice-server não é usado, então não se aquece
    await sleep(amostra.duracaoMs + SILENCE_STOP_MS);
  }
  const t0 = performance.now();
  const texto = await m.stt(amostra, cfg, frio);
  const tStt = performance.now();
  if (!texto?.trim()) throw new Error('transcrição vazia');
  // e o de fala quando a pergunta sai para o Hermes: a carga corre junto com o modelo pensando
  if (pipeline === 'depois' && modo === 'local') {
    fetch(`${VOICE_URL}/warmup?what=tts`, { method: 'POST' }).catch(() => {});
  }

  let tPrimeiroToken = 0;
  let cheio = '';
  let tAudio = 0;
  let primeiroTrecho = '';

  const onDelta = (d) => {
    if (!tPrimeiroToken) tPrimeiroToken = performance.now();
    cheio += d;
  };

  const resposta = await askHermes(texto, cfg, onDelta, { sessionId: sessao.id, onSessionId: (id) => (sessao.id = id) });
  const tCompleto = performance.now();

  primeiroTrecho = splitSentences(resposta)[0];
  const { resto } = await m.tts(primeiroTrecho, cfg).then((r) => ((tAudio = performance.now()), r));

  await resto; // não deixa a síntese de um turno atravessar o próximo
  const e1 = SILENCE_STOP_MS + (tStt - t0);
  const e2 = tPrimeiroToken - tStt;
  const e3 = tCompleto - tPrimeiroToken;
  const e4 = Math.max(0, tAudio - tCompleto);
  return {
    e1, e2, e3, e4,
    e5: SILENCE_STOP_MS + (tAudio - t0),
    chars: resposta.length,
    trecho: primeiroTrecho.length,
    texto,
  };
}

// ---------------------------------------------------------------- frio/quente
// --voice-self: o bench sobe e derruba o voice-server. Sem isso quem respawna é o app, e
// o /warmup que ele dispara no arranque adianta a carga dos modelos e falseia o cenário frio.
const VOICE_SELF = argv.includes('--voice-self');
let voiceProc = null;

async function voiceUp(timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const ok = await fetch(`${VOICE_URL}/health`, { signal: AbortSignal.timeout(1500) })
      .then((r) => r.ok)
      .catch(() => false);
    if (ok) return true;
    await sleep(500);
  }
  return false;
}

async function subirVoiceServer() {
  const dir = path.join(path.dirname(root), 'voice-server');
  voiceProc = spawn(path.join(dir, '.venv/bin/python'), [path.join(dir, 'server.py')], {
    cwd: dir,
    stdio: 'ignore',
    // hibernação desligada: quem decide quando esfria é o bench
    env: { ...process.env, IDLE_UNLOAD_S: '0' },
  });
  if (!(await voiceUp(60_000))) throw new Error('voice-server próprio não subiu');
}

async function esfriar(modo) {
  if (modo !== 'local') return; // nuvem/leve já nascem frios a cada chamada
  if (VOICE_SELF) {
    voiceProc?.kill();
    voiceProc = null;
    await sleep(500);
    await subirVoiceServer();
    return;
  }
  const alvo = (await execFileP('pgrep', ['-f', 'voice-server/server.py']).catch(() => ({ stdout: '' }))).stdout.trim();
  if (alvo) await execFileP('kill', alvo.split('\n')).catch(() => {});
  if (!(await voiceUp(60_000))) throw new Error('voice-server não voltou');
}

async function aquecer(modo, amostra, cfg) {
  if (modo === 'local') {
    await fetch(`${VOICE_URL}/warmup`, { method: 'POST', signal: AbortSignal.timeout(300_000) }).catch(() => {});
    await MODO.local.tts('Pronto.', cfg).catch(() => {});
  }
  if (modo === 'nuvem') await MODO.nuvem.tts('Pronto.', cfg).catch(() => {});
  if (modo === 'leve') await MODO.leve.stt(amostra, cfg).catch(() => {});
}

// ---------------------------------------------------------------- execução
const cfg = settings();
if (!cfg.bridgeToken) throw new Error('settings.json sem bridgeToken — o Hermes é obrigatório no bench');
const amostrasPorNome = await amostras();
const nomes = Object.keys(FRASES);
if (MODOS.includes('leve')) {
  if (!WHISPER_CLI) throw new Error('modo leve exige whisper-cli (brew install whisper-cpp)');
  await baixarModelo(MODELO_LEVE);
}
if (MODOS.includes('local') && PIPELINE === 'depois') {
  if (!WHISPER_CLI) throw new Error('o STT acelerado exige whisper-cli (brew install whisper-cpp)');
  await baixarModelo(MODELO_MEDIO);
}

if (VOICE_SELF && MODOS.includes('local')) await subirVoiceServer();

const resultados = [];
for (const modo of MODOS) {
  for (const estado of ESTADOS) {
    const linhas = [];
    for (let i = 0; i < N; i++) {
      const amostra = amostrasPorNome[nomes[i % nomes.length]];
      const sessao = { id: undefined }; // sessão dedicada do bench, criada na 1ª chamada
      try {
        if (estado === 'frio') await esfriar(modo);
        else if (i === 0) await aquecer(modo, amostra, cfg);
        const r = await turno({ modo, amostra, cfg, sessao, pipeline: PIPELINE, frio: estado === 'frio' });
        linhas.push(r);
        process.stderr.write(
          `[${modo}/${estado}/${PIPELINE}] ${i + 1}/${N} e1=${ms(r.e1)} e2=${ms(r.e2)} e3=${ms(r.e3)} e4=${ms(r.e4)} e5=${ms(r.e5)}\n`,
        );
      } catch (e) {
        process.stderr.write(`[${modo}/${estado}] execução ${i + 1} falhou: ${e.message}\n`);
      }
    }
    if (linhas.length) {
      // eApp = o que o app controla (silêncio + STT + 1º áudio); tira o ruído do agente na VPS
      for (const l of linhas) l.eApp = l.e1 + l.e4;
      const et = (k) => ({ p50: pct(linhas.map((l) => l[k]), 50), p95: pct(linhas.map((l) => l[k]), 95) });
      resultados.push({
        modo, estado, pipeline: PIPELINE, execucoes: linhas.length,
        e1: et('e1'), e2: et('e2'), e3: et('e3'), e4: et('e4'), e5: et('e5'), eApp: et('eApp'),
        linhas,
      });
    }
  }
}

voiceProc?.kill();
writeFileSync(SAIDA, JSON.stringify({ pipeline: PIPELINE, silenceStopMs: SILENCE_STOP_MS, convWavMs: CONV_WAV_MS, voiceSelf: VOICE_SELF, quando: new Date().toISOString(), resultados }, null, 2));

console.log(`\n### pipeline ${PIPELINE} — p50/p95 em ms (${N} execuções por cenário)\n`);
console.log('| modo | estado | n | 1 fala→transcr. | 2 transcr.→1º tok | 3 1º tok→completa | 4 resp.→1º áudio | 5 fala→1º áudio | app (1+4) |');
console.log('|---|---|---|---|---|---|---|---|');
for (const r of resultados) {
  const c = (e) => `${ms(e.p50)} / ${ms(e.p95)}`;
  console.log(`| ${r.modo} | ${r.estado} | ${r.execucoes} | ${c(r.e1)} | ${c(r.e2)} | ${c(r.e3)} | ${c(r.e4)} | **${c(r.e5)}** | ${c(r.eApp)} |`);
}
console.log(`\njson: ${SAIDA}`);
