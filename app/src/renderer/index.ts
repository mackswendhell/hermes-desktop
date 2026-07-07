import './types.d';
import type { ChatAttachment } from './types.d';
import {
  setState,
  getState,
  setEyeTarget,
  setSpeechSide,
  setStatusText,
  showBubble,
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
  if ((e.target as HTMLElement).closest('#type-box, #speech, #bubble, #history, #history-tab, #attach-btn, #attach-bar')) return;
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
  attachBtn.classList.remove('hidden');
  historyTab.classList.remove('hidden');
}

function scheduleHideTypeBox(): void {
  clearTimeout(typeBoxTimer);
  typeBoxTimer = setTimeout(() => {
    // com anexo pendente a caixa não se esconde, para o anexo não "sumir"
    if (document.activeElement !== typeBox && attachments.length === 0) {
      typeBox.classList.add('hidden');
      attachBtn.classList.add('hidden');
    }
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
    if (!text && !attachments.length) return;
    const atts = attachments.length ? attachments : undefined;
    attachments = [];
    renderAttachments();
    typeBox.value = '';
    typeBox.classList.add('hidden');
    attachBtn.classList.add('hidden');
    sendTyped(text || 'Dá uma olhada neste anexo.', atts);
  } else if (e.key === 'Escape') {
    typeBox.value = '';
    attachments = [];
    renderAttachments();
    typeBox.classList.add('hidden');
    attachBtn.classList.add('hidden');
    typeBox.blur();
  }
});

// ---------- anexos (clipe ou Ctrl+V de imagem) ----------
const attachBtn = document.getElementById('attach-btn')!;
const attachBar = document.getElementById('attach-bar')!;
const attachInput = document.getElementById('attach-input') as HTMLInputElement;
const MAX_TEXT_BYTES = 100_000;
const MAX_IMG_SIDE = 1568;

let attachments: ChatAttachment[] = [];

function renderAttachments(): void {
  attachBar.textContent = '';
  attachBar.classList.toggle('hidden', attachments.length === 0);
  attachments.forEach((att, i) => {
    const chip = document.createElement('div');
    chip.className = 'attach-chip';
    if (att.kind === 'image') {
      const img = document.createElement('img');
      img.src = att.dataUrl;
      chip.appendChild(img);
    }
    const name = document.createElement('span');
    name.textContent = att.name;
    name.title = att.name;
    chip.appendChild(name);
    const remove = document.createElement('button');
    remove.textContent = '✕';
    remove.title = 'Remover anexo';
    remove.addEventListener('click', () => {
      attachments.splice(i, 1);
      renderAttachments();
    });
    chip.appendChild(remove);
    attachBar.appendChild(chip);
  });
}

// prints em PNG ficam pesados para o túnel — reduz e recomprime quando grande
async function imageToDataUrl(file: Blob): Promise<string> {
  const raw = await new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as string);
    r.onerror = () => reject(new Error('falha ao ler a imagem'));
    r.readAsDataURL(file);
  });
  const img = new Image();
  await new Promise((resolve, reject) => {
    img.onload = resolve;
    img.onerror = reject;
    img.src = raw;
  });
  const scale = Math.min(1, MAX_IMG_SIDE / Math.max(img.width, img.height));
  if (scale === 1 && raw.length < 1_500_000) return raw;
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(img.width * scale);
  canvas.height = Math.round(img.height * scale);
  canvas.getContext('2d')!.drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', 0.85);
}

async function addAttachment(file: File, fallbackName: string): Promise<void> {
  const name = file.name || fallbackName;
  try {
    if (file.type.startsWith('image/')) {
      attachments.push({ kind: 'image', name, dataUrl: await imageToDataUrl(file) });
    } else {
      if (file.size > MAX_TEXT_BYTES) {
        showBubble(`"${name}" é grande demais (máximo 100 KB de texto).`, 5000);
        return;
      }
      const text = await file.text();
      if (text.includes('\0')) {
        showBubble(`Não consegui ler "${name}" como texto — formato não suportado.`, 5000);
        return;
      }
      attachments.push({ kind: 'text', name, text });
    }
    renderAttachments();
    showTypeBox();
    typeBox.focus();
  } catch {
    showBubble(`Não consegui anexar "${name}".`, 5000);
  }
}

attachBtn.addEventListener('click', () => attachInput.click());
attachBtn.addEventListener('mouseenter', showTypeBox);
attachBtn.addEventListener('mouseleave', scheduleHideTypeBox);
attachBar.addEventListener('mouseenter', showTypeBox);
attachBar.addEventListener('mouseleave', scheduleHideTypeBox);

attachInput.addEventListener('change', async () => {
  for (const file of Array.from(attachInput.files ?? [])) {
    await addAttachment(file, 'arquivo');
  }
  attachInput.value = '';
});

typeBox.addEventListener('paste', (e) => {
  const items = e.clipboardData?.items;
  if (!items) return;
  for (const item of Array.from(items)) {
    if (item.kind === 'file' && item.type.startsWith('image/')) {
      const file = item.getAsFile();
      if (file) {
        e.preventDefault();
        addAttachment(file, 'print colado');
      }
    }
  }
});

window.hermes.onPttToggle(() => onCharacterClick());

setState('idle');
