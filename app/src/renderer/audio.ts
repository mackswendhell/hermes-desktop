let audioCtx: AudioContext | null = null;

export function ctx(): AudioContext {
  if (!audioCtx) audioCtx = new AudioContext();
  return audioCtx;
}
