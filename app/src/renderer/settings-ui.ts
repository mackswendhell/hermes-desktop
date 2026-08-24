import './types.d';

const $ = (id: string) => document.getElementById(id) as HTMLInputElement;

// Campos de chave: mostram a primeira metade e mascaram o resto quando fora de
// foco. O valor real vive em dataset.real — `.value` pode conter a máscara.
const halfMasked = (v: string) => {
  const keep = Math.ceil(v.length / 2);
  return v.slice(0, keep) + '\u2022'.repeat(v.length - keep);
};

const secretOf = (id: string) => ($(id).dataset.real ?? '').trim();

function setSecret(id: string, value: string): void {
  const el = $(id);
  el.dataset.real = value;
  if (document.activeElement !== el) el.value = halfMasked(value);
}

for (const id of ['bridgeToken', 'groqApiKey']) {
  const el = $(id);
  el.addEventListener('input', () => { el.dataset.real = el.value; });
  el.addEventListener('focus', () => { el.value = el.dataset.real ?? ''; });
  el.addEventListener('blur', () => { el.value = halfMasked(el.dataset.real ?? ''); });
}

async function load(): Promise<void> {
  const s = await window.hermes.getSettings();
  $('vpsHost').value = s.vpsHost;
  $('vpsUser').value = s.vpsUser;
  setSecret('bridgeToken', s.bridgeToken);
  setSecret('groqApiKey', s.groqApiKey);
  $('voiceServerDir').value = s.voiceServerDir;
  pintarVoz(s.voiceServerDir);
  $('hotkey').value = s.hotkey;
  ($('idleUnload') as unknown as HTMLSelectElement).value = String(s.idleUnloadMin);
}

async function saveAll(): Promise<void> {
  await window.hermes.saveSettings({
    vpsHost: $('vpsHost').value.trim(),
    vpsUser: $('vpsUser').value.trim() || 'root',
    bridgeToken: secretOf('bridgeToken'),
    groqApiKey: secretOf('groqApiKey'),
    voiceServerDir: $('voiceServerDir').value.trim(),
    hotkey: $('hotkey').value.trim() || 'Control+Alt+Space',
    idleUnloadMin: parseInt(($('idleUnload') as unknown as HTMLSelectElement).value, 10) || 0,
  });
}

document.getElementById('btn-save')!.addEventListener('click', async () => {
  await saveAll();
  const saved = document.getElementById('saved')!;
  saved.classList.remove('hidden');
  setTimeout(() => saved.classList.add('hidden'), 2500);
});

document.getElementById('btn-key')!.addEventListener('click', async () => {
  const { authorizeCommand } = await window.hermes.genSshKey();
  ($('key-cmd') as unknown as HTMLTextAreaElement).value = authorizeCommand;
  document.getElementById('key-area')!.classList.remove('hidden');
});

document.getElementById('btn-copy')!.addEventListener('click', () => {
  navigator.clipboard.writeText(($('key-cmd') as unknown as HTMLTextAreaElement).value);
});

document.getElementById('btn-vps-setup')!.addEventListener('click', async () => {
  const status = document.getElementById('status')!;
  // salva tudo que foi digitado antes do setup — o load() do final recarrega o
  // formulário, e um save parcial descartaria os outros campos (ex.: chave Groq)
  await saveAll();
  status.textContent = 'Configurando a VPS… (até 30 s)';
  status.className = '';
  const r = await window.hermes.vpsSetup();
  status.textContent = r.message;
  status.className = r.ok ? 'ok' : 'err';
  if (r.ok) load();
});

document.getElementById('btn-test')!.addEventListener('click', async () => {
  const status = document.getElementById('status')!;
  status.textContent = 'Testando…';
  status.className = '';
  const r = await window.hermes.testBridge();
  status.textContent = r.message;
  status.className = r.ok ? 'ok' : 'err';
});

// ---- voz local ----
const voiceState = document.getElementById('voice-state')!;
const voiceBtn = document.getElementById('btn-voice-install') as HTMLButtonElement;
const voiceProg = document.getElementById('voice-progress')!;

function pintarVoz(dir: string): void {
  if (dir) {
    voiceState.textContent = `Instalada em: ${dir}`;
    voiceBtn.textContent = 'Reinstalar voz local';
  } else {
    voiceState.textContent = 'Não instalada.';
    voiceBtn.textContent = 'Instalar voz local';
  }
}

window.hermes.onVoiceInstallProgress(({ etapa, detalhe }) => {
  voiceProg.classList.remove('hidden');
  document.getElementById('voice-etapa')!.textContent = etapa;
  document.getElementById('voice-detalhe')!.textContent = detalhe ?? '';
});

async function instalarVoz(): Promise<void> {
  if (voiceBtn.disabled) return;
  voiceBtn.disabled = true;
  voiceProg.classList.remove('hidden');
  document.getElementById('voice-etapa')!.textContent = 'Iniciando…';
  const r = await window.hermes.voiceInstall();
  document.getElementById('voice-etapa')!.textContent = r.message;
  document.getElementById('voice-detalhe')!.textContent = '';
  voiceBtn.disabled = false;
  if (r.ok) await load();
}

voiceBtn.addEventListener('click', instalarVoz);
window.hermes.onVoiceInstallAuto(() => void instalarVoz());

load();
