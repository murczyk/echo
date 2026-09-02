/** @vitest-environment happy-dom */
import { act, createElement, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { HttpRequestError } from '../../../../../services/api/client';
import {
  findSettlementPrefix,
  type SettlementDetails,
} from '../../../../../services/api/settlements';
import { parseCoordLine } from '../../manage-message-drawer.schema';
import { useSettlementAutocomplete } from '../useSettlementAutocomplete';

vi.mock('../../../../../services/api/settlements', () => ({
  findSettlementPrefix: vi.fn(),
}));

const findSettlementPrefixMock = vi.mocked(findSettlementPrefix);

const merefaKharkiv: SettlementDetails = {
  id: 6872990,
  name: 'МЕРЕФА',
  region: 'Харківська область',
  language: 'Ua',
  coords: [49.8197, 36.0507],
};

const merefaOtherRegion: SettlementDetails = {
  id: 7000001,
  name: 'МЕРЕФА',
  region: 'Інша область',
  language: 'Ua',
  coords: [48.1, 35.2],
};

type HarnessProps = {
  open?: boolean;
  busy?: boolean;
  coordsText?: string;
  signalGroupMasterKey?: string | null;
  onError: (message: string) => void;
};

let latest: ReturnType<typeof useSettlementAutocomplete> | undefined;

function Harness({
  open = true,
  busy = false,
  coordsText,
  signalGroupMasterKey = null,
  onError,
}: HarnessProps) {
  const result = useSettlementAutocomplete({
    open,
    busy,
    coordsText,
    signalGroupMasterKey,
    onError,
  });
  useEffect(() => {
    latest = result;
  });
  latest = result;
  return null;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

// @test-scope safeguard: prevents stale settlement suggestions from replacing the current coordinate or typed search input.
describe('useSettlementAutocomplete', () => {
  let root: Root;
  let container: HTMLDivElement;
  let onError: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    findSettlementPrefixMock.mockReset();
    onError = vi.fn();
    latest = undefined;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
  });

  async function render(
    props: Omit<HarnessProps, 'onError'> & { onError?: HarnessProps['onError'] } = {},
  ) {
    await act(async () => {
      root.render(createElement(Harness, { ...props, onError: props.onError ?? onError }));
    });
  }

  async function input(value: string) {
    await act(async () => {
      latest?.onInputChange(value, 'input');
    });
  }

  async function inputEvent(value: string, reason: 'clear' | 'reset' | 'selectOption') {
    await act(async () => {
      latest?.onInputChange(value, reason);
    });
  }

  async function advance(ms: number) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  }

  it('does not search for one character or whitespace-only input', async () => {
    await render();

    await input('м');
    await advance(301);
    await input('   ');
    await advance(301);

    expect(findSettlementPrefixMock).not.toHaveBeenCalled();
    expect(latest?.settlementOptions).toEqual([]);
    expect(latest?.loading).toBe(false);
  });

  it('debounces eligible input and preserves the entered query', async () => {
    const request = deferred<SettlementDetails[]>();
    findSettlementPrefixMock.mockReturnValueOnce(request.promise);
    await render({ coordsText: '49.82, 36.05' });

    await input(' мер');
    await advance(299);
    expect(findSettlementPrefixMock).not.toHaveBeenCalled();

    await advance(1);
    expect(findSettlementPrefixMock).toHaveBeenCalledWith({
      query: ' мер',
      relatedCoordinates: [49.82, 36.05],
      signalGroupMasterKey: null,
      signal: expect.any(AbortSignal),
    });
    expect(latest?.loading).toBe(true);

    await act(async () => request.resolve([merefaKharkiv]));
    expect(latest?.settlementOptions).toEqual([merefaKharkiv]);
    expect(latest?.loading).toBe(false);
  });

  it('clears old results and shows loading immediately for eligible input', async () => {
    const request = deferred<SettlementDetails[]>();
    findSettlementPrefixMock.mockReturnValueOnce(request.promise);
    await render();
    await input('мер');
    await advance(300);
    await act(async () => request.resolve([merefaKharkiv]));
    expect(latest?.settlementOptions).toEqual([merefaKharkiv]);

    await input('мере');

    expect(latest?.settlementOptions).toEqual([]);
    expect(latest?.loading).toBe(true);
  });

  it('requeries with new coordinates and clears old results', async () => {
    const requestA = deferred<SettlementDetails[]>();
    const requestB = deferred<SettlementDetails[]>();
    findSettlementPrefixMock
      .mockReturnValueOnce(requestA.promise)
      .mockReturnValueOnce(requestB.promise);
    await render();
    await input('мер');
    await advance(300);
    await act(async () => requestA.resolve([merefaKharkiv]));
    expect(latest?.settlementOptions).toEqual([merefaKharkiv]);

    await render({ coordsText: '49.82, 36.05' });
    expect(latest?.settlementOptions).toEqual([]);
    expect(latest?.loading).toBe(true);
    await advance(300);

    expect(findSettlementPrefixMock).toHaveBeenCalledTimes(2);
    expect(findSettlementPrefixMock.mock.calls[1][0].relatedCoordinates).toEqual([49.82, 36.05]);
  });

  it('aborts an in-flight request when coordinates change', async () => {
    const requestA = deferred<SettlementDetails[]>();
    const requestB = deferred<SettlementDetails[]>();
    findSettlementPrefixMock
      .mockReturnValueOnce(requestA.promise)
      .mockReturnValueOnce(requestB.promise);
    await render();
    await input('мер');
    await advance(300);
    const signalA = findSettlementPrefixMock.mock.calls[0][0].signal;

    await render({ coordsText: '49.82, 36.05' });
    expect(signalA?.aborted).toBe(true);
    expect(latest?.settlementOptions).toEqual([]);
    await act(async () => requestA.resolve([merefaOtherRegion]));
    expect(latest?.settlementOptions).toEqual([]);
    await advance(300);
    expect(findSettlementPrefixMock).toHaveBeenCalledTimes(2);
  });

  it('requeries with null coordinates when valid coordinates are cleared', async () => {
    const requestA = deferred<SettlementDetails[]>();
    const requestB = deferred<SettlementDetails[]>();
    findSettlementPrefixMock
      .mockReturnValueOnce(requestA.promise)
      .mockReturnValueOnce(requestB.promise);
    await render({ coordsText: '49.82, 36.05' });
    await input('мер');
    await advance(300);
    await act(async () => requestA.resolve([merefaKharkiv]));

    await render({ coordsText: '' });
    await advance(300);

    expect(findSettlementPrefixMock).toHaveBeenCalledTimes(2);
    expect(findSettlementPrefixMock.mock.calls[1][0].relatedCoordinates).toBeNull();
  });

  it('does not requery on coordinate changes for an ineligible cached query', async () => {
    await render();
    await input('м');
    await render({ coordsText: '49.82, 36.05' });
    await advance(300);

    expect(findSettlementPrefixMock).not.toHaveBeenCalled();
  });

  it('replaces a pending timer with the latest input', async () => {
    const request = deferred<SettlementDetails[]>();
    findSettlementPrefixMock.mockReturnValueOnce(request.promise);
    await render();

    await input('ме');
    await advance(200);
    await input('мер');
    await advance(100);
    expect(findSettlementPrefixMock).not.toHaveBeenCalled();

    await advance(200);
    expect(findSettlementPrefixMock).toHaveBeenCalledTimes(1);
    expect(findSettlementPrefixMock.mock.calls[0][0].query).toBe('мер');
  });

  it('aborts old requests and ignores stale results', async () => {
    const requestA = deferred<SettlementDetails[]>();
    const requestB = deferred<SettlementDetails[]>();
    findSettlementPrefixMock
      .mockReturnValueOnce(requestA.promise)
      .mockReturnValueOnce(requestB.promise);
    await render();

    await input('ме');
    await advance(300);
    const signalA = findSettlementPrefixMock.mock.calls[0][0].signal;
    expect(signalA?.aborted).toBe(false);

    await input('мер');
    expect(signalA?.aborted).toBe(true);
    await advance(300);

    await act(async () => requestA.resolve([merefaOtherRegion]));
    expect(latest?.settlementOptions).toEqual([]);

    await act(async () => requestB.resolve([merefaKharkiv]));
    expect(latest?.settlementOptions).toEqual([merefaKharkiv]);
    expect(latest?.loading).toBe(false);
  });

  it.each([
    ['invalid coordinates', 'not coordinates', null],
    ['empty coordinates', '', null],
  ])('sends null for %s', async (_, coordsText, expected) => {
    findSettlementPrefixMock.mockResolvedValueOnce([]);
    await render({ coordsText });
    await input('мер');
    await advance(300);

    expect(findSettlementPrefixMock.mock.calls[0][0].relatedCoordinates).toEqual(expected);
  });

  it('passes parsed MGRS coordinates in latitude-longitude order', async () => {
    const coordsText = '37U DR 05997 22279';
    const parsed = parseCoordLine(coordsText);
    findSettlementPrefixMock.mockResolvedValueOnce([]);
    await render({ coordsText });
    await input('мер');
    await advance(300);

    expect(parsed).not.toBeNull();
    expect(findSettlementPrefixMock.mock.calls[0][0].relatedCoordinates).toEqual([
      parsed?.lat,
      parsed?.lon,
    ]);
  });

  it.each([
    ['closed', { open: false }],
    ['busy', { busy: true }],
  ])('does not search while the drawer is %s', async (_, props) => {
    await render(props);
    await input('мер');
    await advance(301);

    expect(findSettlementPrefixMock).not.toHaveBeenCalled();
    expect(latest?.settlementOptions).toEqual([]);
    expect(latest?.loading).toBe(false);
  });

  it('aborts and clears an active request when the drawer closes', async () => {
    const request = deferred<SettlementDetails[]>();
    findSettlementPrefixMock.mockReturnValueOnce(request.promise);
    await render();
    await input('мер');
    await advance(300);
    const signal = findSettlementPrefixMock.mock.calls[0][0].signal;

    await render({ open: false });

    expect(signal?.aborted).toBe(true);
    expect(latest?.settlementOptions).toEqual([]);
    expect(latest?.loading).toBe(false);
    await act(async () => request.resolve([merefaKharkiv]));
    expect(latest?.settlementOptions).toEqual([]);
  });

  it('aborts and clears an active request when busy becomes true', async () => {
    const request = deferred<SettlementDetails[]>();
    findSettlementPrefixMock.mockReturnValueOnce(request.promise);
    await render({ open: true, busy: false });
    await input('мер');
    await advance(300);
    const signal = findSettlementPrefixMock.mock.calls[0][0].signal;
    expect(signal?.aborted).toBe(false);

    await render({ open: true, busy: true });

    expect(signal?.aborted).toBe(true);
    expect(latest?.settlementOptions).toEqual([]);
    expect(latest?.loading).toBe(false);
    await act(async () => request.resolve([merefaKharkiv]));
    expect(latest?.settlementOptions).toEqual([]);
    expect(onError).not.toHaveBeenCalled();
  });

  it.each(['clear', 'reset', 'selectOption'] as const)(
    'clears loaded options for an empty %s event',
    async (reason) => {
      findSettlementPrefixMock.mockResolvedValueOnce([merefaKharkiv]);
      await render();
      await input('мер');
      await advance(300);
      expect(latest?.settlementOptions).toEqual([merefaKharkiv]);

      await inputEvent('', reason);

      expect(latest?.settlementOptions).toEqual([]);
      expect(latest?.loading).toBe(false);
    },
  );

  it.each(['clear', 'reset', 'selectOption'] as const)(
    'aborts an active request for an empty %s event and ignores its result',
    async (reason) => {
      const request = deferred<SettlementDetails[]>();
      findSettlementPrefixMock.mockReturnValueOnce(request.promise);
      await render();
      await input('мер');
      await advance(300);
      const signal = findSettlementPrefixMock.mock.calls[0][0].signal;

      await inputEvent('', reason);

      expect(signal?.aborted).toBe(true);
      expect(latest?.settlementOptions).toEqual([]);
      expect(latest?.loading).toBe(false);
      await act(async () => request.resolve([merefaKharkiv]));
      expect(latest?.settlementOptions).toEqual([]);
    },
  );

  it.each(['clear', 'reset', 'selectOption'] as const)(
    'does not restart a cleared prefix after a group change from an empty %s event',
    async (reason) => {
      const request = deferred<SettlementDetails[]>();
      findSettlementPrefixMock.mockReturnValueOnce(request.promise);
      await render({ signalGroupMasterKey: 'group-1' });
      await input('мер');
      await advance(300);
      await inputEvent('', reason);

      await render({ signalGroupMasterKey: 'group-2' });
      await advance(300);

      expect(findSettlementPrefixMock).toHaveBeenCalledTimes(1);
    },
  );

  it('ignores a non-empty reset event', async () => {
    await render();

    await inputEvent('МЕРЕФА', 'reset');
    await advance(300);

    expect(findSettlementPrefixMock).not.toHaveBeenCalled();
  });

  it('restarts the current query with a new group after aborting the old request', async () => {
    const requestA = deferred<SettlementDetails[]>();
    const requestB = deferred<SettlementDetails[]>();
    findSettlementPrefixMock
      .mockReturnValueOnce(requestA.promise)
      .mockReturnValueOnce(requestB.promise);
    await render({ signalGroupMasterKey: 'group-1' });
    await input('мер');
    await advance(300);
    const signalA = findSettlementPrefixMock.mock.calls[0][0].signal;
    expect(findSettlementPrefixMock.mock.calls[0][0].signalGroupMasterKey).toBe('group-1');

    await render({ signalGroupMasterKey: 'group-2' });
    expect(signalA?.aborted).toBe(true);
    expect(latest?.settlementOptions).toEqual([]);
    await advance(300);

    expect(findSettlementPrefixMock).toHaveBeenCalledTimes(2);
    expect(findSettlementPrefixMock.mock.calls[1][0].signalGroupMasterKey).toBe('group-2');
    await act(async () => requestA.resolve([merefaOtherRegion]));
    expect(latest?.settlementOptions).toEqual([]);
    await act(async () => requestB.resolve([merefaKharkiv]));
    expect(latest?.settlementOptions).toEqual([merefaKharkiv]);
    expect(onError).not.toHaveBeenCalled();
  });

  it('reports request failures but not abort failures', async () => {
    findSettlementPrefixMock.mockRejectedValueOnce(new HttpRequestError(500, 'Search failed'));
    await render();
    await input('мер');
    await advance(300);

    expect(latest?.settlementOptions).toEqual([]);
    expect(latest?.loading).toBe(false);
    expect(onError).toHaveBeenCalledWith(expect.stringContaining('Не вдалося завантажити'));

    onError.mockReset();
    const request = deferred<SettlementDetails[]>();
    findSettlementPrefixMock.mockReturnValueOnce(request.promise);
    await input('мі');
    await advance(300);
    await act(async () => request.reject(new DOMException('Aborted', 'AbortError')));

    expect(onError).not.toHaveBeenCalled();
    expect(latest?.loading).toBe(false);
  });

  it('cleans up a pending timer and active request on unmount', async () => {
    await render();
    await input('мер');
    await act(async () => root.unmount());
    await advance(300);
    expect(findSettlementPrefixMock).not.toHaveBeenCalled();

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    const request = deferred<SettlementDetails[]>();
    findSettlementPrefixMock.mockReturnValueOnce(request.promise);
    await render();
    await input('мер');
    await advance(300);
    const signal = findSettlementPrefixMock.mock.calls[0][0].signal;
    await act(async () => root.unmount());

    expect(signal?.aborted).toBe(true);
    await act(async () => request.reject(new Error('late failure')));
    expect(onError).not.toHaveBeenCalled();
  });
});
