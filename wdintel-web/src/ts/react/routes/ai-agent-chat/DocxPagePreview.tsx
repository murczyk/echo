import { CircularProgress } from '@mui/material';
import { useEffect, useRef, useState } from 'react';
import { PowerAlert } from '../../components/PowerAlert';
import { emitUnauthorizedEvent } from '../../auth-redirect';

const MAX_PREVIEW_BYTES = 32 * 1024 * 1024;
const PAGE_GAP_PX = 16;

// The rendered document is untrusted: no scripts, no network (remote images,
// fonts and external relationships stay unloaded) and links do not navigate.
const FRAME_DOCUMENT = `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; font-src data: blob:">
<style>
html, body { margin: 0; background: transparent; }
body { padding: ${PAGE_GAP_PX}px 0; }
.docx-wrapper { background: transparent !important; padding: 0 !important; display: flex; flex-direction: column; align-items: center; gap: ${PAGE_GAP_PX}px; }
.docx-wrapper > section.docx { box-shadow: 0 1px 4px rgba(0, 0, 0, 0.25); margin: 0 !important; }
a { pointer-events: none; }
</style></head><body><div id="docx-styles"></div><div id="docx-pages"></div></body></html>`;

async function fetchDocx(href: string, signal: AbortSignal): Promise<ArrayBuffer> {
  const response = await fetch(href, { signal, credentials: 'same-origin' });
  if (response.status === 401) emitUnauthorizedEvent();
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const length = Number(response.headers.get('content-length') ?? 0);
  if (length > MAX_PREVIEW_BYTES) throw new Error('too-large');
  const buffer = await response.arrayBuffer();
  if (buffer.byteLength > MAX_PREVIEW_BYTES) throw new Error('too-large');
  return buffer;
}

// Word list bullets are private-use glyphs of the Symbol and Wingdings fonts,
// which browsers outside Windows lack; show their Unicode look-alikes.
const SYMBOL_BULLETS: Record<string, string> = {
  '\uf0b7': '•',
  '\uf0a7': '▪',
  '\uf0a8': '◦',
  '\uf076': '❖',
  '\uf0d8': '➢',
  '\uf0fc': '✓',
};
const SYMBOL_BULLET_PATTERN = new RegExp(`[${Object.keys(SYMBOL_BULLETS).join('')}]`, 'g');

function replaceSymbolBullets(styles: HTMLElement) {
  for (const style of styles.querySelectorAll('style')) {
    const text = style.textContent ?? '';
    if (SYMBOL_BULLET_PATTERN.test(text))
      style.textContent = text.replace(SYMBOL_BULLET_PATTERN, (glyph) => SYMBOL_BULLETS[glyph]);
    SYMBOL_BULLET_PATTERN.lastIndex = 0;
  }
}

function neutralizeLinks(root: ParentNode) {
  for (const anchor of root.querySelectorAll('a[href]')) {
    if (!anchor.getAttribute('href')?.startsWith('#')) anchor.removeAttribute('href');
  }
}

/** Fits the widest page into the frame width. */
function fitPages(frame: HTMLIFrameElement) {
  const body = frame.contentDocument?.body;
  if (!body) return;
  body.style.zoom = '1';
  const pages = [...body.querySelectorAll<HTMLElement>('section.docx')];
  const widest = Math.max(0, ...pages.map((page) => page.offsetWidth));
  const available = frame.clientWidth - 2 * PAGE_GAP_PX;
  if (widest > 0 && available > 0) body.style.zoom = String(Math.min(1, available / widest));
}

/** Page-like rendering of a .docx file (styles, tables, headers, images). */
export function DocxPagePreview({ href, title }: { href: string; title: string }) {
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error' | 'too-large'>('loading');

  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    const controller = new AbortController();
    let disposed = false;
    setStatus('loading');
    const render = async () => {
      const [buffer, { renderAsync }] = await Promise.all([
        fetchDocx(href, controller.signal),
        import('docx-preview'),
      ]);
      const target = frame.contentDocument;
      if (disposed || !target) return;
      target.open();
      target.write(FRAME_DOCUMENT);
      target.close();
      // docx-preview empties both containers, so they are separate from the frame styles.
      const pages = target.getElementById('docx-pages');
      const styles = target.getElementById('docx-styles');
      if (!pages || !styles) return;
      await renderAsync(buffer, pages, styles, {
        inWrapper: true,
        breakPages: true,
        ignoreLastRenderedPageBreak: true,
        renderHeaders: true,
        renderFooters: true,
        renderFootnotes: true,
        renderEndnotes: true,
        renderComments: false,
        renderChanges: false,
        renderAltChunks: false,
        useBase64URL: true,
        experimental: false,
      });
      if (disposed) return;
      replaceSymbolBullets(styles);
      neutralizeLinks(target);
      fitPages(frame);
      setStatus('ready');
    };
    render().catch((error: unknown) => {
      if (disposed || controller.signal.aborted) return;
      setStatus(error instanceof Error && error.message === 'too-large' ? 'too-large' : 'error');
    });
    return () => {
      disposed = true;
      controller.abort();
    };
  }, [href]);

  useEffect(() => {
    const frame = frameRef.current;
    if (!frame || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => fitPages(frame));
    observer.observe(frame);
    return () => observer.disconnect();
  }, []);

  return (
    <div className="ai-document-preview" data-testid="ai-document-preview">
      <iframe
        ref={frameRef}
        title={`Попередній перегляд: ${title}`}
        sandbox="allow-same-origin"
        className={status === 'ready' ? '' : 'invisible'}
      />
      {status === 'loading' ? (
        <div className="ai-document-preview-overlay">
          <CircularProgress aria-label="Завантажуємо документ" />
        </div>
      ) : null}
      {status === 'error' || status === 'too-large' ? (
        <div className="ai-document-preview-overlay">
          <PowerAlert severity="warning">
            {status === 'too-large'
              ? 'Документ завеликий для попереднього перегляду. Завантажте його.'
              : 'Не вдалося показати документ. Завантажте його, щоб відкрити у Word.'}
          </PowerAlert>
        </div>
      ) : null}
    </div>
  );
}
