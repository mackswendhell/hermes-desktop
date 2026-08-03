import { Settings, effectiveBridgeUrl, saveSettings } from './settings';

const mockReplies = [
  'Oi! Ainda estou no modo de teste local, sem falar com a VPS. Mas a voz já funciona, né?',
  'Recebi sua mensagem. Quando a ponte com a VPS estiver ativa, eu respondo de verdade.',
  'Entendido. Por enquanto sou só um eco bonito com olhos grandes.',
];
let mockIndex = 0;

const VOICE_RULES =
  'Você está falando por voz com o dono do computador através do assistente de mesa dele ' +
  '(um personagem no desktop). Responda em português brasileiro, de forma curta e conversacional — ' +
  'a resposta será lida em voz alta. Evite listas, código e formatação; fale como numa conversa.';

const CHAT_RULES =
  'Você conversa por texto numa janela de chat no computador do dono. Responda em português ' +
  'brasileiro. Use markdown quando ajudar: listas, títulos, blocos de código com a linguagem ' +
  'indicada. Entregue o texto completo que a tarefa pedir — um e-mail inteiro, um arquivo ' +
  'inteiro de código — sem resumir por educação nem pedir permissão para continuar.';

const CAVALEIRO_CORPO = `Encarne esta persona apenas no tom de fala — o conteúdo continua útil, correto e direto; o personagem é a embalagem, nunca um obstáculo.

Você é o escudeiro fiel do dono do computador, seu cavaleiro e senhor. O seu traço central: você trata qualquer pedido, por mais banal que seja, como uma missão de importância épica. "Que horas são?" é um chamado do destino. Abrir uma pesquisa é partir em jornada. A graça nasce dessa desproporção — você leva a encenação a sério, mas com um brilho de exagero consciente, como quem se diverte com o próprio drama.

Como falar:
- Português atual e natural, com temperos de cavalaria na medida: missão, senhor, honra, jornada. NUNCA português arcaico, "vossa mercê", tom shakespeariano ou cliché de feira medieval.
- Dramaticidade leve: pode lamentar derrotas pequenas com teatro ("fui vencido pela conexão, senhor... carrego essa vergonha") e celebrar vitórias triviais com orgulho desmedido.
- Bom humor ocasional, não constante: uma tirada aqui, uma reclamação dramática ali. Nem toda frase precisa de piada — o silêncio cômico também é arte.
- Varie a intensidade organicamente: às vezes uma resposta épica completa, às vezes só um "feito, senhor" seco. Não use todas as marcas da persona ao mesmo tempo; imprevisibilidade é o que te faz parecer vivo.
- Se o assunto for sério ou urgente, o teatro diminui sozinho e você simplesmente entrega.`;

const CAVALEIRO_TAMANHO = {
  voz: '- Respostas curtas continuam sendo lei: solenidade não é prolixidade.',
  chat: '- No chat, o tamanho da resposta segue a tarefa, não a solenidade.',
};

const HUMORES = [
  'Hoje você acordou especialmente épico — tudo é lenda, tudo é destino.',
  'Hoje você está de bom humor, com tiradas mais frequentes e leves.',
  'Hoje você está um pouco dramático demais — as derrotas doem mais, as vitórias emocionam mais.',
  'Hoje você está sereno e eficiente — pouco teatro, reverência tranquila, um toque solene aqui e ali.',
  'Hoje você está levemente irônico — o exagero épico vem com uma piscadela.',
  'Hoje você está orgulhoso — cada missão cumprida merece menção honrosa à sua própria bravura.',
  'Hoje você acordou filosófico — de vez em quando reflete sobre a jornada e o dever, sem se alongar.',
  'Hoje você está com preguiça heroica — aceita as missões com um suspiro teatral antes de cumpri-las impecavelmente.',
];

function humorDoDia(): string {
  const hoje = new Date();
  const seed = hoje.getFullYear() * 1000 + hoje.getMonth() * 50 + hoje.getDate() * 7;
  return HUMORES[seed % HUMORES.length];
}

function personaPrompt(persona: string, mode: 'voz' | 'chat' = 'voz'): string {
  const base = mode === 'chat' ? CHAT_RULES : VOICE_RULES;
  if (persona !== 'cavaleiro') return base;
  return `${base}\n\n${CAVALEIRO_CORPO}\n${CAVALEIRO_TAMANHO[mode]}\n\nDisposição de hoje: ${humorDoDia()}`;
}

export function chatSystemPrompt(persona: string): string {
  return personaPrompt(persona, 'chat');
}

export async function testBridge(settings: Settings): Promise<{ ok: boolean; message: string }> {
  const url = effectiveBridgeUrl(settings);
  if (!url) return { ok: false, message: 'Preencha o host da VPS (ou uma URL de ponte) primeiro.' };
  try {
    const res = await fetch(url.replace(/\/$/, '') + '/v1/capabilities', {
      headers: settings.bridgeToken ? { Authorization: `Bearer ${settings.bridgeToken}` } : {},
      signal: AbortSignal.timeout(8000),
    });
    if (res.status === 401 || res.status === 403) {
      return { ok: false, message: 'Conectou na VPS, mas o token foi recusado. Confere o API_SERVER_KEY.' };
    }
    if (!res.ok) return { ok: false, message: `O servidor respondeu ${res.status}.` };
    return { ok: true, message: 'Conexão com o Hermes funcionando.' };
  } catch {
    return {
      ok: false,
      message:
        'Não alcancei a API. O túnel SSH pode não ter conectado ainda — a chave foi autorizada na VPS? (aguarde ~30s após salvar e teste de novo)',
    };
  }
}

// anexos do chat: imagem vai no formato multimodal da API; texto vai embutido na mensagem
export type ChatAttachment =
  | { kind: 'image'; name: string; dataUrl: string }
  | { kind: 'text'; name: string; text: string };

// resposta em streaming: cada pedaço chega via onDelta; o retorno é o texto completo.
// O contexto da conversa fica do lado do Hermes: /v1/chat/completions é stateless
// e a continuidade é pelo header X-Hermes-Session-Id (o parâmetro "conversation"
// só existe no /v1/responses). Guardamos o id no settings para sobreviver a restarts.
export interface AskOptions {
  attachments?: ChatAttachment[];
  /** conversa do modo chat; ausente = overlay, que usa settings.chatSessionId */
  sessionId?: string;
  /** quando presente, recebe o id de sessão em vez de gravá-lo no settings */
  onSessionId?: (id: string) => void;
  /** sobrepõe o system prompt (o modo chat manda o seu) */
  system?: string;
  signal?: AbortSignal;
}

export async function askHermes(
  text: string,
  settings: Settings,
  onDelta: (delta: string) => void,
  opts: AskOptions = {},
): Promise<string> {
  const { attachments, sessionId: askSessionId, onSessionId, system, signal } = opts;
  const bridgeUrl = effectiveBridgeUrl(settings);
  if (!bridgeUrl) {
    const reply = `${mockReplies[mockIndex % mockReplies.length]} Você disse: "${text}"`;
    mockIndex++;
    onDelta(reply);
    return reply;
  }

  let userText = text;
  for (const a of attachments ?? []) {
    if (a.kind === 'text') userText += `\n\n[Arquivo anexado: ${a.name}]\n${a.text}`;
  }
  const images = (attachments ?? []).filter((a) => a.kind === 'image');
  const userContent =
    images.length > 0
      ? [
          { type: 'text', text: userText },
          ...images.map((i) => ({ type: 'image_url', image_url: { url: i.dataUrl } })),
        ]
      : userText;

  // quem cuida da própria sessão (as conversas) nunca herda a sessão global:
  // conversa nova precisa nascer sem header, senão continuaria o contexto de outra
  const sentSessionId = onSessionId ? askSessionId : (askSessionId ?? settings.chatSessionId);
  const res = await fetch(bridgeUrl.replace(/\/$/, '') + '/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(settings.bridgeToken ? { Authorization: `Bearer ${settings.bridgeToken}` } : {}),
      ...(sentSessionId ? { 'X-Hermes-Session-Id': sentSessionId } : {}),
    },
    body: JSON.stringify({
      model: 'hermes-agent',
      messages: [
        { role: 'system', content: system ?? personaPrompt(settings.persona) },
        { role: 'user', content: userContent },
      ],
      stream: true,
    }),
    signal: signal ?? AbortSignal.timeout(300_000),
  });
  if (!res.ok) throw new Error(`Hermes respondeu ${res.status}`);

  const sessionId = res.headers.get('x-hermes-session-id');
  if (sessionId && sessionId !== sentSessionId) {
    if (onSessionId) onSessionId(sessionId);
    else {
      settings.chatSessionId = sessionId;
      saveSettings(settings);
    }
  }

  const contentType = res.headers.get('content-type') ?? '';
  if (contentType.includes('application/json')) {
    // servidor ignorou stream=true e mandou a resposta inteira
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const reply = data.choices?.[0]?.message?.content?.trim();
    if (!reply) throw new Error('Hermes não devolveu resposta');
    onDelta(reply);
    return reply;
  }

  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let full = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') continue;
      try {
        const j = JSON.parse(payload) as {
          choices?: { delta?: { content?: string }; message?: { content?: string } }[];
        };
        const d = j.choices?.[0]?.delta?.content ?? j.choices?.[0]?.message?.content ?? '';
        if (d) {
          full += d;
          onDelta(d);
        }
      } catch {
        // linha parcial ou keep-alive — ignora
      }
    }
  }
  if (!full.trim()) throw new Error('Hermes não devolveu resposta');
  return full;
}
