/**
 * @vitest-environment happy-dom
 */
import { act, createElement, StrictMode } from 'react';
import type { ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { calculateVisibleItemCount, MrtOverflowItems, MrtOverflowText } from './mrt-overflow';
import {
  assertMrtColumnPolicies,
  mrtCustomCell,
  toMrtScalarText,
  validateMrtColumnPolicies,
} from './get-default-table-options';

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

describe('MRT rendered overflow components', () => {
  let availableWidth = 100;
  let textWidth = 100;
  let itemWidths: Record<string, number> = {};
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
    frames = new Map();
    nextFrame = 0;
    observers = [];
    intersectionObservers = [];
    availableWidth = 100;
    textWidth = 100;
    itemWidths = {};
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
    expect(view.container.querySelector('[aria-hidden][inert]')).toBeNull();
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    destroy(view);
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
    triggerResize();
    vi.useFakeTimers();
    expect(view.container.querySelectorAll('[data-item]')).toHaveLength(0);
    expect(view.container.textContent).toContain('alpha');
    expect(getItemText).toHaveBeenCalledWith('beta', 1);
    expect(getItemKey).toHaveBeenCalledWith('beta', 1);
    const trigger = view.container.querySelector<HTMLButtonElement>(
      'button[aria-label="Показати ще 1 значення"]',
    );
    expect(trigger?.textContent).toBe('Ще 1');
    const compactText = view.container.querySelector('span');
    expect(getComputedStyle(compactText!).textOverflow).toBe('ellipsis');
    act(() => compactText?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })));
    await act(async () => vi.runAllTimers());
    expect(document.body.querySelector('[role="tooltip"]')?.textContent).toBe('alpha-0');
    act(() =>
      compactText?.dispatchEvent(
        new MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body }),
      ),
    );
    await act(async () => vi.runAllTimers());
    act(() => compactText?.focus());
    await act(async () => vi.runAllTimers());
    expect(document.body.querySelector('[role="tooltip"]')?.textContent).toBe('alpha-0');
    act(() => compactText?.blur());
    await act(async () => vi.runAllTimers());
    vi.useRealTimers();
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
    expect(view.container.querySelector('span')?.textContent).not.toBe('alpha');
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

  it('uses the compact first-item text without a bare disclosure for a zero-fit single item', () => {
    itemWidths = { alpha: 140, 'Ще 1': 32 };
    availableWidth = 80;
    const view = render(
      createElement(MrtOverflowItems<string>, {
        items: ['alpha'],
        renderItem: (value) => createElement('button', { 'data-item': value }, value),
        getItemText: (value) => value,
      }),
    );
    triggerResize();
    expect(view.container.querySelector('[data-item]')).toBeNull();
    expect(view.container.textContent).toContain('alpha');
    expect(view.container.querySelector('button[aria-label^="Показати ще"]')).toBeNull();
    expect(view.container.querySelector('[data-mrt-overflow-fade]')).toBeNull();
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
          }),
        ),
      );
    const view = render(createElement(StrictMode, null, renderCells()));

    expect(document.body.querySelectorAll('[data-mrt-overflow-measure]')).toHaveLength(1);
    expect(document.body.querySelectorAll('[data-mrt-overflow-trigger-measure]')).toHaveLength(3);

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
    flushFrames();
    expect(document.body.querySelectorAll('[data-mrt-overflow-measure]')).toHaveLength(1);
    expect(document.body.querySelector('[data-mrt-overflow-measure]')?.textContent).toContain(
      'promoted',
    );
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
