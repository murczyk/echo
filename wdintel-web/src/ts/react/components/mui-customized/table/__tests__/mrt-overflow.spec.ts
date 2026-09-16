/**
 * @vitest-environment happy-dom
 */
import { act, createElement, StrictMode } from 'react';
import type { ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const copyTextToClipboard = vi.hoisted(() => vi.fn());

vi.mock('../../../../../copy-to-clipboard.ts', () => ({ copyTextToClipboard }));

import { EchoChip } from '../../../EchoChip.tsx';
import {
  calculateVisibleItemCount,
  MrtOverflowItems,
  MrtOverflowText,
  resetMrtOverflowMeasurementCacheForTests,
} from '../mrt-overflow.tsx';
import {
  assertMrtColumnPolicies,
  mrtCustomCell,
  toMrtScalarText,
  validateMrtColumnPolicies,
} from '../get-default-table-options.tsx';

type Rendered = { container: HTMLDivElement; root: Root };

function render(node: ReactNode): Rendered {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(node));
  return { container, root };
}

function destroy(view: Rendered) {
  act(() => view.root.unmount());
  view.container.remove();
}

// @test-scope safeguard: prevents virtualized table overflow from hiding data, breaking links or focus, or applying stale shared measurement results
describe('MRT overflow policies', () => {
  it('fits only whole items including gaps and the dynamic trigger width', () => {
    expect(
      calculateVisibleItemCount({
        itemWidths: [20, 30, 40],
        contentWidth: 80,
        triggerWidths: [28, 38, 48],
        itemGap: 4,
        triggerGap: 6,
      }),
    ).toBe(1);

    expect(
      calculateVisibleItemCount({
        itemWidths: [20, 30, 40],
        contentWidth: 90,
        triggerWidths: [28, 38, 48],
        itemGap: 4,
        triggerGap: 6,
      }),
    ).toBe(2);
  });

  it('restores every item when the column widens', () => {
    const measurement = {
      itemWidths: [20, 30, 40],
      triggerWidths: [28, 38, 48],
      itemGap: 4,
      triggerGap: 6,
    };

    expect(calculateVisibleItemCount({ ...measurement, contentWidth: 200 })).toBe(3);
    expect(calculateVisibleItemCount({ ...measurement, contentWidth: 50 })).toBe(0);
  });

  it('never bisects a single item and accounts for the fade spacer', () => {
    const measurement = {
      itemWidths: [100],
      triggerWidths: [28],
      itemGap: 4,
      triggerGap: 6,
      spacerWidth: 32,
    };

    expect(calculateVisibleItemCount({ ...measurement, contentWidth: 172 })).toBe(1);
    expect(calculateVisibleItemCount({ ...measurement, contentWidth: 99 })).toBe(0);
  });

  it('does not stringify arrays or objects as scalar cell values', () => {
    expect(toMrtScalarText('Привіт')).toBe('Привіт');
    expect(toMrtScalarText(42)).toBe('42');
    expect(toMrtScalarText(['a', 'b'])).toBeNull();
    expect(toMrtScalarText({ value: 'a' })).toBeNull();
    expect(toMrtScalarText('')).toBe('');
  });

  it('requires an explicit overflow policy for custom cells, including grouped columns', () => {
    expect(
      validateMrtColumnPolicies([
        {
          id: 'group',
          columns: [
            { id: 'missing', Cell: () => null },
            { id: 'classified', meta: { overflowMode: 'none' }, Cell: () => null },
          ],
        },
      ]),
    ).toEqual(['group.missing']);
  });

  it('rejects unclassified top-level and nested custom cells with their full paths', () => {
    expect(() =>
      assertMrtColumnPolicies([
        { id: 'topLevel', Cell: () => null },
        { id: 'group', columns: [{ id: 'nested', Cell: () => null }] },
      ]),
    ).toThrow('topLevel, group.nested');
  });

  it('rejects an unbranded items renderer', () => {
    expect(() =>
      assertMrtColumnPolicies([
        { id: 'items', meta: { overflowMode: 'items' }, Cell: (() => null) as any },
      ]),
    ).toThrow('items (items Cell must use mrtItemsCell)');
  });

  it('rejects unbranded top-level and grouped custom cells, but accepts mrtCustomCell', () => {
    expect(() =>
      assertMrtColumnPolicies([
        { id: 'custom', meta: { overflowMode: 'custom' }, Cell: (() => null) as any },
      ]),
    ).toThrow('custom (custom Cell must use mrtCustomCell)');
    expect(() =>
      assertMrtColumnPolicies([
        {
          id: 'group',
          columns: [{ id: 'nested', meta: { overflowMode: 'custom' }, Cell: (() => null) as any }],
        },
      ]),
    ).toThrow('group.nested (custom Cell must use mrtCustomCell)');
    expect(() =>
      assertMrtColumnPolicies([
        {
          id: 'owner',
          meta: { overflowMode: 'custom' } as any,
          Cell: mrtCustomCell(() => null),
        },
      ]),
    ).toThrow('owner (custom Cell must declare a valid overflowOwner)');
    expect(() =>
      assertMrtColumnPolicies([
        {
          id: 'branded',
          meta: { overflowMode: 'custom', overflowOwner: 'structured-layout' },
          Cell: mrtCustomCell(() => null),
        },
      ]),
    ).not.toThrow();
  });
});

// @test-scope safeguard: prevents virtualized table overflow from hiding data, breaking links or focus, or applying stale shared measurement results
describe('MRT rendered overflow components', () => {
  let availableWidth = 100;
  let textWidth = 100;
  let itemWidths: Record<string, number> = {};
  let cellWidths = new Map<HTMLElement, number>();
  let columnGap = '4px';
  let frames = new Map<number, FrameRequestCallback>();
  let nextFrame = 0;
  let observers: Array<{ callback: ResizeObserverCallback; disconnect: ReturnType<typeof vi.fn> }> =
    [];
  let intersectionObservers: Array<{
    callback: IntersectionObserverCallback;
    observe: ReturnType<typeof vi.fn>;
    unobserve: ReturnType<typeof vi.fn>;
    disconnect: ReturnType<typeof vi.fn>;
  }> = [];
  let originalClientWidth: PropertyDescriptor | undefined;
  let originalScrollWidth: PropertyDescriptor | undefined;
  let originalRect: typeof HTMLElement.prototype.getBoundingClientRect;
  let originalGetComputedStyle: typeof window.getComputedStyle;
  let originalFonts: PropertyDescriptor | undefined;

  const flushFrames = () => {
    const pending = [...frames.values()];
    frames.clear();
    act(() => pending.forEach((callback) => callback(0)));
  };
  const triggerResize = () => {
    act(() =>
      observers.forEach((observer) => observer.callback([], observer as unknown as ResizeObserver)),
    );
    flushFrames();
  };
  const setCellWidth = (cell: HTMLElement, width: number) => {
    cellWidths.set(cell, width);
  };
  const installIntersectionObserver = () => {
    intersectionObservers = [];
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        callback: IntersectionObserverCallback;
        observe = vi.fn();
        unobserve = vi.fn();
        disconnect = vi.fn();
        constructor(callback: IntersectionObserverCallback) {
          this.callback = callback;
          intersectionObservers.push(this);
        }
      },
    );
  };
  const setIntersection = (element: Element, isIntersecting: boolean) => {
    act(() =>
      intersectionObservers[0]?.callback(
        [{ target: element, isIntersecting } as IntersectionObserverEntry],
        intersectionObservers[0] as unknown as IntersectionObserver,
      ),
    );
  };
  const installFontReadyPromise = () => {
    let resolveFonts: (() => void) | undefined;
    const ready = new Promise<void>((resolve) => {
      resolveFonts = resolve;
    });
    Object.defineProperty(document, 'fonts', {
      configurable: true,
      value: { ready },
    });
    return () => resolveFonts?.();
  };

  beforeEach(() => {
    resetMrtOverflowMeasurementCacheForTests();
    frames = new Map();
    nextFrame = 0;
    observers = [];
    intersectionObservers = [];
    availableWidth = 100;
    textWidth = 100;
    itemWidths = {};
    cellWidths = new Map();
    columnGap = '4px';
    originalClientWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth');
    originalScrollWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollWidth');
    originalRect = HTMLElement.prototype.getBoundingClientRect;
    originalGetComputedStyle = window.getComputedStyle.bind(window);
    originalFonts = Object.getOwnPropertyDescriptor(document, 'fonts');
    Object.defineProperty(document, 'fonts', { configurable: true, value: undefined });
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
      configurable: true,
      get() {
        const cell = this.closest?.('[data-mrt-overflow-items]') as HTMLElement | null;
        if (cell && cellWidths.has(cell)) return cellWidths.get(cell)!;
        return availableWidth;
      },
    });
    Object.defineProperty(HTMLElement.prototype, 'scrollWidth', {
      configurable: true,
      get(this: HTMLElement) {
        return /overflow text|alpha/.test(this.textContent ?? '') ? textWidth : availableWidth;
      },
    });
    HTMLElement.prototype.getBoundingClientRect = function () {
      const label = this.textContent?.trim() ?? '';
      const width = label === '' ? 32 : (itemWidths[label] ?? (label.startsWith('Ще') ? 32 : 20));
      return {
        x: 0,
        y: 0,
        top: 0,
        left: 0,
        right: width,
        bottom: 20,
        width,
        height: 20,
        toJSON() {},
      };
    } as typeof HTMLElement.prototype.getBoundingClientRect;
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      nextFrame += 1;
      frames.set(nextFrame, callback);
      return nextFrame;
    });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
    window.requestAnimationFrame = globalThis.requestAnimationFrame;
    window.cancelAnimationFrame = globalThis.cancelAnimationFrame;
    vi.spyOn(window, 'getComputedStyle').mockImplementation((element) => {
      const styles = originalGetComputedStyle(element);
      return new Proxy(styles, {
        get(target, key, receiver) {
          return key === 'columnGap' ? columnGap : Reflect.get(target, key, target);
        },
      }) as CSSStyleDeclaration;
    });
    vi.stubGlobal(
      'ResizeObserver',
      class {
        callback: ResizeObserverCallback;
        disconnect = vi.fn();
        constructor(callback: ResizeObserverCallback) {
          this.callback = callback;
          observers.push(this);
        }
        observe = vi.fn();
        unobserve = vi.fn();
      },
    );
    vi.stubGlobal('IntersectionObserver', undefined);
    copyTextToClipboard.mockReset();
    copyTextToClipboard.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    if (originalClientWidth)
      Object.defineProperty(HTMLElement.prototype, 'clientWidth', originalClientWidth);
    if (originalScrollWidth)
      Object.defineProperty(HTMLElement.prototype, 'scrollWidth', originalScrollWidth);
    HTMLElement.prototype.getBoundingClientRect = originalRect;
    if (originalFonts) Object.defineProperty(document, 'fonts', originalFonts);
    else delete (document as Document & { fonts?: unknown }).fonts;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    document.body.replaceChildren();
  });

  it('renders the complete scalar tooltip only while text overflows', async () => {
    vi.useFakeTimers();
    textWidth = 220;
    const fullValue = 'complete untruncated value';
    const view = render(
      createElement(MrtOverflowText, { displayValue: 'overflow text', fullValue }),
    );
    const text = view.container.querySelector('span');
    expect(text?.getAttribute('tabindex')).toBe('0');
    expect(getComputedStyle(text!).overflow).toBe('hidden');
    expect(getComputedStyle(text!).whiteSpace).toBe('nowrap');
    expect(getComputedStyle(text!).textOverflow).toBe('ellipsis');
    act(() => text?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })));
    await act(async () => vi.runAllTimers());
    expect(document.body.querySelector('[role="tooltip"]')?.textContent).toBe(fullValue);
    act(() =>
      text?.dispatchEvent(
        new MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body }),
      ),
    );
    await act(async () => vi.runAllTimers());
    destroy(view);
    expect(document.body.querySelector('[role="tooltip"]')).toBeNull();
    const focusView = render(
      createElement(MrtOverflowText, { displayValue: 'overflow text', fullValue }),
    );
    const focusText = focusView.container.querySelector('span');
    act(() => focusText?.focus());
    await act(async () => vi.runAllTimers());
    expect(document.body.querySelector('[role="tooltip"]')?.textContent).toBe(fullValue);

    textWidth = 80;
    triggerResize();
    expect(focusText?.getAttribute('tabindex')).toBeNull();
    act(() => focusText?.blur());
    act(() => focusText?.dispatchEvent(new MouseEvent('mouseleave', { bubbles: true })));
    await act(async () => vi.runAllTimers());
    destroy(focusView);
    const settled = render(
      createElement(MrtOverflowText, { displayValue: 'overflow text', fullValue }),
    );
    const settledText = settled.container.querySelector('span');
    act(() => settledText?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })));
    await act(async () => vi.runAllTimers());
    expect(document.body.querySelector('[role="tooltip"]')).toBeNull();
    act(() => settledText?.focus());
    await act(async () => vi.runAllTimers());
    expect(document.body.querySelector('[role="tooltip"]')).toBeNull();
    destroy(settled);
    vi.useRealTimers();
  });

  it('does not create meaningless text disclosure or conflicting interactive tab stops', () => {
    textWidth = 220;
    const empty = render(createElement(MrtOverflowText, { displayValue: '—', fullValue: '—' }));
    expect(empty.container.querySelector('[tabindex="0"]')).toBeNull();
    destroy(empty);

    const interactive = render(
      createElement(MrtOverflowText, {
        displayValue: createElement('button', null, 'overflow text'),
        fullValue: 'overflow text',
        interactive: true,
      }),
    );
    expect(interactive.container.querySelector('span')?.getAttribute('tabindex')).toBeNull();
    expect(interactive.container.querySelector('button')).not.toBeNull();
    destroy(interactive);
  });

  it('preserves interactive link behavior while disclosing overflowing text', async () => {
    vi.useFakeTimers();
    textWidth = 220;
    const onClick = vi.fn();
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let view: Rendered | undefined;
    try {
      view = render(
        createElement(MrtOverflowText, {
          component: 'a',
          componentProps: { href: '/target', onClick },
          interactive: true,
          displayValue: 'overflow text',
          fullValue: 'overflow text',
        }),
      );
      const link = view.container.querySelector<HTMLAnchorElement>('a[href="/target"]');
      expect(link).not.toBeNull();
      expect(link?.querySelector('[tabindex="0"]')).toBeNull();
      expect(getComputedStyle(link!).textOverflow).toBe('ellipsis');
      act(() => link?.click());
      expect(onClick).toHaveBeenCalledTimes(1);
      act(() => link?.focus());
      expect(link).toBe(document.activeElement);
      await act(async () => vi.runAllTimers());
      expect(document.body.querySelector('[role="tooltip"]')?.textContent).toBe('overflow text');
      act(() => link?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })));
      await act(async () => vi.runAllTimers());
      expect(document.body.querySelector('[role="tooltip"]')?.textContent).toBe('overflow text');

      textWidth = 80;
      triggerResize();
      act(() =>
        link?.dispatchEvent(
          new MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body }),
        ),
      );
      act(() => link?.blur());
      await act(async () => vi.runAllTimers());
      expect(document.body.querySelector('[role="tooltip"]')).toBeNull();
      expect(view.container.querySelector('a[href="/target"]')).toBe(link);
      expect(link?.getAttribute('href')).toBe('/target');
      act(() => link?.focus());
      await act(async () => vi.runAllTimers());
      expect(document.body.querySelector('[role="tooltip"]')).toBeNull();
      act(() => link?.click());
      expect(onClick).toHaveBeenCalledTimes(2);
    } finally {
      if (view) destroy(view);
      const errors = consoleError.mock.calls.map((args) => args.map(String).join(' ')).join('\n');
      consoleError.mockRestore();
      vi.useRealTimers();
      expect(errors).not.toMatch(/failed prop type|invalid prop .* supplied/i);
    }
  });

  it('does not pass invalid portal children to MUI components', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let view: Rendered | undefined;
    let errors = '';

    try {
      itemWidths = { alpha: 60, beta: 60, 'Ще 1': 32, 'Ще 2': 32 };
      availableWidth = 100;
      view = render(
        createElement(MrtOverflowItems<string>, {
          items: ['alpha', 'beta'],
          renderItem: (value) => createElement('span', null, value),
          renderMeasurementItem: (value) => createElement('span', null, value),
          getItemText: (value) => value,
        }),
      );
      triggerResize();
    } finally {
      try {
        if (view) destroy(view);
      } finally {
        errors = consoleError.mock.calls.map((args) => args.map(String).join(' ')).join('\n');
        consoleError.mockRestore();
      }
    }

    expect(errors).not.toMatch(/failed prop type|invalid prop .* supplied/i);
  });

  it('measures whole items, adapts on resize, and discloses only hidden items', async () => {
    itemWidths = { alpha: 60, beta: 60, gamma: 60, 'Ще 1': 32, 'Ще 2': 32, 'Ще 3': 32 };
    availableWidth = 150;
    const onBeta = vi.fn();
    const view = render(
      createElement(MrtOverflowItems<string>, {
        items: ['alpha', 'beta', 'gamma'],
        renderItem: (value) =>
          createElement(
            'button',
            { 'data-item': value, onClick: value === 'beta' ? onBeta : undefined },
            value,
          ),
        renderMeasurementItem: (value) => createElement('span', null, value),
        getItemKey: (value) => value,
        getItemText: (value) => value,
      }),
    );
    expect(observers).toHaveLength(1);
    triggerResize();
    expect(view.container.querySelectorAll('[data-item]')).toHaveLength(1);
    expect(view.container.querySelector('[data-item="alpha"]')).not.toBeNull();
    expect(view.container.querySelector('[data-item="beta"]')).toBeNull();
    expect(view.container.querySelector('[data-item="gamma"]')).toBeNull();
    const trigger = view.container.querySelector<HTMLButtonElement>(
      'button[aria-label^="Показати ще"]',
    );
    expect(trigger?.textContent).toBe('Ще 2');
    expect(trigger?.getAttribute('aria-label')).toBe('Показати ще 2 значення');
    expect(trigger?.classList.contains('mrt-overflow-trigger')).toBe(true);
    expect(trigger?.tagName).toBe('BUTTON');
    expect(trigger?.querySelector('button, a, input, select, textarea')).toBeNull();
    const fade = view.container.querySelector<HTMLElement>('[aria-hidden][inert]');
    expect(getComputedStyle(fade!).background).toContain('linear-gradient');

    act(() => trigger?.click());
    const surface = document.body.querySelector<HTMLElement>('[role="dialog"]');
    expect(surface?.textContent).toContain('beta');
    expect(surface?.textContent).toContain('gamma');
    expect(surface?.textContent).not.toContain('alpha');
    act(() =>
      document.body.querySelector<HTMLButtonElement>('[role="dialog"] [data-item="beta"]')?.click(),
    );
    expect(onBeta).toHaveBeenCalledTimes(1);
    act(() => surface?.focus());
    expect(document.activeElement).toBe(surface);
    act(() =>
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })),
    );
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
    expect(document.activeElement).toBe(trigger);

    act(() => trigger?.click());
    availableWidth = 300;
    triggerResize();
    expect(view.container.querySelectorAll('[data-item]').length).toBe(3);
    expect(view.container.querySelector('button[aria-label^="Показати ще"]')).toBeNull();
    expect(view.container.querySelector('[data-mrt-overflow-fade]')).toBeNull();
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    destroy(view);
  });

  it('preserves click-away focus and does not restore a removed disclosure trigger', async () => {
    itemWidths = { alpha: 60, beta: 60, 'Ще 1': 32, 'Ще 2': 32 };
    availableWidth = 100;
    const outside = document.createElement('button');
    outside.type = 'button';
    outside.textContent = 'Outside';
    document.body.appendChild(outside);
    const view = render(
      createElement(MrtOverflowItems<string>, {
        items: ['alpha', 'beta'],
        renderItem: (value) => createElement('span', null, value),
        renderMeasurementItem: (value) => createElement('span', null, value),
        getItemKey: (value) => value,
        getItemText: (value) => value,
      }),
    );
    try {
      triggerResize();
      flushFrames();
      const trigger = view.container.querySelector<HTMLButtonElement>(
        'button[aria-label="Показати ще 1 значення"]',
      );
      if (!trigger) throw new Error('Expected disclosure trigger');

      act(() => trigger.click());
      expect(document.body.querySelector('[role="dialog"]')).not.toBeNull();
      await act(async () => {
        await new Promise((resolve) => window.setTimeout(resolve, 0));
      });
      act(() => {
        outside.focus();
        outside.click();
      });
      expect(document.body.querySelector('[role="dialog"]')).toBeNull();
      await act(async () => {
        await new Promise((resolve) => window.setTimeout(resolve, 0));
      });
      expect(document.activeElement).toBe(outside);

      act(() => trigger.click());
      expect(document.body.querySelector('[role="dialog"]')).not.toBeNull();
      flushFrames();
      act(() => outside.focus());
      availableWidth = 300;
      triggerResize();
      expect(view.container.querySelector('[aria-label^="Показати ще"]')).toBeNull();
      expect(document.body.querySelector('[role="dialog"]')).toBeNull();
      expect(document.activeElement).toBe(outside);
    } finally {
      destroy(view);
      outside.remove();
    }
  });

  it('treats a normal column gap as zero during rendered item measurement', () => {
    columnGap = 'normal';
    itemWidths = { alpha: 60, beta: 60, gamma: 60, 'Ще 1': 32, 'Ще 2': 32, 'Ще 3': 32 };
    availableWidth = 150;
    const view = render(
      createElement(MrtOverflowItems<string>, {
        items: ['alpha', 'beta', 'gamma'],
        renderItem: (value) => createElement('button', { 'data-item': value }, value),
        renderMeasurementItem: (value) => createElement('span', null, value),
        getItemText: (value) => value,
      }),
    );
    triggerResize();
    expect(view.container.querySelectorAll('[data-item]')).toHaveLength(1);
    expect(view.container.querySelector('[data-item="alpha"]')).not.toBeNull();
    expect(view.container.querySelector('[data-item="beta"]')).toBeNull();
    expect(
      view.container.querySelector('button[aria-label="Показати ще 2 значення"]')?.textContent,
    ).toBe('Ще 2');
    destroy(view);
  });

  it('represents the first oversized item and discloses only later items with original indices', async () => {
    itemWidths = { alpha: 140, beta: 30, 'Ще 1': 32, 'Ще 2': 32 };
    availableWidth = 80;
    textWidth = 140;
    const onBeta = vi.fn();
    const getItemText = vi.fn((value: string, index: number) => `${value}-${index}`);
    const getItemKey = vi.fn((value: string, index: number) => `${value}-${index}`);
    const view = render(
      createElement(MrtOverflowItems<string>, {
        items: ['alpha', 'beta'],
        renderItem: (value) =>
          createElement(
            'button',
            { 'data-item': value, onClick: value === 'beta' ? onBeta : undefined },
            value,
          ),
        getItemKey,
        getItemText,
        emptyValue: 'порожньо',
      }),
    );
    const unresolvedVisible = view.container.querySelector<HTMLElement>(
      '[data-mrt-overflow-visible]',
    );
    expect(unresolvedVisible?.style.visibility).toBe('hidden');
    expect(view.container.querySelector('[aria-label^="Показати ще"]')).toBeNull();
    triggerResize();
    const visible = view.container.querySelector('[data-mrt-overflow-visible]');
    expect((visible as HTMLElement | null)?.style.visibility).toBe('visible');
    expect(visible?.querySelectorAll('[data-item]')).toHaveLength(1);
    expect(visible?.querySelector('[data-item="alpha"]')).not.toBeNull();
    expect(visible?.querySelector('[title="alpha-0"]')).not.toBeNull();
    expect(getItemText).toHaveBeenCalledWith('beta', 1);
    expect(getItemKey).toHaveBeenCalledWith('beta', 1);
    const trigger = view.container.querySelector<HTMLButtonElement>(
      'button[aria-label="Показати ще 1 значення"]',
    );
    expect(trigger?.textContent).toBe('Ще 1');
    act(() => trigger?.click());
    const beta = document.body.querySelector<HTMLButtonElement>(
      '[role="dialog"] [data-item="beta"]',
    );
    act(() => beta?.click());
    expect(onBeta).toHaveBeenCalledTimes(1);
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
    const outside = document.createElement('div');
    document.body.appendChild(outside);
    act(() => outside.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    availableWidth = 300;
    triggerResize();
    expect(view.container.querySelectorAll('[data-item]')).toHaveLength(2);
    expect(view.container.querySelector('[data-item="alpha"]')).not.toBeNull();
    expect(view.container.querySelector('[data-item="beta"]')).not.toBeNull();
    expect(view.container.querySelector('button[aria-label^="Показати ще"]')).toBeNull();
    destroy(view);
    expect(observers.every((observer) => observer.disconnect.mock.calls.length === 1)).toBe(true);

    const empty = render(
      createElement(MrtOverflowItems<string>, {
        items: [],
        renderItem: (value) => value,
        emptyValue: 'немає',
      }),
    );
    expect(empty.container.textContent).toBe('немає');
    destroy(empty);
  });

  it('keeps a zero-fit single renderer stable with native full-value disclosure', () => {
    itemWidths = { alpha: 140, 'Ще 1': 32 };
    availableWidth = 80;
    const view = render(
      createElement(MrtOverflowItems<string>, {
        items: ['alpha'],
        renderItem: (value) => createElement('button', { 'data-item': value }, value),
        getItemText: (value) => value,
      }),
    );
    const visible = view.container.querySelector<HTMLElement>('[data-mrt-overflow-visible]');
    const itemBefore = visible?.querySelector('[data-item="alpha"]');
    expect(visible?.style.visibility).toBe('hidden');
    expect(itemBefore).not.toBeNull();
    expect(view.container.querySelector('[aria-label^="Показати ще"]')).toBeNull();
    triggerResize();
    expect(visible?.style.visibility).toBe('visible');
    expect(visible?.querySelector('[data-item="alpha"]')).toBe(itemBefore);
    expect(visible?.querySelector('[title="alpha"]')).not.toBeNull();
    expect(view.container.querySelector('button[aria-label^="Показати ще"]')).toBeNull();
    expect(view.container.querySelector('[data-mrt-overflow-fade]')).toBeNull();
    destroy(view);
  });

  it('keeps cell and document geometry stable while a layout is unresolved', () => {
    itemWidths = { alpha: 140, beta: 30, 'Ще 1': 32 };
    availableWidth = 80;
    const view = render(
      createElement(MrtOverflowItems<string>, {
        items: ['alpha', 'beta'],
        renderItem: (value) => createElement(EchoChip, { label: value }),
        getItemText: (value) => value,
      }),
    );
    const cell = view.container.querySelector<HTMLElement>('[data-mrt-overflow-items]');
    const surface = view.container.querySelector<HTMLElement>('[data-mrt-overflow-visible]');
    const geometryBefore = cell?.getBoundingClientRect();
    const documentWidthBefore = document.documentElement.scrollWidth;
    const documentHeightBefore = document.documentElement.scrollHeight;

    expect(surface?.style.visibility).toBe('hidden');
    expect(surface?.getAttribute('aria-hidden')).toBe('true');
    expect(view.container.querySelector('[data-mrt-overflow-fade]')).toBeNull();
    expect(view.container.querySelector('[aria-label^="Показати ще"]')).toBeNull();
    expect(view.container.querySelector('[data-mrt-overflow-measurement-host]')).not.toBeNull();

    triggerResize();
    expect(surface?.style.visibility).toBe('visible');
    expect(cell?.getBoundingClientRect().width).toBe(geometryBefore?.width);
    expect(cell?.getBoundingClientRect().height).toBe(geometryBefore?.height);
    expect(document.documentElement.scrollWidth).toBe(documentWidthBefore);
    expect(document.documentElement.scrollHeight).toBe(documentHeightBefore);
    destroy(view);
  });

  it('keeps a specialized compact first item outside the disclosure', () => {
    itemWidths = { alpha: 140, beta: 30, 'Ще 1': 32 };
    availableWidth = 80;
    const compact = vi.fn((value: string, index: number) =>
      createElement('button', { 'data-compact': `${value}-${index}` }, `icon-${value}`),
    );
    const view = render(
      createElement(MrtOverflowItems<string>, {
        items: ['alpha', 'beta'],
        renderItem: (value, index) =>
          createElement('button', { 'data-normal': `${value}-${index}` }, value),
        renderCompactItem: compact,
      }),
    );
    triggerResize();
    expect(compact).toHaveBeenCalledWith('alpha', 0);
    expect(view.container.querySelector('[data-compact="alpha-0"]')?.textContent).toBe(
      'icon-alpha',
    );
    expect(view.container.querySelector('[data-normal="alpha-0"]')).toBeNull();
    expect(view.container.querySelector('[data-normal="beta-1"]')).toBeNull();
    const trigger = view.container.querySelector<HTMLButtonElement>(
      '[aria-label="Показати ще 1 значення"]',
    );
    expect(trigger?.textContent).toBe('Ще 1');
    act(() => trigger?.click());
    expect(document.body.querySelector('[role="dialog"] [data-normal="beta-1"]')).not.toBeNull();
    expect(document.body.querySelector('[role="dialog"] [data-compact="alpha-0"]')).toBeNull();
    expect(document.body.querySelector('[role="dialog"] [data-normal="alpha-0"]')).toBeNull();
    availableWidth = 300;
    triggerResize();
    expect(view.container.querySelector('[aria-label^="Показати ще"]')).toBeNull();
    expect(view.container.querySelector('[data-compact]')).toBeNull();
    expect(view.container.querySelectorAll('[data-normal]')).toHaveLength(2);
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    destroy(view);
  });

  it('contains temporary measurement geometry within its clipped cell host', () => {
    itemWidths = { alpha: 60, beta: 60, 'Ще 1': 32 };
    availableWidth = 100;
    const view = render(
      createElement(MrtOverflowItems<string>, {
        items: ['alpha', 'beta'],
        renderItem: (value) => createElement('span', null, value),
        renderMeasurementItem: (value) => createElement('span', null, value),
        getItemKey: (value) => value,
        getItemText: (value) => value,
      }),
    );
    const cell = view.container.querySelector<HTMLElement>('[data-mrt-overflow-items]');
    const host = view.container.querySelector<HTMLElement>('[data-mrt-overflow-measurement-host]');
    const measure = view.container.querySelector<HTMLElement>('[data-mrt-overflow-measure]');
    const visibleTrigger = view.container.querySelector<HTMLButtonElement>(
      'button[aria-label^="Показати ще"]',
    );
    const measuredTrigger = view.container.querySelector<HTMLButtonElement>(
      '[data-mrt-overflow-trigger-measure]',
    );

    expect(host?.parentElement).toBe(cell);
    expect(host?.contains(measure ?? null)).toBe(true);
    expect(host?.style.position).toBe('absolute');
    expect(host?.style.width).toBe('0px');
    expect(host?.style.height).toBe('0px');
    expect(host?.style.overflow).toBe('hidden');
    expect(host?.style.visibility).toBe('hidden');
    expect(host?.style.contain).toBe('layout style paint');
    expect(measure?.parentElement).toBe(host);
    expect(visibleTrigger).toBeNull();
    expect(measuredTrigger?.className).toBe('mrt-overflow-trigger');

    flushFrames();
    expect(view.container.querySelector('[data-mrt-overflow-measure]')).toBeNull();
    destroy(view);
  });

  it('keeps a specialized single zero-fit item without disclosure', () => {
    itemWidths = { alpha: 140 };
    availableWidth = 80;
    const compact = vi.fn((value: string, index: number) =>
      createElement('span', { 'data-compact': `${value}-${index}` }, `icon-${value}`),
    );
    const view = render(
      createElement(MrtOverflowItems<string>, {
        items: ['alpha'],
        renderItem: (value, index) =>
          createElement('span', { 'data-normal': `${value}-${index}` }, value),
        renderCompactItem: compact,
      }),
    );
    triggerResize();
    expect(compact).toHaveBeenCalledWith('alpha', 0);
    expect(view.container.querySelector('[data-compact="alpha-0"]')?.textContent).toBe(
      'icon-alpha',
    );
    expect(view.container.querySelector('[data-normal="alpha-0"]')).toBeNull();
    expect(view.container.querySelector('[aria-label^="Показати ще"]')).toBeNull();
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    expect(view.container.querySelector('[data-mrt-overflow-fade]')).toBeNull();
    destroy(view);
  });

  it('shares bounded measurement work across cells and caches stable item geometry', () => {
    itemWidths = { alpha: 60, beta: 60, gamma: 60, 'Ще 1': 32, 'Ще 2': 32, 'Ще 3': 32 };
    availableWidth = 100;
    const renderCells = (suffix = '') =>
      createElement(
        'div',
        null,
        ...Array.from({ length: 12 }, (_, index) =>
          createElement(MrtOverflowItems<string>, {
            key: index,
            items: [`alpha${suffix}`, `beta${suffix}`, `gamma${suffix}`],
            renderItem: (value) => createElement('span', { 'data-cell-item': value }, value),
            renderMeasurementItem: (value) =>
              createElement('span', null, value.replace(suffix, '')),
            getItemKey: (value) => value,
            getItemText: (value) => value,
            measurementScope: 'test:shared-cells',
          }),
        ),
      );
    const view = render(createElement(StrictMode, null, renderCells()));

    expect(document.body.querySelectorAll('[data-mrt-overflow-measure]')).toHaveLength(1);
    expect(document.body.querySelectorAll('[data-mrt-overflow-trigger-measure]')).toHaveLength(2);
    expect(
      document.body
        .querySelector('[data-mrt-overflow-trigger-measure]')
        ?.classList.contains('mrt-overflow-trigger'),
    ).toBe(true);

    for (let index = 0; index < 30; index += 1) flushFrames();
    expect(document.body.querySelectorAll('[data-mrt-overflow-measure]')).toHaveLength(0);
    expect(document.body.querySelectorAll('[data-mrt-overflow-trigger-measure]')).toHaveLength(0);

    act(() => view.root.render(createElement(StrictMode, null, renderCells())));
    expect(document.body.querySelectorAll('[data-mrt-overflow-measure]')).toHaveLength(0);

    availableWidth = 300;
    triggerResize();
    expect(document.body.querySelectorAll('[data-mrt-overflow-measure]')).toHaveLength(0);
    expect(view.container.querySelectorAll('[data-cell-item]')).toHaveLength(36);

    act(() => view.root.render(createElement(StrictMode, null, renderCells('-changed'))));
    expect(document.body.querySelectorAll('[data-mrt-overflow-measure]')).toHaveLength(1);
    destroy(view);
    flushFrames();
    expect(document.body.querySelectorAll('[data-mrt-overflow-measure]')).toHaveLength(0);
  });

  it('keeps a 127-item chip collection bounded until its disclosure opens', () => {
    const items = Array.from({ length: 127 }, (_, index) => `chip-${index}`);
    itemWidths = Object.fromEntries(items.map((item) => [item, 60]));
    itemWidths['Ще 126'] = 40;
    availableWidth = 100;
    const renderItem = vi.fn((item: string) => createElement(EchoChip, { label: item }));
    const renderMeasurementItem = vi.fn((item: string) => createElement(EchoChip, { label: item }));
    const view = render(
      createElement(MrtOverflowItems<string>, {
        items,
        renderItem,
        renderMeasurementItem,
        measurementScope: 'test:large-native-chip',
        getItemKey: (item) => item,
        getItemText: (item) => item,
      }),
    );

    expect(
      view.container.querySelector<HTMLElement>('[data-mrt-overflow-visible]')?.style.visibility,
    ).toBe('hidden');
    expect(
      view.container.querySelector('[data-mrt-overflow-visible]')?.querySelectorAll('.echo-chip'),
    ).toHaveLength(1);
    expect(renderItem.mock.calls.length).toBeLessThan(4);
    expect(view.container.textContent).toContain('Ще 126');
    expect(renderMeasurementItem.mock.calls.length).toBeLessThanOrEqual(16);
    expect(document.body.querySelectorAll('[data-mrt-overflow-measure]')).toHaveLength(1);
    flushFrames();
    expect(document.body.querySelectorAll('[data-mrt-overflow-measure]')).toHaveLength(0);
    expect(
      view.container.querySelector<HTMLElement>('[data-mrt-overflow-visible]')?.style.visibility,
    ).toBe('visible');
    expect(view.container.querySelector('[data-mrt-overflow-visible]')?.textContent).toContain(
      'chip-0',
    );
    expect(
      view.container.querySelector('[data-mrt-overflow-visible]')?.querySelectorAll('.echo-chip'),
    ).toHaveLength(1);

    act(() =>
      view.container.querySelector<HTMLButtonElement>('[aria-label^="Показати ще"]')?.click(),
    );
    expect(
      document.body.querySelector('[role="dialog"]')?.querySelectorAll('.echo-chip'),
    ).toHaveLength(126);
    act(() =>
      view.container.querySelector<HTMLButtonElement>('[aria-label^="Показати ще"]')?.click(),
    );
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    destroy(view);
  });

  it('keeps a generic oversized item stable while lazily enhancing its full-value tooltip', () => {
    itemWidths = { alpha: 140 };
    availableWidth = 80;
    const view = render(
      createElement(MrtOverflowItems<string>, {
        items: ['alpha'],
        renderItem: (value) => createElement('button', { 'data-item': value }, value),
        getItemText: (value) => `complete ${value}`,
      }),
    );
    triggerResize();

    const item = view.container.querySelector<HTMLButtonElement>('[data-item="alpha"]');
    const wrapper = item?.parentElement;
    expect(wrapper?.getAttribute('title')).toBe('complete alpha');
    expect(document.body.querySelector('[role="tooltip"]')).toBeNull();

    act(() => item?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })));
    expect(wrapper?.getAttribute('title')).toBeNull();
    expect(document.body.querySelector('[role="tooltip"]')?.textContent).toContain(
      'complete alpha',
    );
    expect(view.container.querySelector('[data-item="alpha"]')).toBe(item);
    act(() => item?.dispatchEvent(new MouseEvent('mouseout', { bubbles: true })));
    expect(wrapper?.getAttribute('title')).toBe('complete alpha');
    expect(document.body.querySelector('[role="tooltip"]')).toBeNull();

    act(() => item?.focus());
    expect(wrapper?.getAttribute('title')).toBeNull();
    expect(document.body.querySelector('[role="tooltip"]')?.textContent).toContain(
      'complete alpha',
    );
    act(() => item?.blur());
    expect(wrapper?.getAttribute('title')).toBe('complete alpha');
    expect(document.body.querySelector('[role="tooltip"]')).toBeNull();
    destroy(view);
  });

  it('renders a bounded list disclosure and lazily copies every original item', async () => {
    itemWidths = { alpha: 60, beta: 60, gamma: 60, 'Ще 1': 32, 'Ще 2': 32 };
    availableWidth = 150;
    const view = render(
      createElement(MrtOverflowItems<string>, {
        items: ['alpha', 'beta', 'gamma'],
        disclosureLayout: 'list',
        renderItem: (value) => createElement('span', { 'data-item': value }, value),
        getItemText: (value) => `full ${value}`,
      }),
    );
    triggerResize();
    expect(view.container.querySelector('[aria-label^="Скопіювати всі"]')).toBeNull();
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();

    act(() =>
      view.container
        .querySelector<HTMLButtonElement>('[aria-label="Показати ще 2 значення"]')
        ?.click(),
    );
    const dialog = document.body.querySelector<HTMLElement>('[role="dialog"]');
    const list = dialog?.querySelector<HTMLUListElement>('ul');
    const copy = dialog?.querySelector<HTMLButtonElement>(
      '[aria-label="Скопіювати всі 3 значення"]',
    );
    const header = dialog?.firstElementChild as HTMLElement | null;
    const status = dialog?.querySelector<HTMLElement>('[role="status"]');
    expect(dialog?.textContent).toContain('Додаткові значення (2)');
    expect(list?.querySelectorAll('li')).toHaveLength(2);
    expect(list?.textContent).toContain('beta');
    expect(list?.textContent).toContain('gamma');
    expect(list?.textContent).not.toContain('alpha');
    expect(getComputedStyle(list!).overflowY).toBe('auto');
    expect(getComputedStyle(list!).overflowX).toBe('hidden');
    expect(copy).not.toBeNull();
    expect(status?.textContent).toBe('');
    expect(status?.getAttribute('aria-live')).toBe('polite');
    expect(status?.parentElement?.parentElement).toBe(header);
    expect(status?.nextElementSibling?.contains(copy!)).toBe(true);
    expect(list?.previousElementSibling).toBe(header);
    const getGeometry = (element: Element | null | undefined) => {
      const rect = element?.getBoundingClientRect();
      return rect && [rect.x, rect.y, rect.width, rect.height];
    };
    const geometryBeforeCopy = [dialog, header, copy, list].map(getGeometry);

    act(() => copy?.click());
    await act(async () => Promise.resolve());
    expect(copyTextToClipboard).toHaveBeenCalledWith('full alpha\nfull beta\nfull gamma');
    expect(document.body.querySelector('[role="status"]')?.textContent).toBe('Скопійовано');
    const copiedDialog = document.body.querySelector<HTMLElement>('[role="dialog"]');
    const geometryAfterCopy = [
      copiedDialog,
      copiedDialog?.firstElementChild,
      copiedDialog?.querySelector('[aria-label="Скопіювати всі 3 значення"]'),
      copiedDialog?.querySelector('ul'),
    ].map(getGeometry);
    expect(geometryAfterCopy).toEqual(geometryBeforeCopy);

    act(() =>
      view.container
        .querySelector<HTMLButtonElement>('[aria-label="Показати ще 2 значення"]')
        ?.click(),
    );
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    expect(document.body.querySelector('[aria-label^="Скопіювати всі"]')).toBeNull();
    destroy(view);

    copyTextToClipboard.mockReset();
    copyTextToClipboard.mockRejectedValue(new Error('denied'));
    availableWidth = 80;
    itemWidths = { alpha: 60, beta: 60, 'Ще 1': 32 };
    const failureView = render(
      createElement(MrtOverflowItems<string>, {
        items: ['alpha', 'beta'],
        renderItem: (value) => createElement('span', null, value),
        getItemText: (value) => value,
      }),
    );
    triggerResize();
    act(() =>
      failureView.container
        .querySelector<HTMLButtonElement>('[aria-label="Показати ще 1 значення"]')
        ?.click(),
    );
    act(() =>
      document.body
        .querySelector<HTMLButtonElement>('[aria-label="Скопіювати всі 2 значення"]')
        ?.click(),
    );
    await act(async () => Promise.resolve());
    const failureStatus = document.body.querySelector<HTMLElement>('[role="status"]');
    expect(failureStatus?.textContent).toBe('Не вдалося скопіювати');
    expect(failureStatus?.getAttribute('aria-live')).toBe('polite');
    destroy(failureView);
  });

  it('keeps a thousand-item collection closed until its one bounded disclosure opens', () => {
    const items = Array.from({ length: 1000 }, (_, index) => `large-${index}`);
    itemWidths = Object.fromEntries(items.map((item) => [item, 60]));
    itemWidths['Ще 999'] = 40;
    availableWidth = 100;
    const renderItem = vi.fn((item: string) => createElement('span', { 'data-item': item }, item));
    const view = render(
      createElement(MrtOverflowItems<string>, {
        items,
        renderItem,
        getItemKey: (item) => item,
        getItemText: (item) => `full ${item}`,
        measurementScope: 'test:thousand-items',
      }),
    );

    expect(renderItem.mock.calls.length).toBeLessThan(20);
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    expect(document.body.querySelector('[aria-label^="Скопіювати всі"]')).toBeNull();
    flushFrames();
    expect(renderItem.mock.calls.length).toBeLessThan(20);
    act(() =>
      view.container.querySelector<HTMLButtonElement>('[aria-label^="Показати ще"]')?.click(),
    );
    expect(document.body.querySelectorAll('[role="dialog"]')).toHaveLength(1);
    expect(
      document.body.querySelectorAll('[aria-label="Скопіювати всі 1000 значень"]'),
    ).toHaveLength(1);
    destroy(view);
  });

  it('continues bounded batches when the first prefix fits', () => {
    const items = Array.from({ length: 20 }, (_, index) => `wide-${index}`);
    itemWidths = Object.fromEntries(items.map((item) => [item, 20]));
    availableWidth = 1000;
    const measured = vi.fn((item: string) => createElement('span', null, item));
    const view = render(
      createElement(MrtOverflowItems<string>, {
        items,
        renderItem: (item) => createElement(EchoChip, { label: item }),
        renderMeasurementItem: measured,
        measurementScope: 'test:incremental-batches',
        getItemKey: (item) => item,
        getItemText: (item) => item,
      }),
    );

    expect(measured.mock.calls.length).toBeLessThanOrEqual(16);
    flushFrames();
    expect(measured).toHaveBeenCalledTimes(20);
    triggerResize();
    expect(view.container.querySelectorAll('.echo-chip')).toHaveLength(20);
    expect(view.container.querySelector('[aria-label^="Показати ще"]')).toBeNull();
    destroy(view);
  });

  it('resumes a cached measured prefix after widening without progressive layout changes', () => {
    const items = Array.from({ length: 33 }, (_, index) => `resumable-${index}`);
    itemWidths = Object.fromEntries(items.map((item) => [item, 20]));
    itemWidths['Ще 32'] = 32;
    availableWidth = 100;
    const measured = vi.fn((item: string) => createElement('span', null, item));
    const view = render(
      createElement(MrtOverflowItems<string>, {
        items,
        renderItem: (item) => createElement(EchoChip, { label: item }),
        renderMeasurementItem: measured,
        measurementScope: 'test:resumable-prefix',
        getItemKey: (item) => item,
        getItemText: (item) => item,
      }),
    );

    flushFrames();
    expect(measured.mock.calls.map(([item]) => item)).toEqual(items.slice(0, 16));
    expect(measured).not.toHaveBeenCalledWith(items[16]);
    expect(
      view.container.querySelector('[data-mrt-overflow-visible]')?.querySelectorAll('.echo-chip'),
    ).toHaveLength(1);

    availableWidth = 500;
    triggerResize();
    expect(document.body.querySelector('[data-mrt-overflow-measure]')?.textContent).toContain(
      items[16],
    );
    expect(
      view.container.querySelector('[data-mrt-overflow-visible]')?.querySelectorAll('.echo-chip'),
    ).toHaveLength(1);
    flushFrames();
    expect(measured.mock.calls.slice(0, 16).map(([item]) => item)).toEqual(items.slice(0, 16));
    expect(measured.mock.calls.slice(16).map(([item]) => item)).toEqual(items.slice(16, 32));
    const partialVisibleCount = view.container.querySelector('[data-mrt-overflow-visible]')
      ?.children.length;
    expect(partialVisibleCount).toBeGreaterThan(1);
    expect(view.container.querySelector('[aria-label^="Показати ще"]')?.textContent).toBe(
      `Ще ${items.length - partialVisibleCount!}`,
    );

    availableWidth = 2_000;
    triggerResize();
    expect(document.body.querySelector('[data-mrt-overflow-measure]')?.textContent).toContain(
      items[32],
    );
    flushFrames();
    expect(view.container.querySelectorAll('[data-mrt-overflow-visible] .echo-chip')).toHaveLength(
      items.length,
    );
    expect(view.container.querySelector('[aria-label^="Показати ще"]')).toBeNull();

    const measurementCount = measured.mock.calls.length;
    availableWidth = 100;
    triggerResize();
    expect(document.body.querySelector('[data-mrt-overflow-measure]')).toBeNull();
    expect(measured).toHaveBeenCalledTimes(measurementCount);
    expect(
      view.container.querySelector('[data-mrt-overflow-visible]')?.querySelectorAll('.echo-chip'),
    ).toHaveLength(1);
    destroy(view);
  });

  it('publishes a shared resumed partial cache to every subscriber after widening', () => {
    const items = Array.from({ length: 33 }, (_, index) => `shared-resume-${index}`);
    itemWidths = Object.fromEntries(items.map((item) => [item, 20]));
    availableWidth = 100;
    const ownerMeasurements = vi.fn((item: string) => createElement('span', null, item));
    const subscriberMeasurements = vi.fn((item: string) => createElement('span', null, item));
    const cell = (key: string, renderMeasurementItem: (item: string, index: number) => ReactNode) =>
      createElement(MrtOverflowItems<string>, {
        key,
        items,
        renderItem: (item, index) =>
          createElement('span', { 'data-shared-resume-item': `${key}-${index}` }, item),
        renderMeasurementItem,
        measurementScope: 'test:shared-resumed-prefix',
        getItemKey: (item) => item,
        getItemText: (item) => item,
      });
    const view = render(
      createElement(
        'div',
        null,
        cell('owner', ownerMeasurements),
        cell('subscriber', subscriberMeasurements),
      ),
    );
    const itemCells = [
      ...view.container.querySelectorAll<HTMLElement>('[data-mrt-overflow-items]'),
    ];

    try {
      flushFrames();
      expect(ownerMeasurements.mock.calls.map(([item]) => item)).toEqual(items.slice(0, 16));
      expect(subscriberMeasurements).not.toHaveBeenCalled();
      expect(
        itemCells.map(
          (itemCell) => itemCell.querySelector('[data-mrt-overflow-visible]')?.children.length ?? 0,
        ),
      ).toEqual([1, 1]);

      itemCells.forEach((itemCell) => setCellWidth(itemCell, 500));
      triggerResize();
      expect(document.body.querySelectorAll('[data-mrt-overflow-measure]')).toHaveLength(1);
      expect(ownerMeasurements.mock.calls.map(([item]) => item)).toEqual(items.slice(0, 32));
      expect(subscriberMeasurements).not.toHaveBeenCalled();
      expect(
        itemCells.map(
          (itemCell) => itemCell.querySelector('[data-mrt-overflow-visible]')?.children.length ?? 0,
        ),
      ).toEqual([1, 1]);

      flushFrames();
      const visibleCounts = itemCells.map(
        (itemCell) => itemCell.querySelector('[data-mrt-overflow-visible]')?.children.length ?? 0,
      );
      const triggerLabels = itemCells.map(
        (itemCell) => itemCell.querySelector('[aria-label^="Показати ще"]')?.textContent ?? null,
      );
      expect(visibleCounts[0]).toBeGreaterThan(16);
      expect(visibleCounts).toEqual([visibleCounts[0], visibleCounts[0]]);
      expect(
        itemCells.map((itemCell) =>
          itemCell.querySelector(
            '[data-shared-resume-item="owner-16"], [data-shared-resume-item="subscriber-16"]',
          ),
        ),
      ).not.toContain(null);
      expect(triggerLabels).toEqual([`Ще ${items.length - visibleCounts[0]}`, triggerLabels[0]]);
      expect(document.body.querySelectorAll('[data-mrt-overflow-measure]')).toHaveLength(0);
    } finally {
      destroy(view);
    }
  });

  it('releases stale virtualized signature jobs before scheduling replacement cells', () => {
    const renderCells = (prefix: string, includeExtra = false) =>
      createElement(
        'div',
        null,
        ...Array.from({ length: 8 }, (_, index) => {
          const items = [`${prefix}-${index}-first`, `${prefix}-${index}-second`];
          items.forEach((item) => {
            itemWidths[item] = 60;
          });
          return createElement(MrtOverflowItems<string>, {
            key: index,
            items,
            renderItem: (item) => createElement('span', { 'data-cell-item': item }, item),
            renderMeasurementItem: (item) =>
              createElement('span', { 'data-measured-item': item }, item),
            measurementScope: `test:virtualized-slot-${index}`,
            getItemKey: (item) => item,
            getItemText: (item) => item,
          });
        }),
        ...(includeExtra
          ? [
              createElement(MrtOverflowItems<string>, {
                key: 'extra',
                items: ['extra-first', 'extra-second'],
                renderItem: (item) => createElement('span', { 'data-cell-item': item }, item),
                renderMeasurementItem: (item) =>
                  createElement('span', { 'data-measured-item': item }, item),
                measurementScope: 'test:virtualized-slot-extra',
                getItemKey: (item) => item,
                getItemText: (item) => item,
              }),
            ]
          : []),
      );
    itemWidths['extra-first'] = 60;
    itemWidths['extra-second'] = 60;
    availableWidth = 300;
    const view = render(renderCells('old'));
    expect(document.body.querySelectorAll('[data-mrt-overflow-measure]')).toHaveLength(8);

    act(() => view.root.render(renderCells('new')));
    expect(
      document.body.querySelector('[data-mrt-overflow-measure]')?.textContent ?? '',
    ).not.toContain('old-');
    Array.from({ length: 20 }, flushFrames);
    expect(view.container.querySelectorAll('[data-cell-item^="new-"]')).toHaveLength(16);

    act(() => view.root.render(renderCells('new', true)));
    expect(document.body.querySelectorAll('[data-mrt-overflow-measure]')).toHaveLength(1);
    Array.from({ length: 20 }, flushFrames);
    expect(view.container.querySelectorAll('[data-cell-item^="new-"]')).toHaveLength(16);
    expect(view.container.querySelectorAll('[data-cell-item^="extra-"]')).toHaveLength(2);
    expect(document.body.querySelectorAll('[data-mrt-overflow-measure]')).toHaveLength(0);
    expect(frames.size).toBe(0);
    destroy(view);
  });

  it('keeps identical subscribers through incremental measurement batches', () => {
    const items = Array.from({ length: 20 }, (_, index) => `shared-${index}`);
    itemWidths = Object.fromEntries(items.map((item) => [item, 20]));
    availableWidth = 1000;
    const measured = vi.fn((item: string) => createElement('span', null, item));
    const cell = (key: string) =>
      createElement(MrtOverflowItems<string>, {
        key,
        items,
        renderItem: (item) => createElement(EchoChip, { label: item }),
        renderMeasurementItem: measured,
        measurementScope: 'test:shared-incremental',
        getItemKey: (item) => item,
        getItemText: (item) => item,
      });
    const view = render(createElement('div', null, cell('first'), cell('second')));

    expect(document.body.querySelectorAll('[data-mrt-overflow-measure]')).toHaveLength(1);
    expect(document.body.querySelectorAll('[data-mrt-overflow-measured-item]')).toHaveLength(16);
    flushFrames();
    expect(document.body.querySelectorAll('[data-mrt-overflow-measured-item]')).toHaveLength(4);
    flushFrames();
    expect(measured).toHaveBeenCalledTimes(20);
    expect(view.container.querySelectorAll('.echo-chip')).toHaveLength(40);
    expect(view.container.querySelectorAll('[aria-label^="Показати ще"]')).toHaveLength(0);
    destroy(view);
  });

  it('promotes a remaining subscriber when an incremental measurement owner unmounts', () => {
    const items = Array.from({ length: 20 }, (_, index) => `owner-${index}`);
    itemWidths = Object.fromEntries(items.map((item) => [item, 20]));
    availableWidth = 1000;
    const ownerMeasurements = vi.fn((item: string) =>
      createElement('span', { 'data-owner-measurement': item }, item),
    );
    const replacementMeasurements = vi.fn((item: string) =>
      createElement('span', { 'data-replacement-measurement': item }, item),
    );
    const cell = (key: string, renderMeasurementItem: (item: string) => ReactNode) =>
      createElement(MrtOverflowItems<string>, {
        key,
        items,
        renderItem: (item) => createElement(EchoChip, { label: item }),
        renderMeasurementItem,
        measurementScope: 'test:owner-cancellation',
        getItemKey: (item) => item,
        getItemText: (item) => item,
      });
    const renderCells = (withOwner: boolean) =>
      createElement(
        'div',
        null,
        ...(withOwner ? [cell('owner', ownerMeasurements)] : []),
        cell('subscriber', replacementMeasurements),
      );
    const view = render(renderCells(true));
    try {
      expect(ownerMeasurements).toHaveBeenCalledTimes(16);
      const ownerMeasurementCount = ownerMeasurements.mock.calls.length;
      act(() => view.root.render(renderCells(false)));
      flushFrames();
      flushFrames();
      flushFrames();
      expect(ownerMeasurements).toHaveBeenCalledTimes(ownerMeasurementCount);
      expect(replacementMeasurements).toHaveBeenCalledTimes(20);
      expect(view.container.querySelectorAll('.echo-chip')).toHaveLength(20);
      expect(document.body.querySelectorAll('[data-mrt-overflow-measure]')).toHaveLength(0);
      expect(frames.size).toBe(0);
    } finally {
      destroy(view);
    }
  });

  it('does not interrupt an active owner when a non-owner subscriber unmounts', () => {
    const items = Array.from({ length: 20 }, (_, index) => `non-owner-${index}`);
    itemWidths = Object.fromEntries(items.map((item) => [item, 20]));
    availableWidth = 1000;
    const measured = vi.fn((item: string) => createElement('span', null, item));
    const cell = (key: string) =>
      createElement(MrtOverflowItems<string>, {
        key,
        items,
        renderItem: (item) => createElement(EchoChip, { label: item }),
        renderMeasurementItem: measured,
        measurementScope: 'test:non-owner-cancellation',
        getItemKey: (item) => item,
        getItemText: (item) => item,
      });
    const renderCells = (withMiddle: boolean) =>
      createElement(
        'div',
        null,
        cell('owner'),
        ...(withMiddle ? [cell('middle')] : []),
        cell('third'),
      );
    const view = render(renderCells(true));
    try {
      expect(document.body.querySelectorAll('[data-mrt-overflow-measure]')).toHaveLength(1);
      flushFrames();
      const measurementRenderCountBeforeRemoval = measured.mock.calls.length;
      act(() => view.root.render(renderCells(false)));
      expect(document.body.querySelectorAll('[data-mrt-overflow-measure]')).toHaveLength(1);
      flushFrames();
      expect(measured.mock.calls.length).toBeLessThanOrEqual(
        measurementRenderCountBeforeRemoval + 4,
      );
      expect(view.container.querySelectorAll('.echo-chip')).toHaveLength(40);
      expect(frames.size).toBe(0);
    } finally {
      destroy(view);
    }
  });

  it('recovers a shared job when its owner becomes zero-width before measurement', () => {
    itemWidths = { alpha: 60 };
    const measured = vi.fn((item: string) => createElement('span', null, item));
    const cell = (key: string) =>
      createElement(MrtOverflowItems<string>, {
        key,
        items: ['alpha'],
        renderItem: (item) => createElement('span', { 'data-item': key }, item),
        renderMeasurementItem: measured,
        measurementScope: 'test:zero-width-owner',
        getItemKey: (item) => item,
        getItemText: (item) => item,
      });
    const view = render(createElement('div', null, cell('owner'), cell('subscriber')));
    try {
      const [owner, subscriber] = [
        ...view.container.querySelectorAll<HTMLElement>('[data-mrt-overflow-items]'),
      ];
      setCellWidth(owner!, 0);
      setCellWidth(subscriber!, 100);
      flushFrames();
      expect(document.body.querySelectorAll('[data-mrt-overflow-measure]')).toHaveLength(0);
      flushFrames();
      expect(document.body.querySelectorAll('[data-mrt-overflow-measure]')).toHaveLength(1);
      flushFrames();
      expect(measured).toHaveBeenCalledTimes(2);
      expect(view.container.querySelectorAll('[data-item]')).toHaveLength(2);
      setCellWidth(owner!, 100);
      triggerResize();
      expect(document.body.querySelectorAll('[data-mrt-overflow-measure]')).toHaveLength(0);
    } finally {
      destroy(view);
    }
  });

  it('parks an all-zero-width shared job until a fresh resize makes one subscriber eligible', () => {
    itemWidths = { alpha: 60 };
    const cell = (key: string) =>
      createElement(MrtOverflowItems<string>, {
        key,
        items: ['alpha'],
        renderItem: (item) => createElement('span', { 'data-item': key }, item),
        measurementScope: 'test:all-zero-width',
        getItemKey: (item) => item,
        getItemText: (item) => item,
      });
    const view = render(createElement('div', null, cell('first'), cell('second')));
    try {
      const [first, second] = [
        ...view.container.querySelectorAll<HTMLElement>('[data-mrt-overflow-items]'),
      ];
      setCellWidth(first!, 0);
      setCellWidth(second!, 0);
      flushFrames();
      flushFrames();
      flushFrames();
      expect(document.body.querySelectorAll('[data-mrt-overflow-measure]')).toHaveLength(0);
      expect(frames.size).toBe(0);

      setCellWidth(second!, 100);
      triggerResize();
      flushFrames();
      expect(view.container.querySelectorAll('[data-item]')).toHaveLength(2);
      expect(document.body.querySelectorAll('[data-mrt-overflow-measure]')).toHaveLength(0);
      expect(frames.size).toBe(0);
    } finally {
      destroy(view);
    }
  });

  it('lets eligible jobs run while earlier all-zero-width jobs stay parked', () => {
    itemWidths = {
      'parked-first-a': 20,
      'parked-first-b': 20,
      'parked-second-a': 20,
      'parked-second-b': 20,
      'valid-a': 20,
      'valid-b': 20,
    };
    availableWidth = 100;
    const itemCell = (scope: string, label: string) =>
      createElement(MrtOverflowItems<string>, {
        key: scope,
        items: [`${label}-a`, `${label}-b`],
        renderItem: (item) => createElement('span', { 'data-item': scope }, item),
        measurementScope: scope,
        getItemKey: (item) => item,
        getItemText: (item) => item,
      });
    const view = render(
      createElement(
        'div',
        null,
        itemCell('test:parked-first', 'parked'),
        itemCell('test:parked-second', 'parked'),
        itemCell('test:valid', 'valid'),
      ),
    );
    try {
      const [first, second, valid] = [
        ...view.container.querySelectorAll<HTMLElement>('[data-mrt-overflow-items]'),
      ];
      setCellWidth(first!, 0);
      setCellWidth(second!, 0);
      setCellWidth(valid!, 100);
      flushFrames();
      flushFrames();
      flushFrames();
      expect(view.container.querySelectorAll('[data-item="test:valid"]')).toHaveLength(2);
      expect(view.container.querySelectorAll('[data-item="test:parked-first"]')).toHaveLength(1);
      expect(view.container.querySelectorAll('[data-item="test:parked-second"]')).toHaveLength(1);
      expect(document.body.querySelectorAll('[data-mrt-overflow-measure]')).toHaveLength(0);
      expect(frames.size).toBe(0);

      setCellWidth(first!, 100);
      triggerResize();
      flushFrames();
      flushFrames();
      expect(view.container.querySelectorAll('[data-item="test:parked-first"]')).toHaveLength(2);
      expect(view.container.querySelectorAll('[data-item="test:parked-second"]')).toHaveLength(1);
    } finally {
      destroy(view);
    }
  });

  it('starts distinct visible measurements in bounded concurrent batches', () => {
    const view = render(
      createElement(
        'div',
        null,
        ...Array.from({ length: 10 }, (_, index) => {
          const label = `distinct-${index}`;
          itemWidths[label] = 60;
          return createElement(MrtOverflowItems<string>, {
            key: label,
            items: [label],
            renderItem: (item) => createElement('span', null, item),
            measurementScope: `test:distinct-${index}`,
            getItemKey: (item) => item,
            getItemText: (item) => item,
          });
        }),
      ),
    );

    expect(document.body.querySelectorAll('[data-mrt-overflow-measure]')).toHaveLength(8);
    expect(document.body.querySelectorAll('[data-mrt-overflow-measured-item]')).toHaveLength(8);
    flushFrames();
    flushFrames();
    expect(document.body.querySelectorAll('[data-mrt-overflow-measure]')).toHaveLength(2);
    flushFrames();
    expect(document.body.querySelectorAll('[data-mrt-overflow-measure]')).toHaveLength(0);
    expect(view.container.querySelectorAll('[data-mrt-overflow-items]')).toHaveLength(10);
    destroy(view);
  });

  it('evicts least-recently-used measurement geometry while retaining recent entries', () => {
    const measured = vi.fn((item: string) => createElement('span', null, item));
    const renderCached = (scope: string) =>
      render(
        createElement(MrtOverflowItems<string>, {
          items: [scope],
          renderItem: (item) => createElement('span', null, item),
          renderMeasurementItem: measured,
          measurementScope: scope,
          getItemKey: (item) => item,
          getItemText: (item) => item,
        }),
      );
    const oldest = renderCached('test:cache-oldest');
    flushFrames();
    destroy(oldest);
    const recent = renderCached('test:cache-recent');
    flushFrames();
    destroy(recent);
    for (let index = 0; index < 511; index += 1) {
      const view = renderCached(`test:cache-${index}`);
      flushFrames();
      destroy(view);
    }
    const recentHit = renderCached('test:cache-recent');
    expect(document.body.querySelectorAll('[data-mrt-overflow-measure]')).toHaveLength(0);
    destroy(recentHit);
    const countBeforeOldest = measured.mock.calls.length;
    const newest = renderCached('test:cache-newest');
    flushFrames();
    destroy(newest);
    const evicted = renderCached('test:cache-oldest');
    expect(document.body.querySelectorAll('[data-mrt-overflow-measure]')).toHaveLength(1);
    flushFrames();
    expect(measured.mock.calls.length).toBeGreaterThan(countBeforeOldest + 1);
    destroy(evicted);
  });

  it('keeps repeated table previews bounded and shares their measurement scope', () => {
    const items = ['alpha', 'beta', 'gamma', 'delta'];
    itemWidths = { alpha: 60, beta: 60, gamma: 60, delta: 60, 'Ще 3': 32 };
    availableWidth = 100;
    const view = render(
      createElement(
        'div',
        null,
        ...Array.from({ length: 400 }, (_, index) =>
          createElement(MrtOverflowItems<string>, {
            key: index,
            items,
            renderItem: (item) => createElement(EchoChip, { label: item }),
            measurementScope: 'test:repeated-chip-column',
            getItemKey: (item) => item,
            getItemText: (item) => item,
          }),
        ),
      ),
    );

    expect(view.container.querySelectorAll('[data-mrt-overflow-visible]')).toHaveLength(400);
    expect(
      [...view.container.querySelectorAll<HTMLElement>('[data-mrt-overflow-visible]')].every(
        (surface) => surface.style.visibility === 'hidden',
      ),
    ).toBe(true);
    expect(view.container.querySelectorAll('[data-mrt-overflow-visible] .echo-chip')).toHaveLength(
      400,
    );
    expect(view.container.querySelector('[data-mrt-overflow-visible]')?.textContent).not.toContain(
      'beta',
    );
    expect(document.body.querySelectorAll('[data-mrt-overflow-measure]')).toHaveLength(1);
    flushFrames();
    flushFrames();
    expect(document.body.querySelectorAll('[data-mrt-overflow-measure]')).toHaveLength(0);
    expect(view.container.querySelectorAll('[data-mrt-overflow-visible]')).toHaveLength(400);
    expect(
      [...view.container.querySelectorAll<HTMLElement>('[data-mrt-overflow-visible]')].every(
        (surface) => surface.style.visibility === 'visible',
      ),
    ).toBe(true);
    expect(view.container.querySelectorAll('[data-mrt-overflow-visible] .echo-chip')).toHaveLength(
      400,
    );
    destroy(view);
  });

  it('hides provisional rich content when a virtualized row signature changes', () => {
    itemWidths = { old: 30, old2: 30, next: 140, next2: 140, 'Ще 1': 32 };
    availableWidth = 300;
    const renderCell = (items: string[]) =>
      createElement(MrtOverflowItems<string>, {
        items,
        renderItem: (item) => createElement(EchoChip, { label: item }),
        measurementScope: 'test:virtualized-row',
        getItemKey: (item) => item,
        getItemText: (item) => item,
      });
    const view = render(renderCell(['old', 'old2']));
    triggerResize();
    expect(view.container.querySelectorAll('.echo-chip')).toHaveLength(2);

    availableWidth = 80;
    act(() => view.root.render(renderCell(['next', 'next2'])));
    expect(view.container.textContent).toContain('next');
    expect(view.container.textContent).not.toContain('old');
    expect(
      view.container.querySelector<HTMLElement>('[data-mrt-overflow-visible]')?.style.visibility,
    ).toBe('hidden');
    expect(
      view.container.querySelector('[data-mrt-overflow-visible]')?.querySelectorAll('.echo-chip'),
    ).toHaveLength(1);
    expect(view.container.querySelector('[aria-label="Показати ще 1 значення"]')).toBeNull();
    destroy(view);
  });

  it('defers offscreen jobs and lets a visible cell run ahead of them', () => {
    installIntersectionObserver();
    itemWidths = { deferred: 60, visible: 60, 'Ще 1': 32 };
    const renderCell = (label: string) =>
      createElement(MrtOverflowItems<string>, {
        key: label,
        items: [label, 'deferred'],
        renderItem: (value) => createElement('span', null, value),
        getItemKey: (value) => value,
        getItemText: (value) => value,
      });
    const view = render(
      createElement(
        'div',
        null,
        ...Array.from({ length: 8 }, (_, index) => renderCell(`off-${index}`)),
        renderCell('visible'),
      ),
    );
    const cells = [...view.container.querySelectorAll('[data-mrt-overflow-items]')];
    cells.forEach((cell) => setIntersection(cell, false));
    expect(frames.size).toBe(0);
    expect(document.body.querySelectorAll('[data-mrt-overflow-measure]')).toHaveLength(0);

    setIntersection(cells.at(-1)!, true);
    expect(document.body.querySelectorAll('[data-mrt-overflow-measure]')).toHaveLength(1);
    expect(document.body.querySelector('[data-mrt-overflow-measure]')?.textContent).toContain(
      'visible',
    );
    flushFrames();
    expect(document.body.querySelectorAll('[data-mrt-overflow-measure]')).toHaveLength(0);
    expect(frames.size).toBe(0);
    destroy(view);
  });

  it('promotes a deferred job once and gives it priority after an active job finishes', () => {
    installIntersectionObserver();
    itemWidths = { active: 60, promoted: 60, deferred: 60, 'Ще 1': 32 };
    const view = render(
      createElement(
        'div',
        null,
        ...['active', 'promoted', 'deferred'].map((label) =>
          createElement(MrtOverflowItems<string>, {
            key: label,
            items: [label, 'deferred'],
            renderItem: (value) => createElement('span', null, value),
            getItemKey: (value) => value,
            getItemText: (value) => value,
          }),
        ),
      ),
    );
    const cells = [...view.container.querySelectorAll('[data-mrt-overflow-items]')];
    cells.forEach((cell) => setIntersection(cell, false));
    setIntersection(cells[0], true);
    expect(document.body.querySelector('[data-mrt-overflow-measure]')?.textContent).toContain(
      'active',
    );
    setIntersection(cells[1], true);
    setIntersection(cells[1], true);
    flushFrames();
    expect(document.body.querySelectorAll('[data-mrt-overflow-measure]')).toHaveLength(0);
    destroy(view);
  });

  it('keeps offscreen changes queued, and clears queued work when items become empty', () => {
    installIntersectionObserver();
    const renderCell = (items: string[]) =>
      createElement(MrtOverflowItems<string>, {
        items,
        renderItem: (value) => createElement('span', null, value),
        getItemKey: (value) => value,
        getItemText: (value) => value,
        emptyValue: 'порожньо',
      });
    const view = render(renderCell(['before']));
    const cell = view.container.querySelector('[data-mrt-overflow-items]')!;
    setIntersection(cell, false);
    act(() => view.root.render(renderCell(['after'])));
    expect(document.body.querySelectorAll('[data-mrt-overflow-measure]')).toHaveLength(0);
    setIntersection(cell, true);
    expect(document.body.querySelector('[data-mrt-overflow-measure]')?.textContent).toContain(
      'after',
    );
    act(() => view.root.render(renderCell([])));
    expect(view.container.textContent).toBe('порожньо');
    expect(document.body.querySelectorAll('[data-mrt-overflow-measure]')).toHaveLength(0);
    expect(frames.size).toBe(0);
    destroy(view);
  });

  it('invalidates for font readiness once without remeasuring on visibility changes', async () => {
    installIntersectionObserver();
    const resolveFonts = installFontReadyPromise();
    itemWidths = { alpha: 60, beta: 60, 'Ще 1': 32, 'Ще 2': 32 };
    availableWidth = 100;
    const renderMeasurementItem = vi.fn((value: string) => createElement('span', null, value));
    const view = render(
      createElement(MrtOverflowItems<string>, {
        items: ['alpha', 'beta'],
        renderItem: (value) => createElement('button', { 'data-item': value }, value),
        renderMeasurementItem,
        getItemKey: (value) => value,
        getItemText: (value) => value,
      }),
    );
    const cell = view.container.querySelector('[data-mrt-overflow-items]')!;
    setIntersection(cell, true);
    expect(document.body.querySelectorAll('[data-mrt-overflow-measure]')).toHaveLength(1);
    flushFrames();
    const initialMeasurementRenderCount = renderMeasurementItem.mock.calls.length;
    expect(document.body.querySelectorAll('[data-mrt-overflow-measure]')).toHaveLength(0);

    await act(async () => {
      resolveFonts();
      await Promise.resolve();
    });
    expect(document.body.querySelectorAll('[data-mrt-overflow-measure]')).toHaveLength(1);
    expect(renderMeasurementItem.mock.calls.length).toBeGreaterThan(initialMeasurementRenderCount);
    flushFrames();
    const settledMeasurementRenderCount = renderMeasurementItem.mock.calls.length;

    setIntersection(cell, false);
    setIntersection(cell, true);
    expect(document.body.querySelectorAll('[data-mrt-overflow-measure]')).toHaveLength(0);
    expect(renderMeasurementItem).toHaveBeenCalledTimes(settledMeasurementRenderCount);

    availableWidth = 300;
    triggerResize();
    expect(document.body.querySelectorAll('[data-mrt-overflow-measure]')).toHaveLength(0);
    expect(view.container.querySelectorAll('[data-item]')).toHaveLength(2);
    destroy(view);
  });

  it('defers font invalidation while offscreen and ignores font readiness after unmount', async () => {
    installIntersectionObserver();
    const resolveFonts = installFontReadyPromise();
    const view = render(
      createElement(MrtOverflowItems<string>, {
        items: ['alpha', 'beta'],
        renderItem: (value) => createElement('span', null, value),
        getItemKey: (value) => value,
        getItemText: (value) => value,
      }),
    );
    const cell = view.container.querySelector('[data-mrt-overflow-items]')!;
    setIntersection(cell, false);
    await act(async () => {
      resolveFonts();
      await Promise.resolve();
    });
    expect(document.body.querySelectorAll('[data-mrt-overflow-measure]')).toHaveLength(0);
    expect(frames.size).toBe(0);

    setIntersection(cell, true);
    expect(document.body.querySelectorAll('[data-mrt-overflow-measure]')).toHaveLength(1);
    destroy(view);
    flushFrames();
    expect(document.body.querySelectorAll('[data-mrt-overflow-measure]')).toHaveLength(0);

    const resolveUnmountedFonts = installFontReadyPromise();
    const unmounted = render(
      createElement(MrtOverflowItems<string>, {
        items: ['alpha'],
        renderItem: (value) => createElement('span', null, value),
      }),
    );
    destroy(unmounted);
    await act(async () => {
      resolveUnmountedFonts();
      await Promise.resolve();
    });
    expect(document.body.querySelectorAll('[data-mrt-overflow-measure]')).toHaveLength(0);
    expect(frames.size).toBe(0);
  });
});
