# Hermes Desktop — guia para agentes

Você está ajudando alguém a instalar e configurar o **Hermes Desktop**: um assistente de
mesa (Electron + voz local) que conversa com o Hermes Agent que a pessoa já roda na VPS
dela. Leia o `README.md` para o panorama. Este arquivo é o seu roteiro de instalação.

## Roteiro de instalação assistida

1. **Pré-requisitos** — confirme com a pessoa:
   - Ela tem um Hermes Agent instalado e funcionando na VPS dela? (teste: ela conversa
     com ele no Telegram/Discord?) Sem isso, pare e indique a doc oficial do Hermes.
   - Anote: IP da VPS e usuário SSH (geralmente `root`).

2. **Instalar o app**:
   - Se existir instalador em Releases: baixe e rode com `/S` (silencioso) ou peça para
     a pessoa dar dois cliques.
   - Para compilar do código: `cd app && npm install && npm run build` e
     `npx electron .` (remova a env `ELECTRON_RUN_AS_NODE` antes, se existir). Instalador:
     `npm run dist` → `app/release/*.exe`.

3. **Conectar à VPS da pessoa** (tela Configurações — botão direito no personagem):
   - Preencha IP e usuário; salve.
   - Botão **"Mostrar chave SSH e comando de autorização"** → a pessoa cola o comando no
     terminal da VPS dela (você NÃO tem acesso à VPS dela; quem cola é ela).
   - Botão **"Configurar Hermes automaticamente"** → o app ativa `API_SERVER_ENABLED` no
     `~/.hermes/.env`, gera token e reinicia o `hermes-gateway` via SSH.
   - Botão **"Testar conexão"** deve responder "funcionando".

4. **Voz**:
   - A voz leve (whisper.cpp + voz do Windows) baixa sozinha no primeiro uso (~190 MB).
   - Se a pessoa tem **GPU NVIDIA 6+ GB** e quer voz neural: rode
     `powershell -ExecutionPolicy Bypass -File instalar-voz.ps1` na raiz do repo
     (downloads grandes: ~2,5 GB de PyTorch + ~3,5 GB de modelos no primeiro uso).

5. **Verificação final**: personagem visível, `Ctrl+Alt+Space`, a pessoa fala, o Hermes
   dela responde por voz. Menu do botão direito: Voz, Personalidade, Cor, Tamanho.

## Fatos técnicos que você vai precisar

- Configurações/log: `%APPDATA%\hermes-assistente\` (`settings.json`, `app.log`).
  Settings sempre em UTF-8 **sem BOM**.
- Túnel SSH: chave `~/.ssh/id_ed25519_hermes` → porta local 8642 → API do Hermes
  (`/v1/chat/completions`, Bearer = `bridgeToken` do settings).
- Voz leve: binário e modelo em `%APPDATA%\hermes-assistente\whisper\`.
- Voz completa: `voice-server/` com venv Python 3.11 (uv); os modelos não aceitam
  inferência concorrente (o servidor já serializa — não "otimize" isso).
- O servidor de voz é filho do app e renasce sozinho se cair.

## Problemas comuns

- **"Permission denied (publickey)"** → a pessoa não colou (ou colou errado) o comando de
  autorização na VPS. Gere de novo na tela de Configurações.
- **"Testar conexão" falha após configurar** → túnel demora ~30 s para reconectar;
  confira também `systemctl status hermes-gateway` na VPS.
- **SmartScreen bloqueia o instalador** → "Mais informações → Executar assim mesmo"
  (app sem assinatura digital).
- **Voz leve não entende nada** → microfone padrão errado no Windows; e a primeira
  transcrição após abrir o app é mais lenta (carga do modelo).
