import { ctx } from './audio';
import { VOICE_URL } from './stt';

// Fala não-streaming: o texto completo é quebrado em frases e tocado em fila.
// O estado de "tocando" mora aqui, não no personagem, para o chat poder usar
// o mesmo motor sem depender dos balões do overlay.

export interface SpeakSettings {
  muted: boolean;
  voiceEngine?: string;
  ttsSpeaker: string;
  windowsVoice: string;
}

type OnAmp = (amp: number) => void;

let cancelled = false;
let playing = false;
let currentSource: AudioBufferSourceNode | null = null;

export function isSpeaking(): boolean {
  return playing;
}

export function stopSpeaking(): void {
  cancelled = true;
  playing = false;
  try {
    currentSource?.stop();
  } catch {
    // já parado
  }
  speechSynthesis.cancel();
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

export function splitSentences(text: string): string[] {
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

/** Fala o texto inteiro. Retorna true se ficou em silêncio (mudo ou motor "texto"). */
export async function speak(text: string, settings: SpeakSettings, onAmp: OnAmp = () => {}): Promise<boolean> {
  const engine = settings.voiceEngine ?? 'xtts';
  if (settings.muted || engine === 'texto') return true;

  cancelled = false;
  playing = true;
  try {
    if (engine === 'xtts') {
      await playQueue(splitSentences(text), onAmp, (s) => fetchTtsWav(s, settings.ttsSpeaker || undefined));
    } else if (engine === 'nuvem') {
      const spoke = await playQueue(splitSentences(text), onAmp, fetchTtsEdge);
      // Edge fora do ar: resposta inteira na voz do Windows, sem misturar vozes
      if (!spoke && !cancelled) await speakWindows(text, settings.windowsVoice, onAmp);
    } else {
      await speakWindows(text, settings.windowsVoice, onAmp);
    }
  } finally {
    playing = false;
    onAmp(0);
  }
  return false;
}

function speakWindows(text: string, voiceName: string, onAmp: OnAmp): Promise<void> {
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
    // a Web Speech API não expõe waveform, então a boca é simulada
    utter.onstart = () => {
      const tick = () => {
        if (cancelled || !playing) return;
        const t = performance.now() - t0;
        onAmp(0.25 + 0.55 * Math.abs(Math.sin(t / 95)) * (0.6 + 0.4 * Math.random()));
        raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
    };
    const finish = () => {
      cancelAnimationFrame(raf);
      onAmp(0);
      resolve();
    };
    utter.onend = finish;
    utter.onerror = finish;
    speechSynthesis.speak(utter);
  });
}

async function playQueue(
  queue: string[],
  onAmp: OnAmp,
  synthFn: (s: string) => Promise<AudioBuffer>,
): Promise<boolean> {
  let ahead: Promise<AudioBuffer | null> | null = null;
  let played = false;
  const synth = (s: string) => synthFn(s).catch(() => null);

  while (!cancelled) {
    let current: Promise<AudioBuffer | null>;
    if (ahead) {
      current = ahead;
      ahead = null;
    } else {
      const s = queue.shift();
      if (s === undefined) break;
      current = synth(s);
    }
    const next = queue.shift();
    if (next !== undefined) ahead = synth(next);

    const buffer = await current;
    if (cancelled) break;
    if (buffer) {
      played = true;
      await playBuffer(buffer, onAmp);
    }
  }
  onAmp(0);
  return played;
}

async function fetchTtsEdge(text: string): Promise<AudioBuffer> {
  const mp3 = await window.hermes.ttsNuvem(text);
  return ctx().decodeAudioData(mp3);
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

function playBuffer(buffer: AudioBuffer, onAmp: OnAmp): Promise<void> {
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
      onAmp(Math.min(1, rms * 7));
      if (playing && !cancelled) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);

    source.onended = () => {
      if (currentSource === source) currentSource = null;
      resolve();
    };
    source.start();
  });
}
