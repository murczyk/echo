export function copyTextToClipboard(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    return navigator.clipboard.writeText(text).catch(() => fallbackCopyTextToClipboard(text));
  }

  return fallbackCopyTextToClipboard(text);
}

/**
 * Copies `text`, with an optional HTML version that rich editors paste instead. Its
 * fallback never moves focus, so it also works inside menus and dialogs that trap focus.
 */
export async function copyTextToClipboardInPlace(text: string, html?: string): Promise<void> {
  if (await writeWithClipboardApi(text, html)) return;
  if (!copyWithCopyEvent(text, html)) await copyTextToClipboard(text);
}

async function writeWithClipboardApi(text: string, html?: string): Promise<boolean> {
  try {
    if (html === undefined && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
    if (html !== undefined && navigator.clipboard?.write && typeof ClipboardItem !== 'undefined') {
      await navigator.clipboard.write([
        new ClipboardItem({
          'text/html': new Blob([html], { type: 'text/html' }),
          'text/plain': new Blob([text], { type: 'text/plain' }),
        }),
      ]);
      return true;
    }
  } catch {
    // Denied, or no clipboard access on plain HTTP: fall back to a copy event.
  }
  return false;
}

function copyWithCopyEvent(text: string, html?: string): boolean {
  let written = false;
  const onCopy = (event: ClipboardEvent) => {
    if (!event.clipboardData) return;
    if (html !== undefined) event.clipboardData.setData('text/html', html);
    event.clipboardData.setData('text/plain', text);
    event.preventDefault();
    written = true;
  };
  document.addEventListener('copy', onCopy);
  try {
    return document.execCommand('copy') && written;
  } catch {
    return false;
  } finally {
    document.removeEventListener('copy', onCopy);
  }
}

// When copy runs after async UI work, the browser may report that the document is not focused.
// This fallback keeps copy working in the same way across Elm and React callers.
function fallbackCopyTextToClipboard(text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.left = '-9999px';
    textarea.style.top = '0';
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();

    try {
      if (document.execCommand('copy')) {
        resolve();
      } else {
        reject(new Error('Copy command was rejected'));
      }
    } finally {
      document.body.removeChild(textarea);
    }
  });
}
