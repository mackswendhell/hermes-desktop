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
import type { ChatAttachment, RendererSettings } from './types.d';
import { ctx } from './audio';
import { transcribe } from './stt';
import { speak, stopSpeaking } from './tts';

const MAX_RECORD_MS = 30_000;
const SILENCE_STOP_MS = 1400;
const SILENCE_RMS = 0.012;

let mediaStream: MediaStream | null = null;
let recorder: MediaRecorder | null = null;
let chunks: Blob[] = [];
let stopTimer: ReturnType<typeof setTimeout> | undefined;
let silenceRaf = 0;

let cancelRequested = false;
let currentDelta: ((d: string) => void) | null = null;

window.hermes.onHermesDelta((_reqId, d) => currentDelta?.(d));

export function isListening(): boolean {
  return getState() === 'listening';
}

// clique durante a fala: cala na hora
export function cancelSpeech(): void {
  cancelRequested = true;
  stopSpeaking();
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
    showSpeech('Não consegui acessar o microfone. Confere as permissões do sistema.', 6000);
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

// mensagem digitada: a resposta vem só em texto, sem voz
export async function sendTyped(text: string, attachments?: ChatAttachment[]): Promise<void> {
  const state = getState();
  if (state !== 'idle' && state !== 'error') return;
  setState('thinking');
  try {
    await respond(text, false, attachments);
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
  const text = await transcribe(blob, settings);

  if (!text.trim()) {
    setState('idle');
    showBubble('Não entendi nada — fala de novo?', 4000);
    return;
  }

  await respond(text, true);
}

// o texto vai preenchendo o balão em tempo real, mas a fala começa
// só com a resposta completa (fala contínua, sem pausas entre frases).
// viaVoice: pergunta falada responde com voz; digitada responde só em texto
async function respond(
  text: string,
  viaVoice: boolean,
  attachments?: ChatAttachment[],
): Promise<void> {
  const attLabel = attachments?.length
    ? ` 📎 ${attachments.map((a) => a.name).join(', ')}`
    : '';
  showBubble(text + attLabel, undefined, 'user');
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
    reply = await window.hermes.askHermes(text, attachments);
  } finally {
    currentDelta = null;
  }

  // quem grava é o main, na mesma conversa do chat
  showSpeech(reply);
  const silent = viaVoice ? await speakOut(reply, settings) : true;

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
  if (settings.muted || (settings.voiceEngine ?? 'xtts') === 'texto') return true;
  setState('speaking');
  return speak(text, settings, setAmplitude);
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