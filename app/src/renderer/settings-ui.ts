import './types.d';

const $ = (id: string) => document.getElementById(id) as HTMLInputElement;

async function load(): Promise<void> {
  const s = await window.hermes.getSettings();
  $('vpsHost').value = s.vpsHost;
  $('vpsUser').value = s.vpsUser;
  $('bridgeToken').value = s.bridgeToken;
  $('groqApiKey').value = s.groqApiKey;
  $('voiceServerDir').value = s.voiceServerDir;
  $('hotkey').value = s.hotkey;
  ($('idleUnload') as unknown as HTMLSelectElement).value = String(s.idleUnloadMin);
}

async function saveAll(): Promise<void> {
  await window.hermes.saveSettings({
    vpsHost: $('vpsHost').value.trim(),
    vpsUser: $('vpsUser').value.trim() || 'root',
    bridgeToken: $('bridgeToken').value.trim(),
    groqApiKey: $('groqApiKey').value.trim(),
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

load();
