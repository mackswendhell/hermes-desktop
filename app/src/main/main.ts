import {
  app,
  BrowserWindow,
  Tray,
  Menu,
  globalShortcut,
  ipcMain,
  screen,
  nativeImage,
  shell,
  dialog,
  Notification,
} from 'electron';
import path from 'node:path';
import { writeFileSync } from 'node:fs';
import { loadSettings, saveSettings, Settings, Persona } from './settings';
import { log } from './logger';
import {
  startVoiceServer,
  stopVoiceServer,
  isVoiceServerUp,
  setVoiceServerDir,
  setVoiceIdleMinutes,
  hasVoiceServerVenv,
} from './voiceServer';
import { ensureWhisper, transcribeLocal, whisperReady, whisperAvailable } from './whisperLocal';
import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts';
import { askHermes, testBridge, ChatAttachment } from './hermes';
import { createChatWindow } from './chatWindow';
import {
  appendMsg,
  clearChat,
  deleteChat,
  ensureTitle,
  exportChat,
  listChats,
  mediaPath,
  newChat,
  readChat,
  saveMedia,
  recapPrompt,
  rewriteChat,
  searchChats,
  setMeta,
  ChatMsg,
  Chat,
} from './chatStore';
import { chatSystemPrompt } from './hermes';
import { extractFile } from './extract';
import { startTunnel, stopTunnel } from './tunnel';
import { openSettingsWindow } from './settingsWindow';
import { ensureSshKey } from './sshKey';
import { startProbe, stopProbe } from './probe';
import { startProactive, stopProactive } from './proactive';
import { autoConfigureVps } from './vpsSetup';

const WIN_W = 260;
const WIN_H = 340;
const WIDE_W = 490; // largura com o balão de fala aberto à direita

let win: BrowserWindow | null = null;
let tray: Tray | null = null;
let settings: Settings;
let dragStartPos: { x: number; y: number } | null = null;
let isWide = false;
let obsActive = false;
let hiddenByFullscreen = false;

let windowsVoices: string[] = [];
const inFlight = new Map<string, AbortController>();

const ENGINES: { label: string; id: 'xtts' | 'leve' | 'texto' | 'nuvem' }[] = [
  { label: 'Voz completa (XTTS local — GPU NVIDIA ou Apple Silicon)', id: 'xtts' },
  { label: 'Voz na nuvem (grátis, sem GPU)', id: 'nuvem' },
  { label: 'Voz leve (voz do sistema)', id: 'leve' },
  { label: 'Só texto', id: 'texto' },
];

function voiceProgress(msg: string): void {
  win?.webContents.send('voice-progress', msg);
}

const SIZES: { label: string; id: string; scale: number }[] = [
  { label: 'Clippy', id: 'clippy', scale: 0.36 },
  { label: 'Pequeno', id: 'pequeno', scale: 0.72 },
  { label: 'Médio', id: 'medio', scale: 1 },
  { label: 'Grande', id: 'grande', scale: 1.25 },
];

function uiScale(): number {
  const base = SIZES.find((s) => s.id === settings.size)?.scale ?? 1;
  // com o OBS aberto, entra no modo reduzido (mas tudo continua funcionando)
  return obsActive ? Math.min(base, 0.72) : base;
}

function applyScale(): void {
  if (!win || settings.uiMode === 'chat') return;
  const s = uiScale();
  win.webContents.setZoomFactor(s);
  const [x, y] = win.getPosition();
  win.setResizable(true);
  win.setBounds({
    x,
    y,
    width: Math.round((isWide ? WIDE_W : WIN_W) * s),
    height: Math.round(WIN_H * s),
  });
  win.setResizable(false);
}

function clampToScreen(x: number, y: number): { x: number; y: number } {
  const area = screen.getDisplayNearestPoint({ x, y }).workArea;
  return {
    x: Math.min(Math.max(x, area.x - WIN_W + 60), area.x + area.width - 60),
    y: Math.min(Math.max(y, area.y - 20), area.y + area.height - 80),
  };
}

function createWindow(): void {
  win = settings.uiMode === 'chat' ? createChatWindow(settings, saveChatBounds) : createOverlayWindow();
  // arquivo solto na janela ou link clicado no markdown não podem navegar a página
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  // erro de renderer sem DevTools aberto é invisível; no app.log dá para depurar.
  // Só nível 3 (error): warning de biblioteca não é problema do usuário.
  win.webContents.on('console-message', (_e, level, message, line, source) => {
    if (level >= 3) log(`[renderer] ${source}:${line} ${message}`);
  });
  win.on('focus', () => setBadge(false));
  win.on('closed', () => (win = null));
}

function saveChatBounds(b: { x: number; y: number; width: number; height: number }): void {
  settings.chatBounds = b;
  saveSettings(settings);
}

// trocar de modo troca a janela inteira; relaunch derrubaria túnel e voice-server
function switchMode(mode: 'overlay' | 'chat'): void {
  if (mode === settings.uiMode) return;
  settings.uiMode = mode;
  saveSettings(settings);
  applyMode();
}

function applyMode(): void {
  win?.destroy();
  createWindow();
  refreshTrayMenu();
  bumpIdleHide();
  log(`[modo] ${settings.uiMode}`);
}

// show() sozinho não restaura janela minimizada
function showWin(): void {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  setBadge(false);
}

function setBadge(on: boolean): void {
  // app.setBadgeCount() é no-op no Windows; o que funciona é o overlay do botão da barra
  tray?.setToolTip(on ? 'Hermes — mensagem nova' : 'Hermes — assistente de voz');
  if (process.platform === 'darwin') {
    app.dock?.setBadge(on ? '●' : '');
    return;
  }
  if (process.platform !== 'win32' || !win || win.isDestroyed()) return;
  win.setOverlayIcon(
    on ? nativeImage.createFromPath(path.join(__dirname, 'assets', 'badge.png')) : null,
    on ? 'mensagens novas' : '',
  );
}

// os dois modos escrevem e leem a mesma conversa: a última aberta no chat.
// Sem ela (primeira execução, conversa apagada), cai na mais recente da lista.
function activeChat(): Chat {
  const atual = settings.activeChatId ? readChat(settings.activeChatId) : null;
  if (atual) return atual;
  const primeira = listChats()[0];
  const chat = (primeira && readChat(primeira.id)) ?? newChat();
  setActiveChat(chat.id);
  return chat;
}

function setActiveChat(id: string): void {
  if (settings.activeChatId === id) return;
  settings.activeChatId = id;
  saveSettings(settings);
}

function onProactive(text: string): void {
  const chatId = activeChat().id;
  appendMsg(chatId, { type: 'msg', role: 'assistant', t: new Date().toISOString(), text });
  if (settings.uiMode === 'overlay') {
    if (win && !win.isVisible() && !hiddenByFullscreen) win.show();
    bumpIdleHide();
    win?.webContents.send('proactive', text);
    return;
  }
  // no chat ele nunca fala nem rouba foco: só avisa pelo Windows
  if (win?.isVisible() && !win.isMinimized() && win.isFocused()) {
    win.webContents.send('proactive', text, chatId);
    return;
  }
  const note = new Notification({ title: 'Hermes', body: text.slice(0, 250) });
  note.on('click', () => {
    showWin();
    win?.webContents.send('chat-open', chatId);
  });
  note.show();
  setBadge(true);
}

function createOverlayWindow(): BrowserWindow {
  const area = screen.getPrimaryDisplay().workArea;
  const pos = settings.position
    ? clampToScreen(settings.position.x, settings.position.y)
    : { x: area.x + area.width - WIN_W - 24, y: area.y + area.height - WIN_H - 24 };

  const overlay = new BrowserWindow({
    width: WIN_W,
    height: WIN_H,
    x: pos.x,
    y: pos.y,
    frame: false,
    transparent: true,
    resizable: false,
    skipTaskbar: true,
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  overlay.setAlwaysOnTop(true, 'screen-saver');
  overlay.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  overlay.loadFile(path.join(__dirname, 'index.html'));
  overlay.webContents.on('did-finish-load', () => applyScale());
  return overlay;
}

function applyAutoStart(): void {
  app.setLoginItemSettings({
    openAtLogin: settings.autoStart,
    path: process.execPath,
    args: app.isPackaged ? [] : [app.getAppPath()],
  });
}

const VOICES: { label: string; id: string }[] = [
  { label: 'Grave — Damien Black', id: 'Damien Black' },
  { label: 'Grave — Viktor Menelaos', id: 'Viktor Menelaos' },
  { label: 'Grave — Aaron Dreschner', id: 'Aaron Dreschner' },
  { label: 'Grave — Ludvig Milivoj', id: 'Ludvig Milivoj' },
  { label: 'Masculina — Luis Moray', id: 'Luis Moray' },
  { label: 'Masculina — Marcos Rudaski', id: 'Marcos Rudaski' },
  { label: 'Feminina — Ana Florence', id: 'Ana Florence' },
  { label: 'Feminina — Sofia Hellen', id: 'Sofia Hellen' },
];

const EDGE_VOICES: { label: string; id: string }[] = [
  { label: 'Masculina — Antonio', id: 'pt-BR-AntonioNeural' },
  { label: 'Feminina — Francisca', id: 'pt-BR-FranciscaNeural' },
  { label: 'Feminina — Thalita', id: 'pt-BR-ThalitaMultilingualNeural' },
];

const PERSONA_LABELS: { label: string; id: Persona }[] = [
  { label: 'Cavaleiro — servo leal em missão', id: 'cavaleiro' },
  { label: 'Normal — assistente direto', id: 'normal' },
];

const THEMES: { label: string; id: string }[] = [
  { label: 'Dourado Hermes (fosco)', id: 'dourado' },
  { label: 'Azul índigo', id: 'azul' },
  { label: 'Verde esmeralda', id: 'verde' },
  { label: 'Grafite', id: 'grafite' },
  { label: 'Roxo ametista', id: 'roxo' },
  { label: 'Ciano ártico', id: 'ciano' },
];

function notifySettingsChanged(): void {
  win?.webContents.send('settings-changed', settings);
}

// mesmo tempo da hibernação da voz: sem uso, o personagem recolhe para a bandeja
// (segue ativo — os modelos de voz hibernam por conta própria no server.py)
let idleHideTimer: ReturnType<typeof setTimeout> | undefined;

function bumpIdleHide(): void {
  clearTimeout(idleHideTimer);
  // no modo chat a janela nunca se recolhe sozinha (a VRAM hiberna pelo server.py de qualquer jeito)
  if (settings.uiMode === 'chat') return;
  if (!settings.idleUnloadMin || settings.idleUnloadMin <= 0) return;
  idleHideTimer = setTimeout(() => {
    if (win?.isVisible()) {
      win.hide();
      log(`[idle] ${settings.idleUnloadMin} min sem uso — personagem recolhido para a bandeja`);
    }
  }, settings.idleUnloadMin * 60_000);
}

const MODES: { label: string; id: 'overlay' | 'chat' }[] = [
  { label: 'Personagem flutuante', id: 'overlay' },
  { label: 'Janela de chat', id: 'chat' },
];

function buildMenu(): Menu {
  const overlayOnly: Electron.MenuItemConstructorOptions[] =
    settings.uiMode !== 'overlay'
      ? []
      : [
          {
            label: 'Tamanho',
            submenu: SIZES.map((sz) => ({
              label: sz.label,
              type: 'radio' as const,
              checked: settings.size === sz.id,
              click: () => {
                settings.size = sz.id;
                saveSettings(settings);
                refreshTrayMenu();
                applyScale();
              },
            })),
          },
          {
            label: 'Posição da fala',
            submenu: [
              { label: 'Lado esquerdo da tela', id: 'left' as const },
              { label: 'Lado direito da tela', id: 'right' as const },
            ].map((p) => ({
              label: p.label,
              type: 'radio' as const,
              checked: settings.speechSide === p.id,
              click: () => {
                settings.speechSide = p.id;
                saveSettings(settings);
                refreshTrayMenu();
                notifySettingsChanged();
              },
            })),
          },
        ];

  return Menu.buildFromTemplate([
      {
        label: 'Mostrar / ocultar',
        click: () => {
          if (!win) return;
          if (win.isVisible() && !win.isMinimized()) win.hide();
          else showWin();
        },
      },
      {
        label: 'Modo',
        submenu: MODES.map((m) => ({
          label: m.label,
          type: 'radio' as const,
          checked: settings.uiMode === m.id,
          click: () => switchMode(m.id),
        })),
      },
      {
        label: `Falar (${settings.hotkey.replace('Control', 'Ctrl')})`,
        click: () => win?.webContents.send('ptt-toggle'),
      },
      {
        label: 'Voz',
        submenu: [
          ...ENGINES.map((eng) => ({
            label: eng.label,
            type: 'radio' as const,
            checked: settings.voiceEngine === eng.id,
            click: () => {
              settings.voiceEngine = eng.id;
              saveSettings(settings);
              refreshTrayMenu();
              notifySettingsChanged();
              if (eng.id === 'xtts') {
                startVoiceServer();
              } else {
                stopVoiceServer();
                if (!whisperReady()) {
                  ensureWhisper(voiceProgress).catch((err) =>
                    voiceProgress(`falha ao baixar a voz leve: ${err.message}`),
                  );
                }
              }
            },
          })),
          { type: 'separator' as const },
          {
            label: 'Sem voz (só texto)',
            type: 'checkbox' as const,
            checked: settings.muted,
            click: (item: Electron.MenuItem) => {
              settings.muted = item.checked;
              saveSettings(settings);
              refreshTrayMenu();
              notifySettingsChanged();
            },
          },
          { type: 'separator' as const },
          ...(settings.voiceEngine === 'xtts'
            ? VOICES.map((v) => ({
                label: v.label,
                type: 'radio' as const,
                checked: settings.ttsSpeaker === v.id,
                click: () => {
                  settings.ttsSpeaker = v.id;
                  saveSettings(settings);
                  refreshTrayMenu();
                },
              }))
            : settings.voiceEngine === 'nuvem'
            ? EDGE_VOICES.map((v) => ({
                label: v.label,
                type: 'radio' as const,
                checked: settings.edgeVoice === v.id,
                click: () => {
                  settings.edgeVoice = v.id;
                  saveSettings(settings);
                  refreshTrayMenu();
                },
              }))
            : windowsVoices.map((name) => ({
                label: name.replace('Microsoft ', ''),
                type: 'radio' as const,
                checked: settings.windowsVoice === name,
                click: () => {
                  settings.windowsVoice = name;
                  saveSettings(settings);
                  refreshTrayMenu();
                  notifySettingsChanged();
                },
              }))),
        ],
      },
      {
        // cada modo guarda a sua: cavaleiro na voz, direto no chat, ambos configuráveis
        label: settings.uiMode === 'chat' ? 'Personalidade (no chat)' : 'Personalidade',
        submenu: PERSONA_LABELS.map((p) => ({
          label: p.label,
          type: 'radio' as const,
          checked: (settings.uiMode === 'chat' ? settings.chatPersona : settings.persona) === p.id,
          click: () => {
            if (settings.uiMode === 'chat') settings.chatPersona = p.id;
            else settings.persona = p.id;
            saveSettings(settings);
            refreshTrayMenu();
          },
        })),
      },
      ...overlayOnly,
      {
        label: 'Cor',
        submenu: THEMES.map((t) => ({
          label: t.label,
          type: 'radio' as const,
          checked: settings.theme === t.id,
          click: () => {
            settings.theme = t.id;
            saveSettings(settings);
            refreshTrayMenu();
            notifySettingsChanged();
          },
        })),
      },
      {
        label: 'Iniciar com o sistema',
        type: 'checkbox',
        checked: settings.autoStart,
        click: (item) => {
          settings.autoStart = item.checked;
          saveSettings(settings);
          applyAutoStart();
        },
      },
      { label: 'Configurações…', click: () => openSettingsWindow() },
      { type: 'separator' },
      { label: 'Sair', click: () => app.quit() },
  ]);
}

function refreshTrayMenu(): void {
  tray?.setContextMenu(buildMenu());
}

function createTray(): void {
  // no macOS o ícone da menu bar é template image (nome termina em "Template")
  const trayFile = process.platform === 'darwin' ? 'trayTemplate.png' : 'tray.png';
  const icon = nativeImage.createFromPath(path.join(__dirname, 'assets', trayFile));
  tray = new Tray(icon);
  tray.setToolTip('Hermes — assistente de voz');
  refreshTrayMenu();
  tray.on('click', () => {
    showWin();
    bumpIdleHide();
  });
}

// posição aproximada do centro dos olhos dentro da janela
const EYES_X = 130;
const EYES_Y = 174;
let lastCursor = { x: -1, y: -1 };

function startCursorTracking(): void {
  setInterval(() => {
    // no modo chat os olhos seguem o mousemove do DOM, dentro da janela
    if (!win || !win.isVisible() || settings.uiMode === 'chat') return;
    const c = screen.getCursorScreenPoint();
    if (Math.abs(c.x - lastCursor.x) < 2 && Math.abs(c.y - lastCursor.y) < 2) return;
    lastCursor = c;
    const [wx, wy] = win.getPosition();
    const s = uiScale();
    const eyesX = (isWide && settings.speechSide === 'left' ? EYES_X + (WIDE_W - WIN_W) : EYES_X) * s;
    win.webContents.send('cursor-move', c.x - (wx + eyesX), c.y - (wy + EYES_Y * s));
  }, 40);
}

function registerHotkey(): void {
  globalShortcut.unregisterAll();
  const ok = globalShortcut.register(settings.hotkey, () => {
    log(`[hotkey] ${settings.hotkey} pressionado`);
    if (!win) return;
    showWin();
    bumpIdleHide();
    win.webContents.send('ptt-toggle');
  });
  log(ok ? `[hotkey] ${settings.hotkey} registrado` : `[hotkey] FALHA ao registrar ${settings.hotkey}`);
}

function setupIpc(): void {
  ipcMain.on('drag-start', () => {
    if (!win) return;
    const [x, y] = win.getPosition();
    dragStartPos = { x, y };
  });

  ipcMain.on('drag-move', (_e, dx: number, dy: number) => {
    if (!win || !dragStartPos) return;
    const p = clampToScreen(dragStartPos.x + dx, dragStartPos.y + dy);
    win.setPosition(p.x, p.y);
  });

  ipcMain.on('drag-end', () => {
    if (!win) return;
    const [x, y] = win.getPosition();
    settings.position = { x, y };
    saveSettings(settings);
    dragStartPos = null;
    bumpIdleHide();
  });

  ipcMain.handle('get-settings', () => settings);

  ipcMain.handle('save-settings', (_e, patch: Partial<Settings>) => {
    const oldHotkey = settings.hotkey;
    const oldIdle = settings.idleUnloadMin;
    const oldMode = settings.uiMode;
    const hadGroqKey = Boolean(settings.groqApiKey);
    settings = { ...settings, ...patch };
    // chave Groq recém-preenchida com o app mudo em "texto": a intenção óbvia é falar
    if (!hadGroqKey && settings.groqApiKey && settings.voiceEngine === 'texto') {
      settings.voiceEngine = 'nuvem';
    }
    saveSettings(settings);
    // o modo define qual janela existe, então qualquer caminho que o mude tem de recriá-la
    if (settings.uiMode !== oldMode) applyMode();
    setVoiceServerDir(settings.voiceServerDir);
    setVoiceIdleMinutes(settings.idleUnloadMin);
    if (settings.hotkey !== oldHotkey) registerHotkey();
    applyAutoStart();
    applyScale();
    stopTunnel();
    startTunnel(settings);
    if (settings.voiceEngine !== 'xtts') {
      stopVoiceServer();
    } else if (settings.idleUnloadMin !== oldIdle) {
      // reinicia o servidor de voz para aplicar o novo tempo de hibernação
      stopVoiceServer();
      setTimeout(() => startVoiceServer(), 2000);
    } else {
      startVoiceServer();
    }
    startProactive(settings, onProactive);
    refreshTrayMenu();
    notifySettingsChanged();
    bumpIdleHide();
    return settings;
  });

  ipcMain.handle('gen-ssh-key', () => ensureSshKey());
  ipcMain.handle('test-bridge', () => testBridge(settings));

  ipcMain.handle('vps-setup', async () => {
    const result = await autoConfigureVps(settings);
    if (result.token) {
      settings.bridgeToken = result.token;
      saveSettings(settings);
      stopTunnel();
      startTunnel(settings);
    }
    return result;
  });

  // o painel do overlay mostra a mesma conversa do chat, em pares pergunta/resposta.
  // Proativa é assistant sem user antes, e sai com q vazio — como no history.jsonl antigo.
  ipcMain.handle('history-get', () => {
    const out: { t: string; q: string; a: string }[] = [];
    let q = '';
    for (const m of activeChat().msgs) {
      if (m.role === 'user') q = m.text;
      else if (m.role === 'assistant') {
        out.push({ t: m.t, q, a: m.text });
        q = '';
      }
    }
    return out.slice(-200);
  });

  ipcMain.handle('ask-hermes', async (_e, text: string, attachments?: ChatAttachment[]) => {
    bumpIdleHide();
    const chat = activeChat();
    appendMsg(chat.id, {
      type: 'msg',
      role: 'user',
      t: new Date().toISOString(),
      text,
      atts: (attachments ?? []).map((a) =>
        a.kind === 'image'
          ? { kind: 'image' as const, name: a.name, dataUrl: a.dataUrl }
          : { kind: 'text' as const, name: a.name },
      ),
    });
    // sessão perdida no servidor: reenvia o contexto local uma vez
    const prompt = chat.sessionId || !chat.msgs.length ? text : recapPrompt(chat.msgs, text);
    const reply = await askHermes(prompt, settings, (delta) => win?.webContents.send('hermes-delta', '', delta), {
      attachments,
      sessionId: chat.sessionId,
      onSessionId: (id) => setMeta(chat.id, { sessionId: id }),
    });
    appendMsg(chat.id, { type: 'msg', role: 'assistant', t: new Date().toISOString(), text: reply });
    ensureTitle(chat.id);
    return reply;
  });

  ipcMain.on('ask-abort', (_e, reqId: string) => {
    inFlight.get(reqId)?.abort();
    inFlight.delete(reqId);
  });

  ipcMain.handle('extract-file', (_e, name: string, buffer: ArrayBuffer) => extractFile(name, buffer));

  ipcMain.handle('chat-list', () => listChats());
  // abrir ou criar uma conversa no chat é o que define para onde o overlay fala
  ipcMain.handle('chat-open', (_e, id: string) => {
    const chat = readChat(id);
    if (chat) setActiveChat(id);
    return chat;
  });
  ipcMain.handle('chat-new', () => {
    const chat = newChat();
    setActiveChat(chat.id);
    return chat;
  });
  ipcMain.handle('chat-rename', (_e, id: string, title: string) => setMeta(id, { title }));
  ipcMain.handle('chat-delete', (_e, id: string) => {
    deleteChat(id);
    if (settings.activeChatId === id) setActiveChat('');
  });
  ipcMain.handle('chat-clear', (_e, id: string) => clearChat(id));
  ipcMain.handle('media-save', (_e, buf: ArrayBuffer, ext: string) => saveMedia(buf, ext));
  ipcMain.handle('media-path', (_e, name: string) => mediaPath(name));
  ipcMain.handle('chat-meta', (_e, id: string, patch: Record<string, unknown>) => setMeta(id, patch));
  ipcMain.handle('chat-search', (_e, q: string) => searchChats(q));

  ipcMain.handle('chat-export', async (_e, id: string) => {
    const out = exportChat(id);
    if (!out) return null;
    const { canceled, filePath } = await dialog.showSaveDialog({
      defaultPath: out.name,
      filters: [{ name: 'Markdown', extensions: ['md'] }],
    });
    if (canceled || !filePath) return null;
    writeFileSync(filePath, out.markdown, 'utf-8');
    return filePath;
  });

  // O main é o dono do disco: grava a pergunta antes de chamar e a resposta ao terminar.
  ipcMain.handle(
    'chat-ask',
    async (
      _e,
      req: {
        chatId: string;
        reqId: string;
        text: string;
        attachments?: ChatAttachment[];
        /** áudio gravado no chat: fica tocável na bolha, o modelo recebe a transcrição */
        audio?: { file: string; name: string };
        /** regenerar: não grava a pergunta e substitui a última resposta */
        mode?: 'normal' | 'regen';
      },
    ) => {
      const chat = readChat(req.chatId);
      if (!chat) throw new Error('Conversa não encontrada');

      const now = () => new Date().toISOString();
      if (req.mode !== 'regen') {
        appendMsg(req.chatId, {
          type: 'msg',
          role: 'user',
          t: now(),
          text: req.text,
          atts: [
            ...(req.audio ? [{ kind: 'audio' as const, ...req.audio }] : []),
            ...(req.attachments ?? []).map((a) =>
              a.kind === 'image'
                ? { kind: 'image' as const, name: a.name, dataUrl: a.dataUrl }
                : { kind: 'text' as const, name: a.name },
            ),
          ],
        });
      }

      // sessão perdida no servidor: reenvia o contexto local uma vez
      const prompt = chat.sessionId || !chat.msgs.length ? req.text : recapPrompt(chat.msgs, req.text);

      const controller = new AbortController();
      inFlight.set(req.reqId, controller);
      const timeout = setTimeout(() => controller.abort(), 300_000);
      let reply = '';
      try {
        reply = await askHermes(
          prompt,
          settings,
          (delta) => win?.webContents.send('hermes-delta', req.reqId, delta),
          {
            attachments: req.attachments,
            sessionId: chat.sessionId,
            system: chatSystemPrompt(settings.chatPersona),
            signal: controller.signal,
            onSessionId: (id) => {
              const perdeu = Boolean(chat.sessionId) && chat.sessionId !== id && chat.msgs.length > 0;
              setMeta(req.chatId, { sessionId: id });
              if (perdeu) {
                appendMsg(req.chatId, {
                  type: 'msg',
                  role: 'system',
                  t: now(),
                  text: 'O Hermes começou uma sessão nova — ele pode não lembrar do que veio antes.',
                });
              }
            },
          },
        );
      } finally {
        clearTimeout(timeout);
        inFlight.delete(req.reqId);
      }

      if (req.mode === 'regen') {
        const atual = readChat(req.chatId)!;
        const last = atual.msgs[atual.msgs.length - 1];
        if (last?.role === 'assistant') atual.msgs.pop();
        atual.msgs.push({ type: 'msg', role: 'assistant', t: now(), text: reply });
        rewriteChat(atual);
      } else {
        appendMsg(req.chatId, { type: 'msg', role: 'assistant', t: now(), text: reply });
      }
      const title = ensureTitle(req.chatId);
      return { reply, title };
    },
  );

  // editar e reenviar: trunca a conversa e rotaciona a sessão, porque o contexto
  // é server-side e o modelo veria a pergunta velha e a nova ao mesmo tempo
  ipcMain.handle('chat-truncate', (_e, id: string, index: number) => {
    const chat = readChat(id);
    if (!chat) return null;
    chat.msgs = chat.msgs.slice(0, index);
    chat.sessionId = '';
    rewriteChat(chat);
    return chat;
  });

  ipcMain.on('win-min', () => win?.minimize());
  ipcMain.on('win-max', () => {
    if (!win) return;
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
  });

  ipcMain.handle('win-pin', () => {
    settings.chatPinned = !settings.chatPinned;
    saveSettings(settings);
    win?.setAlwaysOnTop(settings.chatPinned);
    return settings.chatPinned;
  });

  ipcMain.on('open-external', (_e, url: string) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
  });

  ipcMain.handle('voice-server-up', () => isVoiceServerUp());

  ipcMain.handle('stt-local', async (_e, buf: ArrayBuffer) => {
    bumpIdleHide();
    if (!whisperReady()) await ensureWhisper(voiceProgress);
    return transcribeLocal(Buffer.from(buf));
  });

  ipcMain.handle('tts-nuvem', async (_e, text: string) => {
    const tts = new MsEdgeTTS();
    await tts.setMetadata(settings.edgeVoice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
    try {
      // o texto entra num template SSML sem escape — proteger o XML
      const safe = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      const { audioStream } = tts.toStream(safe);
      const chunks: Buffer[] = [];
      for await (const chunk of audioStream) chunks.push(chunk as Buffer);
      const buf = Buffer.concat(chunks);
      return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    } finally {
      tts.close();
    }
  });

  ipcMain.on('windows-voices', (_e, names: string[]) => {
    windowsVoices = names;
    if (!settings.windowsVoice && names.length) {
      settings.windowsVoice = names.find((n) => /luciana|joana|maria|francisca/i.test(n)) ?? names[0];
      saveSettings(settings);
    }
    refreshTrayMenu();
  });

  ipcMain.on('set-wide', (_e, wide: boolean) => {
    if (!win || wide === isWide || settings.uiMode === 'chat') return;
    const s = uiScale();
    const [x, y] = win.getPosition();
    const delta = Math.round((WIDE_W - WIN_W) * s);
    // com a fala à esquerda da tela, a janela cresce para a esquerda
    // para o personagem não sair do lugar
    const nx = settings.speechSide === 'left' ? (wide ? x - delta : x + delta) : x;
    win.setResizable(true);
    win.setBounds({
      x: nx,
      y,
      width: Math.round((wide ? WIDE_W : WIN_W) * s),
      height: Math.round(WIN_H * s),
    });
    win.setResizable(false);
    isWide = wide;
  });

  ipcMain.on('open-menu', () => {
    if (win) buildMenu().popup({ window: win });
    refreshTrayMenu();
    bumpIdleHide();
  });

  // send, não invoke: switchMode destrói a janela que fez a chamada
  ipcMain.on('set-ui-mode', (_e, mode: 'overlay' | 'chat') => switchMode(mode));

  ipcMain.on('hide-window', () => win?.hide());
  ipcMain.on('quit-app', () => app.quit());
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    showWin();
    bumpIdleHide();
  });

  app.whenReady().then(() => {
    // sem isso o Windows mostra as notificações como "electron.app.Electron" — ou não mostra
    app.setAppUserModelId('com.macks.hermes-assistente');
    // no macOS, Cmd+V/C/X/A só funcionam com um menu de aplicativo com os papéis de edição
    if (process.platform === 'darwin') {
      Menu.setApplicationMenu(Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }]));
    }
    settings = loadSettings();
    setVoiceServerDir(settings.voiceServerDir);
    setVoiceIdleMinutes(settings.idleUnloadMin);
    // sem o ambiente da voz completa (outro PC, por exemplo), cai para a nuvem ou voz leve
    if (settings.voiceEngine === 'xtts' && !hasVoiceServerVenv()) {
      settings.voiceEngine = settings.groqApiKey ? 'nuvem' : whisperAvailable() ? 'leve' : 'texto';
      saveSettings(settings);
      log(`[voice] voice-server ausente — usando voz ${settings.voiceEngine}`);
    }
    createWindow();
    createTray();
    registerHotkey();
    setupIpc();
    // primeiro uso: sem VPS configurada, abre direto as Configurações
    if (!settings.vpsHost && !settings.bridgeUrl) openSettingsWindow();
    applyAutoStart();
    startCursorTracking();
    if (settings.voiceEngine === 'xtts') startVoiceServer();
    else if (!whisperReady()) ensureWhisper(voiceProgress).catch(() => undefined);
    startTunnel(settings);
    bumpIdleHide();
    startProactive(settings, onProactive);
    startProbe(({ obs, fs }) => {
      if (obs !== obsActive) {
        obsActive = obs;
        applyScale();
      }
      // esconder uma janela de chat porque um vídeo entrou em tela cheia seria surpresa ruim
      if (settings.uiMode === 'chat') return;
      if (fs && win?.isVisible()) {
        win.hide();
        hiddenByFullscreen = true;
      } else if (!fs && hiddenByFullscreen) {
        win?.show();
        hiddenByFullscreen = false;
        bumpIdleHide();
      }
    });
  });

  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
    stopVoiceServer();
    stopTunnel();
    stopProbe();
    stopProactive();
  });
  // app de bandeja: fechar a janela nunca encerra o app (sair só pelo menu do tray).
  // Também protege a troca de modo, que destrói a janela antes de recriar.
  app.on('window-all-closed', () => {});
}
