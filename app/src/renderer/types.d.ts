export interface RendererSettings {
  hotkey: string;
  bridgeUrl: string;
  bridgeToken: string;
  vpsHost: string;
  vpsUser: string;
  ttsSpeaker: string;
  persona: string;
  theme: string;
  voiceServerDir: string;
  autoStart: boolean;
  speechSide: 'left' | 'right';
  muted: boolean;
  size: string;
  idleUnloadMin: number;
  voiceEngine: 'xtts' | 'leve' | 'texto' | 'nuvem';
  windowsVoice: string;
  groqApiKey: string;
  edgeVoice: string;
  uiMode: 'overlay' | 'chat';
  chatPinned: boolean;
  activeChatId: string;
}

export interface ChatAtt {
  kind: 'image' | 'text' | 'audio';
  name: string;
  dataUrl?: string;
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

export interface SearchHit {
  chatId: string;
  title: string;
  t: string;
  snippet: string;
  index: number;
}

export interface HistoryEntry {
  t: string;
  q: string;
  a: string;
}

export type ChatAttachment =
  | { kind: 'image'; name: string; dataUrl: string }
  | { kind: 'text'; name: string; text: string };

export interface HermesBridge {
  onPttToggle(cb: () => void): void;
  onSettingsChanged(cb: (settings: RendererSettings) => void): void;
  onCursorMove(cb: (dx: number, dy: number) => void): void;
  onHermesDelta(cb: (reqId: string, delta: string) => void): void;
  onProactive(cb: (text: string, chatId?: string) => void): void;
  onWinState(cb: (s: { maximized: boolean }) => void): void;
  onChatOpen(cb: (chatId: string) => void): void;
  dragStart(): void;
  dragMove(dx: number, dy: number): void;
  dragEnd(): void;
  getSettings(): Promise<RendererSettings>;
  saveSettings(patch: Partial<RendererSettings>): Promise<RendererSettings>;
  genSshKey(): Promise<{ publicKey: string; authorizeCommand: string }>;
  testBridge(): Promise<{ ok: boolean; message: string }>;
  vpsSetup(): Promise<{ ok: boolean; message: string }>;
  getHistory(): Promise<HistoryEntry[]>;
  sttLocal(wav: ArrayBuffer): Promise<string>;
  ttsNuvem(text: string): Promise<ArrayBuffer>;
  setWindowsVoices(names: string[]): void;
  onVoiceProgress(cb: (msg: string) => void): void;
  askHermes(text: string, attachments?: ChatAttachment[]): Promise<string>;
  voiceServerUp(): Promise<boolean>;
  openMenu(): void;
  setWide(wide: boolean): void;
  hideWindow(): void;
  quitApp(): void;

  winMin(): void;
  winMax(): void;
  winPin(): Promise<boolean>;
  openExternal(url: string): void;
  setUiMode(mode: 'overlay' | 'chat'): void;

  chatList(): Promise<ChatSummary[]>;
  chatOpen(id: string): Promise<Chat | null>;
  chatNew(): Promise<Chat>;
  chatRename(id: string, title: string): Promise<void>;
  chatDelete(id: string): Promise<void>;
  chatClear(id: string): Promise<Chat | null>;
  chatMeta(
    id: string,
    patch: { title?: string; avatar?: string; pinned?: boolean; archived?: boolean },
  ): Promise<void>;
  chatSearch(q: string): Promise<SearchHit[]>;
  chatExport(id: string): Promise<string | null>;
  chatTruncate(id: string, index: number): Promise<Chat | null>;
  chatAsk(req: {
    chatId: string;
    reqId: string;
    text: string;
    attachments?: ChatAttachment[];
    audio?: { file: string; name: string };
    mode?: 'normal' | 'regen';
  }): Promise<{ reply: string; title: string | null }>;
  mediaSave(buf: ArrayBuffer, ext: string): Promise<string>;
  mediaPath(name: string): Promise<string>;
  askAbort(reqId: string): void;
  extractFile(name: string, buffer: ArrayBuffer): Promise<{ text?: string; error?: string }>;
}

declare global {
  interface Window {
    hermes: HermesBridge;
  }
}
