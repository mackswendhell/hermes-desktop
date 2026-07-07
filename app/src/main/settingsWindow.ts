import { BrowserWindow } from 'electron';
import path from 'node:path';

let win: BrowserWindow | null = null;

export function openSettingsWindow(): void {
  if (win) {
    win.focus();
    return;
  }
  win = new BrowserWindow({
    width: 540,
    height: 680,
    title: 'Hermes — Configurações',
    autoHideMenuBar: true,
    resizable: false,
    maximizable: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, 'settings.html'));
  win.on('closed', () => (win = null));
}
