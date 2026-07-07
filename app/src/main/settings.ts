import { app } from 'electron';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

export type Persona = 'normal' | 'cavaleiro';

export interface Settings {
  position?: { x: number; y: number };
  hotkey: string;
  bridgeUrl: string;
  bridgeToken: string;
  vpsHost: string;
  vpsUser: string;
  autoStart: boolean;
  ttsSpeaker: string;
  persona: Persona;
  theme: string;
  voiceServerDir: string;
  speechSide: 'left' | 'right';
  muted: boolean;
  size: string;
  idleUnloadMin: number;
  voiceEngine: 'xtts' | 'leve' | 'texto';
  windowsVoice: string;
  chatSessionId: string;
}

const defaults: Settings = {
  hotkey: 'Control+Alt+Space',
  bridgeUrl: '',
  bridgeToken: '',
  vpsHost: '',
  vpsUser: 'root',
  autoStart: false,
  ttsSpeaker: 'Damien Black',
  persona: 'cavaleiro',
  theme: 'dourado',
  voiceServerDir: '',
  speechSide: 'left',
  muted: false,
  size: 'medio',
  idleUnloadMin: 10,
  voiceEngine: 'xtts',
  windowsVoice: '',
  chatSessionId: '',
};

// com túnel SSH ativo, a API do Hermes aparece em localhost
export function effectiveBridgeUrl(s: Settings): string {
  if (s.bridgeUrl) return s.bridgeUrl;
  if (s.vpsHost) return 'http://127.0.0.1:8642';
  return '';
}

function settingsPath(): string {
  return path.join(app.getPath('userData'), 'settings.json');
}

export function loadSettings(): Settings {
  try {
    const raw = readFileSync(settingsPath(), 'utf-8').replace(/^﻿/, '');
    return { ...defaults, ...JSON.parse(raw) };
  } catch {
    return { ...defaults };
  }
}

export function saveSettings(s: Settings): void {
  mkdirSync(app.getPath('userData'), { recursive: true });
  writeFileSync(settingsPath(), JSON.stringify(s, null, 2), 'utf-8');
}
