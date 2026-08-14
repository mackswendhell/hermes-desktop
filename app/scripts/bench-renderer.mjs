// Mede o caminho de voz dentro do app de verdade, pelo CDP — o bench-voz.mjs mede os
// serviços, este aqui prova que o renderer se comporta como o modelo dele diz.
//
//   npm run build && npx electron . --remote-debugging-port=9222   (sem ELECTRON_RUN_AS_NODE)
//   node scripts/bench-renderer.mjs [--n 3] [--wav caminho.wav]
//
// O microfone é falso: um WAV vira MediaStream (o --use-file-for-fake-audio-capture do
// Chromium não funciona aqui). O resto é o app: silêncio detectado, STT, Hermes e fala.

import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CACHE = path.join(os.tmpdir(), 'hermes-bench');
const argv = process.argv.slice(2);
const arg = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};
const N = Number(arg('n', '3'));
const WAV = arg('wav', path.join(CACHE, 'media.wav'));
const WEBM = WAV.replace(/\.wav$/, '.webm');

if (!existsSync(WAV)) throw new Error(`amostra ausente: ${WAV} (rode o bench-voz.mjs uma vez para gerá-la)`);

// ---------------------------------------------------------------- CDP mínimo
const alvos = await fetch('http://127.0.0.1:9222/json/list').then((r) => r.json());
const pagina = alvos.find((t) => t.type === 'page' && t.url.endsWith('index.html'));
if (!pagina) throw new Error('overlay não encontrado no 9222 — o app está em modo chat?');

const ws = new WebSocket(pagina.webSocketDebuggerUrl);
await new Promise((r, j) => ((ws.onopen = r), (ws.onerror = j)));
let seq = 0;
const pendentes = new Map();
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pendentes.has(m.id)) pendentes.get(m.id)(m), pendentes.delete(m.id);
};
const enviar = (method, params) =>
  new Promise((r) => {
    const id = ++seq;
    pendentes.set(id, r);
    ws.send(JSON.stringify({ id, method, params }));
  });

async function avaliar(expressao) {
  const m = await enviar('Runtime.evaluate', {
    expression: `(async () => { ${expressao} })()`,
    awaitPromise: true,
    returnByValue: true,
  });
  const det = m.result?.exceptionDetails;
  if (det) throw new Error(det.exception?.description ?? JSON.stringify(det));
  return m.result.result.value;
}

const b64 = (p) => readFileSync(p).toString('base64');

// Janela escondida throttla os timers do renderer e trava a detecção de silêncio — durante
// a medição o recolhimento por ocioso fica desligado (restaurado no fim).
const idleOriginal = await avaliar(`return (await window.hermes.getSettings()).idleUnloadMin;`);
await avaliar(`await window.hermes.saveSettings({ idleUnloadMin: 0 }); return 1;`);
const restaurar = async () => {
  await avaliar(`await window.hermes.saveSettings({ idleUnloadMin: ${idleOriginal} }); return 1;`).catch(() => {});
};
process.on('exit', () => {});

// ---------------------------------------------------------------- instrumentação
await avaliar(`
  const bin = Uint8Array.from(atob(${JSON.stringify(b64(WAV))}), (c) => c.charCodeAt(0));
  const ac = new AudioContext();
  window.__bench = { fala: await ac.decodeAudioData(bin.buffer), ac, t: {}, trechos: [], marca(k) { this.t[k] ??= performance.now(); } };

  // microfone falso: o WAV vira um MediaStream, e o fim do buffer é o "fim da fala"
  navigator.mediaDevices.getUserMedia = async () => {
    const dest = ac.createMediaStreamDestination();
    const src = ac.createBufferSource();
    src.buffer = window.__bench.fala;
    src.__microfone = true; // não confundir a própria fonte do microfone com a fala do app
    src.connect(dest);
    src.onended = () => window.__bench.marca('fimFala');
    src.start();
    window.__bench.marca('inicioFala');
    return dest.stream;
  };

  // primeiro som que entra na linha do tempo, e quanto do texto já existia nesse instante.
  // idempotente: rodar o bench duas vezes na mesma página empilharia patches, e o antigo venceria
  const start0 = AudioBufferSourceNode.prototype.__benchOriginal ?? AudioBufferSourceNode.prototype.start;
  AudioBufferSourceNode.prototype.__benchOriginal = start0;
  AudioBufferSourceNode.prototype.start = function (...a) {
    // ignora o microfone falso e o OfflineAudioContext do blobToWav16k (conversão, não fala)
    const off = this.context instanceof OfflineAudioContext;
    if (this.buffer && !this.__microfone && !off) {
      if (!window.__bench.t.primeiroAudio) {
        window.__bench.marca('primeiroAudio');
        window.__bench.textoNoAudio = (document.getElementById('speech-text')?.textContent ?? '').length;
        window.__bench.estadoNoAudio = (document.getElementById('stage').className.match(/state-(\\w+)/)?.[1] ?? 'idle');
      }
      // linha do tempo da fala: início agendado e duração de cada trecho, para achar buracos
      window.__bench.trechos.push({ em: a[0] ?? this.context.currentTime, dur: this.buffer.duration });
    }
    return start0.apply(this, a);
  };
  return 'ok';
`);

// custo real do blobToWav16k (webm → WAV 16 kHz), que é o preço do STT acelerado
const conv = await avaliar(`
  const bin = Uint8Array.from(atob(${JSON.stringify(b64(existsSync(WEBM) ? WEBM : WAV))}), (c) => c.charCodeAt(0));
  const medidas = [];
  for (let i = 0; i < 5; i++) {
    const t0 = performance.now();
    const dec = await window.__bench.ac.decodeAudioData(bin.buffer.slice(0));
    const off = new OfflineAudioContext(1, Math.ceil(dec.duration * 16000), 16000);
    const src = off.createBufferSource();
    src.buffer = dec; src.connect(off.destination); src.start();
    const r = await off.startRendering();
    r.getChannelData(0);
    medidas.push(performance.now() - t0);
  }
  return medidas;
`);
console.log(`blobToWav16k: ${conv.map((m) => m.toFixed(0)).join(', ')} ms`);

// ---------------------------------------------------------------- turnos
const linhas = [];
for (let i = 0; i < N; i++) {
  // setWide(true) desarma o recolhimento por ocioso: janela escondida trava os timers do
  // renderer (throttling), e aí nem o silêncio nem o limite de 30 s de gravação disparam
  await avaliar(`
    window.hermes.setWide(true);
    window.__bench.t = {}; window.__bench.trechos = []; window.__bench.textoNoAudio = 0; window.__bench.estadoNoAudio = '';
    return 1;
  `);
  const estado = await avaliar(`return document.getElementById('stage').className.match(/state-(\\w+)/)?.[1] ?? 'idle';`);
  if (estado !== 'idle') {
    console.error(`execução ${i + 1}: personagem em "${estado}", esperando`);
    await new Promise((r) => setTimeout(r, 5000));
  }
  // clique no personagem = push-to-talk
  await avaliar(`
    const stage = document.getElementById('stage');
    stage.dispatchEvent(new MouseEvent('mousedown', { button: 0, bubbles: true }));
    window.dispatchEvent(new MouseEvent('mouseup', { button: 0, bubbles: true }));
    return 1;
  `);

  // a espera é daqui de fora: dentro da página um setTimeout pode estar throttlado
  const ler = () =>
    avaliar(`return { ...window.__bench.t, textoNoAudio: window.__bench.textoNoAudio,
             estadoNoAudio: window.__bench.estadoNoAudio,
             estado: document.getElementById('stage').className.match(/state-(\\w+)/)?.[1] ?? 'idle',
             trechos: window.__bench.trechos,
             textoFinal: (document.getElementById('speech-text')?.textContent ?? '').length };`);
  let t = {};
  for (let k = 0; k < 240; k++) {
    t = await ler();
    if (t.primeiroAudio && t.estado !== 'speaking' && t.estado !== 'thinking') break;
    await new Promise((r) => setTimeout(r, 500));
  }
  if (!t.primeiroAudio) {
    console.error(`execução ${i + 1}: nenhum áudio saiu`, t);
    continue;
  }
  const e5 = t.primeiroAudio - t.fimFala;
  // buraco = trecho que começa depois do fim do anterior; acima de ~20 ms se ouve
  const tr = (t.trechos ?? []).slice().sort((x, y) => x.em - y.em);
  const vaos = tr.slice(1).map((s, k) => (s.em - (tr[k].em + tr[k].dur)) * 1000).filter((v) => v > 20);
  const audio = tr.reduce((s, x) => s + x.dur, 0);
  linhas.push({ e5, textoNoAudio: t.textoNoAudio, textoFinal: t.textoFinal, trechos: tr.length, vaos, audio });
  console.log(
    `execução ${i + 1}: 1º áudio = ${Math.round(e5)} ms | texto ${t.textoNoAudio}/${t.textoFinal} | ` +
      `${tr.length} trechos, ${audio.toFixed(1)}s de fala | ` +
      (vaos.length ? `BURACOS: ${vaos.map((v) => Math.round(v) + 'ms').join(', ')}` : 'sem buraco'),
  );
  await new Promise((r) => setTimeout(r, 3000));
}

if (linhas.length) {
  const ord = linhas.map((l) => l.e5).sort((a, b) => a - b);
  console.log(`\np50 fim da fala → 1º áudio: ${Math.round(ord[Math.floor(ord.length / 2)])} ms (${linhas.length} execuções)`);
  const cedo = linhas.filter((l) => l.textoNoAudio < l.textoFinal).length;
  console.log(`fala começou antes da resposta terminar em ${cedo}/${linhas.length} execuções`);
  const comBuraco = linhas.filter((l) => l.vaos.length);
  const todos = linhas.flatMap((l) => l.vaos);
  console.log(
    `continuidade: ${comBuraco.length}/${linhas.length} execuções com buraco` +
      (todos.length ? ` — ${todos.length} no total, pior ${Math.round(Math.max(...todos))} ms` : ''),
  );
}
await restaurar();
ws.close();
