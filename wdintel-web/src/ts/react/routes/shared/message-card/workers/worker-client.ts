export type WorkerTaskResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

export function runWorkerTask<TRequest, TResponse>(
  workerFactory: () => Worker,
  request: TRequest,
  signal?: AbortSignal,
): Promise<TResponse> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }

    const worker = workerFactory();
    const requestId = Math.random().toString(36).slice(2);

    const cleanup = () => {
      signal?.removeEventListener('abort', onAbort);
      worker.removeEventListener('message', onMessage);
      worker.removeEventListener('error', onError);
      worker.terminate();
    };

    const onAbort = () => {
      cleanup();
      reject(new DOMException('Aborted', 'AbortError'));
    };

    const onMessage = (event: MessageEvent<WorkerTaskResult<TResponse> & { requestId?: string }>) => {
      if (event.data?.requestId !== requestId) return;
      cleanup();
      if (event.data.ok) {
        resolve(event.data.value);
      } else {
        reject(new Error(event.data.error));
      }
    };

    const onError = () => {
      cleanup();
      reject(new Error('Worker execution failed'));
    };

    signal?.addEventListener('abort', onAbort, { once: true });
    worker.addEventListener('message', onMessage);
    worker.addEventListener('error', onError);
    worker.postMessage({ requestId, request });
  });
}

