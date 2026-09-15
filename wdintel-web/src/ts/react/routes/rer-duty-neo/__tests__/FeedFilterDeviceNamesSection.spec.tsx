/**
 * @vitest-environment happy-dom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sectionSpy = vi.hoisted(() => vi.fn());
const searchDeviceNames = vi.hoisted(() => vi.fn());
const resolveDeviceNames = vi.hoisted(() => vi.fn());
const notify = vi.hoisted(() => vi.fn());
const activeBulkResolution = vi.hoisted(() => ({
  tokens: null as readonly string[] | null,
  resolved: null as readonly string[] | null,
}));

vi.mock('../FeedFilterSelectionSection', async () => {
  const { useEffect } = await import('react');
  return {
    FeedFilterSelectionSection: (props: {
      resolveBulkPasteOptions?: (
        tokens: readonly string[],
        options: { signal: AbortSignal },
      ) => Promise<readonly string[]>;
    }) => {
      sectionSpy(props);
      useEffect(() => {
        const tokens = activeBulkResolution.tokens;
        if (!tokens || !props.resolveBulkPasteOptions) return;
        const controller = new AbortController();
        void props
          .resolveBulkPasteOptions(tokens, { signal: controller.signal })
          .then((resolved) => {
            if (!controller.signal.aborted) activeBulkResolution.resolved = resolved;
          });
        return () => controller.abort();
      }, [props.resolveBulkPasteOptions]);
      return null;
    },
  };
});
vi.mock('../../../services/api/direct-submit', () => ({ searchDeviceNames, resolveDeviceNames }));
vi.mock('../../../components/PowerSnackbar', () => ({
  usePowerSnackbar: () => ({ notify }),
}));

import { FeedFilterDeviceNamesSection } from '../FeedFilterDeviceNamesSection';

// @test-scope regression: https://github.com/echoua/echo/issues/3461
describe('FeedFilterDeviceNamesSection', () => {
  let container: HTMLElement;
  let root: Root;

  beforeEach(() => {
    vi.useFakeTimers();
    sectionSpy.mockClear();
    searchDeviceNames.mockReset();
    resolveDeviceNames.mockReset();
    notify.mockClear();
    activeBulkResolution.tokens = null;
    activeBulkResolution.resolved = null;
    searchDeviceNames.mockResolvedValue([{ id: 1, name: 'Device A' }]);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
  });

  async function render() {
    const onSelectedChange = vi.fn();
    const onDeniedChange = vi.fn();
    const onModeTransfer = vi.fn();
    await act(async () => {
      root.render(
        <FeedFilterDeviceNamesSection
          selected={['Included']}
          denied={['Excluded']}
          onSelectedChange={onSelectedChange}
          onDeniedChange={onDeniedChange}
          onModeTransfer={onModeTransfer}
        />,
      );
    });
    return { onSelectedChange, onDeniedChange, onModeTransfer };
  }

  it('ECHO-3461 searches device names remotely and retains both filter modes', async () => {
    await render();
    await act(async () => vi.advanceTimersByTimeAsync(250));

    expect(searchDeviceNames).toHaveBeenCalledWith('', expect.any(Object));
    expect(sectionSpy.mock.calls.at(-1)?.[0]).toMatchObject({
      title: 'Пристрої',
      options: expect.arrayContaining(['Excluded', 'Device A']),
      bulkPasteSeparators: ['\n'],
    });
  });

  it('ECHO-3461 reports remote search errors', async () => {
    searchDeviceNames.mockRejectedValueOnce(new Error('network unavailable'));
    await render();
    await act(async () => vi.advanceTimersByTimeAsync(250));

    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({
        severity: 'error',
        message: expect.stringContaining('network unavailable'),
      }),
    );
  });

  it('ECHO-3461 transfers device names and clears the opposite mode', async () => {
    const { onModeTransfer } = await render();
    const props = sectionSpy.mock.calls.at(-1)?.[0] as {
      onModeChange: (mode: 'include' | 'exclude') => void;
    };

    await act(async () => props.onModeChange('include'));

    expect(onModeTransfer).toHaveBeenCalledWith({
      includeValues: ['Excluded'],
      excludeValues: [],
    });
  });

  it('ECHO-3461 searches with an empty query after receiving cleared input', async () => {
    await render();
    const props = sectionSpy.mock.calls.at(-1)?.[0] as {
      onInputChange: (value: string) => void;
    };
    await act(async () => props.onInputChange('device'));
    await act(async () => vi.advanceTimersByTimeAsync(250));
    await act(async () => props.onInputChange(''));
    await act(async () => vi.advanceTimersByTimeAsync(250));
    expect(searchDeviceNames).toHaveBeenLastCalledWith('', expect.any(Object));
  });

  it('ECHO-3461 distinguishes an empty option page from a failed device-name search', async () => {
    await render();
    let props = sectionSpy.mock.calls.at(-1)?.[0] as {
      noOptionsText: string;
      onInputChange: (value: string) => void;
    };
    expect(props.noOptionsText).toBe('Немає варіантів');

    await act(async () => props.onInputChange('missing device'));
    props = sectionSpy.mock.calls.at(-1)?.[0];
    expect(props.noOptionsText).toBe('Назв пристроїв не знайдено');
  });

  it('ECHO-3461 keeps loading feedback ahead of empty-state feedback during a search', async () => {
    let completeSearch!: (devices: { id: number; name: string }[]) => void;
    searchDeviceNames.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          completeSearch = resolve;
        }),
    );
    await render();
    const props = sectionSpy.mock.calls.at(-1)?.[0] as {
      onInputChange: (value: string) => void;
    };
    await act(async () => props.onInputChange('missing device'));
    await act(async () => vi.advanceTimersByTimeAsync(250));

    expect(sectionSpy.mock.calls.at(-1)?.[0]).toMatchObject({
      loading: true,
      loadingText: 'Завантажуємо назви пристроїв…',
      noOptionsText: 'Назв пристроїв не знайдено',
    });

    await act(async () => completeSearch([]));
    expect(sectionSpy.mock.calls.at(-1)?.[0]).toMatchObject({ loading: false });
  });

  it('ECHO-3461 forwards one typed batch resolver and surfaces its failure', async () => {
    const error = new Error('resolver unavailable');
    resolveDeviceNames.mockRejectedValueOnce(error);
    await render();
    const props = sectionSpy.mock.calls.at(-1)?.[0] as {
      resolveBulkPasteOptions: (
        tokens: readonly string[],
        options: { signal: AbortSignal },
      ) => Promise<readonly string[]>;
      onBulkPasteResolveError: (error: unknown) => void;
    };

    await expect(
      props.resolveBulkPasteOptions(['device-a', 'device-b'], {
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow('resolver unavailable');
    expect(resolveDeviceNames).toHaveBeenCalledTimes(1);
    props.onBulkPasteResolveError(error);
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({
        severity: 'error',
        message: expect.stringContaining('resolver unavailable'),
      }),
    );
  });

  it('ECHO-3461 keeps an unchanged bulk resolution alive through ordinary search rerenders', async () => {
    let completeResolution!: (devices: { id: number; name: string }[]) => void;
    let resolutionSignal: AbortSignal | undefined;
    activeBulkResolution.tokens = ['device-a', 'device-b'];
    resolveDeviceNames.mockImplementationOnce((_, options: { signal: AbortSignal }) => {
      resolutionSignal = options.signal;
      return new Promise((resolve) => {
        completeResolution = resolve;
      });
    });
    let completeSearch!: (devices: { id: number; name: string }[]) => void;
    searchDeviceNames.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          completeSearch = resolve;
        }),
    );

    await render();
    expect(resolveDeviceNames).toHaveBeenCalledWith(
      ['device-a', 'device-b'],
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    const props = sectionSpy.mock.calls.at(-1)?.[0] as {
      onInputChange: (value: string) => void;
    };
    await act(async () => props.onInputChange('device'));
    await act(async () => vi.advanceTimersByTimeAsync(250));
    expect(resolveDeviceNames).toHaveBeenCalledTimes(1);
    expect(resolutionSignal?.aborted).toBe(false);

    await act(async () => completeSearch([{ id: 1, name: 'Device A' }]));
    expect(resolveDeviceNames).toHaveBeenCalledTimes(1);
    expect(resolutionSignal?.aborted).toBe(false);

    await act(async () =>
      completeResolution([
        { id: 1, name: 'DEVICE-A' },
        { id: 2, name: 'DEVICE-B' },
      ]),
    );
    expect(activeBulkResolution.resolved).toEqual(['DEVICE-A', 'DEVICE-B']);
  });
});
