export type ThumbnailRequestScheduler = <T>(
  signal: AbortSignal,
  request: () => Promise<T>,
) => Promise<T>;

export function createThumbnailRequestScheduler(limit: number): ThumbnailRequestScheduler {
  let active = 0;
  const waiting = new Set<() => void>();
  const next = () => {
    while (active < limit && waiting.size > 0) waiting.values().next().value!();
  };
  return (signal, request) =>
    new Promise((resolve, reject) => {
      const abort = () => {
        waiting.delete(start);
        reject(new DOMException('Aborted', 'AbortError'));
      };
      const start = () => {
        waiting.delete(start);
        signal.removeEventListener('abort', abort);
        if (signal.aborted) {
          abort();
          return;
        }
        active += 1;
        void request()
          .then(resolve, reject)
          .finally(() => {
            active -= 1;
            next();
          });
      };
      if (signal.aborted) {
        abort();
        return;
      }
      waiting.add(start);
      signal.addEventListener('abort', abort, { once: true });
      next();
    });
}
