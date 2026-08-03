import { app } from 'electron';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { log } from './logger';

// Uma conversa = um .jsonl. A primeira linha é um "meta"; renomear ou trocar a
// sessão acrescenta outro meta e o último vence — nada é reescrito, então um
// crash no meio da escrita nunca corrompe o histórico.
// ponytail: lista e busca leem todos os arquivos; se passar de ~100 MB em chats/, criar chats/index.json

export interface ChatAtt {
  kind: 'image' | 'text' | 'audio';
  name: string;
  dataUrl?: string;
  /** áudio gravado: nome do arquivo em chats/media/, tocado direto do disco */
  file?: string;
  dropped?: boolean;
}

export interface ChatMsg {
  type: 'msg';
  role: 'user' | 'assistant' | 'system';
  t: string;
  text: string;
  atts?: ChatAtt[];
}

export interface ChatMeta {
  type: 'meta';
  id: string;
  title?: string;
  createdAt?: string;
  sessionId?: string;
  /** foto da conversa, data-URL já reduzida pelo renderer */
  avatar?: string;
  pinned?: boolean;
  archived?: boolean;
}

export interface Chat {
  id: string;
  title: string;
  createdAt: string;
  sessionId: string;
  avatar: string;
  pinned: boolean;
  archived: boolean;
  msgs: ChatMsg[];
}

export interface ChatSummary {
  id: string;
  title: string;
  updatedAt: string;
  preview: string;
  avatar: string;
  pinned: boolean;
  archived: boolean;
}

const MAX_STORED_IMAGE = 400_000;

function chatsDir(): string {
  const dir = path.join(app.getPath('userData'), 'chats');
  mkdirSync(dir, { recursive: true });
  return dir;
}

function chatFile(id: string): string {
  return path.join(chatsDir(), `${id}.jsonl`);
}

function newId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/** Grava um áudio gravado no chat e devolve o nome do arquivo. Fica fora do .jsonl
 *  porque um minuto de webm em base64 engordaria a conversa em ~700 KB. */
export function saveMedia(buffer: ArrayBuffer, ext = 'webm'): string {
  const dir = path.join(chatsDir(), 'media');
  mkdirSync(dir, { recursive: true });
  const name = `${newId()}.${ext}`;
  writeFileSync(path.join(dir, name), Buffer.from(buffer));
  return name;
}

export function mediaPath(name: string): string {
  return path.join(chatsDir(), 'media', path.basename(name));
}

function parseLines(raw: string): (ChatMeta | ChatMsg)[] {
  const out: (ChatMeta | ChatMsg)[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // linha truncada por um crash — ignora, como o history-get sempre fez
    }
  }
  return out;
}

export function readChat(id: string): Chat | null {
  let raw: string;
  try {
    raw = readFileSync(chatFile(id), 'utf-8');
  } catch {
    return null;
  }
  const chat: Chat = {
    id,
    title: '',
    createdAt: '',
    sessionId: '',
    avatar: '',
    pinned: false,
    archived: false,
    msgs: [],
  };
  for (const entry of parseLines(raw)) {
    if (entry.type === 'meta') {
      if (entry.title !== undefined) chat.title = entry.title;
      if (entry.createdAt) chat.createdAt = entry.createdAt;
      if (entry.sessionId !== undefined) chat.sessionId = entry.sessionId;
      if (entry.avatar !== undefined) chat.avatar = entry.avatar;
      if (entry.pinned !== undefined) chat.pinned = entry.pinned;
      if (entry.archived !== undefined) chat.archived = entry.archived;
    } else if (entry.type === 'msg') {
      chat.msgs.push(entry);
    }
  }
  return chat;
}

export function newChat(): Chat {
  const id = newId();
  const createdAt = new Date().toISOString();
  const meta: ChatMeta = { type: 'meta', id, title: '', createdAt, sessionId: '' };
  writeFileSync(chatFile(id), JSON.stringify(meta) + '\n', 'utf-8');
  return {
    id,
    title: '',
    createdAt,
    sessionId: '',
    avatar: '',
    pinned: false,
    archived: false,
    msgs: [],
  };
}

/** Apaga as mensagens e zera a sessão, mantendo a conversa (nome, foto, posição). */
export function clearChat(id: string): Chat | null {
  const chat = readChat(id);
  if (!chat) return null;
  chat.msgs = [];
  chat.sessionId = '';
  rewriteChat(chat);
  return chat;
}

export function setMeta(id: string, patch: Partial<Omit<ChatMeta, 'type' | 'id'>>): void {
  try {
    appendFileSync(chatFile(id), JSON.stringify({ type: 'meta', id, ...patch }) + '\n', 'utf-8');
  } catch (err) {
    log(`[chat] falha ao gravar meta de ${id}: ${err}`);
  }
}

export function appendMsg(id: string, msg: ChatMsg): void {
  const atts = msg.atts?.map((a) =>
    a.dataUrl && a.dataUrl.length > MAX_STORED_IMAGE
      ? { kind: a.kind, name: a.name, dropped: true }
      : a,
  );
  try {
    appendFileSync(chatFile(id), JSON.stringify({ ...msg, atts }) + '\n', 'utf-8');
  } catch (err) {
    log(`[chat] falha ao gravar mensagem em ${id}: ${err}`);
  }
}

/** Reescreve a conversa inteira. Único caminho que reescreve arquivo — usado só
 *  por editar/reenviar e regenerar, que precisam descartar mensagens. */
export function rewriteChat(chat: Chat): void {
  const lines = [
    JSON.stringify({
      type: 'meta',
      id: chat.id,
      title: chat.title,
      createdAt: chat.createdAt,
      sessionId: chat.sessionId,
      avatar: chat.avatar,
      pinned: chat.pinned,
      archived: chat.archived,
    }),
    ...chat.msgs.map((m) => JSON.stringify(m)),
  ];
  const tmp = chatFile(chat.id) + '.tmp';
  writeFileSync(tmp, lines.join('\n') + '\n', 'utf-8');
  renameSync(tmp, chatFile(chat.id));
}

export function deleteChat(id: string): void {
  try {
    unlinkSync(chatFile(id));
  } catch (err) {
    log(`[chat] falha ao apagar ${id}: ${err}`);
  }
}

export function listChats(): ChatSummary[] {
  migrateHistory();
  const out: ChatSummary[] = [];
  for (const file of readdirSync(chatsDir())) {
    if (!file.endsWith('.jsonl')) continue;
    const chat = readChat(file.slice(0, -6));
    if (!chat) continue;
    const last = chat.msgs[chat.msgs.length - 1];
    out.push({
      id: chat.id,
      title: chat.title || firstLineTitle(chat) || 'Conversa sem título',
      updatedAt: last?.t ?? chat.createdAt,
      preview: (last?.text ?? '').slice(0, 90).replace(/\s+/g, ' '),
      avatar: chat.avatar,
      pinned: chat.pinned,
      archived: chat.archived,
    });
  }
  // fixadas primeiro, depois as mais recentes
  return out.sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    return a.updatedAt < b.updatedAt ? 1 : -1;
  });
}

function firstLineTitle(chat: Chat): string {
  const first = chat.msgs.find((m) => m.role === 'user');
  return first ? first.text.slice(0, 48).replace(/\s+/g, ' ').trim() : '';
}

/** Título automático a partir da primeira pergunta, se ainda não houver um. */
export function ensureTitle(id: string): string | null {
  const chat = readChat(id);
  if (!chat || chat.title) return null;
  const title = firstLineTitle(chat);
  if (!title) return null;
  setMeta(id, { title });
  return title;
}

function norm(s: string): string {
  return s
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase();
}

export function searchChats(q: string): { chatId: string; title: string; t: string; snippet: string; index: number }[] {
  const needle = norm(q.trim());
  if (!needle) return [];
  const hits: { chatId: string; title: string; t: string; snippet: string; index: number }[] = [];
  for (const file of readdirSync(chatsDir())) {
    if (!file.endsWith('.jsonl')) continue;
    const chat = readChat(file.slice(0, -6));
    if (!chat) continue;
    const title = chat.title || firstLineTitle(chat) || 'Conversa sem título';
    chat.msgs.forEach((m, index) => {
      if (hits.length >= 50) return;
      const at = norm(m.text).indexOf(needle);
      if (at < 0) return;
      hits.push({
        chatId: chat.id,
        title,
        t: m.t,
        index,
        snippet: m.text.slice(Math.max(0, at - 60), at + needle.length + 60).replace(/\s+/g, ' '),
      });
    });
  }
  return hits;
}

export function exportChat(id: string): { name: string; markdown: string } | null {
  const chat = readChat(id);
  if (!chat) return null;
  const title = chat.title || firstLineTitle(chat) || 'Conversa';
  const parts = [`# ${title}`, ''];
  for (const m of chat.msgs) {
    if (m.role === 'system') {
      parts.push(`> _${m.text}_`, '');
      continue;
    }
    const hora = new Date(m.t).toLocaleString('pt-BR');
    parts.push(`**${m.role === 'user' ? 'Você' : 'Hermes'}** — ${hora}`, '');
    for (const a of m.atts ?? []) parts.push(`> 📎 ${a.name}`);
    if (m.atts?.length) parts.push('');
    parts.push(m.text, '');
  }
  return { name: `${title.replace(/[\\/:*?"<>|]/g, '-')}.md`, markdown: parts.join('\n') };
}

/** Traz o history.jsonl do modo overlay para dentro do chat, uma única vez. */
function migrateHistory(): void {
  const marker = path.join(chatsDir(), '.migrated');
  if (existsSync(marker)) return;
  writeFileSync(marker, '', 'utf-8');
  let raw: string;
  try {
    raw = readFileSync(path.join(app.getPath('userData'), 'history.jsonl'), 'utf-8');
  } catch {
    return;
  }
  const entries = parseLines(raw) as unknown as { t: string; q: string; a: string }[];
  if (!entries.length) return;
  const chat = newChat();
  setMeta(chat.id, { title: 'Histórico anterior (voz)' });
  for (const e of entries) {
    if (!e || typeof e.a !== 'string') continue;
    if (e.q) appendMsg(chat.id, { type: 'msg', role: 'user', t: e.t, text: e.q });
    appendMsg(chat.id, { type: 'msg', role: 'assistant', t: e.t, text: e.a });
  }
  log(`[chat] migradas ${entries.length} entradas do history.jsonl`);
}

/** Contexto local reenviado quando a sessão do servidor se perde ou é rotacionada. */
export function recapPrompt(msgs: ChatMsg[], text: string): string {
  if (!msgs.length) return text;
  let recap = '';
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m.role === 'system') continue;
    const line = `${m.role === 'user' ? 'Você' : 'Hermes'}: ${m.text}\n`;
    if (recap.length + line.length > 6000) break;
    recap = line + recap;
  }
  return `Contexto da conversa até aqui:\n${recap}\nAgora: ${text}`;
}
