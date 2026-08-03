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
  onHermesDelta: (cb: (reqId: string, delta: string) => void) => {
    ipcRenderer.on('hermes-delta', (_e, reqId, d) => cb(reqId, d));
  },
  onProactive: (cb: (text: string, chatId?: string) => void) => {
    ipcRenderer.on('proactive', (_e, t, chatId) => cb(t, chatId));
  },
  onWinState: (cb: (s: { maximized: boolean }) => void) => {
    ipcRenderer.on('win-state', (_e, s) => cb(s));
  },
  onChatOpen: (cb: (chatId: string) => void) => {
    ipcRenderer.on('chat-open', (_e, id) => cb(id));
  },
  dragStart: () => ipcRenderer.send('drag-start'),
  dragMove: (dx: number, dy: number) => ipcRenderer.send('drag-move', dx, dy),
  dragEnd: () => ipcRenderer.send('drag-end'),
  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (patch: unknown) => ipcRenderer.invoke('save-settings', patch),
  genSshKey: () => ipcRenderer.invoke('gen-ssh-key'),
  testBridge: () => ipcRenderer.invoke('test-bridge'),
  vpsSetup: () => ipcRenderer.invoke('vps-setup'),
  getHistory: () => ipcRenderer.invoke('history-get'),
  sttLocal: (wav: ArrayBuffer) => ipcRenderer.invoke('stt-local', wav),
  ttsNuvem: (text: string) => ipcRenderer.invoke('tts-nuvem', text),
  setWindowsVoices: (names: string[]) => ipcRenderer.send('windows-voices', names),
  onVoiceProgress: (cb: (msg: string) => void) => {
    ipcRenderer.on('voice-progress', (_e, m) => cb(m));
  },
  askHermes: (text: string, attachments?: unknown[]) =>
    ipcRenderer.invoke('ask-hermes', text, attachments),
  voiceServerUp: () => ipcRenderer.invoke('voice-server-up'),
  openMenu: () => ipcRenderer.send('open-menu'),
  setWide: (wide: boolean) => ipcRenderer.send('set-wide', wide),
  hideWindow: () => ipcRenderer.send('hide-window'),
  quitApp: () => ipcRenderer.send('quit-app'),

  // janela do modo chat
  winMin: () => ipcRenderer.send('win-min'),
  winMax: () => ipcRenderer.send('win-max'),
  winPin: () => ipcRenderer.invoke('win-pin'),
  openExternal: (url: string) => ipcRenderer.send('open-external', url),
  setUiMode: (mode: 'overlay' | 'chat') => ipcRenderer.send('set-ui-mode', mode),

  // conversas
  chatList: () => ipcRenderer.invoke('chat-list'),
  chatOpen: (id: string) => ipcRenderer.invoke('chat-open', id),
  chatNew: () => ipcRenderer.invoke('chat-new'),
  chatRename: (id: string, title: string) => ipcRenderer.invoke('chat-rename', id, title),
  chatDelete: (id: string) => ipcRenderer.invoke('chat-delete', id),
  chatClear: (id: string) => ipcRenderer.invoke('chat-clear', id),
  chatMeta: (id: string, patch: unknown) => ipcRenderer.invoke('chat-meta', id, patch),
  chatSearch: (q: string) => ipcRenderer.invoke('chat-search', q),
  chatExport: (id: string) => ipcRenderer.invoke('chat-export', id),
  chatTruncate: (id: string, index: number) => ipcRenderer.invoke('chat-truncate', id, index),
  chatAsk: (req: unknown) => ipcRenderer.invoke('chat-ask', req),
  mediaSave: (buf: ArrayBuffer, ext: string) => ipcRenderer.invoke('media-save', buf, ext),
  mediaPath: (name: string) => ipcRenderer.invoke('media-path', name),
  askAbort: (reqId: string) => ipcRenderer.send('ask-abort', reqId),
  extractFile: (name: string, buffer: ArrayBuffer) =>
    ipcRenderer.invoke('extract-file', name, buffer),
});
