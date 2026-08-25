import { setState, setAmplitude, setEyeTarget } from './character';
import { renderMarkdown, copyInto } from './markdown';
import { transcribe } from './stt';
import { pdfToText } from './pdfText';
import { speak, stopSpeaking, isSpeaking } from './tts';
import type { Chat, ChatAttachment, ChatMsg, ChatSummary, RendererSettings, SearchHit } from './types.d';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const msgsEl = $('messages');
const inputEl = $<HTMLTextAreaElement>('input');
const attachBar = $('attach-bar');
const attachInput = $<HTMLInputElement>('attach-input');
const statusEl = $('composer-status');
const ctxMenu = $('ctx-menu');
const stage = $('stage');
const veil = $('drop-veil');
const btnSend = $<HTMLButtonElement>('btn-send');
const findDlg = $<HTMLDialogElement>('find-dlg');
const findInput = $<HTMLInputElement>('find-input');
const findHits = $('find-hits');

const VISIBLE_MSGS = 200;
const MAX_FILE_BYTES = 20_000_000;
const MAX_AUDIO_BYTES = 25_000_000;
const MAX_TEXT_CHARS = 200_000;
const MAX_IMG_SIDE = 1568;
const AUDIO_EXT = /\.(mp3|m4a|wav|ogg|opus|flac|aac|webm|mp4)$/i;
const OFFICE_EXT = /\.(docx|xlsx|xls|pptx)$/i;
const THEMES = ['azul', 'dourado', 'verde', 'grafite', 'roxo', 'ciano', 'titanio'];

let settings: RendererSettings;
let chat: Chat | null = null;
let attachments: ChatAttachment[] = [];
let streamReqId = '';
let streamEl: HTMLElement | null = null;
let showFrom = 0;

function status(msg: string): void {
  statusEl.textContent = msg;
}

function applyTheme(theme: string): void {
  document.body.classList.remove(...THEMES.map((t) => `theme-${t}`));
  document.body.classList.add(`theme-${THEMES.includes(theme) ? theme : 'azul'}`);
}

/* ---------------- barra de título ---------------- */

// no macOS quem minimiza, maximiza e fecha são os semáforos nativos
if (navigator.userAgent.includes('Macintosh')) document.body.classList.add('mac');

$('btn-min').addEventListener('click', () => window.hermes.winMin());
$('btn-max').addEventListener('click', () => window.hermes.winMax());
$('btn-close').addEventListener('click', () => window.hermes.hideWindow());
$('titlebar').addEventListener('dblclick', (e) => {
  if ((e.target as HTMLElement).closest('#win-buttons, #bar-actions')) return;
  window.hermes.winMax();
});
$('btn-pin').addEventListener('click', async () => {
  const on = await window.hermes.winPin();
  $('btn-pin').classList.toggle('on', on);
});
window.hermes.onWinState((s) => ($('btn-max').textContent = s.maximized ? '❐' : '□'));

function avatarNode(c: { avatar: string; title: string }): HTMLElement {
  const el = document.createElement('div');
  el.className = 'avatar';
  if (c.avatar) el.style.backgroundImage = `url("${c.avatar}")`;
  else el.textContent = (c.title.trim()[0] ?? '💬').toUpperCase();
  return el;
}

/* ---------------- menu de opções da conversa ---------------- */

function fecharMenu(): void {
  ctxMenu.classList.add('hidden');
}

document.addEventListener('click', (e) => {
  if (!(e.target as HTMLElement).closest('#ctx-menu')) fecharMenu();
});
document.addEventListener('keydown', (e) => e.key === 'Escape' && fecharMenu());

type MenuChat = { id: string; title: string };

function abrirMenu(c: MenuChat, âncora: HTMLElement): void {
  ctxMenu.textContent = '';
  const item = (rótulo: string, açao: () => void, perigo = false) => {
    const b = document.createElement('button');
    b.textContent = rótulo;
    if (perigo) b.className = 'perigo';
    b.addEventListener('click', async () => {
      fecharMenu();
      await açao();
    });
    ctxMenu.appendChild(b);
  };

  item('Exportar como .md', async () => {
    const salvo = await window.hermes.chatExport(c.id);
    status(salvo ? `salvo em ${salvo}` : '');
  });
  item(
    'Limpar conversa',
    async () => {
      if (!confirm(`Apagar todas as mensagens de "${c.title}"? A conversa em si continua.`)) return;
      const limpa = await window.hermes.chatClear(c.id);
      if (limpa && chat?.id === c.id) {
        chat = limpa;
        showFrom = 0;
        renderMessages();
      }
    },
    true,
  );
  const r = âncora.getBoundingClientRect();
  ctxMenu.classList.remove('hidden');
  // encaixa dentro da janela: abre para cima/esquerda quando falta espaço
  const alt = ctxMenu.offsetHeight;
  const larg = ctxMenu.offsetWidth;
  ctxMenu.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - larg - 8))}px`;
  ctxMenu.style.top = `${r.bottom + alt > window.innerHeight ? Math.max(8, r.top - alt) : r.bottom + 4}px`;
}

/* ---------------- busca ---------------- */

// sem acento e sem caixa, como a busca do main, para o destaque cair no lugar certo
const semAcento = (s: string) =>
  s
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase();

// o trecho com o termo em destaque; nós de DOM, nunca innerHTML com texto do modelo
function trechoNode(snippet: string, termo: string): HTMLElement {
  const p = document.createElement('div');
  p.className = 'p';
  let texto = snippet;
  let at = termo ? semAcento(texto).indexOf(semAcento(termo)) : -1;
  if (at < 0) {
    p.textContent = texto;
    return p;
  }
  // a linha é única e corta com reticências: o termo tem que caber nela
  if (at > 24) {
    texto = `…${texto.slice(at - 24)}`;
    at = 25;
  }
  const marca = document.createElement('mark');
  marca.textContent = texto.slice(at, at + termo.length);
  p.append(texto.slice(0, at), marca, texto.slice(at + termo.length));
  return p;
}

function quando(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const hoje = new Date();
  const mesmoDia = d.toDateString() === hoje.toDateString();
  return mesmoDia
    ? d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: '2-digit' });
}

function hitNode(h: SearchHit, termo = ''): HTMLElement {
  const el = document.createElement('div');
  el.className = 'chat-item';
  el.appendChild(avatarNode({ avatar: h.avatar, title: h.title }));
  const texto = document.createElement('div');
  texto.className = 'texto';
  const t = document.createElement('div');
  t.className = 't';
  const nome = document.createElement('span');
  nome.textContent = h.title;
  const data = document.createElement('span');
  data.className = 'quando';
  data.textContent = quando(h.t);
  t.append(nome, data);
  texto.append(t, trechoNode(h.snippet, termo));
  el.appendChild(texto);
  el.addEventListener('click', () => openChat(h.chatId, h.index));
  return el;
}

/* busca nas mensagens: a barra da sidebar some abaixo de 900px, então a lupa do
   cabeçalho e o Cmd+K abrem esta paleta, que fala com a mesma chatSearch */

let findTimer: ReturnType<typeof setTimeout> | undefined;
let findSel = -1;

function findItens(): HTMLElement[] {
  return Array.from(findHits.querySelectorAll<HTMLElement>('.chat-item'));
}

function marcarSel(i: number): void {
  const itens = findItens();
  if (!itens.length) return;
  findSel = (i + itens.length) % itens.length;
  itens.forEach((el, n) => el.classList.toggle('sel', n === findSel));
  itens[findSel].scrollIntoView({ block: 'nearest' });
}

async function runFind(): Promise<void> {
  const q = findInput.value.trim();
  findHits.textContent = '';
  findSel = -1;
  if (!q) return;
  const hits = await window.hermes.chatSearch(q);
  const label = document.createElement('div');
  label.className = 'side-label';
  label.textContent = hits.length ? `${hits.length} resultado(s)` : 'nada encontrado';
  findHits.appendChild(label);
  for (const h of hits) {
    const el = hitNode(h, q);
    el.addEventListener('click', () => findDlg.close());
    findHits.appendChild(el);
  }
  marcarSel(0);
}

function abrirBusca(): void {
  if (findDlg.open) return;
  findDlg.showModal();
  findInput.select();
}

$('btn-find').addEventListener('click', abrirBusca);

findInput.addEventListener('input', () => {
  clearTimeout(findTimer);
  findTimer = setTimeout(runFind, 200);
});

findInput.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    marcarSel(findSel + (e.key === 'ArrowDown' ? 1 : -1));
  } else if (e.key === 'Enter') {
    e.preventDefault();
    findItens()[findSel]?.click();
  }
});

window.addEventListener('keydown', (e) => {
  if (e.key.toLowerCase() === 'k' && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    abrirBusca();
  }
});

/* ---------------- abrir conversa ---------------- */

async function openChat(id: string, focusIndex?: number): Promise<void> {
  const loaded = await window.hermes.chatOpen(id);
  if (!loaded) return;
  chat = loaded;
  showFrom = focusIndex !== undefined ? 0 : Math.max(0, loaded.msgs.length - VISIBLE_MSGS);
  renderMessages();
  if (focusIndex !== undefined) {
    const alvo = msgsEl.querySelector(`[data-i="${focusIndex}"]`);
    alvo?.scrollIntoView({ block: 'center' });
    // como no WhatsApp: a mensagem pisca para os olhos acharem onde caíram
    alvo?.classList.add('flash');
    setTimeout(() => alvo?.classList.remove('flash'), 1600);
  }
}

$('btn-conv-menu').addEventListener('click', (e) => {
  e.stopPropagation();
  if (chat) abrirMenu(chat, $('btn-conv-menu'));
});

/* ---------------- mensagens ---------------- */

function renderMessages(): void {
  msgsEl.textContent = '';
  if (!chat) return;
  if (showFrom > 0) {
    const more = document.createElement('button');
    more.id = 'load-more';
    more.textContent = `carregar as ${showFrom} mensagens anteriores`;
    more.addEventListener('click', () => {
      showFrom = 0;
      renderMessages();
    });
    msgsEl.appendChild(more);
  }
  chat.msgs.forEach((m, i) => {
    if (i >= showFrom) msgsEl.appendChild(msgNode(m, i));
  });
  msgsEl.scrollTop = msgsEl.scrollHeight;
}

function msgNode(m: ChatMsg, index: number): HTMLElement {
  const el = document.createElement('div');
  el.className = `msg ${m.role}`;
  el.dataset.i = String(index);
  if (m.role === 'system') {
    el.textContent = m.text;
    return el;
  }
  if (m.atts?.length) el.appendChild(attNode(m.atts));
  const body = document.createElement('div');
  body.className = 'msg-body';
  body.append(...renderMarkdown(m.text));
  el.append(body, toolsNode(m, index));
  return el;
}

function attNode(atts: NonNullable<ChatMsg['atts']>): HTMLElement {
  const box = document.createElement('div');
  box.className = 'msg-atts';
  for (const a of atts) {
    if (a.kind === 'image' && a.dataUrl) {
      const img = document.createElement('img');
      img.src = a.dataUrl;
      img.alt = a.name;
      box.appendChild(img);
    } else if (a.kind === 'audio' && a.file) {
      box.appendChild(audioNode(a.file));
    } else {
      const chip = document.createElement('span');
      chip.className = 'att-chip';
      chip.textContent = `📎 ${a.name}${a.dropped ? ' (não guardado)' : ''}`;
      box.appendChild(chip);
    }
  }
  return box;
}

function audioNode(file: string): HTMLElement {
  const audio = document.createElement('audio');
  audio.controls = true;
  audio.preload = 'metadata';
  // o WebM do MediaRecorder não traz a duração no cabeçalho: pular para o fim
  // uma vez força o Chromium a calculá-la, senão a barra de progresso fica sem fim
  const corrigirDuracao = () => {
    if (audio.duration !== Infinity) return;
    audio.currentTime = 1e101;
    audio.addEventListener('timeupdate', () => (audio.currentTime = 0), { once: true });
  };
  audio.addEventListener('loadedmetadata', corrigirDuracao, { once: true });
  window.hermes.mediaPath(file).then((p) => (audio.src = `file:///${p.replace(/\\/g, '/')}`));
  return audio;
}

function toolsNode(m: ChatMsg, index: number): HTMLElement {
  const tools = document.createElement('div');
  tools.className = 'msg-tools';

  const copiar = document.createElement('button');
  copiar.textContent = 'copiar';
  copiar.addEventListener('click', () => copyInto(copiar, m.text));
  tools.appendChild(copiar);

  if (m.role === 'assistant') {
    const ouvir = document.createElement('button');
    ouvir.textContent = 'ouvir';
    ouvir.addEventListener('click', () => toggleSpeak(m.text, ouvir));
    tools.appendChild(ouvir);

    // regenerar só faz sentido na última resposta
    if (chat && index === chat.msgs.length - 1) {
      const regen = document.createElement('button');
      regen.textContent = 'regenerar';
      regen.addEventListener('click', () => send('', 'regen'));
      tools.appendChild(regen);
    }

    // o markdown que o Hermes escreveu, como veio: baixar é gravar o m.text
    const md = document.createElement('button');
    md.textContent = '.md';
    md.addEventListener('click', async () => {
      if (!(await window.hermes.msgSave(m.text))) return;
      md.textContent = 'salvo ✓';
      setTimeout(() => (md.textContent = '.md'), 1500);
    });
    tools.appendChild(md);
  } else {
    const editar = document.createElement('button');
    editar.textContent = 'editar';
    editar.addEventListener('click', () => startEdit(m, index));
    tools.appendChild(editar);
  }
  return tools;
}

async function toggleSpeak(text: string, btn: HTMLElement): Promise<void> {
  if (isSpeaking()) {
    stopSpeaking();
    setState('idle');
    btn.textContent = 'ouvir';
    return;
  }
  btn.textContent = 'parar';
  setState('speaking');
  await speak(text, settings, setAmplitude);
  setState('idle');
  btn.textContent = 'ouvir';
}

// editar uma pergunta: trunca a conversa e rotaciona a sessão (o contexto é server-side)
async function startEdit(m: ChatMsg, index: number): Promise<void> {
  if (!chat) return;
  inputEl.value = m.text;
  inputEl.focus();
  autoGrow();
  const truncated = await window.hermes.chatTruncate(chat.id, index);
  if (truncated) {
    chat = truncated;
    showFrom = Math.max(0, chat.msgs.length - VISIBLE_MSGS);
    renderMessages();
  }
  status('mensagem carregada para edição — Enter reenvia');
}

/* ---------------- envio ---------------- */

function atBottom(): boolean {
  return msgsEl.scrollHeight - msgsEl.scrollTop - msgsEl.clientHeight < 60;
}

const REGEN_PROMPT = 'Reescreva sua última resposta de outra forma. Não comente que está refazendo.';

async function send(
  text: string,
  mode: 'normal' | 'regen' = 'normal',
  audio?: { file: string; name: string },
): Promise<void> {
  if (streamReqId) return;
  if (mode === 'normal' && !text.trim() && !attachments.length) return;
  if (!chat) chat = await window.hermes.chatNew();

  const atts = attachments;
  if (mode === 'normal') {
    attachments = [];
    renderAttachments();
    inputEl.value = '';
    autoGrow();
    chat.msgs.push({
      type: 'msg',
      role: 'user',
      t: new Date().toISOString(),
      text,
      atts: [
        ...(audio ? [{ kind: 'audio' as const, ...audio }] : []),
        ...atts.map((a) =>
          a.kind === 'image'
            ? { kind: 'image' as const, name: a.name, dataUrl: a.dataUrl }
            : { kind: 'text' as const, name: a.name },
        ),
      ],
    });
    msgsEl.appendChild(msgNode(chat.msgs[chat.msgs.length - 1], chat.msgs.length - 1));
  }

  streamReqId = `r${Date.now()}`;
  setState('thinking');
  status('pensando…');

  const holder = document.createElement('div');
  holder.className = 'msg assistant';
  const body = document.createElement('div');
  body.className = 'msg-body';
  holder.appendChild(body);
  if (mode === 'regen') msgsEl.lastElementChild?.remove();
  msgsEl.appendChild(holder);
  streamEl = body;
  msgsEl.scrollTop = msgsEl.scrollHeight;

  try {
    const { title } = await window.hermes.chatAsk({
      chatId: chat.id,
      reqId: streamReqId,
      text: mode === 'regen' ? REGEN_PROMPT : text,
      attachments: atts,
      audio,
      mode,
    });
    if (title) chat.title = title;
    // recarrega do disco: o main é quem grava (e pode ter inserido o aviso de sessão nova)
    await reload();
  } catch (e) {
    holder.remove();
    setState('error');
    status(e instanceof Error ? e.message : String(e));
    setTimeout(() => setState('idle'), 4000);
  } finally {
    streamReqId = '';
    streamEl = null;
    if (statusEl.textContent === 'pensando…') status('');
  }
}

async function reload(): Promise<void> {
  if (!chat) return;
  const fresh = await window.hermes.chatOpen(chat.id);
  if (!fresh) return;
  chat = fresh;
  const noFim = atBottom();
  const scroll = msgsEl.scrollTop;
  showFrom = Math.max(0, chat.msgs.length - VISIBLE_MSGS);
  renderMessages();
  if (!noFim) msgsEl.scrollTop = scroll;
  setState('idle');
}

window.hermes.onHermesDelta((reqId, delta) => {
  if (!streamEl || reqId !== streamReqId) return;
  const grudado = atBottom();
  // markdown pela metade renderiza instável: texto puro enquanto streama
  streamEl.textContent = (streamEl.textContent ?? '') + delta;
  if (grudado) msgsEl.scrollTop = msgsEl.scrollHeight;
});

/* ---------------- compositor ---------------- */

function autoGrow(): void {
  inputEl.style.height = 'auto';
  inputEl.style.height = `${Math.min(inputEl.scrollHeight, 220)}px`;
  // o botão de enviar fica sempre visível; send() ignora o clique com o campo vazio
  btnSend.disabled = !inputEl.value.trim() && !attachments.length;
}

inputEl.addEventListener('input', () => {
  autoGrow();
  bumpTyping();
});

inputEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    send(inputEl.value.trim());
  } else if (e.key === 'Escape' && streamReqId) {
    window.hermes.askAbort(streamReqId);
  }
});

btnSend.addEventListener('click', () => send(inputEl.value.trim()));

/* ---------------- anexos ---------------- */

$('btn-attach').addEventListener('click', () => attachInput.click());
attachInput.addEventListener('change', async () => {
  await addFiles(Array.from(attachInput.files ?? []));
  attachInput.value = '';
});

document.addEventListener('dragover', (e) => {
  e.preventDefault();
  veil.classList.remove('hidden');
});
document.addEventListener('dragleave', (e) => {
  if (e.relatedTarget === null) veil.classList.add('hidden');
});
document.addEventListener('drop', async (e) => {
  e.preventDefault();
  veil.classList.add('hidden');
  await addFiles(Array.from(e.dataTransfer?.files ?? []));
});

// ponytail: copiar seleção sempre como texto puro — o text/html do Chromium leva
// junto o fundo escuro do balão e suja o destino da colagem.
document.addEventListener('copy', (e) => {
  const sel = document.getSelection()?.toString();
  if (!sel) return;
  e.preventDefault();
  e.clipboardData?.setData('text/plain', sel);
});

inputEl.addEventListener('paste', async (e) => {
  const items = Array.from(e.clipboardData?.items ?? []).filter((i) => i.kind === 'file');
  if (!items.length) return;
  e.preventDefault();
  const erros: string[] = [];
  for (const it of items) {
    const f = it.getAsFile();
    if (!f) continue;
    const erro = await addFile(f, f.name || (f.type.startsWith('image/') ? 'print colado.png' : 'colado'));
    if (erro) erros.push(erro);
  }
  status(erros.join(' · '));
});

/** Devolve a mensagem de erro, ou null se anexou. Quem chama junta os erros —
 *  senão o sucesso do arquivo seguinte apaga o aviso do anterior. */
async function addFile(file: File, nome = file.name): Promise<string | null> {
  const limite = AUDIO_EXT.test(nome) ? MAX_AUDIO_BYTES : MAX_FILE_BYTES;
  if (file.size > limite) {
    return `${nome} tem ${(file.size / 1e6).toFixed(1)} MB — o limite é ${limite / 1e6} MB`;
  }
  try {
    if (file.type.startsWith('image/')) {
      attachments.push({ kind: 'image', name: nome, dataUrl: await imageToDataUrl(file) });
    } else if (AUDIO_EXT.test(nome)) {
      status(`transcrevendo ${nome}… pode levar alguns minutos`);
      const text = await transcribeFile(file, nome);
      attachments.push({ kind: 'text', name: `${nome} (transcrição)`, text });
    } else if (/\.pdf$/i.test(nome)) {
      status(`lendo ${nome}…`);
      const text = await pdfToText(await file.arrayBuffer());
      if (text.replace(/\s/g, '').length < 30) {
        return `${nome} parece digitalizado (só imagens), não consegui extrair texto. Se for uma página só, cola um print aqui que eu leio a imagem.`;
      }
      attachments.push({ kind: 'text', name: nome, text: truncate(text) });
    } else if (OFFICE_EXT.test(nome)) {
      status(`lendo ${nome}…`);
      const out = await window.hermes.extractFile(nome, await file.arrayBuffer());
      if (out.error) return out.error;
      attachments.push({ kind: 'text', name: nome, text: truncate(out.text ?? '') });
    } else {
      const text = await file.text();
      if (text.includes('\0')) return `${nome} parece binário — não consigo ler como texto`;
      attachments.push({ kind: 'text', name: nome, text: truncate(text) });
    }
    renderAttachments();
    return null;
  } catch (e) {
    return `falha em ${nome}: ${e instanceof Error ? e.message : String(e)}`;
  }
}

async function addFiles(files: File[]): Promise<void> {
  const erros: string[] = [];
  for (const f of files) {
    const erro = await addFile(f);
    if (erro) erros.push(erro);
  }
  status(erros.join(' · '));
}

function truncate(s: string): string {
  return s.length > MAX_TEXT_CHARS ? s.slice(0, MAX_TEXT_CHARS) + '\n[…texto truncado…]' : s;
}

async function transcribeFile(file: Blob, nome: string): Promise<string> {
  if ((settings.voiceEngine ?? 'xtts') === 'xtts' && !(await window.hermes.voiceServerUp())) {
    status('servidor de voz local desligado — usando a transcrição local, mais lenta');
    return transcribe(file, { ...settings, voiceEngine: 'leve' }, nome);
  }
  return transcribe(file, settings, nome);
}

async function imageToDataUrl(file: File, maxSide = MAX_IMG_SIDE): Promise<string> {
  const raw = await new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as string);
    r.onerror = () => reject(new Error('não consegui ler a imagem'));
    r.readAsDataURL(file);
  });
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const i = new Image();
    i.onload = () => resolve(i);
    i.onerror = () => reject(new Error('imagem inválida'));
    i.src = raw;
  });
  const maior = Math.max(img.width, img.height);
  if (maior <= maxSide && raw.length < 1_500_000) return raw;

  const canvas = document.createElement('canvas');
  const ctx2d = canvas.getContext('2d')!;
  const escala = Math.min(1, maxSide / maior);
  canvas.width = Math.round(img.width * escala);
  canvas.height = Math.round(img.height * escala);
  ctx2d.drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', 0.85);
}

function renderAttachments(): void {
  attachBar.textContent = '';
  attachBar.classList.toggle('hidden', !attachments.length);
  attachments.forEach((a, i) => {
    const chip = document.createElement('span');
    chip.className = 'att-chip';
    const label = document.createElement('span');
    label.textContent = a.kind === 'image' ? `🖼 ${a.name}` : `📎 ${a.name}`;
    const x = document.createElement('button');
    x.textContent = '✕';
    x.addEventListener('click', () => {
      attachments.splice(i, 1);
      renderAttachments();
      autoGrow();
    });
    chip.append(label, x);
    attachBar.appendChild(chip);
  });
  autoGrow();
}

/* ---------------- personagem ---------------- */

let typingTimer: ReturnType<typeof setTimeout> | undefined;

function bumpTyping(): void {
  stage.classList.add('typing');
  clearTimeout(typingTimer);
  typingTimer = setTimeout(() => stage.classList.remove('typing'), 1200);
}

document.addEventListener('mousemove', (e) => {
  const r = stage.getBoundingClientRect();
  setEyeTarget(e.clientX - (r.left + r.width / 2), e.clientY - (r.top + r.height / 2));
});

// atalho de volta para o personagem flutuante
stage.title = 'Voltar para o personagem flutuante';
stage.addEventListener('click', () => window.hermes.setUiMode('overlay'));

/* ---------------- boot ---------------- */

window.hermes.onSettingsChanged((s) => {
  settings = s;
  applyTheme(s.theme);
});
window.hermes.onChatOpen((id) => openChat(id));
window.hermes.onProactive((_text, chatId) => {
  if (chatId && chat?.id === chatId) openChat(chatId);
});

(async () => {
  settings = await window.hermes.getSettings();
  applyTheme(settings.theme);
  $('btn-pin').classList.toggle('on', settings.chatPinned);
  const chats = await window.hermes.chatList();
  // a conversa ativa é a que o overlay também usa; sem ela, a mais recente
  const alvo =
    chats.find((c) => c.id === settings.activeChatId) ?? chats.find((c) => !c.archived) ?? chats[0];
  if (alvo) await openChat(alvo.id);
  else chat = await window.hermes.chatNew();
  autoGrow();
  inputEl.focus();
})();
