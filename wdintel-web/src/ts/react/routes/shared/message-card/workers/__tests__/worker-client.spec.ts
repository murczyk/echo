import { describe, expect, it, vi } from 'vitest';

import { runWorkerTask, WorkerTaskTimeoutError, type WorkerTaskResult } from '../worker-client';

class FakeWorker {
  readonly listeners = new Map<string, EventListener>();
  readonly postMessage = vi.fn();
  readonly terminate = vi.fn();

  addEventListener(type: string, listener: EventListener): void {
    this.listeners.set(type, listener);
  }

  removeEventListener(type: string, listener: EventListener): void {
    if (this.listeners.get(type) === listener) this.listeners.delete(type);
  }

  emitMessage(value: WorkerTaskResult<string> & { requestId: string }): void {
    this.listeners.get('message')?.({ data: value } as MessageEvent);
  }

  emitError(): void {
    this.listeners.get('error')?.(new Event('error'));
  }
}

describe('runWorkerTask', () => {
  it('terminates and returns a distinct error when its parent deadline expires', async () => {
    vi.useFakeTimers();
    try {
      const worker = new FakeWorker();
      const task = runWorkerTask(
        () => worker as unknown as Worker,
        { buffer: new ArrayBuffer(1) },
        undefined,
        [],
        5,
      );
      const rejected = expect(task).rejects.toBeInstanceOf(WorkerTaskTimeoutError);

      await vi.advanceTimersByTimeAsync(5);

      await rejected;
      expect(worker.terminate).toHaveBeenCalledOnce();
      expect(worker.listeners.size).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('settles once and ignores a late matching message after cleanup', async () => {
    const worker = new FakeWorker();
    const task = runWorkerTask(() => worker as unknown as Worker, { value: 1 });
    const [[{ requestId }]] = worker.postMessage.mock.calls as [[{ requestId: string }]];

    expect(requestId).toBeTypeOf('string');
    expect(worker.listeners.get('message')).toBeTypeOf('function');
    worker.emitMessage({ requestId, ok: true, value: 'ready' });
    expect(worker.terminate).toHaveBeenCalledOnce();
    await expect(task).resolves.toBe('ready');
    worker.emitMessage({ requestId, ok: false, error: 'late failure' });

    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(worker.listeners.size).toBe(0);
  });

  it('rejects synchronous factory and post-message failures with cleanup', async () => {
    await expect(
      runWorkerTask(() => {
        throw new Error('factory failed');
      }, {}),
    ).rejects.toThrow('factory failed');

    const worker = new FakeWorker();
    worker.postMessage.mockImplementation(() => {
      throw new Error('post failed');
    });
    await expect(runWorkerTask(() => worker as unknown as Worker, {})).rejects.toThrow(
      'post failed',
    );
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(worker.listeners.size).toBe(0);
  });

  it('rejects invalid parent deadlines before creating a worker', async () => {
    const factory = vi.fn(() => new FakeWorker() as unknown as Worker);
    await expect(runWorkerTask(factory, {}, undefined, [], Number.NaN)).rejects.toThrow(
      'Invalid worker deadline',
    );
    expect(factory).not.toHaveBeenCalled();
  });

  it('does not post when the signal aborts during worker setup', async () => {
    const controller = new AbortController();
    const worker = new FakeWorker();
    const original = worker.addEventListener.bind(worker);
    worker.addEventListener = ((type: string, listener: EventListener) => {
      original(type, listener);
      if (type === 'message') controller.abort();
    }) as FakeWorker['addEventListener'];

    await expect(
      runWorkerTask(() => worker as unknown as Worker, {}, controller.signal),
    ).rejects.toThrow('Aborted');
    expect(worker.postMessage).not.toHaveBeenCalled();
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it('ignores a timeout after a successful response', async () => {
    vi.useFakeTimers();
    try {
      const worker = new FakeWorker();
      const task = runWorkerTask(() => worker as unknown as Worker, {}, undefined, [], 5);
      const [[{ requestId }]] = worker.postMessage.mock.calls as [[{ requestId: string }]];
      worker.emitMessage({ requestId, ok: true, value: 'ready' });

      await expect(task).resolves.toBe('ready');
      await vi.advanceTimersByTimeAsync(5);
      expect(worker.terminate).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('settles once when worker failure races with abort', async () => {
    const controller = new AbortController();
    const worker = new FakeWorker();
    const task = runWorkerTask(() => worker as unknown as Worker, {}, controller.signal);

    worker.emitError();
    controller.abort();

    await expect(task).rejects.toThrow('Worker execution failed');
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it('ignores foreign request IDs until the deadline expires', async () => {
    vi.useFakeTimers();
    try {
      const worker = new FakeWorker();
      const task = runWorkerTask(() => worker as unknown as Worker, {}, undefined, [], 5);
      worker.emitMessage({ requestId: 'foreign', ok: true, value: 'unexpected' });
      const rejected = expect(task).rejects.toBeInstanceOf(WorkerTaskTimeoutError);

      await vi.advanceTimersByTimeAsync(5);
      await rejected;
      expect(worker.terminate).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
});
