// PDF é lido aqui, e não no main, porque o pdf.js depende de APIs do DOM
// (DOMMatrix e cia) que não existem no processo main do Electron.
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import workerSrc from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs';

let ready = false;

export async function pdfToText(buffer: ArrayBuffer): Promise<string> {
  if (!ready) {
    // worker embutido como blob: a CSP não deixa buscar arquivo externo
    const blob = new Blob([workerSrc], { type: 'text/javascript' });
    pdfjs.GlobalWorkerOptions.workerSrc = URL.createObjectURL(blob);
    ready = true;
  }
  const task = pdfjs.getDocument({
    data: new Uint8Array(buffer),
    useWorkerFetch: false,
    disableFontFace: true,
  });
  const doc = await task.promise;
  const paginas: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    const linha = content.items
      .map((it) => ('str' in it ? it.str : ''))
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (linha) paginas.push(`--- página ${i} ---\n${linha}`);
  }
  await task.destroy();
  return paginas.join('\n\n');
}
