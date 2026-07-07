import './types.d';
import {
  setState,
  getState,
  setEyeTarget,
  setSpeechSide,
  setStatusText,
  openHistory,
  closeHistory,
  isHistoryOpen,
} from './character';
import {
  startListening,
  stopListening,
  sendTyped,
  cancelSpeech,
  deliverProactive,
} from './conversation';

const stage = document.getElementById('stage')!;

// ---------- arrastar × clicar ----------
const CLICK_THRESHOLD = 5;
let pressing = false;
let moved = false;
let startX = 0;
let startY = 0;

stage.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return;
  if ((e.target as HTMLElement).closest('#type-box, #speech, #bubble, #history, #history-tab')) return;
  pressing = true;
  moved = false;
  startX = e.screenX;
  startY = e.screenY;
  window.hermes.dragStart();
});

window.addEventListener('mousemove', (e) => {
  if (!pressing) return;
  const dx = e.screenX - startX;
  const dy = e.screenY - startY;
  if (!moved && Math.hypot(dx, dy) < CLICK_THRESHOLD) return;
  moved = true;
  stage.style.cursor = 'grabbing';
  window.hermes.dragMove(dx, dy);
});

window.addEventListener('mouseup', (e) => {
  if (!pressing || e.button !== 0) return;
  pressing = false;
  stage.style.cursor = 'grab';
  window.hermes.dragEnd();
  if (!moved) onCharacterClick();
});

// ---------- push-to-talk ----------
function onCharacterClick(): void {
  const state = getState();
  if (state === 'idle' || state === 'error') {
    startListening();
  } else if (state === 'listening') {
    stopListening();
  } else if (state === 'speaking') {
    cancelSpeech();
  }
  // em 'thinking' o clique é ignorado (a resposta já está a caminho)
}

window.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  window.hermes.openMenu();
});

const THEME_CLASSES = [
  'theme-azul',
  'theme-dourado',
  'theme-verde',
  'theme-grafite',
  'theme-roxo',
  'theme-ciano',
];

function applyTheme(theme: string): void {
  stage.classList.remove(...THEME_CLASSES);
  stage.classList.add(`theme-${THEME_CLASSES.includes(`theme-${theme}`) ? theme : 'azul'}`);
}

window.hermes.getSettings().then((s) => {
  applyTheme(s.theme);
  setSpeechSide(s.speechSide);
});
window.hermes.onSettingsChanged((s) => {
  applyTheme(s.theme);
  setSpeechSide(s.speechSide);
});

// olhos seguem o cursor pela tela inteira
window.hermes.onCursorMove((dx, dy) => setEyeTarget(dx, dy));

// mensagens espontâneas do Hermes
window.hermes.onProactive((text) => deliverProactive(text));

// progresso do download da voz leve
window.hermes.onVoiceProgress((msg) => setStatusText(msg));

// informa ao menu quais vozes pt o Windows oferece
function sendWindowsVoices(): void {
  const names = speechSynthesis
    .getVoices()
    .filter((v) => v.lang.toLowerCase().startsWith('pt'))
    .map((v) => v.name);
  if (names.length) window.hermes.setWindowsVoices(names);
}
speechSynthesis.onvoiceschanged = sendWindowsVoices;
sendWindowsVoices();

// sobrancelhas levantam quando o mouse passa sobre o personagem
const character = document.getElementById('character')!;
const typeBox = document.getElementById('type-box') as HTMLInputElement;
const historyTab = document.getElementById('history-tab')!;
let typeBoxTimer: ReturnType<typeof setTimeout> | undefined;

function showTypeBox(): void {
  clearTimeout(typeBoxTimer);
  typeBox.classList.remove('hidden');
  historyTab.classList.remove('hidden');
}

function scheduleHideTypeBox(): void {
  clearTimeout(typeBoxTimer);
  typeBoxTimer = setTimeout(() => {
    if (document.activeElement !== typeBox) typeBox.classList.add('hidden');
    if (!isHistoryOpen()) historyTab.classList.add('hidden');
  }, 1400);
}

character.addEventListener('mouseenter', () => {
  stage.classList.add('hover');
  showTypeBox();
});
character.addEventListener('mouseleave', () => {
  stage.classList.remove('hover');
  scheduleHideTypeBox();
});
typeBox.addEventListener('mouseenter', showTypeBox);
typeBox.addEventListener('mouseleave', scheduleHideTypeBox);
typeBox.addEventListener('blur', scheduleHideTypeBox);

historyTab.addEventListener('mouseenter', showTypeBox);
historyTab.addEventListener('mouseleave', scheduleHideTypeBox);
historyTab.addEventListener('click', async () => {
  if (isHistoryOpen()) {
    closeHistory();
  } else {
    openHistory(await window.hermes.getHistory());
  }
});
typeBox.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    const text = typeBox.value.trim();
    if (!text) return;
    typeBox.value = '';
    typeBox.classList.add('hidden');
    sendTyped(text);
  } else if (e.key === 'Escape') {
    typeBox.value = '';
    typeBox.classList.add('hidden');
    typeBox.blur();
  }
});

window.hermes.onPttToggle(() => onCharacterClick());

setState('idle');
