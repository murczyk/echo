/**
 * @vitest-environment happy-dom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sectionSpy = vi.hoisted(() => vi.fn());
const searchDeviceNames = vi.hoisted(() => vi.fn());
const notify = vi.hoisted(() => vi.fn());

vi.mock('./FeedFilterSelectionSection', () => ({
  FeedFilterSelectionSection: (props: unknown) => {
    sectionSpy(props);
    return null;
  },
}));
vi.mock('../../services/api/direct-submit', () => ({ searchDeviceNames }));
vi.mock('../../components/PowerSnackbar', () => ({
  usePowerSnackbar: () => ({ notify }),
}));

import { FeedFilterDeviceNamesSection } from './FeedFilterDeviceNamesSection';

describe('FeedFilterDeviceNamesSection', () => {
  let container: HTMLElement;
  let root: Root;

  beforeEach(() => {
    vi.useFakeTimers();
    sectionSpy.mockClear();
    searchDeviceNames.mockReset();
    notify.mockClear();
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
});
