/** @vitest-environment happy-dom */
import { act, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const getSystemServiceNameAvailabilityMock = vi.hoisted(() => vi.fn());

vi.mock('../../../services/api/messenger', () => ({
  getSystemServiceNameAvailability: getSystemServiceNameAvailabilityMock,
}));

import { useSystemServiceName } from '.././use-system-service-name';

type HarnessProps = {
  active: boolean;
  displayName: string;
  messengerType: string;
  onReady: (value: ReturnType<typeof useSystemServiceName>) => void;
};

function Harness({ active, displayName, messengerType, onReady }: HarnessProps) {
  const value = useSystemServiceName({
    active,
    displayName,
    messengerType,
  });
  useEffect(() => {
    onReady(value);
  }, [onReady, value]);
  return null;
}

async function renderHook(
  params: Omit<HarnessProps, 'onReady'> = {
    active: false,
    displayName: 'echo_kherson',
    messengerType: 'signal',
  },
) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  let current!: ReturnType<typeof useSystemServiceName>;
  await act(async () => {
    root.render(<Harness {...params} onReady={(value) => (current = value)} />);
  });
  return {
    root,
    get current() {
      return current;
    },
  };
}

describe('useSystemServiceName', () => {
  beforeEach(() => getSystemServiceNameAvailabilityMock.mockReset());
  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = '';
  });
  it('checks and applies an available normalized name after debouncing', async () => {
    vi.useFakeTimers();
    getSystemServiceNameAvailabilityMock.mockResolvedValueOnce({
      exists: true,
      systemServiceName: 'echo-kherson-2',
    });
    const view = await renderHook({
      active: true,
      displayName: 'echo_kherson',
      messengerType: 'signal',
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });

    expect(getSystemServiceNameAvailabilityMock).toHaveBeenCalledWith(
      {
        messenger: 'signal',
        systemServiceName: 'echo-kherson',
      },
      expect.any(AbortSignal),
    );
    expect(view.current.systemServiceName).toBe('echo-kherson-2');
    await act(async () => view.root.unmount());
  });
  it('keeps a manual edit when an automatic request finishes late', async () => {
    vi.useFakeTimers();
    let resolveAvailability!: (value: { exists: boolean; systemServiceName: string }) => void;
    let signal: AbortSignal | undefined;
    getSystemServiceNameAvailabilityMock.mockImplementationOnce((_request, requestSignal) => {
      signal = requestSignal;
      return new Promise((resolve) => {
        resolveAvailability = resolve;
      });
    });
    const view = await renderHook({
      active: true,
      displayName: 'echo_kherson',
      messengerType: 'signal',
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });

    await act(async () => {
      view.current.editSystemServiceName('manual-name');
    });
    expect(signal?.aborted).toBe(true);

    await act(async () => {
      resolveAvailability({
        exists: false,
        systemServiceName: 'echo-kherson',
      });
      await Promise.resolve();
    });
    expect(view.current.systemServiceName).toBe('manual-name');
    await act(async () => view.root.unmount());
  });
  it('rejects an availability result after the flow resets', async () => {
    let resolveAvailability!: (value: { exists: boolean; systemServiceName: string }) => void;
    let signal: AbortSignal | undefined;
    getSystemServiceNameAvailabilityMock.mockImplementationOnce((_request, requestSignal) => {
      signal = requestSignal;
      return new Promise((resolve) => {
        resolveAvailability = resolve;
      });
    });
    const view = await renderHook();
    let availabilityPromise!: Promise<boolean>;

    await act(async () => {
      view.current.editSystemServiceName('echo-kherson');
    });
    await act(async () => {
      availabilityPromise = view.current.checkSystemServiceNameAvailability();
      await Promise.resolve();
    });
    expect(signal?.aborted).toBe(false);

    await act(async () => {
      view.current.resetSystemServiceName();
    });
    expect(signal?.aborted).toBe(true);

    resolveAvailability({
      exists: false,
      systemServiceName: 'echo-kherson',
    });
    await expect(availabilityPromise).resolves.toBe(false);
    await act(async () => view.root.unmount());
  });
  it('aborts submission availability when unmounted', async () => {
    let resolveAvailability!: (value: { exists: boolean; systemServiceName: string }) => void;
    let signal: AbortSignal | undefined;
    getSystemServiceNameAvailabilityMock.mockImplementationOnce((_request, requestSignal) => {
      signal = requestSignal;
      return new Promise((resolve) => {
        resolveAvailability = resolve;
      });
    });
    const view = await renderHook();
    await act(async () => {
      view.current.editSystemServiceName('echo-kherson');
    });
    const availabilityPromise = view.current.checkSystemServiceNameAvailability();
    await act(async () => {
      await Promise.resolve();
      view.root.unmount();
    });
    expect(signal?.aborted).toBe(true);

    resolveAvailability({
      exists: false,
      systemServiceName: 'echo-kherson',
    });
    await expect(availabilityPromise).resolves.toBe(false);
  });
});
