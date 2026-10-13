// @vitest-environment happy-dom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useTargetedInboxReconciliation } from '../use-targeted-inbox-reconciliation';

type ScheduleReconciliation = ReturnType<typeof useTargetedInboxReconciliation>;

function Harness({
  onRender,
  reconcileBatch,
  scopeKey,
}: {
  onRender: (scheduleReconciliation: ScheduleReconciliation) => void;
  reconcileBatch: Parameters<typeof useTargetedInboxReconciliation>[0];
  scopeKey?: string;
}) {
  onRender(useTargetedInboxReconciliation(reconcileBatch, scopeKey));
  return null;
}

describe('useTargetedInboxReconciliation', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.useFakeTimers();
    container = document.createElement('div');
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    vi.useRealTimers();
  });
  it('coalesces an in-flight message into one follow-up and applies only the newest response', async () => {
    const responses: Array<() => void> = [];
    const applied: number[] = [];
    const reconcileBatch = vi.fn(
      async (messageIds: number[], shouldApply: (messageId: number) => boolean): Promise<void> => {
        const responseNumber = responses.length + 1;
        await new Promise<void>((resolve) => responses.push(resolve));
        messageIds.forEach((messageId) => {
          if (shouldApply(messageId)) applied.push(responseNumber);
        });
      },
    );
    let scheduleReconciliation: ScheduleReconciliation | undefined;
    act(() => {
      root.render(
        <Harness
          reconcileBatch={reconcileBatch}
          onRender={(schedule) => (scheduleReconciliation = schedule)}
        />,
      );
    });

    const first = scheduleReconciliation!([42]);
    await act(async () => vi.advanceTimersByTimeAsync(0));
    expect(reconcileBatch).toHaveBeenCalledTimes(1);
    const newest = scheduleReconciliation!([42]);
    scheduleReconciliation!([42]);
    responses[0]?.();
    await act(async () => vi.advanceTimersByTimeAsync(1_999));
    expect(reconcileBatch).toHaveBeenCalledTimes(1);
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(reconcileBatch).toHaveBeenCalledTimes(2);
    expect(applied).toEqual([]);

    responses[1]?.();
    await Promise.all([first, newest]);

    expect(applied).toEqual([2]);
    expect(reconcileBatch).toHaveBeenNthCalledWith(
      2,
      [42],
      expect.any(Function),
      expect.any(AbortSignal),
    );
  });
  it('aborts the active request and prevents application after unmount', async () => {
    let finishRequest: (() => void) | undefined;
    let shouldApply: ((messageId: number) => boolean) | undefined;
    let signal: AbortSignal | undefined;
    const reconcileBatch = vi.fn(
      async (
        _messageIds: number[],
        canApply: (messageId: number) => boolean,
        requestSignal: AbortSignal,
      ) => {
        shouldApply = canApply;
        signal = requestSignal;
        await new Promise<void>((resolve) => (finishRequest = resolve));
      },
    );
    let scheduleReconciliation: ScheduleReconciliation | undefined;
    act(() => {
      root.render(
        <Harness
          reconcileBatch={reconcileBatch}
          onRender={(schedule) => (scheduleReconciliation = schedule)}
        />,
      );
    });

    void scheduleReconciliation!([42]);
    await vi.waitFor(() => expect(reconcileBatch).toHaveBeenCalledOnce());
    act(() => root.unmount());

    expect(signal?.aborted).toBe(true);
    expect(shouldApply?.(42)).toBe(false);
    finishRequest?.();
  });

  it('#3780 batches four events per second without losing repeated or pending IDs', async () => {
    const starts: number[] = [];
    const applied: number[] = [];
    const reconcileBatch = vi.fn(
      async (messageIds: number[], shouldApply: (messageId: number) => boolean) => {
        starts.push(performance.now());
        applied.push(...messageIds.filter(shouldApply));
      },
    );
    let schedule!: ScheduleReconciliation;
    act(() =>
      root.render(
        <Harness reconcileBatch={reconcileBatch} onRender={(value) => (schedule = value)} />,
      ),
    );
    let pending = Promise.resolve();
    for (let index = 0; index < 40; ++index) {
      pending = schedule([42, 100 + index]);
      await act(async () => vi.advanceTimersByTimeAsync(250));
    }
    await pending;
    expect(starts).toEqual([0, 2_000, 4_000, 6_000, 8_000, 10_000]);
    expect(new Set(applied)).toEqual(
      new Set([42, ...Array.from({ length: 40 }, (_, index) => 100 + index)]),
    );
  });

  it('#3780 lets a user mutation bypass the system wait and keeps queued updates', async () => {
    const starts: number[] = [];
    const reconcileBatch = vi.fn(async (_messageIds: number[]) => {
      starts.push(performance.now());
    });
    let schedule!: ScheduleReconciliation;
    act(() =>
      root.render(
        <Harness reconcileBatch={reconcileBatch} onRender={(value) => (schedule = value)} />,
      ),
    );
    void schedule([42]);
    await act(async () => vi.advanceTimersByTimeAsync(0));
    const system = schedule([43]);
    await act(async () => vi.advanceTimersByTimeAsync(250));
    const user = schedule([44], { immediate: true });
    await act(async () => vi.advanceTimersByTimeAsync(0));
    await Promise.all([system, user]);
    expect(starts).toEqual([0, 250]);
    expect(reconcileBatch).toHaveBeenLastCalledWith(
      [44, 43],
      expect.any(Function),
      expect.any(AbortSignal),
    );
  });

  it('#3780 aborts an obsolete scope without letting its response drain the new scope', async () => {
    let finish!: () => void;
    let oldSignal!: AbortSignal;
    const applied: number[] = [];
    const reconcileBatch = vi.fn(
      async (
        messageIds: number[],
        shouldApply: (messageId: number) => boolean,
        signal: AbortSignal,
      ) => {
        if (messageIds.includes(42)) {
          oldSignal = signal;
          await new Promise<void>((resolve) => (finish = resolve));
        }
        applied.push(...messageIds.filter(shouldApply));
      },
    );
    let schedule!: ScheduleReconciliation;
    const render = (scopeKey: string) =>
      act(() =>
        root.render(
          <Harness
            scopeKey={scopeKey}
            reconcileBatch={reconcileBatch}
            onRender={(value) => (schedule = value)}
          />,
        ),
      );
    render('old');
    const obsolete = schedule([42]);
    await act(async () => vi.advanceTimersByTimeAsync(0));
    void schedule([43]);
    render('new');
    await obsolete;
    expect(oldSignal.aborted).toBe(true);
    const current = schedule([9]);
    await act(async () => vi.advanceTimersByTimeAsync(0));
    await current;
    finish();
    await act(async () => vi.advanceTimersByTimeAsync(4_000));
    expect(applied).toEqual([9]);
    expect(reconcileBatch).toHaveBeenCalledTimes(2);
  });
});
