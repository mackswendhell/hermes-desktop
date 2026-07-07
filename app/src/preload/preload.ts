import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('hermes', {
  onPttToggle: (cb: () => void) => {
    ipcRenderer.on('ptt-toggle', cb);
  },
  onSettingsChanged: (cb: (settings: unknown) => void) => {
    ipcRenderer.on('settings-changed', (_e, s) => cb(s));
  },
  onCursorMove: (cb: (dx: number, dy: number) => void) => {
    ipcRenderer.on('cursor-move', (_e, dx, dy) => cb(dx, dy));
  },
  onHermesDelta: (cb: (delta: string) => void) => {
    ipcRenderer.on('hermes-delta', (_e, d) => cb(d));
  },
  onProactive: (cb: (text: string) => void) => {
    ipcRenderer.on('proactive', (_e, t) => cb(t));
  },
  dragStart: () => ipcRenderer.send('drag-start'),
  dragMove: (dx: number, dy: number) => ipcRenderer.send('drag-move', dx, dy),
  dragEnd: () => ipcRenderer.send('drag-end'),
  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (patch: unknown) => ipcRenderer.invoke('save-settings', patch),
  genSshKey: () => ipcRenderer.invoke('gen-ssh-key'),
  testBridge: () => ipcRenderer.invoke('test-bridge'),
  vpsSetup: () => ipcRenderer.invoke('vps-setup'),
  addHistory: (entry: unknown) => ipcRenderer.send('history-add', entry),
  getHistory: () => ipcRenderer.invoke('history-get'),
  sttLocal: (wav: ArrayBuffer) => ipcRenderer.invoke('stt-local', wav),
  setWindowsVoices: (names: string[]) => ipcRenderer.send('windows-voices', names),
  onVoiceProgress: (cb: (msg: string) => void) => {
    ipcRenderer.on('voice-progress', (_e, m) => cb(m));
  },
  askHermes: (text: string) => ipcRenderer.invoke('ask-hermes', text),
  voiceServerUp: () => ipcRenderer.invoke('voice-server-up'),
  openMenu: () => ipcRenderer.send('open-menu'),
  setWide: (wide: boolean) => ipcRenderer.send('set-wide', wide),
  hideWindow: () => ipcRenderer.send('hide-window'),
  quitApp: () => ipcRenderer.send('quit-app'),
});
