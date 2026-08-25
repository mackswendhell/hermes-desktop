// Renderer de markdown que constrói nós de DOM com createElement/textContent.
// Nunca usa innerHTML, então texto do modelo não tem como virar markup — é por isso
// que não há sanitizador aqui.
// ponytail: sem lista aninhada além de um nível, sem highlight de sintaxe.

export interface CodeBlock {
  lang: string;
  code: string;
}

function inline(text: string): Node[] {
  const out: Node[] = [];
  // `código` | **negrito** | *itálico* | [rótulo](url) | url solta
  // ênfase precisa abrir e fechar colada ao texto, senão "2 * 3 * 4" vira itálico
  const re =
    /`([^`]+)`|\*\*(\S[^*]*?\S|\S)\*\*|\*(\S[^*\n]*?\S|\S)\*|\[([^\]]+)\]\(([^)\s]+)\)|(https?:\/\/[^\s<>()]+)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(document.createTextNode(text.slice(last, m.index)));
    if (m[1] !== undefined) {
      const el = document.createElement('code');
      el.textContent = m[1];
      out.push(el);
    } else if (m[2] !== undefined) {
      const el = document.createElement('strong');
      el.textContent = m[2];
      out.push(el);
    } else if (m[3] !== undefined) {
      const el = document.createElement('em');
      el.textContent = m[3];
      out.push(el);
    } else {
      const href = m[5] ?? m[6];
      out.push(link(m[4] ?? href, href));
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(document.createTextNode(text.slice(last)));
  return out;
}

function link(label: string, href: string): HTMLElement {
  const a = document.createElement('a');
  a.textContent = label;
  a.href = href;
  // sem isso o clique navega a página file:// do app e o chat some
  a.addEventListener('click', (e) => {
    e.preventDefault();
    window.hermes.openExternal(href);
  });
  return a;
}

function codeBlock(lang: string, code: string): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'code-block';

  const bar = document.createElement('div');
  bar.className = 'code-bar';
  const label = document.createElement('span');
  label.textContent = lang || 'código';
  const btn = document.createElement('button');
  btn.className = 'copy-btn';
  btn.textContent = 'copiar';
  btn.addEventListener('click', () => copyInto(btn, code));
  bar.append(label, btn);

  const pre = document.createElement('pre');
  const el = document.createElement('code');
  el.textContent = code;
  pre.appendChild(el);

  wrap.append(bar, pre);
  return wrap;
}

// tabela GFM: cabeçalho, linha de travessões e as linhas de dados
const TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$/;

function celulas(linha: string): string[] {
  return linha
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((c) => c.trim());
}

// `:---:` centraliza, `---:` alinha à direita; o resto fica no padrão do CSS
function alinhamento(sep: string): string {
  const fim = sep.endsWith(':');
  if (sep.startsWith(':')) return fim ? 'center' : '';
  return fim ? 'right' : '';
}

function tableBlock(linhas: string[]): HTMLElement {
  const bloco = document.createElement('div');
  bloco.className = 'table-block';
  // rola na horizontal em vez de espremer a coluna: a bolha do chat é estreita
  const wrap = document.createElement('div');
  wrap.className = 'table-wrap';
  const table = document.createElement('table');

  const cabecalho = celulas(linhas[0]);
  const alinhas = celulas(linhas[1]).map(alinhamento);
  const thead = document.createElement('thead');
  const trh = document.createElement('tr');
  for (let i = 0; i < cabecalho.length; i++) {
    const th = document.createElement('th');
    th.append(...inline(cabecalho[i]));
    if (alinhas[i]) th.style.textAlign = alinhas[i];
    trh.appendChild(th);
  }
  thead.appendChild(trh);

  const tbody = document.createElement('tbody');
  for (const linha of linhas.slice(2)) {
    const tr = document.createElement('tr');
    const cs = celulas(linha);
    // linha mais curta que o cabeçalho: completa com vazio para a grade não torcer
    for (let i = 0; i < cabecalho.length; i++) {
      const td = document.createElement('td');
      td.append(...inline(cs[i] ?? ''));
      if (alinhas[i]) td.style.textAlign = alinhas[i];
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }

  table.append(thead, tbody);
  wrap.appendChild(table);
  bloco.append(tableBar(table), wrap);
  return bloco;
}

// baixar a tabela: o main é quem tem o SheetJS e o diálogo de salvar
function tableBar(table: HTMLTableElement): HTMLElement {
  const bar = document.createElement('div');
  bar.className = 'table-bar';
  for (const formato of ['xlsx', 'csv'] as const) {
    const btn = document.createElement('button');
    btn.className = 'copy-btn';
    btn.textContent = formato;
    btn.addEventListener('click', async () => {
      const linhas = Array.from(table.rows, (r) => Array.from(r.cells, (c) => c.textContent ?? ''));
      const salvo = await window.hermes.tableSave(linhas, formato);
      if (salvo) {
        btn.textContent = 'salvo ✓';
        setTimeout(() => (btn.textContent = formato), 1500);
      }
    });
    bar.appendChild(btn);
  }
  return bar;
}

export function copyInto(btn: HTMLElement, text: string): void {
  navigator.clipboard.writeText(text).then(() => {
    const antes = btn.textContent;
    btn.textContent = 'copiado ✓';
    setTimeout(() => (btn.textContent = antes), 1500);
  });
}

/** Fatia por cercas ``` e devolve blocos de texto e de código na ordem. */
function slice(md: string): { code: boolean; lang: string; body: string }[] {
  const parts: { code: boolean; lang: string; body: string }[] = [];
  const lines = md.split('\n');
  let buffer: string[] = [];
  let fence: { lang: string; body: string[] } | null = null;

  const flush = () => {
    if (buffer.length) parts.push({ code: false, lang: '', body: buffer.join('\n') });
    buffer = [];
  };

  for (const line of lines) {
    const open = /^```(\w*)\s*$/.exec(line);
    if (fence) {
      if (/^```\s*$/.test(line)) {
        parts.push({ code: true, lang: fence.lang, body: fence.body.join('\n') });
        fence = null;
      } else {
        fence.body.push(line);
      }
    } else if (open) {
      flush();
      fence = { lang: open[1], body: [] };
    } else {
      buffer.push(line);
    }
  }
  // cerca não fechada (resposta cortada): mostra o que veio como código mesmo assim
  if (fence) parts.push({ code: true, lang: fence.lang, body: fence.body.join('\n') });
  flush();
  return parts;
}

function textBlocks(body: string): Node[] {
  const out: Node[] = [];
  const lines = body.split('\n');
  let para: string[] = [];
  let list: HTMLElement | null = null;

  const flushPara = () => {
    if (!para.length) return;
    const p = document.createElement('p');
    p.append(...inline(para.join(' ')));
    out.push(p);
    para = [];
  };
  const flushList = () => {
    if (list) out.push(list);
    list = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const head = /^(#{1,3})\s+(.*)$/.exec(line);
    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    const quote = /^>\s?(.*)$/.exec(line);

    if (!line.trim()) {
      flushPara();
      flushList();
      continue;
    }
    if (line.includes('|') && TABLE_SEP.test(lines[i + 1] ?? '')) {
      flushPara();
      flushList();
      const bloco = [line, lines[i + 1]];
      let j = i + 2;
      while (j < lines.length && lines[j].trim() && lines[j].includes('|')) bloco.push(lines[j++]);
      out.push(tableBlock(bloco));
      i = j - 1;
      continue;
    }
    if (head) {
      flushPara();
      flushList();
      const h = document.createElement(`h${head[1].length}`);
      h.append(...inline(head[2]));
      out.push(h);
      continue;
    }
    if (bullet || numbered) {
      flushPara();
      const tag = bullet ? 'ul' : 'ol';
      if (!list || list.tagName.toLowerCase() !== tag) {
        flushList();
        list = document.createElement(tag);
      }
      const li = document.createElement('li');
      li.append(...inline((bullet ?? numbered)![1]));
      list.appendChild(li);
      continue;
    }
    flushList();
    if (quote) {
      flushPara();
      const bq = document.createElement('blockquote');
      bq.append(...inline(quote[1]));
      out.push(bq);
      continue;
    }
    para.push(line);
  }
  flushPara();
  flushList();
  return out;
}

export function renderMarkdown(md: string): Node[] {
  const out: Node[] = [];
  for (const part of slice(md)) {
    if (part.code) out.push(codeBlock(part.lang, part.body));
    else out.push(...textBlocks(part.body));
  }
  return out;
}
