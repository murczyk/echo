/**
 * @vitest-environment happy-dom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AnalysisMapPane } from './AnalysisMapPane';

function buildProps(overrides: Partial<Parameters<typeof AnalysisMapPane>[0]> = {}): Parameters<typeof AnalysisMapPane>[0] {
  return {
    mapAttrs: {
      daterange: '',
      daterangeLoading: '',
      messages: '',
      palitras: '',
      palitrasLoaded: '',
      palitrasLoadState: 'idle',
      points: '',
      selectedUnits: '',
    },
    search: '',
    visible: true,
    onDateRangeChange: vi.fn(),
    onLoadMessages: vi.fn(),
    onUnitClick: vi.fn(),
    onExit: vi.fn(),
    ...overrides,
  };
}

describe('AnalysisMapPane', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    vi.useRealTimers();
  });

  it('delays visibility until the next frame', async () => {
    vi.useFakeTimers();

    await act(async () => {
      root.render(<AnalysisMapPane {...buildProps({ visible: true })} />);
    });

    const map = container.querySelector('analysis-map');
    expect(map?.getAttribute('visibility')).toBe('false');

    await act(async () => {
      await vi.runAllTimersAsync();
    });

    expect(map?.getAttribute('visibility')).toBe('true');
  });
});
