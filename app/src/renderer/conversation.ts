import {
  setState,
  getState,
  showBubble,
  hideBubble,
  showSpeech,
  hideSpeech,
  setAmplitude,
  closeHistory,
} from './character';

const VOICE_URL = 'http://127.0.0.1:8756';
const MAX_RECORD_MS = 30_000;
const SILENCE_STOP_MS = 1400;
const SILENCE_RMS = 0.012;

let mediaStream: MediaStream | null = null;
let recorder: MediaRecorder | null = null;
let chunks: Blob[] = [];
let audioCtx: AudioContext | null = null;
let stopTimer: ReturnType<typeof setTimeout> | undefined;
let silenceRaf = 0;

let cancelRequested = false;
let currentSource: AudioBufferSourceNode | null = null;
let currentDelta: ((d: string) => void) | null = null;

window.hermes.onHermesDelta((d) => currentDelta?.(d));

function ctx(): AudioContext {
  if (!audioCtx) audioCtx = new AudioContext();
  return audioCtx;
}

export function isListening(): boolean {
  return getState() === 'listening';
}

// clique durante a fala: cala na hora
export function cancelSpeech(): void {
  cancelRequested = true;
  try {
    currentSource?.stop();
  } catch {
    // já parado
  }
  speechSynthesis.cancel();
  setAmplitude(0);
  setState('idle');
  setTimeout(() => {
    if (getState() === 'idle') hideSpeech();
  }, 4000);
}

export async function startListening(): Promise<void> {
  if (getState() !== 'idle' && getState() !== 'error') return;
  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch {
    setState('error');
    showSpeech('Não consegui acessar o microfone. Confere as permissões do Windows.', 6000);
    setTimeout(() => setState('idle'), 6000);
    return;
  }

  chunks = [];
  recorder = new MediaRecorder(mediaStream, { mimeType: 'audio/webm;codecs=opus' });
  recorder.ondataavailable = (e) => {
    if (e.data.size > 0) chunks.push(e.data);
  };
  recorder.start();
  setState('listening');
  hideBubble();
  closeHistory();
  hideSpeech();

  stopTimer = setTimeout(() => stopListening(), MAX_RECORD_MS);
  watchSilence(mediaStream);
}

function watchSilence(stream: MediaStream): void {
  const source = ctx().createMediaStreamSource(stream);
  const analyser = ctx().createAnalyser();
  analyser.fftSize = 1024;
  source.connect(analyser);
  const buf = new Float32Array(analyser.fftSize);

  let spokeOnce = false;
  let silentSince = performance.now();

  const tick = () => {
    if (getState() !== 'listening') {
      source.disconnect();
      return;
    }
    analyser.getFloatTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
    const rms = Math.sqrt(sum / buf.length);

    if (rms > SILENCE_RMS) {
      spokeOnce = true;
      silentSince = performance.now();
    } else if (spokeOnce && performance.now() - silentSince > SILENCE_STOP_MS) {
      source.disconnect();
      stopListening();
      return;
    }
    silenceRaf = requestAnimationFrame(tick);
  };
  silenceRaf = requestAnimationFrame(tick);
}

export async function stopListening(): Promise<void> {
  if (getState() !== 'listening' || !recorder) return;
  clearTimeout(stopTimer);
  cancelAnimationFrame(silenceRaf);

  const rec = recorder;
  recorder = null;
  const blob = await new Promise<Blob>((resolve) => {
    rec.onstop = () => resolve(new Blob(chunks, { type: 'audio/webm' }));
    rec.stop();
  });
  mediaStream?.getTracks().forEach((t) => t.stop());
  mediaStream = null;

  setState('thinking');
  try {
    await processUtterance(blob);
  } catch (err) {
    handleError(err);
  }
}

export async function sendTyped(text: string): Promise<void> {
  const state = getState();
  if (state !== 'idle' && state !== 'error') return;
  setState('thinking');
  try {
    await respond(text);
  } catch (err) {
    handleError(err);
  }
}

function handleError(err: unknown): void {
  console.error(err);
  setState('error');
  showSpeech(errorMessage(err), 7000);
  setTimeout(() => {
    if (getState() === 'error') setState('idle');
  }, 7000);
}

function errorMessage(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.includes('Failed to fetch')) {
    return 'O servidor de voz local não respondeu. Ele ainda pode estar carregando os modelos — tenta de novo em instantes.';
  }
  return `Deu algo errado: ${msg}`;
}

async function processUtterance(blob: Blob): Promise<void> {
  const settings = await window.hermes.getSettings();
  const text = await transcribe(blob, settings.voiceEngine ?? 'xtts');

  if (!text.trim()) {
    setState('idle');
    showBubble('Não entendi nada — fala de novo?', 4000);
    return;
  }

  await respond(text);
}

async function transcribe(blob: Blob, engine: string): Promise<string> {
  if (engine === 'xtts') {
    const form = new FormData();
    form.append('audio', blob, 'fala.webm');
    const sttRes = await fetch(`${VOICE_URL}/stt`, { method: 'POST', body: form });
    if (!sttRes.ok) throw new Error(`STT falhou (${sttRes.status})`);
    const { text } = (await sttRes.json()) as { text: string };
    return text;
  }
  // voz leve: whisper.cpp local via main process (precisa de WAV 16 kHz mono)
  const wav = await blobToWav16k(blob);
  return window.hermes.sttLocal(wav);
}

async function blobToWav16k(blob: Blob): Promise<ArrayBuffer> {
  const decoded = await ctx().decodeAudioData(await blob.arrayBuffer());
  const rate = 16000;
  const off = new OfflineAudioContext(1, Math.ceil(decoded.duration * rate), rate);
  const src = off.createBufferSource();
  src.buffer = decoded;
  src.connect(off.destination);
  src.start();
  const rendered = await off.startRendering();
  const samples = rendered.getChannelData(0);

  const buf = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buf);
  const writeStr = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i));
  };
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, 'data');
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    view.setInt16(44 + i * 2, Math.max(-1, Math.min(1, samples[i])) * 32767, true);
  }
  return buf;
}

function cleanSentence(s: string): string {
  // o XTTS narra pontos finais literalmente; ?, ! ajudam a entonação e ficam
  return s.replace(/[.…]+$/, '').trim();
}

// o XTTS trunca áudio acima de ~200 caracteres — quebra frases longas na vírgula
const MAX_TTS_CHARS = 180;

function chunkLong(s: string): string[] {
  if (s.length <= MAX_TTS_CHARS) return [s];
  const commas = [...s.matchAll(/,\s/g)].map((m) => m.index!);
  let cut: number;
  if (commas.length) {
    const mid = s.length / 2;
    cut = commas.reduce((a, b) => (Math.abs(b - mid) < Math.abs(a - mid) ? b : a)) + 1;
  } else {
    const space = s.lastIndexOf(' ', MAX_TTS_CHARS);
    cut = space > 40 ? space : MAX_TTS_CHARS;
  }
  return [...chunkLong(s.slice(0, cut).trim()), ...chunkLong(s.slice(cut).trim())];
}

function splitSentences(text: string): string[] {
  const parts = text
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?…])\s+/)
    .map(cleanSentence)
    .filter((s) => s.length > 1);

  // junta pedaços muito curtos com o vizinho para não fragmentar o TTS
  const merged: string[] = [];
  for (const p of parts) {
    if (merged.length > 0 && (p.length < 25 || merged[merged.length - 1].length < 25)) {
      merged[merged.length - 1] += ', ' + p;
    } else {
      merged.push(p);
    }
  }
  return (merged.length ? merged : [text]).flatMap(chunkLong);
}

// o texto vai preenchendo o balão em tempo real, mas a fala começa
// só com a resposta completa (fala contínua, sem pausas entre frases)
async function respond(text: string): Promise<void> {
  showBubble(text, undefined, 'user');
  const settings = await window.hermes.getSettings();
  const speaker = settings.ttsSpeaker || undefined;
  cancelRequested = false;

  let full = '';
  currentDelta = (d) => {
    full += d;
    if (getState() === 'thinking') {
      hideBubble();
      showSpeech(full);
    }
  };

  let reply: string;
  try {
    reply = await window.hermes.askHermes(text);
  } finally {
    currentDelta = null;
  }

  window.hermes.addHistory({ t: new Date().toISOString(), q: text, a: reply });
  showSpeech(reply);
  const silent = await speakOut(reply, settings);

  if (getState() === 'speaking' || getState() === 'thinking') setState('idle');
  const hideMs = silent ? Math.max(8000, reply.length * 60) : 8000;
  setTimeout(() => {
    if (getState() === 'idle') hideSpeech();
  }, hideMs);
}

// escolhe o backend de fala pelo motor configurado; retorna true se ficou em silêncio
async function speakOut(
  text: string,
  settings: { muted: boolean; voiceEngine?: string; ttsSpeaker: string; windowsVoice: string },
): Promise<boolean> {
  const engine = settings.voiceEngine ?? 'xtts';
  if (settings.muted || engine === 'texto') return true;

  setState('speaking');
  if (engine === 'xtts') {
    await playQueue(splitSentences(text), () => true, settings.ttsSpeaker || undefined);
  } else {
    await speakWindows(text, settings.windowsVoice);
  }
  return false;
}

function speakWindows(text: string, voiceName: string): Promise<void> {
  return new Promise((resolve) => {
    const utter = new SpeechSynthesisUtterance(text.replace(/[*_#`]/g, ''));
    const voices = speechSynthesis.getVoices();
    const voice =
      voices.find((v) => v.name === voiceName) ??
      voices.find((v) => v.lang.toLowerCase().startsWith('pt'));
    if (voice) utter.voice = voice;
    utter.lang = 'pt-BR';
    utter.rate = 1.05;

    let raf = 0;
    const t0 = performance.now();
    utter.onstart = () => {
      const tick = () => {
        if (getState() !== 'speaking' || cancelRequested) return;
        const t = performance.now() - t0;
        setAmplitude(0.25 + 0.55 * Math.abs(Math.sin(t / 95)) * (0.6 + 0.4 * Math.random()));
        raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
    };
    const finish = () => {
      cancelAnimationFrame(raf);
      setAmplitude(0);
      resolve();
    };
    utter.onend = finish;
    utter.onerror = finish;
    speechSynthesis.speak(utter);
  });
}

async function playQueue(
  queue: string[],
  ended: () => boolean,
  speaker?: string,
): Promise<void> {
  let ahead: Promise<AudioBuffer | null> | null = null;
  const synth = (s: string) => fetchTtsWav(s, speaker).catch(() => null);

  while (!cancelRequested) {
    let current: Promise<AudioBuffer | null>;
    if (ahead) {
      current = ahead;
      ahead = null;
    } else {
      const s = queue.shift();
      if (s === undefined) {
        if (ended()) break;
        await new Promise((r) => setTimeout(r, 120));
        continue;
      }
      current = synth(s);
    }
    const next = queue.shift();
    if (next !== undefined) ahead = synth(next);

    const buffer = await current;
    if (cancelRequested) break;
    if (buffer) {
      if (getState() === 'thinking') setState('speaking');
      await playBuffer(buffer);
    }
  }
  setAmplitude(0);
}

async function fetchTtsWav(text: string, speaker?: string): Promise<AudioBuffer> {
  const res = await fetch(`${VOICE_URL}/tts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(speaker ? { text, speaker } : { text }),
  });
  if (!res.ok) throw new Error(`TTS falhou (${res.status})`);
  const bytes = await res.arrayBuffer();
  return ctx().decodeAudioData(bytes);
}

function playBuffer(buffer: AudioBuffer): Promise<void> {
  return new Promise((resolve) => {
    const source = ctx().createBufferSource();
    currentSource = source;
    source.buffer = buffer;
    const analyser = ctx().createAnalyser();
    analyser.fftSize = 512;
    source.connect(analyser);
    analyser.connect(ctx().destination);

    const data = new Float32Array(analyser.fftSize);
    const tick = () => {
      analyser.getFloatTimeDomainData(data);
      let sum = 0;
      for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
      const rms = Math.sqrt(sum / data.length);
      setAmplitude(Math.min(1, rms * 7));
      if (getState() === 'speaking') requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);

    source.onended = () => {
      if (currentSource === source) currentSource = null;
      resolve();
    };
    source.start();
  });
}

// mensagens que o Hermes manda por conta própria (outbox na VPS)
const proactiveQueue: string[] = [];
let proactiveTimer: ReturnType<typeof setTimeout> | undefined;

export function deliverProactive(text: string): void {
  proactiveQueue.push(text);
  drainProactive();
}

async function drainProactive(): Promise<void> {
  clearTimeout(proactiveTimer);
  if (getState() !== 'idle') {
    proactiveTimer = setTimeout(drainProactive, 15_000);
    return;
  }
  const text = proactiveQueue.shift();
  if (!text) return;

  const settings = await window.hermes.getSettings();
  window.hermes.addHistory({ t: new Date().toISOString(), q: '', a: text });
  showSpeech(text);
  cancelRequested = false;
  const silent = await speakOut(text, settings);
  if (getState() === 'speaking') setState('idle');
  const hideMs = silent ? Math.max(8000, text.length * 60) : 8000;
  setTimeout(() => {
    if (getState() === 'idle') hideSpeech();
  }, hideMs);
  if (proactiveQueue.length) proactiveTimer = setTimeout(drainProactive, 2000);
}
