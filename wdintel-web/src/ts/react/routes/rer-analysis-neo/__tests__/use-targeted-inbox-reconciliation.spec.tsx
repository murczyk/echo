// @vitest-environment happy-dom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useTargetedInboxReconciliation } from '../use-targeted-inbox-reconciliation';

type ScheduleReconciliation = ReturnType<typeof useTargetedInboxReconciliation>;

function Harness({
  onRender,
  reconcileBatch,
}: {
  onRender: (scheduleReconciliation: ScheduleReconciliation) => void;
  reconcileBatch: Parameters<typeof useTargetedInboxReconciliation>[0];
}) {
  onRender(useTargetedInboxReconciliation(reconcileBatch));
  return null;
}

describe('useTargetedInboxReconciliation', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
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
    await vi.waitFor(() => expect(reconcileBatch).toHaveBeenCalledTimes(1));
    const newest = scheduleReconciliation!([42]);
    scheduleReconciliation!([42]);
    responses[0]?.();
    await vi.waitFor(() => expect(reconcileBatch).toHaveBeenCalledTimes(2));
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
});
