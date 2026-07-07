# Hermes Desktop — seu Hermes Agent com um rosto

Um assistente de mesa para Windows no espírito do velho Clippy, reestilizado: um
personagem com olhos grandes que flutua sobre as suas janelas, ouve você pelo microfone,
responde por voz e usa como cérebro o **seu próprio [Hermes Agent](https://github.com/nousresearch/hermes-agent)**
rodando na **sua VPS** — mesma memória e personalidade que você já tem no Telegram.

## O que você precisa

1. **Windows 10/11**
2. **Um Hermes Agent funcionando na sua VPS** (com gateway ativo). Se ainda não tem,
   siga a doc oficial do Hermes primeiro.
3. Microfone (para falar) — ou use a caixinha de texto.

## Instalação

**Caminho 1 — com um agente (recomendado).** Clone este repositório, abra a pasta no
Claude Code (ou outro agente compatível) e diga: *"instala e configura o assistente para
mim"*. O arquivo `CLAUDE.md` ensina o agente a fazer tudo: instalar, conectar na sua VPS
e, se você tiver GPU NVIDIA, instalar a voz de alta qualidade.

**Caminho 2 — manual.**
1. Baixe o instalador na aba [Releases](../../releases) e execute. (O Windows vai avisar
   "editor desconhecido" — clique em "Mais informações → Executar assim mesmo"; o app não
   é assinado digitalmente.)
2. O personagem aparece na tela. Clique nele com o **botão direito → Configurações…**
3. Preencha o **IP da sua VPS** e o usuário SSH (geralmente `root`).
4. Clique em **"Mostrar chave SSH e comando de autorização"**, copie o comando e cole no
   terminal da sua VPS (uma única vez).
5. Clique em **"Configurar Hermes automaticamente"** — o app ativa a API do seu Hermes,
   gera o token e reinicia o gateway sozinho.
6. Clique em **"Testar conexão"**. Pronto: clique no personagem (ou `Ctrl+Alt+Space`) e fale.

## Voz

- **De fábrica (voz leve)**: o app baixa sozinho um transcritor local (whisper.cpp,
  ~190 MB, roda em qualquer CPU) e responde com a voz nativa do Windows. Nada de nuvem —
  o áudio nunca sai do seu PC.
- **Upgrade (voz completa, GPU NVIDIA)**: rode `instalar-voz.ps1` (PowerShell) para
  instalar o XTTS v2 — vozes neurais muito mais naturais (8 opções, incluindo graves).
- **Só texto**: menu Voz → "Só texto".

## O que ele faz

Personagem animado que segue seu mouse com os olhos • conversa por voz ou texto •
personalidades (Cavaleiro épico-cômico ou assistente direto) • 6 cores, 3 tamanhos •
histórico de conversas • avisos proativos do seu Hermes • modo reduzido automático com
OBS aberto • some em tela cheia • hibernação da GPU configurável.

## Privacidade e segurança

- Transcrição e síntese de voz são locais; suas falas não vão para nenhum serviço.
- A conexão com a sua VPS é um **túnel SSH** com chave dedicada — a API do Hermes nunca
  fica exposta na internet.
- O app guarda configurações em `%APPDATA%\hermes-assistente` e nada mais.

## Licença

MIT — use, modifique e distribua à vontade.
