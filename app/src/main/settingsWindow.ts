import { BrowserWindow } from 'electron';
import path from 'node:path';

let win: BrowserWindow | null = null;

export function openSettingsWindow(autoVoiceInstall = false): void {
  if (win) {
    win.focus();
    if (autoVoiceInstall) win.webContents.send('voice-install-auto');
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
  if (autoVoiceInstall) {
    win.webContents.once('did-finish-load', () => win?.webContents.send('voice-install-auto'));
  }
  win.on('closed', () => (win = null));
}
