import { app, BrowserWindow, Tray, Menu, globalShortcut, ipcMain, screen, nativeImage } from 'electron';
import path from 'node:path';
import { appendFileSync, readFileSync } from 'node:fs';
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
  if (!win) return;
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
  const area = screen.getPrimaryDisplay().workArea;
  const pos = settings.position
    ? clampToScreen(settings.position.x, settings.position.y)
    : { x: area.x + area.width - WIN_W - 24, y: area.y + area.height - WIN_H - 24 };

  win = new BrowserWindow({
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
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.loadFile(path.join(__dirname, 'index.html'));
  win.webContents.on('did-finish-load', () => applyScale());
  win.on('closed', () => (win = null));
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
  if (!settings.idleUnloadMin || settings.idleUnloadMin <= 0) return;
  idleHideTimer = setTimeout(() => {
    if (win?.isVisible()) {
      win.hide();
      log(`[idle] ${settings.idleUnloadMin} min sem uso — personagem recolhido para a bandeja`);
    }
  }, settings.idleUnloadMin * 60_000);
}

function buildMenu(): Menu {
  return Menu.buildFromTemplate([
      {
        label: 'Mostrar / ocultar',
        click: () => {
          if (!win) return;
          if (win.isVisible()) {
            win.hide();
          } else {
            win.show();
            bumpIdleHide();
          }
        },
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
        label: 'Personalidade',
        submenu: PERSONA_LABELS.map((p) => ({
          label: p.label,
          type: 'radio' as const,
          checked: settings.persona === p.id,
          click: () => {
            settings.persona = p.id;
            saveSettings(settings);
            refreshTrayMenu();
          },
        })),
      },
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
    win?.show();
    bumpIdleHide();
  });
}

// posição aproximada do centro dos olhos dentro da janela
const EYES_X = 130;
const EYES_Y = 174;
let lastCursor = { x: -1, y: -1 };

function startCursorTracking(): void {
  setInterval(() => {
    if (!win || !win.isVisible()) return;
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
    if (!win.isVisible()) win.show();
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
    const hadGroqKey = Boolean(settings.groqApiKey);
    settings = { ...settings, ...patch };
    // chave Groq recém-preenchida com o app mudo em "texto": a intenção óbvia é falar
    if (!hadGroqKey && settings.groqApiKey && settings.voiceEngine === 'texto') {
      settings.voiceEngine = 'nuvem';
    }
    saveSettings(settings);
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
    startProactive(settings, (text) => {
      if (win && !win.isVisible() && !hiddenByFullscreen) win.show();
      bumpIdleHide();
      win?.webContents.send('proactive', text);
    });
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

  const historyFile = path.join(app.getPath('userData'), 'history.jsonl');

  ipcMain.on('history-add', (_e, entry: { t: string; q: string; a: string }) => {
    try {
      appendFileSync(historyFile, JSON.stringify(entry) + '\n', 'utf-8');
    } catch (err) {
      log(`[history] falha ao gravar: ${err}`);
    }
  });

  ipcMain.handle('history-get', () => {
    try {
      return readFileSync(historyFile, 'utf-8')
        .trim()
        .split('\n')
        .slice(-200)
        .map((l) => {
          try {
            return JSON.parse(l);
          } catch {
            return null;
          }
        })
        .filter(Boolean);
    } catch {
      return [];
    }
  });

  ipcMain.handle('ask-hermes', async (_e, text: string, attachments?: ChatAttachment[]) => {
    bumpIdleHide();
    return askHermes(
      text,
      settings,
      (delta) => win?.webContents.send('hermes-delta', delta),
      attachments,
    );
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
    if (!win || wide === isWide) return;
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

  ipcMain.on('hide-window', () => win?.hide());
  ipcMain.on('quit-app', () => app.quit());
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    win?.show();
    win?.focus();
    bumpIdleHide();
  });

  app.whenReady().then(() => {
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
    startProactive(settings, (text) => {
      if (win && !win.isVisible() && !hiddenByFullscreen) win.show();
      bumpIdleHide();
      win?.webContents.send('proactive', text);
    });
    startProbe(({ obs, fs }) => {
      if (obs !== obsActive) {
        obsActive = obs;
        applyScale();
      }
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
  app.on('window-all-closed', () => app.quit());
}
