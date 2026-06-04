let observer: MutationObserver | null = null;
let syncQueued = false;

function getWatermarkForTablePaper(tablePaper: HTMLElement): string {
  const shell = tablePaper.closest<HTMLElement>('.app-shell[data-auth-user-name]');
  const name = shell?.getAttribute('data-auth-user-name')?.trim() ?? '';
  if (!name || name === 'anonymous') return '';
  return name;
}

export function syncTableWatermarks() {
  if (typeof document === 'undefined') return;

  document.querySelectorAll<HTMLElement>('[data-table-watermark]').forEach((tablePaper) => {
    const nextWatermark = getWatermarkForTablePaper(tablePaper);
    if (tablePaper.getAttribute('data-table-watermark') === nextWatermark) return;
    tablePaper.setAttribute('data-table-watermark', nextWatermark);
  });
}

function scheduleSyncTableWatermarks() {
  if (syncQueued) return;
  syncQueued = true;

  const flush = () => {
    syncQueued = false;
    syncTableWatermarks();
  };

  if (typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(flush);
    return;
  }

  queueMicrotask(flush);
}

export function ensureTableWatermarkObserver() {
  if (typeof document === 'undefined' || typeof MutationObserver === 'undefined') return;
  if (observer) return;

  observer = new MutationObserver(() => {
    scheduleSyncTableWatermarks();
  });

  const root = document.body || document.documentElement;
  if (!root) return;

  observer.observe(root, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['data-auth-user-name'],
  });

  scheduleSyncTableWatermarks();
}
