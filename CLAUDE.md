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
   - Se existir instalador em Releases: no Windows, baixe o `.exe` e rode com `/S`
     (silencioso) ou peça para a pessoa dar dois cliques; no macOS, baixe o `.dmg`,
     arraste para Aplicativos e abra com botão direito → Abrir (Gatekeeper, app sem
     assinatura).
   - Para compilar do código: `cd app && npm install && npm run build` e
     `npx electron .` (remova a env `ELECTRON_RUN_AS_NODE` antes, se existir). Instalador:
     `npm run dist:win` → `app/release/*.exe`; `npm run dist:mac` → `app/release/*.dmg`.

3. **Conectar à VPS da pessoa** (tela Configurações — botão direito no personagem):
   - Preencha IP e usuário; salve.
   - Botão **"Mostrar chave SSH e comando de autorização"** → a pessoa cola o comando no
     terminal da VPS dela (você NÃO tem acesso à VPS dela; quem cola é ela).
   - Botão **"Configurar Hermes automaticamente"** → o app ativa `API_SERVER_ENABLED` no
     `~/.hermes/.env`, gera token e reinicia o gateway via SSH — detecta sozinho se o
     Hermes é nativo (systemd `hermes-gateway`) ou roda em Docker (container `hermes`
     do compose oficial, que monta `~/.hermes` do host e usa a rede do host).
   - Botão **"Testar conexão"** deve responder "funcionando".

4. **Voz**:
   - A voz leve (whisper.cpp + voz do sistema) baixa sozinha no primeiro uso no Windows
     (~190 MB); no macOS instale o transcritor com `brew install whisper-cpp`.
   - A voz na nuvem (STT Groq + TTS Edge, zero GPU) só precisa da chave da Groq nas
     Configurações — é o caminho recomendado no macOS.
   - Voz completa (XTTS local): no Windows com **GPU NVIDIA 6+ GB**, rode
     `powershell -ExecutionPolicy Bypass -File instalar-voz.ps1` na raiz do repo.
     No **macOS (Apple Silicon)** roda em CPU mais rápido que o tempo real:
     `cd voice-server && uv venv --python 3.11 .venv && uv pip install --python .venv
     torch torchaudio && uv pip install --python .venv -r requirements.txt "coqui-tts[codec]"`,
     depois aponte a "Pasta do servidor de voz" nas Configurações para `voice-server/`.
     (Downloads grandes: ~2,5 GB de PyTorch + ~3,5 GB de modelos no primeiro uso.)

5. **Verificação final**: personagem visível, `Ctrl+Alt+Space`, a pessoa fala, o Hermes
   dela responde por voz. Menu do botão direito: Voz, Personalidade, Cor, Tamanho.

## Fatos técnicos que você vai precisar

- Configurações/log: `%APPDATA%\hermes-assistente\` no Windows,
  `~/Library/Application Support/hermes-assistente` no macOS (`settings.json`, `app.log`).
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
  confira também `systemctl status hermes-gateway` na VPS (ou, em Docker,
  `docker ps` / `docker logs hermes`).
- **SmartScreen bloqueia o instalador** → "Mais informações → Executar assim mesmo"
  (app sem assinatura digital).
- **Voz leve não entende nada** → microfone padrão errado no sistema; e a primeira
  transcrição após abrir o app é mais lenta (carga do modelo).
- **macOS: voz leve reclama de whisper.cpp** → `brew install whisper-cpp` (o app procura
  o `whisper-cli` do Homebrew).
