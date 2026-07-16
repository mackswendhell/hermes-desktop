import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { Settings } from './settings';
import { log } from './logger';
import { SSH_EXE } from './platform';

function run(settings: Settings, cmd: string): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const proc = spawn(
      SSH_EXE,
      [
        '-i', path.join(os.homedir(), '.ssh', 'id_ed25519_hermes'),
        '-o', 'BatchMode=yes',
        '-o', 'ConnectTimeout=15',
        '-o', 'StrictHostKeyChecking=accept-new',
        `${settings.vpsUser || 'root'}@${settings.vpsHost}`,
        cmd,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
    );
    let out = '';
    proc.stdout?.on('data', (d) => (out += String(d)));
    proc.on('error', () => resolve({ code: 255, out }));
    proc.on('exit', (code) => resolve({ code: code ?? 255, out }));
  });
}

export interface VpsSetupResult {
  ok: boolean;
  message: string;
  token?: string;
}

// configura o API server do Hermes na VPS da pessoa: token, .env, outbox e restart
export async function autoConfigureVps(settings: Settings): Promise<VpsSetupResult> {
  if (!settings.vpsHost) return { ok: false, message: 'Preencha o endereço da VPS primeiro.' };

  const probe = await run(
    settings,
    'test -d ~/.hermes && echo TEM-HERMES || echo SEM-HERMES; command -v docker >/dev/null 2>&1 && echo TEM-DOCKER; true',
  );
  if (probe.code !== 0) {
    return {
      ok: false,
      message:
        'Não consegui conectar via SSH. A chave já foi autorizada na VPS? (botão acima gera o comando)',
    };
  }
  if (probe.out.includes('SEM-HERMES')) {
    return {
      ok: false,
      message: probe.out.includes('TEM-DOCKER')
        ? 'A pasta ~/.hermes não existe nessa VPS. Se o Hermes roda em Docker, o container precisa montar o volume ~/.hermes:/opt/data (padrão do docker-compose oficial).'
        : 'A pasta ~/.hermes não existe nessa VPS — instale o Hermes Agent primeiro.',
    };
  }

  // reaproveita o token remoto se já houver (idempotente)
  const existing = await run(
    settings,
    "grep '^API_SERVER_KEY=' ~/.hermes/.env 2>/dev/null | head -1 | cut -d= -f2-",
  );
  let token = existing.out.trim();
  if (token) {
    await run(
      settings,
      "grep -q '^API_SERVER_ENABLED=true' ~/.hermes/.env || printf '\\nAPI_SERVER_ENABLED=true\\n' >> ~/.hermes/.env",
    );
  } else {
    token = randomBytes(24).toString('hex');
    await run(
      settings,
      `printf '\\nAPI_SERVER_ENABLED=true\\nAPI_SERVER_KEY=${token}\\n' >> ~/.hermes/.env`,
    );
  }

  // no Docker oficial o gateway roda como UID 10000 — o outbox precisa herdar o dono da pasta
  await run(
    settings,
    'touch ~/.hermes/desktop-outbox.jsonl && chown --reference ~/.hermes ~/.hermes/desktop-outbox.jsonl',
  );

  // instalação nativa (systemd) ou em Docker (container "hermes" do compose oficial,
  // com fallback por porta publicada para setups custom em bridge)
  const restart = await run(
    settings,
    'if systemctl restart hermes-gateway 2>/dev/null; then echo REINICIADO-SYSTEMD; ' +
      'elif command -v docker >/dev/null 2>&1; then ' +
      "C=$(docker ps -q --filter 'name=^hermes$'); [ -n \"$C\" ] || C=$(docker ps -q --filter publish=8642 | head -1); " +
      'if [ -n "$C" ]; then docker restart "$C" >/dev/null 2>&1 && echo REINICIADO-DOCKER || echo FALHA-DOCKER; ' +
      'else echo SEM-CONTAINER; fi; ' +
      'else echo SEM-RESTART; fi',
  );
  const viaDocker = restart.out.includes('REINICIADO-DOCKER');
  if (restart.out.includes('SEM-CONTAINER') || restart.out.includes('FALHA-DOCKER')) {
    return {
      ok: false,
      token,
      message:
        'Configurei o .env, mas não consegui reiniciar o container do Hermes no Docker. Rode "docker restart hermes" (ou "docker compose restart") na VPS e use "Testar conexão".',
    };
  }
  if (restart.out.includes('SEM-RESTART')) {
    return {
      ok: false,
      token,
      message:
        'Configurei o .env, mas não achei o serviço hermes-gateway (systemd) nem Docker na VPS. Reinicie o gateway do Hermes manualmente e teste a conexão.',
    };
  }

  const port = await run(settings, 'sleep 6; ss -tln | grep -q 8642 && echo ABERTA || echo FECHADA');
  if (!port.out.includes('ABERTA')) {
    return {
      ok: false,
      token,
      message: viaDocker
        ? 'Container reiniciado, mas a porta 8642 não abriu no host. O gateway em Docker precisa de network_mode: host (padrão do compose oficial) ou publicar -p 127.0.0.1:8642:8642. Depois use "Testar conexão".'
        : 'Gateway reiniciado, mas a porta 8642 não abriu ainda. Aguarde ~30 s e use "Testar conexão".',
    };
  }

  log('[vps-setup] API server configurado com sucesso');
  return { ok: true, token, message: 'Hermes configurado! O túnel reconecta sozinho — teste a conexão.' };
}
