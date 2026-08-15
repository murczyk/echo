/**
 * @vitest-environment happy-dom
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { act, createElement } from 'react';
import type { ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import ts from 'typescript';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { calculateVisibleItemCount, MrtOverflowItems, MrtOverflowText } from './mrt-overflow';
import {
  assertMrtColumnPolicies,
  toMrtScalarText,
  validateMrtColumnPolicies,
} from './get-default-table-options';

type ColumnPolicy = {
  mode: 'text' | 'items' | 'wrap' | 'none';
  factory?: 'mrtTextCell' | 'mrtItemsCell';
};

function property(object: ts.ObjectLiteralExpression, name: string) {
  return object.properties.find(
    (candidate): candidate is ts.PropertyAssignment =>
      ts.isPropertyAssignment(candidate) &&
      candidate.name.getText().replaceAll("'", '').replaceAll('"', '') === name,
  );
}

function columnPolicies(path: string) {
  const source = ts.createSourceFile(
    path,
    readFileSync(path, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  const columns: Array<{ id: string; mode?: string; factory?: string; position: string }> = [];
  const visit = (node: ts.Node) => {
    if (ts.isObjectLiteralExpression(node)) {
      const id = property(node, 'id') ?? property(node, 'accessorKey');
      const cell = property(node, 'Cell');
      if (id && cell) {
        const rawId = id.initializer.getText().replaceAll("'", '').replaceAll('"', '');
        const meta = property(node, 'meta');
        const mode =
          meta && ts.isObjectLiteralExpression(meta.initializer)
            ? property(meta.initializer, 'overflowMode')
                ?.initializer.getText()
                .replaceAll("'", '')
                .replaceAll('"', '')
            : undefined;
        const factory = ts.isCallExpression(cell.initializer)
          ? cell.initializer.expression.getText()
          : undefined;
        const location = source.getLineAndCharacterOfPosition(node.getStart(source));
        columns.push({
          id: rawId,
          mode,
          factory,
          position: `${path}:${location.line + 1}:${location.character + 1}`,
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return columns;
}

function expectColumnPolicies(path: string, expected: Record<string, ColumnPolicy>) {
  const columns = columnPolicies(path);
  const failures = Object.entries(expected).flatMap(([id, policy]) => {
    const matches = columns.filter((column) => column.id === id);
    if (matches.length === 0) return [`${path}: missing ${id}`];
    return matches.flatMap((column) => {
      const failures: string[] = [];
      if (column.mode !== policy.mode)
        failures.push(
          `${column.position} ${id}: expected ${policy.mode}, got ${column.mode ?? 'missing'}`,
        );
      if (policy.factory && column.factory !== policy.factory)
        failures.push(
          `${column.position} ${id}: expected ${policy.factory}, got ${column.factory ?? 'raw Cell'}`,
        );
      return failures;
    });
  });
  expect(failures).toEqual([]);
}

function collectProductionFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) return collectProductionFiles(path);
    return /\.(ts|tsx)$/.test(path) && !/\.spec\.(ts|tsx)$/.test(path) ? [path] : [];
  });
}

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

  it('keeps the direct MRT hook import inside the shared adapter', () => {
    const root = resolve('src/ts/react');
    const files: string[] = [];
    const collect = (directory: string) => {
      for (const entry of readdirSync(directory)) {
        const path = join(directory, entry);
        if (statSync(path).isDirectory()) collect(path);
        else if (/\.(ts|tsx)$/.test(path)) files.push(path);
      }
    };
    collect(root);

    const violations = files
      .filter((path) => !path.endsWith('get-default-table-options.tsx'))
      .filter((path) => /import\s*\{[^}]*useMaterialReactTable/.test(readFileSync(path, 'utf8')));

    expect(violations).toEqual([]);
  });

  it('keeps named semantic policies on their branded factories', () => {
    expectColumnPolicies('src/ts/react/routes/admin-organisms-neo/index.tsx', {
      aors: { mode: 'items', factory: 'mrtItemsCell' },
      groups: { mode: 'items', factory: 'mrtItemsCell' },
      roles: { mode: 'items', factory: 'mrtItemsCell' },
      limitGroups: { mode: 'items', factory: 'mrtItemsCell' },
      parent: { mode: 'text', factory: 'mrtTextCell' },
      createdAt: { mode: 'text', factory: 'mrtTextCell' },
    });
    expectColumnPolicies('src/ts/react/routes/admin-users-neo/index.tsx', {
      login: { mode: 'text', factory: 'mrtTextCell' },
      id: { mode: 'text', factory: 'mrtTextCell' },
      roles: { mode: 'items', factory: 'mrtItemsCell' },
      organism: { mode: 'text', factory: 'mrtTextCell' },
      zone: { mode: 'text', factory: 'mrtTextCell' },
      createdAt: { mode: 'text', factory: 'mrtTextCell' },
      description: { mode: 'text', factory: 'mrtTextCell' },
    });
    expectColumnPolicies(
      'src/ts/react/routes/rer-networks-neo/components/NetworksTableColumns.tsx',
      {
        network: { mode: 'text', factory: 'mrtTextCell' },
        aors: { mode: 'items', factory: 'mrtItemsCell' },
        freqs: { mode: 'items', factory: 'mrtItemsCell' },
        location: { mode: 'text', factory: 'mrtTextCell' },
        lastActivity: { mode: 'text', factory: 'mrtTextCell' },
        activity: { mode: 'none' },
      },
    );
    expectColumnPolicies('src/ts/react/routes/rer-unit-details/UnitAttachmentsTable.tsx', {
      aors: { mode: 'items', factory: 'mrtItemsCell' },
      createdAt: { mode: 'text', factory: 'mrtTextCell' },
      shortDescription: { mode: 'wrap' },
      fullDescription: { mode: 'wrap' },
      fileName: { mode: 'none' },
    });
    expectColumnPolicies('src/ts/react/routes/rer-palitra-neo/components/PalitraTable.cells.tsx', {
      name: { mode: 'wrap' },
      sourceFileName: { mode: 'text', factory: 'mrtTextCell' },
      lastUploadedAtTs: { mode: 'text', factory: 'mrtTextCell' },
      author: { mode: 'text', factory: 'mrtTextCell' },
      accessSummary: { mode: 'text', factory: 'mrtTextCell' },
      colorHex: { mode: 'none' },
    });
    expectColumnPolicies('src/ts/react/routes/admin-directions-neo/index.tsx', {
      aors: { mode: 'items', factory: 'mrtItemsCell' },
      access: { mode: 'items', factory: 'mrtItemsCell' },
      admins: { mode: 'items', factory: 'mrtItemsCell' },
      group: { mode: 'text', factory: 'mrtTextCell' },
      datasource: { mode: 'text', factory: 'mrtTextCell' },
      activityDay: { mode: 'text', factory: 'mrtTextCell' },
      activityWeek: { mode: 'text', factory: 'mrtTextCell' },
      createdAt: { mode: 'text', factory: 'mrtTextCell' },
      GROUP_ACTIVITY_TIMELINE_COLUMN_ID: { mode: 'none' },
      notes: { mode: 'wrap' },
    });
    expectColumnPolicies('src/ts/react/routes/admin-messenger-neo/index.tsx', {
      messenger: { mode: 'none' },
      description: { mode: 'wrap' },
      debugInfo: { mode: 'wrap' },
      status: { mode: 'none' },
    });
  });

  it('keeps every production custom cell classified and branded', () => {
    const violations = collectProductionFiles(resolve('src/ts/react/routes')).flatMap((path) =>
      columnPolicies(path).flatMap((column) => {
        if (!column.mode) return [`${column.position} ${column.id}: missing meta.overflowMode`];
        if (column.mode === 'text' && column.factory !== 'mrtTextCell')
          return [`${column.position} ${column.id}: text bypasses mrtTextCell`];
        if (column.mode === 'items' && column.factory !== 'mrtItemsCell')
          return [`${column.position} ${column.id}: items bypasses mrtItemsCell`];
        return [];
      }),
    );
    expect(violations).toEqual([]);
  });

  it('keeps runtime enforcement ahead of MRT initialization without a raw options compatibility union', () => {
    const source = readFileSync(
      'src/ts/react/components/mui-customized/table/get-default-table-options.tsx',
      'utf8',
    );
    expect(source.indexOf('assertMrtColumnPolicies(options.columns)')).toBeGreaterThanOrEqual(0);
    expect(source).not.toContain('AppMrtTableOptions<TData> | MRT_TableOptions<TData>');
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
  let originalClientWidth: PropertyDescriptor | undefined;
  let originalScrollWidth: PropertyDescriptor | undefined;
  let originalRect: typeof HTMLElement.prototype.getBoundingClientRect;
  let originalGetComputedStyle: typeof window.getComputedStyle;

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

  beforeEach(() => {
    frames = new Map();
    nextFrame = 0;
    observers = [];
    availableWidth = 100;
    textWidth = 100;
    itemWidths = {};
    columnGap = '4px';
    originalClientWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth');
    originalScrollWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollWidth');
    originalRect = HTMLElement.prototype.getBoundingClientRect;
    originalGetComputedStyle = window.getComputedStyle.bind(window);
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
      configurable: true,
      get() {
        return availableWidth;
      },
    });
    Object.defineProperty(HTMLElement.prototype, 'scrollWidth', {
      configurable: true,
      get(this: HTMLElement) {
        return this.textContent?.includes('overflow text') ? textWidth : availableWidth;
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
  });

  afterEach(() => {
    vi.useRealTimers();
    if (originalClientWidth)
      Object.defineProperty(HTMLElement.prototype, 'clientWidth', originalClientWidth);
    if (originalScrollWidth)
      Object.defineProperty(HTMLElement.prototype, 'scrollWidth', originalScrollWidth);
    HTMLElement.prototype.getBoundingClientRect = originalRect;
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

  it('hides an oversized item, preserves interactive hidden content, closes on click-away, and cleans up', async () => {
    itemWidths = { alpha: 140, beta: 30, 'Ще 1': 32, 'Ще 2': 32 };
    availableWidth = 80;
    const onBeta = vi.fn();
    const view = render(
      createElement(MrtOverflowItems<string>, {
        items: ['alpha', 'beta'],
        renderItem: (value) =>
          createElement(
            'button',
            { 'data-item': value, onClick: value === 'beta' ? onBeta : undefined },
            value,
          ),
        getItemKey: (value) => value,
        getItemText: (value) => value,
        emptyValue: 'порожньо',
      }),
    );
    triggerResize();
    expect(view.container.querySelectorAll('[data-item]')).toHaveLength(0);
    const trigger = view.container.querySelector<HTMLButtonElement>(
      'button[aria-label="Показати ще 2 значення"]',
    );
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
});
