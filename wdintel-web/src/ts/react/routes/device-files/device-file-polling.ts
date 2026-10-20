export function waitForDeviceFilePoll(delayMs: number | null, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    const timer = setTimeout(
      () => {
        signal.removeEventListener('abort', abort);
        resolve();
      },
      Math.max(250, Math.min(30_000, delayMs ?? 1000)),
    );
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}
