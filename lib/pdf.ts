/**
 * A minimal PDF writer, for signature records (spec section 9, step 5:
 * "Generate a PDF of the signed document at submission time and store it as a
 * FIRM_ONLY document").
 *
 * Hand-written rather than a dependency, for two reasons that both come from
 * what this document is for. It is evidence: it may be produced years later to
 * show what somebody agreed to, so the bytes should be produced by code we can
 * read in an afternoon rather than by a library whose rendering of a paragraph
 * changed in a minor version. And it is tiny: one font, black text, no images,
 * no vector graphics — perhaps two percent of what a PDF library does.
 *
 * The output targets PDF 1.4 with the base-14 Helvetica, which every reader
 * since 1993 has had built in. Text is encoded WinAnsi, which covers every
 * accented character Spanish uses.
 */

const PAGE_WIDTH = 612; // US Letter, 8.5in at 72dpi
const PAGE_HEIGHT = 792;
const MARGIN = 64;
const BODY_SIZE = 10.5;
const BODY_LEADING = 14.5;
const HEADING_SIZE = 15;

const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;

export interface PdfBlock {
  text: string;
  style?: 'heading' | 'body' | 'label' | 'mono';
}

/**
 * Helvetica advance widths, in 1/1000 em, for the printable WinAnsi range.
 *
 * Needed because line breaking has to happen before the text is written, and
 * "assume every character is 0.5em" wraps a paragraph of lowercase text about
 * fifteen percent short — which on a legal authorization looks like the text
 * was truncated.
 */
const HELVETICA_WIDTHS: Record<string, number> = {
  ' ': 278, '!': 278, '"': 355, '#': 556, $: 556, '%': 889, '&': 667, "'": 191,
  '(': 333, ')': 333, '*': 389, '+': 584, ',': 278, '-': 333, '.': 278, '/': 278,
  '0': 556, '1': 556, '2': 556, '3': 556, '4': 556, '5': 556, '6': 556, '7': 556,
  '8': 556, '9': 556, ':': 278, ';': 278, '<': 584, '=': 584, '>': 584, '?': 556,
  '@': 1015, A: 667, B: 667, C: 722, D: 722, E: 667, F: 611, G: 778, H: 722,
  I: 278, J: 500, K: 667, L: 556, M: 833, N: 722, O: 778, P: 667, Q: 778, R: 722,
  S: 667, T: 611, U: 722, V: 667, W: 944, X: 667, Y: 667, Z: 611,
  '[': 278, '\\': 278, ']': 278, '^': 469, _: 556, '`': 333,
  a: 556, b: 556, c: 500, d: 556, e: 556, f: 278, g: 556, h: 556, i: 222, j: 222,
  k: 500, l: 222, m: 833, n: 556, o: 556, p: 556, q: 556, r: 333, s: 500, t: 278,
  u: 556, v: 500, w: 722, x: 500, y: 500, z: 500,
  '{': 334, '|': 260, '}': 334, '~': 584,
};

/** Bold is wider; close enough for headings, which are short by definition. */
function charWidth(char: string, bold: boolean): number {
  const base = HELVETICA_WIDTHS[char] ?? 556;
  return bold ? base * 1.06 : base;
}

function textWidth(text: string, size: number, bold: boolean): number {
  let total = 0;
  for (const char of text) total += charWidth(char, bold);
  return (total / 1000) * size;
}

/** Greedy wrap. Words longer than a line are broken rather than overflowing. */
function wrap(text: string, size: number, bold: boolean, width: number): string[] {
  const lines: string[] = [];

  for (const paragraph of text.split('\n')) {
    if (paragraph.trim() === '') {
      lines.push('');
      continue;
    }

    let current = '';
    for (const word of paragraph.split(/\s+/)) {
      const candidate = current ? `${current} ${word}` : word;
      if (textWidth(candidate, size, bold) <= width) {
        current = candidate;
        continue;
      }
      if (current) lines.push(current);

      if (textWidth(word, size, bold) <= width) {
        current = word;
        continue;
      }
      // A single token wider than the line — a URL, or a hash.
      let chunk = '';
      for (const char of word) {
        if (textWidth(chunk + char, size, bold) > width) {
          lines.push(chunk);
          chunk = char;
        } else {
          chunk += char;
        }
      }
      current = chunk;
    }
    if (current) lines.push(current);
  }

  return lines;
}

/** `(`, `)` and `\` terminate or escape a PDF string literal. */
function escapePdfString(text: string): string {
  return text.replace(/[\\()]/g, (c) => `\\${c}`);
}

/**
 * WinAnsi is a superset of Latin-1 for the characters this document uses, so
 * latin1 encoding is correct. Characters outside it — a curly quote pasted from
 * a word processor, say — are replaced rather than dropped, because a missing
 * character in a legal text is worse than a visibly substituted one.
 */
function toWinAnsi(text: string): string {
  return text
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/—/g, '--')
    .replace(/–/g, '-')
    .replace(/…/g, '...')
    .replace(/ /g, ' ');
}

export interface PdfOptions {
  title: string;
  /** Repeated at the foot of every page, e.g. the document hash. */
  footer?: string;
}

export function renderPdf(blocks: PdfBlock[], options: PdfOptions): Buffer {
  // --- lay out -------------------------------------------------------------
  interface Line {
    text: string;
    size: number;
    bold: boolean;
    gapAfter: number;
  }

  const pages: Line[][] = [];
  let page: Line[] = [];
  let used = 0;
  const usableHeight = PAGE_HEIGHT - MARGIN * 2 - 24; // 24 reserved for the footer

  const push = (line: Line) => {
    if (used + line.size + line.gapAfter > usableHeight) {
      pages.push(page);
      page = [];
      used = 0;
    }
    page.push(line);
    used += BODY_LEADING + line.gapAfter;
  };

  for (const block of blocks) {
    const heading = block.style === 'heading';
    const label = block.style === 'label';
    const size = heading ? HEADING_SIZE : BODY_SIZE;
    const bold = heading || label;

    const wrapped = wrap(toWinAnsi(block.text), size, bold, CONTENT_WIDTH);
    wrapped.forEach((text, index) => {
      push({
        text,
        size,
        bold,
        gapAfter: index === wrapped.length - 1 ? (heading ? 10 : 6) : 0,
      });
    });
  }
  pages.push(page);

  // --- serialize -----------------------------------------------------------
  const objects: string[] = [];
  const addObject = (body: string): number => {
    objects.push(body);
    return objects.length; // object numbers are 1-based
  };

  const catalogId = addObject(''); // 1, patched below once Pages is known
  const pagesId = addObject('');
  const regularFontId = addObject(
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
  );
  const boldFontId = addObject(
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>',
  );

  const pageIds: number[] = [];

  for (const [index, lines] of pages.entries()) {
    let y = PAGE_HEIGHT - MARGIN;
    let stream = 'BT\n';

    for (const line of lines) {
      stream += `/${line.bold ? 'F2' : 'F1'} ${line.size} Tf\n`;
      stream += `1 0 0 1 ${MARGIN} ${y.toFixed(2)} Tm\n`;
      stream += `(${escapePdfString(line.text)}) Tj\n`;
      y -= BODY_LEADING + line.gapAfter;
    }

    const footer = options.footer
      ? `${options.footer}    ${index + 1} / ${pages.length}`
      : `${index + 1} / ${pages.length}`;
    stream += '/F1 7.5 Tf\n';
    stream += `1 0 0 1 ${MARGIN} ${MARGIN - 24} Tm\n`;
    stream += `(${escapePdfString(toWinAnsi(footer))}) Tj\n`;
    stream += 'ET';

    const contentId = addObject(
      `<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`,
    );

    pageIds.push(
      addObject(
        `<< /Type /Page /Parent ${pagesId} 0 R ` +
          `/MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] ` +
          `/Resources << /Font << /F1 ${regularFontId} 0 R /F2 ${boldFontId} 0 R >> >> ` +
          `/Contents ${contentId} 0 R >>`,
      ),
    );
  }

  objects[catalogId - 1] = `<< /Type /Catalog /Pages ${pagesId} 0 R >>`;
  objects[pagesId - 1] =
    `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] ` +
    `/Count ${pageIds.length} >>`;

  const infoId = addObject(
    `<< /Title (${escapePdfString(toWinAnsi(options.title))}) /Producer (Onboarding Platform) >>`,
  );

  // --- assemble, tracking byte offsets for the xref table ------------------
  const chunks: Buffer[] = [];
  let offset = 0;
  const push2 = (text: string) => {
    const buffer = Buffer.from(text, 'latin1');
    chunks.push(buffer);
    offset += buffer.byteLength;
  };

  push2('%PDF-1.4\n');
  // A binary comment marks the file as binary for tools that sniff content.
  push2('%\xE2\xE3\xCF\xD3\n');

  const offsets: number[] = [];
  objects.forEach((body, index) => {
    offsets[index] = offset;
    push2(`${index + 1} 0 obj\n${body}\nendobj\n`);
  });

  const xrefOffset = offset;
  push2(`xref\n0 ${objects.length + 1}\n`);
  push2('0000000000 65535 f \n');
  for (const objectOffset of offsets) {
    push2(`${String(objectOffset).padStart(10, '0')} 00000 n \n`);
  }
  push2(
    `trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R /Info ${infoId} 0 R >>\n` +
      `startxref\n${xrefOffset}\n%%EOF\n`,
  );

  return Buffer.concat(chunks);
}
