/** @vitest-environment happy-dom */
import { act, createElement, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { HttpRequestError } from '../../../../services/api/client';
import { findSettlementPrefix, type SettlementDetails } from '../../../../services/api/settlements';
import { parseCoordLine } from '../manage-message-drawer.schema';
import { useSettlementAutocomplete } from './useSettlementAutocomplete';

vi.mock('../../../../services/api/settlements', () => ({
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
  onError: (message: string) => void;
};

let latest: ReturnType<typeof useSettlementAutocomplete> | undefined;

function Harness({ open = true, busy = false, coordsText, onError }: HarnessProps) {
  const result = useSettlementAutocomplete({ open, busy, coordsText, onError });
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
      signal: expect.any(AbortSignal),
    });
    expect(latest?.loading).toBe(true);

    await act(async () => request.resolve([merefaKharkiv]));
    expect(latest?.settlementOptions).toEqual([merefaKharkiv]);
    expect(latest?.loading).toBe(false);
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
