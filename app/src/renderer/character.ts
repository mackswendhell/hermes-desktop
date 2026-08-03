import charSvg from './character.svg';

export type CharState = 'idle' | 'listening' | 'thinking' | 'speaking' | 'error';

// o SVG mora num arquivo só, usado pelo overlay e pela miniatura do chat
const slot = document.getElementById('char-slot');
if (slot) slot.innerHTML = charSvg;

// balões, histórico e status só existem no overlay — no chat estes ids não vêm
const $ = (id: string) => document.getElementById(id);
const stage = document.getElementById('stage')!;
const bubble = $('bubble');
const bubbleText = $('bubble-text');
const speech = $('speech');
const speechText = $('speech-text');
const statusLabel = $('status-label');

const statusText: Record<CharState, string> = {
  idle: '',
  listening: 'ouvindo…',
  thinking: 'pensando…',
  speaking: '',
  error: 'ops…',
};

let current: CharState = 'idle';

export function setState(state: CharState): void {
  stage.classList.remove(`state-${current}`);
  stage.classList.add(`state-${state}`);
  current = state;
  if (statusLabel) statusLabel.textContent = statusText[state];
  if (state !== 'speaking') setAmplitude(0);
}

export function getState(): CharState {
  return current;
}

// mensagens transitórias (ex.: progresso de download da voz leve)
export function setStatusText(msg: string): void {
  if (current === 'idle' && statusLabel) statusLabel.textContent = msg;
}

export function setAmplitude(amp: number): void {
  stage.style.setProperty('--amp', String(Math.min(1, Math.max(0, amp))));
}

const EYE_RANGE = 5.5;

export function setEyeTarget(dx: number, dy: number): void {
  const dist = Math.hypot(dx, dy);
  if (dist < 1) return;
  const reach = Math.min(1, dist / 350);
  const px = (dx / dist) * EYE_RANGE * reach;
  const py = (dy / dist) * EYE_RANGE * reach;
  stage.style.setProperty('--px', `${px.toFixed(1)}px`);
  stage.style.setProperty('--py', `${py.toFixed(1)}px`);
}

let bubbleTimer: ReturnType<typeof setTimeout> | undefined;

// balão de pensamento (bolinhas): o que você disse ao personagem
export function showBubble(text: string, autoHideMs?: number, kind: 'user' | 'reply' = 'reply'): void {
  if (!bubble || !bubbleText) return;
  bubbleText.textContent = text;
  bubble.classList.remove('hidden');
  bubble.classList.toggle('user', kind === 'user');
  if (bubbleTimer) clearTimeout(bubbleTimer);
  if (autoHideMs) bubbleTimer = setTimeout(hideBubble, autoHideMs);
}

export function hideBubble(): void {
  bubble?.classList.add('hidden');
}

let speechTimer: ReturnType<typeof setTimeout> | undefined;
let speechSide: 'left' | 'right' = 'left';

const historyPanel = $('history');
const historyList = $('history-list');
const historyTab = $('history-tab') as HTMLElement | null;
let historyOpen = false;

export function setSpeechSide(side: 'left' | 'right'): void {
  speechSide = side;
  // a abinha do histórico fica do mesmo lado em que o painel abre
  if (historyTab) historyTab.style.left = side === 'left' ? '2px' : '230px';
}

export function isHistoryOpen(): boolean {
  return historyOpen;
}

export function openHistory(entries: { t: string; q: string; a: string }[]): void {
  if (!historyPanel || !historyList || !speech) return;
  historyList.textContent = '';
  if (!entries.length) {
    const vazio = document.createElement('div');
    vazio.className = 'h-q';
    vazio.textContent = 'Nenhuma conversa registrada ainda.';
    historyList.appendChild(vazio);
  }
  for (const e of entries) {
    if (e.q) {
      const q = document.createElement('div');
      q.className = 'h-q';
      q.textContent = `Você: ${e.q}`;
      historyList.appendChild(q);
    }
    const a = document.createElement('div');
    a.className = 'h-a';
    a.textContent = e.a;
    historyList.appendChild(a);
  }
  speech.classList.add('hidden');
  historyOpen = true;
  stage.classList.toggle('speech-left', speechSide === 'left');
  historyPanel.classList.remove('hidden');
  window.hermes.setWide(true);
  historyList.scrollTop = historyList.scrollHeight;
}

export function closeHistory(): void {
  if (!historyOpen || !historyPanel || !speech) return;
  historyOpen = false;
  historyPanel.classList.add('hidden');
  if (speech.classList.contains('hidden')) {
    window.hermes.setWide(false);
    stage.classList.remove('speech-left');
  }
}

// balão de fala (rabinho na boca): a resposta do Hermes
export function showSpeech(text: string, autoHideMs?: number): void {
  if (!speech || !speechText) return;
  closeHistory();
  speechText.textContent = text;
  speech.classList.remove('hidden');
  stage.classList.toggle('speech-left', speechSide === 'left');
  window.hermes.setWide(true);
  if (speechTimer) clearTimeout(speechTimer);
  if (autoHideMs) speechTimer = setTimeout(hideSpeech, autoHideMs);
}

export function hideSpeech(): void {
  if (!speech) return;
  speech.classList.add('hidden');
  if (!historyOpen) {
    window.hermes.setWide(false);
    stage.classList.remove('speech-left');
  }
}
