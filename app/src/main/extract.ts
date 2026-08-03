import { log } from './logger';

// Extração de texto roda no main: não pesa a UI e mantém pdf.js fora da CSP do renderer.

const MAX_TEXT = 200_000;

function truncate(s: string): string {
  return s.length > MAX_TEXT ? s.slice(0, MAX_TEXT) + '\n[…texto truncado…]' : s;
}

export async function extractFile(name: string, buffer: ArrayBuffer): Promise<{ text?: string; error?: string }> {
  const ext = (name.split('.').pop() ?? '').toLowerCase();
  try {
    switch (ext) {
      case 'docx':
        return finish(await fromDocx(buffer), 'docx');
      case 'xlsx':
      case 'xls':
        return finish(await fromSheet(buffer), 'planilha');
      case 'pptx':
        return finish(await fromPptx(buffer), 'pptx');
      case 'doc':
      case 'ppt':
        return { error: `Formato antigo (.${ext}) não é suportado — salve como .docx/.pptx e tente de novo.` };
      default:
        return { error: `Não sei ler .${ext}` };
    }
  } catch (err) {
    log(`[extract] ${name}: ${err}`);
    return { error: `Não consegui ler ${name}: ${err instanceof Error ? err.message : String(err)}` };
  }
}

function finish(text: string, tipo: string): { text?: string; error?: string } {
  if (text.replace(/\s/g, '').length < 30) {
    return { error: `O ${tipo} não tem texto extraível.` };
  }
  return { text: truncate(text) };
}

async function fromDocx(buffer: ArrayBuffer): Promise<string> {
  const mammoth = await import('mammoth');
  const { value } = await mammoth.extractRawText({ buffer: Buffer.from(buffer) });
  return value;
}

async function fromSheet(buffer: ArrayBuffer): Promise<string> {
  const XLSX = await import('xlsx');
  const wb = XLSX.read(new Uint8Array(buffer), { type: 'array' });
  return wb.SheetNames.map(
    (nome) => `--- planilha ${nome} ---\n${XLSX.utils.sheet_to_csv(wb.Sheets[nome])}`,
  ).join('\n\n');
}

// pptx é um zip de XML: os textos são os <a:t> de cada slide. Não existe lib pequena
// e boa para isso, e o formato é trivial para extrair texto.
async function fromPptx(buffer: ArrayBuffer): Promise<string> {
  const JSZip = (await import('jszip')).default;
  const zip = await JSZip.loadAsync(buffer);
  const slides = Object.keys(zip.files)
    .filter((f) => /^ppt\/slides\/slide\d+\.xml$/.test(f))
    .sort((a, b) => Number(a.match(/\d+/)![0]) - Number(b.match(/\d+/)![0]));
  const out: string[] = [];
  for (const [i, file] of slides.entries()) {
    const xml = await zip.files[file].async('string');
    const textos = [...xml.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map((m) => unescapeXml(m[1]));
    if (textos.length) out.push(`--- slide ${i + 1} ---\n${textos.join('\n')}`);
  }
  return out.join('\n\n');
}

function unescapeXml(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}
