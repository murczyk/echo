(function () {
  const devAssetPrefixes = [
    '/src/',
    '/.elm-land/',
    '/@vite/',
    '/@id/',
    '/node_modules/.vite/',
  ];
  const lastReloadAtStorageKey = 'echo.dev-module-reload-recovery.last-reload-at';
  const autoReloadCooldownMs = 8000;
  const readyProbeUrl = '/.elm-land/server/main.js';
  const readyProbeAttempts = 5;
  const readyProbeDelayMs = 250;
  const recoverableMessageParts = [
    'failed to fetch dynamically imported module',
    'importing a module script failed',
    'error loading dynamically imported module',
    '.vite/deps/',
    '/.elm-land/server/.vite/',
  ];

  let recoveryInFlight = false;

  function handleRecoverableEvent(event) {
    if (!isRecoverableEvent(event)) {
      return;
    }

    event.preventDefault();
    void requestRecovery();
  }

  async function requestRecovery() {
    if (recoveryInFlight || !canAutoReload()) {
      return;
    }

    recoveryInFlight = true;
    markAutoReloadedNow();

    try {
      const ready = await waitForDevServerReady();
      if (ready) {
        window.location.reload();
      }
    } finally {
      recoveryInFlight = false;
    }
  }

  function isRecoverableEvent(event) {
    if (event.type === 'vite:preloadError') {
      return true;
    }

    return isRecoverableUrl(getRecoverableUrl(event)) || isRecoverableMessage(getRecoverableMessage(event));
  }

  function getRecoverableUrl(event) {
    if (event instanceof ErrorEvent && event.filename) {
      return event.filename;
    }

    const target = event.target;
    if (target instanceof HTMLScriptElement) {
      return target.src;
    }

    if (target instanceof HTMLLinkElement) {
      return target.href;
    }

    return null;
  }

  function getRecoverableMessage(event) {
    if (event instanceof ErrorEvent) {
      return [event.message, event.error && event.error.message, event.filename].filter(Boolean).join(' ');
    }

    if (event instanceof PromiseRejectionEvent) {
      const reason = event.reason;
      if (reason instanceof Error) {
        return [reason.message, reason.stack].filter(Boolean).join(' ');
      }

      return String(reason || '');
    }

    return '';
  }

  function isRecoverableUrl(url) {
    if (!url) {
      return false;
    }

    const pathname = toPathname(url);
    return Boolean(pathname && devAssetPrefixes.some((prefix) => pathname.startsWith(prefix)));
  }

  function isRecoverableMessage(message) {
    const normalizedMessage = message.toLowerCase();
    return recoverableMessageParts.some((messagePart) => normalizedMessage.includes(messagePart));
  }

  function toPathname(url) {
    try {
      return new URL(url, window.location.href).pathname;
    } catch {
      return url.startsWith('/') ? url : null;
    }
  }

  function canAutoReload() {
    const lastReloadAt = readLastReloadAt();
    return !Number.isFinite(lastReloadAt) || lastReloadAt <= 0 || Date.now() - lastReloadAt >= autoReloadCooldownMs;
  }

  function markAutoReloadedNow() {
    try {
      window.sessionStorage.setItem(lastReloadAtStorageKey, String(Date.now()));
    } catch {}
  }

  function readLastReloadAt() {
    try {
      return Number(window.sessionStorage.getItem(lastReloadAtStorageKey));
    } catch {
      return 0;
    }
  }

  async function waitForDevServerReady() {
    for (let attempt = 0; attempt < readyProbeAttempts; attempt += 1) {
      if (await probeDevServerReady()) {
        return true;
      }

      if (attempt < readyProbeAttempts - 1) {
        await delay(readyProbeDelayMs);
      }
    }

    return false;
  }

  async function probeDevServerReady() {
    try {
      const response = await fetch(readyProbeUrl, {
        cache: 'no-store',
        credentials: 'same-origin',
      });

      return response.ok;
    } catch {
      return false;
    }
  }

  function delay(ms) {
    return new Promise((resolve) => {
      window.setTimeout(resolve, ms);
    });
  }

  window.addEventListener('error', handleRecoverableEvent, true);
  window.addEventListener('unhandledrejection', handleRecoverableEvent);
  window.addEventListener('vite:preloadError', handleRecoverableEvent);
})();
