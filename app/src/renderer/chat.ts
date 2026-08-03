import { setState, setAmplitude, setEyeTarget } from './character';
import { renderMarkdown, copyInto } from './markdown';
import { transcribe } from './stt';
import { pdfToText } from './pdfText';
import { speak, stopSpeaking, isSpeaking } from './tts';
import type { Chat, ChatAttachment, ChatMsg, ChatSummary, RendererSettings } from './types.d';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const listEl = $('chat-list');
const msgsEl = $('messages');
const inputEl = $<HTMLTextAreaElement>('input');
const searchEl = $<HTMLInputElement>('search');
const attachBar = $('attach-bar');
const attachInput = $<HTMLInputElement>('attach-input');
const avatarInput = $<HTMLInputElement>('avatar-input');
const statusEl = $('composer-status');
const convTitle = $('conv-title');
const convAvatar = $('conv-avatar');
const ctxMenu = $('ctx-menu');
const stage = $('stage');
const veil = $('drop-veil');
const btnSend = $('btn-send');
const btnMic = $('btn-mic');
const askDlg = $<HTMLDialogElement>('ask-dlg');
const askInput = $<HTMLInputElement>('ask-input');

const VISIBLE_MSGS = 200;
const MAX_FILE_BYTES = 20_000_000;
const MAX_AUDIO_BYTES = 25_000_000;
const MAX_TEXT_CHARS = 200_000;
const MAX_IMG_SIDE = 1568;
const AVATAR_SIDE = 96;
const AUDIO_EXT = /\.(mp3|m4a|wav|ogg|opus|flac|aac|webm|mp4)$/i;
const OFFICE_EXT = /\.(docx|xlsx|xls|pptx)$/i;
const THEMES = ['azul', 'dourado', 'verde', 'grafite', 'roxo', 'ciano'];

let settings: RendererSettings;
let chat: Chat | null = null;
let attachments: ChatAttachment[] = [];
let streamReqId = '';
let streamEl: HTMLElement | null = null;
let showFrom = 0;
let mostrandoArquivadas = false;

function status(msg: string): void {
  statusEl.textContent = msg;
}

function applyTheme(theme: string): void {
  document.body.classList.remove(...THEMES.map((t) => `theme-${t}`));
  document.body.classList.add(`theme-${THEMES.includes(theme) ? theme : 'azul'}`);
}

/* ---------------- barra de título ---------------- */

$('btn-min').addEventListener('click', () => window.hermes.winMin());
$('btn-max').addEventListener('click', () => window.hermes.winMax());
$('btn-close').addEventListener('click', () => window.hermes.hideWindow());
$('titlebar').addEventListener('dblclick', (e) => {
  if ((e.target as HTMLElement).closest('#win-buttons')) return;
  window.hermes.winMax();
});
$('btn-pin').addEventListener('click', async () => {
  const on = await window.hermes.winPin();
  $('btn-pin').classList.toggle('on', on);
});
window.hermes.onWinState((s) => ($('btn-max').textContent = s.maximized ? '❐' : '□'));

/* ---------------- lista de conversas ---------------- */

async function refreshList(): Promise<void> {
  if (searchEl.value.trim()) return;
  const chats = await window.hermes.chatList();
  const ativas = chats.filter((c) => !c.archived);
  const arquivadas = chats.filter((c) => c.archived);

  listEl.textContent = '';
  if (arquivadas.length) {
    const linha = document.createElement('div');
    linha.className = 'side-label';
    linha.style.cursor = 'pointer';
    linha.textContent = `${mostrandoArquivadas ? '▾' : '▸'} Arquivadas (${arquivadas.length})`;
    linha.addEventListener('click', () => {
      mostrandoArquivadas = !mostrandoArquivadas;
      refreshList();
    });
    listEl.appendChild(linha);
    if (mostrandoArquivadas) for (const c of arquivadas) listEl.appendChild(chatItem(c));
  }
  if (!ativas.length && !arquivadas.length) {
    const vazio = document.createElement('div');
    vazio.className = 'side-label';
    vazio.textContent = 'Nenhuma conversa ainda';
    listEl.appendChild(vazio);
    return;
  }
  for (const c of ativas) listEl.appendChild(chatItem(c));
}

function avatarNode(c: { avatar: string; title: string }): HTMLElement {
  const el = document.createElement('div');
  el.className = 'avatar';
  if (c.avatar) el.style.backgroundImage = `url("${c.avatar}")`;
  else el.textContent = (c.title.trim()[0] ?? '💬').toUpperCase();
  return el;
}

function chatItem(c: ChatSummary): HTMLElement {
  const el = document.createElement('div');
  el.className = 'chat-item' + (chat?.id === c.id ? ' active' : '');
  el.appendChild(avatarNode(c));

  const texto = document.createElement('div');
  texto.className = 'texto';
  const t = document.createElement('div');
  t.className = 't';
  const nome = document.createElement('span');
  nome.textContent = c.title;
  t.appendChild(nome);
  if (c.pinned) {
    const pin = document.createElement('span');
    pin.className = 'marcas';
    pin.textContent = '📌';
    t.appendChild(pin);
  }
  const p = document.createElement('div');
  p.className = 'p';
  p.textContent = c.preview;
  texto.append(t, p);
  el.appendChild(texto);

  const chevron = document.createElement('button');
  chevron.className = 'chat-chevron';
  chevron.textContent = '▾';
  chevron.title = 'Opções da conversa';
  chevron.addEventListener('click', (e) => {
    e.stopPropagation();
    abrirMenu(c, chevron);
  });
  el.appendChild(chevron);

  el.addEventListener('click', () => openChat(c.id));
  el.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    abrirMenu(c, chevron);
  });
  return el;
}

/* ---------------- menu de opções da conversa ---------------- */

function fecharMenu(): void {
  ctxMenu.classList.add('hidden');
  document.querySelectorAll('.chat-chevron.aberto').forEach((b) => b.classList.remove('aberto'));
}

document.addEventListener('click', (e) => {
  if (!(e.target as HTMLElement).closest('#ctx-menu')) fecharMenu();
});
document.addEventListener('keydown', (e) => e.key === 'Escape' && fecharMenu());

function abrirMenu(c: ChatSummary, âncora: HTMLElement): void {
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

  item(c.archived ? 'Desarquivar' : 'Arquivar conversa', async () => {
    await window.hermes.chatMeta(c.id, { archived: !c.archived });
    refreshList();
  });
  item(c.pinned ? 'Desafixar' : 'Fixar no topo', async () => {
    await window.hermes.chatMeta(c.id, { pinned: !c.pinned });
    refreshList();
  });
  item('Renomear', () => renomear(c.id, c.title));
  item('Trocar foto', () => escolherAvatar(c.id));
  ctxMenu.appendChild(document.createElement('hr'));
  item('Exportar como .md', async () => {
    const salvo = await window.hermes.chatExport(c.id);
    status(salvo ? `salvo em ${salvo}` : '');
  });
  item(
    'Limpar conversa',
    async () => {
      if (!confirm(`Apagar todas as mensagens de "${c.title}"? A conversa continua na lista.`)) return;
      const limpa = await window.hermes.chatClear(c.id);
      if (limpa && chat?.id === c.id) {
        chat = limpa;
        showFrom = 0;
        renderMessages();
      }
      refreshList();
    },
    true,
  );
  item(
    'Apagar conversa',
    async () => {
      if (!confirm(`Apagar "${c.title}" de vez? Não dá para desfazer.`)) return;
      await window.hermes.chatDelete(c.id);
      if (chat?.id === c.id) {
        chat = null;
        convTitle.textContent = 'Nova conversa';
        msgsEl.textContent = '';
        pintarAvatarHeader();
      }
      refreshList();
    },
    true,
  );

  const r = âncora.getBoundingClientRect();
  ctxMenu.classList.remove('hidden');
  // encaixa dentro da janela: abre para cima/esquerda quando falta espaço
  const alt = ctxMenu.offsetHeight;
  const larg = ctxMenu.offsetWidth;
  ctxMenu.style.left = `${Math.min(r.left, window.innerWidth - larg - 8)}px`;
  ctxMenu.style.top = `${r.bottom + alt > window.innerHeight ? Math.max(8, r.top - alt) : r.bottom + 4}px`;
  âncora.classList.add('aberto');
}

// o Electron não implementa window.prompt(): usa o <dialog> nativo da página.
// O "confirmou" vem do evento submit, não do returnValue: Enter no campo submete
// sem submitter e o returnValue viria vazio, igualzinho ao cancelar.
let askOk = false;
$('ask-form').addEventListener('submit', () => (askOk = true));
$('ask-cancel').addEventListener('click', () => askDlg.close());

function pedirTexto(rótulo: string, valor: string): Promise<string | null> {
  $('ask-label').textContent = rótulo;
  askInput.value = valor;
  askOk = false;
  askDlg.showModal();
  askInput.select();
  return new Promise((resolve) =>
    askDlg.addEventListener('close', () => resolve(askOk ? askInput.value : null), { once: true }),
  );
}

async function renomear(id: string, atual: string): Promise<void> {
  const titulo = await pedirTexto('Nome da conversa:', atual);
  if (titulo === null) return;
  await window.hermes.chatRename(id, titulo.trim());
  if (chat?.id === id) {
    chat.title = titulo.trim();
    convTitle.textContent = chat.title || 'Conversa sem título';
  }
  refreshList();
}

/* ---------------- foto da conversa ---------------- */

let avatarAlvo = '';

function escolherAvatar(id: string): void {
  avatarAlvo = id;
  avatarInput.click();
}

avatarInput.addEventListener('change', async () => {
  const file = avatarInput.files?.[0];
  avatarInput.value = '';
  if (!file || !avatarAlvo) return;
  try {
    const avatar = await imageToDataUrl(file, AVATAR_SIDE, true);
    await window.hermes.chatMeta(avatarAlvo, { avatar });
    if (chat?.id === avatarAlvo) {
      chat.avatar = avatar;
      pintarAvatarHeader();
    }
    refreshList();
  } catch (e) {
    status(e instanceof Error ? e.message : String(e));
  }
});

function pintarAvatarHeader(): void {
  convAvatar.style.backgroundImage = chat?.avatar ? `url("${chat.avatar}")` : '';
  convAvatar.textContent = chat?.avatar ? '' : '💬';
}

convAvatar.addEventListener('click', () => chat && escolherAvatar(chat.id));

/* ---------------- busca ---------------- */

let searchTimer: ReturnType<typeof setTimeout> | undefined;
searchEl.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(runSearch, 200);
});

async function runSearch(): Promise<void> {
  const q = searchEl.value.trim();
  if (!q) return refreshList();
  const hits = await window.hermes.chatSearch(q);
  listEl.textContent = '';
  const label = document.createElement('div');
  label.className = 'side-label';
  label.textContent = hits.length ? `${hits.length} resultado(s)` : 'nada encontrado';
  listEl.appendChild(label);
  for (const h of hits) {
    const el = document.createElement('div');
    el.className = 'chat-item';
    el.appendChild(avatarNode({ avatar: '', title: h.title }));
    const texto = document.createElement('div');
    texto.className = 'texto';
    const t = document.createElement('div');
    t.className = 't';
    const nome = document.createElement('span');
    nome.textContent = h.title;
    t.appendChild(nome);
    const p = document.createElement('div');
    p.className = 'p';
    p.textContent = h.snippet;
    texto.append(t, p);
    el.appendChild(texto);
    el.addEventListener('click', () => openChat(h.chatId, h.index));
    listEl.appendChild(el);
  }
}

/* ---------------- abrir conversa ---------------- */

async function openChat(id: string, focusIndex?: number): Promise<void> {
  const loaded = await window.hermes.chatOpen(id);
  if (!loaded) return;
  chat = loaded;
  convTitle.textContent = loaded.title || 'Conversa sem título';
  pintarAvatarHeader();
  showFrom = focusIndex !== undefined ? 0 : Math.max(0, loaded.msgs.length - VISIBLE_MSGS);
  renderMessages();
  if (focusIndex !== undefined) {
    msgsEl.querySelector(`[data-i="${focusIndex}"]`)?.scrollIntoView({ block: 'center' });
  }
  refreshList();
}

$('btn-new').addEventListener('click', async () => {
  chat = await window.hermes.chatNew();
  convTitle.textContent = 'Nova conversa';
  pintarAvatarHeader();
  showFrom = 0;
  renderMessages();
  refreshList();
  inputEl.focus();
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
    if (title) {
      convTitle.textContent = title;
      chat.title = title;
    }
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
  refreshList();
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
  // como no WhatsApp: campo vazio mostra o microfone, com texto mostra o enviar.
  // Gravando, o microfone vira o botão de parar e fica no lugar de qualquer jeito.
  const gravando = Boolean(recorder);
  const temTexto = Boolean(inputEl.value.trim() || attachments.length);
  btnSend.classList.toggle('hidden', gravando || !temTexto);
  btnMic.classList.toggle('hidden', !gravando && temTexto);
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

async function imageToDataUrl(file: File, maxSide = MAX_IMG_SIDE, quadrado = false): Promise<string> {
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
  if (!quadrado && maior <= maxSide && raw.length < 1_500_000) return raw;

  const canvas = document.createElement('canvas');
  const ctx2d = canvas.getContext('2d')!;
  if (quadrado) {
    // recorta o centro para a foto redonda não distorcer
    const lado = Math.min(img.width, img.height);
    canvas.width = canvas.height = maxSide;
    ctx2d.drawImage(img, (img.width - lado) / 2, (img.height - lado) / 2, lado, lado, 0, 0, maxSide, maxSide);
  } else {
    const escala = Math.min(1, maxSide / maior);
    canvas.width = Math.round(img.width * escala);
    canvas.height = Math.round(img.height * escala);
    ctx2d.drawImage(img, 0, 0, canvas.width, canvas.height);
  }
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

/* ---------------- áudio: grava e manda, como no WhatsApp ---------------- */

let recorder: MediaRecorder | null = null;
let recChunks: Blob[] = [];
let recTimer: ReturnType<typeof setInterval> | undefined;
let recInicio = 0;
let recCancelado = false;

const timerEl = document.createElement('span');
timerEl.id = 'rec-timer';

function mmss(ms: number): string {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

async function toggleMic(): Promise<void> {
  if (recorder) {
    recorder.stop();
    return;
  }
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch {
    status('sem acesso ao microfone');
    return;
  }
  recChunks = [];
  recCancelado = false;
  recorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });
  recorder.ondataavailable = (e) => e.data.size && recChunks.push(e.data);
  recorder.onstop = async () => {
    stream.getTracks().forEach((t) => t.stop());
    recorder = null;
    clearInterval(recTimer);
    const duracao = Date.now() - recInicio;
    timerEl.remove();
    btnMic.classList.remove('on');
    btnMic.textContent = '🎤';
    autoGrow();
    if (recCancelado) {
      status('gravação descartada');
      return;
    }

    const blob = new Blob(recChunks, { type: 'audio/webm' });
    setState('thinking');
    status('transcrevendo o áudio…');
    try {
      const texto = (await transcribeFile(blob, 'audio.webm')).trim();
      if (!texto) {
        status('não entendi nada no áudio');
        setState('idle');
        return;
      }
      const file = await window.hermes.mediaSave(await blob.arrayBuffer(), 'webm');
      status('');
      await send(texto, 'normal', { file, name: `Áudio ${mmss(duracao)}` });
    } catch (e) {
      status(e instanceof Error ? e.message : String(e));
      setState('idle');
    }
  };

  recorder.start();
  recInicio = Date.now();
  btnMic.classList.add('on');
  btnMic.textContent = '⏹';
  btnMic.title = 'Parar e enviar (Esc descarta)';
  autoGrow();
  btnMic.parentElement!.insertBefore(timerEl, btnMic);
  timerEl.textContent = '0:00';
  recTimer = setInterval(() => (timerEl.textContent = mmss(Date.now() - recInicio)), 250);
  setState('listening');
  status('gravando — clique de novo para enviar');
}

btnMic.addEventListener('click', toggleMic);
window.hermes.onPttToggle(() => toggleMic());
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && recorder) {
    recCancelado = true;
    recorder.stop();
  }
});

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
  else refreshList();
});

(async () => {
  settings = await window.hermes.getSettings();
  applyTheme(settings.theme);
  $('btn-pin').classList.toggle('on', settings.chatPinned);
  await refreshList();
  const chats = await window.hermes.chatList();
  // a conversa ativa é a que o overlay também usa; sem ela, a mais recente
  const alvo =
    chats.find((c) => c.id === settings.activeChatId) ?? chats.find((c) => !c.archived) ?? chats[0];
  if (alvo) await openChat(alvo.id);
  else chat = await window.hermes.chatNew();
  pintarAvatarHeader();
  autoGrow();
  inputEl.focus();
})();
