/** @vitest-environment happy-dom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { UnitStatsRsp } from '../../../../../Bindings';
import { fetchInboxUnitStats } from '../../../services/api/inbox-unit-stats';
import type { FeedFilterPanelModel } from '../FeedFilterPanel';
import { useDutyUnitOptions } from '../useDutyUnitOptions';
import { buildInboxReq, emptyFilter } from '../utils';

vi.mock('../../../services/api/inbox-unit-stats', () => ({ fetchInboxUnitStats: vi.fn() }));

function deferred() {
  let resolve!: (value: UnitStatsRsp) => void;
  const promise = new Promise<UnitStatsRsp>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function counts(count: number): UnitStatsRsp {
  return { units: [], options: [{ value: 'unit-parent:group:2:6 А', label: '6 А', count }] };
}

function Harness({ frequency = '' }: { frequency?: string }) {
  const panel = {
    sources: {
      unitStatsReq: buildInboxReq({
        filter: { ...emptyFilter(), freqsSelected: frequency ? [frequency] : null },
        loadLatest: true,
      }),
      unitStatsRefreshIntervalMs: 1000,
    },
    actions: { onUnitStatsError: vi.fn() },
  } as FeedFilterPanelModel;
  const { options } = useDutyUnitOptions(panel);
  return <span>{options.map((option) => `${option.label}:${option.count}`).join(',')}</span>;
}

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(fetchInboxUnitStats).mockReset();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
});

it('#3527 finishes slow counts during inbox bursts and coalesces follow-up work', async () => {
  const first = deferred();
  const second = deferred();
  const third = deferred();
  vi.mocked(fetchInboxUnitStats)
    .mockReturnValueOnce(first.promise)
    .mockReturnValueOnce(second.promise)
    .mockReturnValueOnce(third.promise);
  await act(async () => root.render(<Harness />));
  const signal = vi.mocked(fetchInboxUnitStats).mock.calls[0][1]?.signal;
  await act(async () => {
    window.dispatchEvent(new CustomEvent('echo-inbox-changed', { detail: { messageIds: [1] } }));
    await vi.advanceTimersByTimeAsync(1000);
    window.dispatchEvent(new CustomEvent('echo-inbox-changed', { detail: { messageIds: [2, 3] } }));
    await vi.advanceTimersByTimeAsync(10_000);
  });
  expect(fetchInboxUnitStats).toHaveBeenCalledTimes(1);
  expect(signal?.aborted).toBe(false);
  await act(async () => first.resolve(counts(11)));
  expect(container.textContent).toBe('6 А:11');
  expect(fetchInboxUnitStats).toHaveBeenCalledTimes(1);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1000);
  });
  expect(fetchInboxUnitStats).toHaveBeenCalledTimes(2);
  await act(async () => {
    window.dispatchEvent(new CustomEvent('echo-inbox-changed', { detail: { messageIds: [4, 5] } }));
    await vi.advanceTimersByTimeAsync(10_000);
    second.resolve(counts(12));
  });
  expect(container.textContent).toBe('6 А:12');
  expect(fetchInboxUnitStats).toHaveBeenCalledTimes(2);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(999);
  });
  expect(fetchInboxUnitStats).toHaveBeenCalledTimes(2);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1);
    third.resolve(counts(13));
  });
  expect(fetchInboxUnitStats).toHaveBeenCalledTimes(3);
  expect(container.textContent).toBe('6 А:13');
});

it('#3527 discards counts from the old filter scope after a filter change', async () => {
  const first = deferred();
  const second = deferred();
  vi.mocked(fetchInboxUnitStats)
    .mockReturnValueOnce(first.promise)
    .mockReturnValueOnce(second.promise);
  await act(async () => root.render(<Harness frequency="111" />));
  const oldSignal = vi.mocked(fetchInboxUnitStats).mock.calls[0][1]?.signal;
  await act(async () => root.render(<Harness frequency="222" />));
  expect(oldSignal?.aborted).toBe(true);
  await act(async () => second.resolve(counts(5)));
  await act(async () => first.resolve(counts(99)));
  expect(container.textContent).toBe('6 А:5');
});
