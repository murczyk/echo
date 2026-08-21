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
let originalIntersectionObserver: typeof IntersectionObserver | undefined;
let measurementRuns = 0;

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
  originalIntersectionObserver = globalThis.IntersectionObserver;
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get: () => width,
  });
  HTMLElement.prototype.getBoundingClientRect = function () {
    const text = this.textContent ?? '';
    if (this.hasAttribute('data-mrt-overflow-measured-item')) measurementRuns += 1;
    const measuredWidth = text.includes('SAME')
      ? this.querySelector('[data-testid="InfoIcon"]') ||
        this.querySelector('[data-callsign-measure-icon]')
        ? 125
        : 60
      : text.includes('NEXT')
        ? 60
        : text.includes('FIRST-OVERSIZED')
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
  globalThis.IntersectionObserver = undefined as unknown as typeof IntersectionObserver;
  measurementRuns = 0;
});

afterEach(() => {
  if (originalClientWidth)
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', originalClientWidth);
  HTMLElement.prototype.getBoundingClientRect = originalRect;
  globalThis.requestAnimationFrame = originalRaf;
  globalThis.cancelAnimationFrame = originalCancelRaf;
  if (originalResizeObserver) globalThis.ResizeObserver = originalResizeObserver;
  else delete (globalThis as { ResizeObserver?: typeof ResizeObserver }).ResizeObserver;
  if (originalIntersectionObserver) globalThis.IntersectionObserver = originalIntersectionObserver;
  else
    delete (globalThis as { IntersectionObserver?: typeof IntersectionObserver })
      .IntersectionObserver;
});

it('keeps specialized callsign chips in compact mode for both consumers', async () => {
  const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const container = document.createElement('div');
  const outside = document.createElement('button');
  document.body.appendChild(container);
  document.body.appendChild(outside);
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
    vi.useFakeTimers();
    expect(container.querySelector('.echo-chip')).not.toBeNull();
    expect(container.textContent).toContain('FIRST-OVERSIZED-CALLSIGN');
    expect(container.querySelector('[data-testid="InfoIcon"]')).not.toBeNull();
    expect(container.querySelector('[data-selected="true"]')).not.toBeNull();
    const chip = container.querySelector<HTMLElement>('.echo-chip');
    expect(
      getComputedStyle(chip?.querySelector<HTMLElement>('.echo-chip__label span span')!)
        .textOverflow,
    ).toBe('ellipsis');
    const tooltipAnchor = chip?.parentElement;
    expect(chip?.getAttribute('title')).toBeNull();
    expect(tooltipAnchor?.getAttribute('title')).toBeNull();
    act(() => tooltipAnchor?.focus());
    await act(async () => vi.runAllTimers());
    expect(document.body.querySelectorAll('[role="tooltip"]')).toHaveLength(1);
    expect(document.body.querySelector('[role="tooltip"]')?.textContent).toBe('Підказка домену');
    act(() =>
      tooltipAnchor?.dispatchEvent(
        new FocusEvent('focusout', { bubbles: true, relatedTarget: outside }),
      ),
    );
    await act(async () => vi.runAllTimers());
    act(() => tooltipAnchor?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })));
    await act(async () => vi.runAllTimers());
    expect(document.body.querySelectorAll('[role="tooltip"]')).toHaveLength(1);
    expect(document.body.querySelector('[role="tooltip"]')?.textContent).toBe('Підказка домену');
    act(() =>
      tooltipAnchor?.dispatchEvent(
        new MouseEvent('mouseout', { bubbles: true, relatedTarget: outside }),
      ),
    );
    await act(async () => vi.runAllTimers());
    act(() => root.render(null));
    await act(async () => vi.runAllTimers());
    expect(document.body.querySelectorAll('[role="tooltip"]')).toHaveLength(0);
    act(() => root.render(createElement(CallsignChipsCell, { callsigns })));
    width = 80;
    triggerResize();
    expect(container.querySelector('[aria-label="Показати ще 1 значення"]')).not.toBeNull();
    act(() =>
      container.querySelector<HTMLElement>('[aria-label="Показати ще 1 значення"]')?.click(),
    );
    expect(document.body.querySelector('[role="dialog"]')?.textContent).toContain('SECOND');
    expect(document.body.querySelector('[role="dialog"]')?.textContent).not.toContain(
      'FIRST-OVERSIZED',
    );
    const disclosureChip = document.body.querySelector<HTMLElement>('[role="dialog"] .echo-chip');
    const disclosureTooltipAnchor = disclosureChip?.parentElement;
    expect(disclosureChip?.getAttribute('title')).toBeNull();
    expect(disclosureTooltipAnchor?.getAttribute('title')).toBeNull();
    act(() =>
      disclosureTooltipAnchor?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })),
    );
    await act(async () => vi.runAllTimers());
    expect(
      Array.from(document.body.querySelectorAll('[role="tooltip"]')).filter(
        (tooltip) => tooltip.textContent === 'SECOND',
      ),
    ).toHaveLength(1);
    act(() =>
      disclosureTooltipAnchor?.dispatchEvent(
        new MouseEvent('mouseout', { bubbles: true, relatedTarget: outside }),
      ),
    );
    await act(async () => vi.runAllTimers());
    act(() => disclosureTooltipAnchor?.focus());
    await act(async () => vi.runAllTimers());
    expect(
      Array.from(document.body.querySelectorAll('[role="tooltip"]')).filter(
        (tooltip) => tooltip.textContent === 'SECOND',
      ),
    ).toHaveLength(1);
    act(() =>
      disclosureTooltipAnchor?.dispatchEvent(
        new FocusEvent('focusout', { bubbles: true, relatedTarget: outside }),
      ),
    );
    await act(async () => vi.runAllTimers());
    width = 400;
    triggerResize();
    expect(container.querySelectorAll('.echo-chip')).toHaveLength(2);
    expect(container.querySelector('[aria-label^="Показати ще"]')).toBeNull();
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
  } finally {
    act(() => root.unmount());
    container.remove();
    outside.remove();
    const output = errors.mock.calls.map((args) => args.join(' ')).join('\n');
    errors.mockRestore();
    vi.useRealTimers();
    expect(output).not.toMatch(/warning|error|invalid prop|aria|nesting/i);
  }
});

it('remeasures callsigns when width-affecting chip decoration changes', () => {
  width = 150;
  const undecorated = [
    { callsign: 'same', tooltip: null, iconClass: '', isHighlighted: false },
    { callsign: 'next', tooltip: null, iconClass: '', isHighlighted: false },
  ];
  const decorated = [
    {
      callsign: 'same',
      tooltip: 'Декорована підказка',
      iconClass: 'info-circle-fill',
      isHighlighted: true,
    },
    { callsign: 'next', tooltip: null, iconClass: '', isHighlighted: false },
  ];
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);

  try {
    act(() => root.render(createElement(CallsignChipsCell, { callsigns: undecorated })));
    triggerResize();
    expect(container.querySelectorAll('.echo-chip')).toHaveLength(2);
    expect(container.querySelector('[aria-label^="Показати ще"]')).toBeNull();
    const initialMeasurementRuns = measurementRuns;

    act(() => root.render(createElement(CallsignChipsCell, { callsigns: decorated })));
    triggerResize();
    expect(measurementRuns).toBeGreaterThan(initialMeasurementRuns);
    expect(container.querySelector('.echo-chip')).not.toBeNull();
    expect(container.querySelector('[data-testid="InfoIcon"]')).not.toBeNull();
    expect(container.querySelector('[data-selected="true"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="Показати ще 1 значення"]')).not.toBeNull();
  } finally {
    act(() => root.unmount());
    container.remove();
  }
});
