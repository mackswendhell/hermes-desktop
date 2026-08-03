import { ctx } from './audio';
import type { RendererSettings } from './types.d';

export const VOICE_URL = 'http://127.0.0.1:8756';

/** Transcreve áudio pelo caminho disponível: voice-server local → Groq → whisper.cpp local.
 *  `filename` importa: o server.py usa o sufixo para decodificar o arquivo. */
export async function transcribe(
  blob: Blob,
  settings: RendererSettings,
  filename = 'fala.webm',
): Promise<string> {
  const engine = settings.voiceEngine ?? 'xtts';
  if (engine === 'xtts') {
    const form = new FormData();
    form.append('audio', blob, filename);
    const sttRes = await fetch(`${VOICE_URL}/stt`, { method: 'POST', body: form });
    if (!sttRes.ok) throw new Error(`STT falhou (${sttRes.status})`);
    const { text } = (await sttRes.json()) as { text: string };
    return text;
  }
  let groqErr = '';
  if (engine === 'nuvem') {
    if (!settings.groqApiKey) {
      throw new Error('voz na nuvem sem chave Groq — preencha e clique em Salvar nas Configurações');
    }
    try {
      const form = new FormData();
      form.append('file', blob, filename);
      form.append('model', 'whisper-large-v3-turbo');
      form.append('language', 'pt');
      const res = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${settings.groqApiKey}` },
        body: form,
      });
      if (!res.ok) throw new Error(`Groq ${res.status}`);
      return ((await res.json()) as { text: string }).text;
    } catch (e) {
      // rede/limite/chave inválida: tenta o whisper.cpp local abaixo, sem esconder a causa
      groqErr = e instanceof Error ? e.message : String(e);
    }
  }
  // voz leve: whisper.cpp local via main process (precisa de WAV 16 kHz mono)
  try {
    const wav = await blobToWav16k(blob);
    return await window.hermes.sttLocal(wav);
  } catch (e) {
    const local = e instanceof Error ? e.message : String(e);
    throw new Error(groqErr ? `transcrição na nuvem falhou (${groqErr}) e a local também (${local})` : local);
  }
}

export async function blobToWav16k(blob: Blob): Promise<ArrayBuffer> {
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
