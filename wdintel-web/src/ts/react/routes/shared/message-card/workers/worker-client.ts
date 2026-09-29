export type WorkerTaskResult<T> = { ok: true; value: T } | { ok: false; error: string };

export class WorkerTaskTimeoutError extends Error {
  constructor() {
    super('Worker task timed out');
    this.name = 'WorkerTaskTimeoutError';
  }
}

export function runWorkerTask<TRequest, TResponse>(
  workerFactory: () => Worker,
  request: TRequest,
  signal?: AbortSignal,
  transferList: Transferable[] = [],
  deadlineMs?: number,
): Promise<TResponse> {
  return new Promise((resolve, reject) => {
    if (deadlineMs != null && (!Number.isFinite(deadlineMs) || deadlineMs < 0)) {
      reject(new Error('Invalid worker deadline'));
      return;
    }
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }

    let worker: Worker | null = null;
    const requestId = Math.random().toString(36).slice(2);
    let settled = false;
    const deadline =
      deadlineMs == null
        ? null
        : globalThis.setTimeout(() => settleReject(new WorkerTaskTimeoutError()), deadlineMs);

    const cleanup = () => {
      if (deadline != null) globalThis.clearTimeout(deadline);
      signal?.removeEventListener('abort', onAbort);
      worker?.removeEventListener('message', onMessage);
      worker?.removeEventListener('error', onError);
      worker?.terminate();
    };

    const settleReject = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };

    const settleResolve = (value: TResponse) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };

    const onAbort = () => {
      settleReject(new DOMException('Aborted', 'AbortError'));
    };

    const onMessage = (
      event: MessageEvent<WorkerTaskResult<TResponse> & { requestId?: string }>,
    ) => {
      if (event.data?.requestId !== requestId) return;
      if (event.data.ok) {
        settleResolve(event.data.value);
      } else {
        settleReject(new Error(event.data.error));
      }
    };

    const onError = () => {
      settleReject(new Error('Worker execution failed'));
    };

    try {
      worker = workerFactory();
      signal?.addEventListener('abort', onAbort, { once: true });
      worker.addEventListener('message', onMessage);
      worker.addEventListener('error', onError);
      if (signal?.aborted) {
        onAbort();
        return;
      }
      worker.postMessage({ requestId, request }, transferList);
    } catch (error) {
      settleReject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}
