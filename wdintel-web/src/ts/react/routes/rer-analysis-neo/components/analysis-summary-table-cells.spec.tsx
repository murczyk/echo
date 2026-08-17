/** @vitest-environment happy-dom */
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { buildAnalysisSummaryTableColumns } from './analysis-summary-table-columns';
import { CallsignChipsCell } from './analysis-summary-table-cells';
import type { AnalysisSummaryTableRowView } from './analysis-summary-table-rows';

let width = 80;
let observers: ResizeObserverCallback[] = [];
let originalClientWidth: PropertyDescriptor | undefined;
let originalRect: typeof HTMLElement.prototype.getBoundingClientRect;
let originalRaf: typeof requestAnimationFrame;
let originalCancelRaf: typeof cancelAnimationFrame;
let originalResizeObserver: typeof ResizeObserver | undefined;

function triggerResize() {
  act(() => observers.forEach((callback) => callback([], {} as ResizeObserver)));
}

const callsigns = [
  {
    callsign: 'first-oversized-callsign',
    tooltip: 'Підказка домену',
    iconClass: 'info-circle-fill',
    isHighlighted: true,
  },
  { callsign: 'second', tooltip: null, iconClass: '', isHighlighted: false },
];

const row: AnalysisSummaryTableRowView = {
  freq: '123',
  count: 1,
  coordinateLabels: [],
  callsignChips: callsigns,
  unitLabels: [],
  editableUnits: [],
  locationLabels: [],
};

beforeEach(() => {
  width = 80;
  observers = [];
  originalClientWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth');
  originalRect = HTMLElement.prototype.getBoundingClientRect;
  originalRaf = requestAnimationFrame;
  originalCancelRaf = cancelAnimationFrame;
  originalResizeObserver = globalThis.ResizeObserver;
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get: () => width,
  });
  HTMLElement.prototype.getBoundingClientRect = function () {
    const text = this.textContent ?? '';
    const measuredWidth = text.includes('FIRST-OVERSIZED')
      ? 140
      : text.includes('SECOND')
        ? 40
        : 32;
    return {
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: measuredWidth,
      bottom: 20,
      width: measuredWidth,
      height: 20,
      toJSON: () => ({}),
    } as DOMRect;
  };
  globalThis.requestAnimationFrame = undefined as unknown as typeof requestAnimationFrame;
  globalThis.cancelAnimationFrame = (() => undefined) as typeof cancelAnimationFrame;
  globalThis.ResizeObserver = class {
    constructor(callback: ResizeObserverCallback) {
      observers.push(callback);
    }
    observe() {}
    disconnect() {}
  } as typeof ResizeObserver;
});

afterEach(() => {
  if (originalClientWidth)
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', originalClientWidth);
  HTMLElement.prototype.getBoundingClientRect = originalRect;
  globalThis.requestAnimationFrame = originalRaf;
  globalThis.cancelAnimationFrame = originalCancelRaf;
  if (originalResizeObserver) globalThis.ResizeObserver = originalResizeObserver;
  else delete (globalThis as { ResizeObserver?: typeof ResizeObserver }).ResizeObserver;
});

it('keeps specialized callsign chips in compact mode for both consumers', async () => {
  vi.useFakeTimers();
  const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    const column = buildAnalysisSummaryTableColumns({
      onRenameUnit: vi.fn(),
      onSelectFreq: vi.fn(),
      onShowFreqOnMap: vi.fn(),
    }).find((item) => item.id === 'callsignSearchText');
    const node = column?.Cell?.({ row: { original: row } } as never);
    act(() => root.render(node));
    triggerResize();
    expect(container.querySelector('.MuiChip-root')).not.toBeNull();
    expect(container.textContent).toContain('FIRST-OVERSIZED-CALLSIGN');
    expect(container.querySelector('[data-testid="InfoIcon"]')).not.toBeNull();
    expect(container.querySelector('.MuiChip-filled')).not.toBeNull();
    const chip = container.querySelector<HTMLElement>('.MuiChip-root');
    expect(
      getComputedStyle(chip?.querySelector<HTMLElement>('.MuiChip-label span span')!).textOverflow,
    ).toBe('ellipsis');
    const tooltipAnchor = chip?.parentElement;
    act(() => tooltipAnchor?.focus());
    await act(async () => vi.runAllTimers());
    expect(document.body.querySelector('[role="tooltip"]')?.textContent).toBe('Підказка домену');
    act(() => tooltipAnchor?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })));
    await act(async () => vi.runAllTimers());
    expect(document.body.querySelector('[role="tooltip"]')?.textContent).toBe('Підказка домену');
    expect(container.querySelector('[aria-label="Показати ще 1 значення"]')).not.toBeNull();
    act(() =>
      container.querySelector<HTMLElement>('[aria-label="Показати ще 1 значення"]')?.click(),
    );
    expect(document.body.querySelector('[role="dialog"]')?.textContent).toContain('SECOND');
    expect(document.body.querySelector('[role="dialog"]')?.textContent).not.toContain(
      'FIRST-OVERSIZED',
    );
    width = 400;
    triggerResize();
    expect(container.querySelectorAll('.MuiChip-root')).toHaveLength(2);
    expect(container.querySelector('[aria-label^="Показати ще"]')).toBeNull();
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    act(() => root.render(createElement(CallsignChipsCell, { callsigns })));
    width = 80;
    triggerResize();
    expect(container.querySelector('.MuiChip-root')).not.toBeNull();
    expect(container.textContent).toContain('FIRST-OVERSIZED-CALLSIGN');
  } finally {
    act(() => root.unmount());
    container.remove();
    const output = errors.mock.calls.map((args) => args.join(' ')).join('\n');
    errors.mockRestore();
    vi.useRealTimers();
    expect(output).not.toMatch(/warning|error|invalid prop|aria|nesting/i);
  }
});
