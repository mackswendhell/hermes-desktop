import { app, BrowserWindow } from 'electron';
import path from 'node:path';
import { Settings } from './settings';

type Bounds = { x: number; y: number; width: number; height: number };

let saindo = false;
app.on('before-quit', () => (saindo = true));

// Janela do modo chat. Ao contrário do overlay ela é uma janela de verdade:
// transparent:false porque no Windows uma janela transparente perde a borda de
// resize, o snap (Win+setas) e a animação de minimizar.
export function createChatWindow(settings: Settings, onBounds: (b: Bounds) => void): BrowserWindow {
  const win = new BrowserWindow({
    ...(settings.chatBounds ?? { width: 1040, height: 720 }),
    minWidth: 380,
    minHeight: 480,
    // no macOS os semáforos nativos ficam por cima da barra custom (hiddenInset);
    // no Windows não há equivalente, então a barra é toda nossa
    ...(process.platform === 'darwin'
      ? { titleBarStyle: 'hiddenInset' as const }
      : { frame: false }),
    transparent: false,
    backgroundColor: '#1b1d26',
    resizable: true,
    skipTaskbar: false,
    show: false,
    title: 'Hermes',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.once('ready-to-show', () => win.show());
  win.setAlwaysOnTop(settings.chatPinned);
  win.loadFile(path.join(__dirname, 'chat.html'));

  const save = () => {
    if (!win.isDestroyed() && !win.isMinimized() && !win.isMaximized()) onBounds(win.getBounds());
  };
  // o semáforo vermelho do macOS fecha a janela de verdade; aqui ele recolhe para a
  // bandeja, como o ✕ da barra custom no Windows
  win.on('close', (e) => {
    if (saindo || win.isDestroyed()) return;
    e.preventDefault();
    win.hide();
  });
  win.on('resized', save);
  win.on('moved', save);
  win.on('maximize', () => win.webContents.send('win-state', { maximized: true }));
  win.on('unmaximize', () => win.webContents.send('win-state', { maximized: false }));

  return win;
}
