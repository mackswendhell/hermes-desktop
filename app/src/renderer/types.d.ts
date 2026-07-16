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
  onHermesDelta(cb: (delta: string) => void): void;
  onProactive(cb: (text: string) => void): void;
  dragStart(): void;
  dragMove(dx: number, dy: number): void;
  dragEnd(): void;
  getSettings(): Promise<RendererSettings>;
  saveSettings(patch: Partial<RendererSettings>): Promise<RendererSettings>;
  genSshKey(): Promise<{ publicKey: string; authorizeCommand: string }>;
  testBridge(): Promise<{ ok: boolean; message: string }>;
  vpsSetup(): Promise<{ ok: boolean; message: string }>;
  addHistory(entry: HistoryEntry): void;
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
}

declare global {
  interface Window {
    hermes: HermesBridge;
  }
}
