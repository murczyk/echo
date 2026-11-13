import { copyRichTextToClipboard } from '../../../copy-to-clipboard';

/** Rendered controls and icons that are not part of an answer's text. */
const COPY_SKIP_SELECTOR = '[data-copy-skip], svg, [aria-hidden="true"]';
const COPY_KEPT_ATTRIBUTES = new Set(['href', 'start', 'colspan', 'rowspan']);
const COPY_BLOCK_TAGS = new Set([
  'BLOCKQUOTE',
  'DIV',
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6',
  'HR',
  'OL',
  'P',
  'TABLE',
  'UL',
]);
const COPY_CELL_STYLE = 'border:1px solid;padding:4px 8px';

/** Copies a rendered answer as formatted HTML with a readable plain-text alternative. */
export function copyRenderedAnswer(root: HTMLElement | null): Promise<void> {
  if (!root) return Promise.reject(new Error('The answer is not rendered'));
  const answer = copyableAnswer(root);
  return copyRichTextToClipboard(answer.innerHTML, answerPlainText(answer));
}

/**
 * A detached copy of rendered answer markup without controls, icons or app-only
 * attributes. Elements with `data-copy-text` (map and document chips) become that text;
 * links get absolute URLs so they still work after pasting elsewhere.
 */
export function copyableAnswer(root: HTMLElement): HTMLElement {
  const answer = root.cloneNode(true) as HTMLElement;
  answer.querySelectorAll<HTMLElement>('[data-copy-text]').forEach((element) => {
    element.replaceWith(element.dataset.copyText ?? '');
  });
  answer.querySelectorAll(COPY_SKIP_SELECTOR).forEach((element) => element.remove());
  answer.querySelectorAll<HTMLInputElement>('input[type="checkbox"]').forEach((input) => {
    input.replaceWith(input.checked ? '[x]' : '[ ]');
  });
  for (const element of answer.querySelectorAll('*')) keepCopyAttributes(element);
  answer.querySelectorAll('table').forEach((table) => {
    table.setAttribute('style', 'border-collapse:collapse');
  });
  answer.querySelectorAll('th, td').forEach((cell) => cell.setAttribute('style', COPY_CELL_STYLE));
  return answer;
}

function keepCopyAttributes(element: Element) {
  const href = element instanceof HTMLAnchorElement ? element.href : '';
  for (const name of element.getAttributeNames()) {
    if (!COPY_KEPT_ATTRIBUTES.has(name)) element.removeAttribute(name);
  }
  if (href) element.setAttribute('href', href);
}

/** Readable text of copyable answer markup: blocks on their own lines, lists marked, table cells tab-separated. */
export function answerPlainText(answer: Node): string {
  const writer = new PlainTextWriter();
  writeNode(answer, writer, 0);
  return writer.toString();
}

function writeNode(node: Node, writer: PlainTextWriter, listDepth: number) {
  if (node.nodeType === Node.TEXT_NODE) {
    writer.text((node.textContent ?? '').replace(/\s+/g, ' '));
    return;
  }
  if (!(node instanceof Element)) return;
  const tag = node.tagName;
  if (tag === 'BR') writer.lineBreak(1);
  else if (tag === 'PRE') writePreformatted(node, writer, listDepth);
  else if (tag === 'TR') writeTableRow(node, writer, listDepth);
  else if (tag === 'UL' || tag === 'OL') writeList(node, writer, listDepth);
  else {
    const gap = COPY_BLOCK_TAGS.has(tag) ? blockGap(listDepth) : 0;
    writer.blockBreak(gap);
    node.childNodes.forEach((child) => writeNode(child, writer, listDepth));
    writer.blockBreak(gap);
  }
}

/** Blocks inside list items stay on adjacent lines; top-level blocks get an empty line. */
function blockGap(listDepth: number) {
  return listDepth ? 1 : 2;
}

function writePreformatted(pre: Element, writer: PlainTextWriter, listDepth: number) {
  writer.blockBreak(blockGap(listDepth));
  writer.raw((pre.textContent ?? '').replace(/\n$/, ''));
  writer.blockBreak(blockGap(listDepth));
}

function writeTableRow(row: Element, writer: PlainTextWriter, listDepth: number) {
  writer.lineBreak(1);
  [...row.children].forEach((cell, index) => {
    if (index) writer.marker('\t');
    cell.childNodes.forEach((child) => writeNode(child, writer, listDepth));
  });
  writer.lineBreak(1);
}

function writeList(list: Element, writer: PlainTextWriter, listDepth: number) {
  const ordered = list.tagName === 'OL';
  const start = Number(list.getAttribute('start') ?? 1);
  let number = Number.isInteger(start) ? start : 1;
  writer.blockBreak(blockGap(listDepth));
  for (const item of list.children) {
    if (item.tagName !== 'LI') continue;
    writer.lineBreak(1);
    writer.marker(`${'  '.repeat(listDepth)}${ordered ? `${number++}.` : '•'} `);
    item.childNodes.forEach((child) => writeNode(child, writer, listDepth + 1));
  }
  writer.lineBreak(blockGap(listDepth));
}

/** Builds text line by line, collapsing requested breaks and trimming spaces at line edges. */
class PlainTextWriter {
  private chunks: string[] = [];
  private line = '';
  private breaks = 0;
  private trimStart = true;
  private markerOnly = false;

  text(value: string) {
    this.raw(this.trimStart ? value.replace(/^ +/, '') : value);
  }

  raw(value: string) {
    if (!value) return;
    if (this.breaks) {
      this.chunks.push(this.line.replace(/ +$/, ''), '\n'.repeat(this.breaks));
      this.line = '';
      this.breaks = 0;
    }
    this.line += value;
    this.trimStart = false;
    this.markerOnly = false;
  }

  /** A list bullet or cell separator: the next text starts right after it. */
  marker(value: string) {
    this.raw(value);
    this.trimStart = true;
    this.markerOnly = true;
  }

  /** Ends the line even after a bare marker, e.g. an empty list item or table cell. */
  lineBreak(count: number) {
    if (!count || (!this.line && !this.chunks.length)) return;
    this.breaks = Math.max(this.breaks, count);
    this.trimStart = true;
    this.markerOnly = false;
  }

  /** Separates blocks, except that a block's text stays on the line of its list bullet. */
  blockBreak(count: number) {
    if (!this.markerOnly) this.lineBreak(count);
  }

  toString() {
    return this.chunks.join('') + this.line.replace(/ +$/, '');
  }
}
