/** @vitest-environment happy-dom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { NetworkCallsignRowView } from '../network-callsigns.types';
import type { NetworkFreqTableRow } from '../frequency-utils';
import { validateMrtColumnPolicies } from '../../../components/mui-customized/table/get-default-table-options';
import {
  buildNetworkDetailsFrequencyColumns,
  NetworkFrequencyCallsignCell,
  NetworkFrequencyCell,
} from './NetworkDetailsFrequenciesTable';
import {
  createNetworkCallsignColumn,
  NetworkCallsignDecoratedCell,
} from './NetworkCallsignsNetworkTable';

const longFrequency = '145.1000 / 146.2000 / 147.3000 / 148.4000';
const longCallsigns = 'СОКІЛ-ОДИН, СОКІЛ-ДВА, СОКІЛ-ТРИ, СОКІЛ-ЧОТИРИ';
const longDecoratedCallsign = 'НАДЗВИЧАЙНО-ДОВГИЙ-ПОЗИВНИЙ-ДЛЯ-ПЕРЕВІРКИ';

function createFrequencyRow(overrides: Partial<NetworkFreqTableRow> = {}): NetworkFreqTableRow {
  return {
    id: 'group-1',
    kind: 'group',
    parentGroupId: null,
    freq: { networkFreqId: 1, isActive: true } as NetworkFreqTableRow['freq'],
    freqIds: [1],
    isActive: true,
    displayFreq: longFrequency,
    callsignLabel: longCallsigns,
    ...overrides,
  } as NetworkFreqTableRow;
}

function createCallsignRow(
  overrides: Partial<NetworkCallsignRowView> = {},
): NetworkCallsignRowView {
  return {
    id: 1,
    callsign: longDecoratedCallsign,
    status: 'catalog',
    statusLabel: 'Каталог',
    mainRadioStation: true,
    commandControl: true,
    ...overrides,
  } as NetworkCallsignRowView;
}

describe('network detail overflow cells', () => {
  let container: HTMLDivElement;
  let root: Root;
  let overflowing = true;
  let originalClientWidth: PropertyDescriptor | undefined;
  let originalScrollWidth: PropertyDescriptor | undefined;

  beforeEach(() => {
    overflowing = true;
    originalClientWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth');
    originalScrollWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollWidth');
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
      configurable: true,
      get: () => 80,
    });
    Object.defineProperty(HTMLElement.prototype, 'scrollWidth', {
      configurable: true,
      get: () => (overflowing ? 240 : 80),
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    if (originalClientWidth)
      Object.defineProperty(HTMLElement.prototype, 'clientWidth', originalClientWidth);
    if (originalScrollWidth)
      Object.defineProperty(HTMLElement.prototype, 'scrollWidth', originalScrollWidth);
    document.body.innerHTML = '';
    vi.useRealTimers();
  });

  it('bounds grouped frequencies and aggregated callsigns without changing load states', async () => {
    vi.useFakeTimers();
    const row = createFrequencyRow();
    await act(async () => {
      root.render(
        <>
          <NetworkFrequencyCell row={row} />
          <NetworkFrequencyCallsignCell
            row={row}
            freqCallsignsById={new Map([[1, ['СОКІЛ-ОДИН']]])}
            freqCallsignsStatus="success"
          />
        </>,
      );
    });

    expect(container.querySelector('[aria-label="Активна"]')).not.toBeNull();
    const overflowTexts = container.querySelectorAll<HTMLElement>('[tabindex="0"]');
    expect(overflowTexts).toHaveLength(2);
    for (const text of overflowTexts) {
      expect(getComputedStyle(text).whiteSpace).toBe('nowrap');
      expect(getComputedStyle(text).textOverflow).toBe('ellipsis');
    }
    act(() => overflowTexts[0].focus());
    await act(async () => vi.runAllTimers());
    expect(document.body.querySelector('[role="tooltip"]')?.textContent).toBe(longFrequency);
    act(() => overflowTexts[0].blur());
    act(() => overflowTexts[1].focus());
    await act(async () => vi.runAllTimers());
    expect(
      Array.from(document.body.querySelectorAll('[role="tooltip"]')).some(
        (tooltip) => tooltip.textContent === longCallsigns,
      ),
    ).toBe(true);

    await act(async () => {
      root.render(
        <>
          <NetworkFrequencyCallsignCell
            row={row}
            freqCallsignsById={new Map()}
            freqCallsignsStatus="loading"
          />
          <NetworkFrequencyCallsignCell
            row={row}
            freqCallsignsById={new Map()}
            freqCallsignsStatus="error"
          />
        </>,
      );
    });
    expect(container.querySelector('[role="progressbar"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="Не завантажено"]')).not.toBeNull();
  });

  it('keeps decorated callsign markers visible while its label truncates', async () => {
    vi.useFakeTimers();
    await act(async () => {
      root.render(<NetworkCallsignDecoratedCell row={createCallsignRow()} />);
    });

    expect(container.querySelector('[aria-label="Каталог"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="StarIcon"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="MilitaryTechOutlinedIcon"]')).not.toBeNull();
    const text = container.querySelector<HTMLElement>('[tabindex="0"]');
    expect(text).not.toBeNull();
    expect(getComputedStyle(text!).textOverflow).toBe('ellipsis');
    act(() => text?.focus());
    await act(async () => vi.runAllTimers());
    expect(document.body.querySelector('[role="tooltip"]')?.textContent).toBe(
      longDecoratedCallsign,
    );

    overflowing = false;
    await act(async () => {
      root.render(<NetworkCallsignDecoratedCell row={createCallsignRow({ callsign: 'СОКІЛ' })} />);
    });
    await act(async () => vi.runAllTimers());
    expect(container.querySelector('[tabindex="0"]')).toBeNull();
    expect(document.body.querySelector('[role="tooltip"]')).toBeNull();
  });

  it('keeps the structured custom columns policy-valid', () => {
    expect(
      validateMrtColumnPolicies(buildNetworkDetailsFrequencyColumns(new Map(), 'success')),
    ).toEqual([]);
    expect(validateMrtColumnPolicies([createNetworkCallsignColumn()])).toEqual([]);
  });
});
