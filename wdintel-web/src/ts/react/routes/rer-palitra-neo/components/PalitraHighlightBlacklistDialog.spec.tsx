/**
 * @vitest-environment happy-dom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { PalitraHighlightBlacklistEntry } from '../../../../../Bindings';
import { NeoMuiThemeProvider } from '../../../mui-theme';
import {
  PalitraHighlightBlacklistDialog,
  PALITRA_HIGHLIGHT_BLACKLIST_TABLE_HEAD_CELL_PROPS,
} from './PalitraHighlightBlacklistDialog';

const entry: PalitraHighlightBlacklistEntry = {
  id: 9,
  palitraId: 7,
  label: 'Стара точка',
  createdByLoginId: 'login-id',
  createdByLogin: 'оператор',
};

const data = {
  palitra: {} as never,
  geometries: [
    {
      id: 1,
      colorHex: '#fff',
      sourceFileName: null,
      lastUploadedAtTs: null,
      geometry: null,
      points: [
        { label: 'Альфа', coords: {} as never, color: null },
        { label: 'Бета', coords: {} as never, color: null },
      ],
    },
  ],
};

function renderDialog(
  overrides: Partial<React.ComponentProps<typeof PalitraHighlightBlacklistDialog>> = {},
) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const onToggle = vi.fn();
  act(() => {
    root.render(
      <NeoMuiThemeProvider>
        <PalitraHighlightBlacklistDialog
          palitra={{ id: 7, name: 'Палітра сім' } as never}
          data={data}
          entries={[entry]}
          loading={false}
          error={null}
          mutationError={null}
          mutationBlocked={false}
          pendingEntryIds={new Set()}
          pendingLabels={new Set()}
          onRetry={vi.fn()}
          onToggle={onToggle}
          onClose={vi.fn()}
          {...overrides}
        />
      </NeoMuiThemeProvider>,
    );
  });
  return { container, root, onToggle };
}

function textExists(text: string) {
  return document.body.textContent?.includes(text) ?? false;
}

function setSearch(value: string) {
  const input = document.querySelector('input[placeholder="Пошук"]') as HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

async function settle() {
  await act(async () => {
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

describe('PalitraHighlightBlacklistDialog', () => {
  let mounted: { root: Root; container: HTMLElement } | null = null;

  afterEach(() => {
    if (mounted) act(() => mounted?.root.unmount());
    mounted?.container.remove();
    mounted = null;
    document.body.innerHTML = '';
  });

  it('renders current and stale rows with author and dash values', async () => {
    const view = renderDialog();
    mounted = view;
    await settle();

    expect(textExists('Альфа')).toBe(true);
    expect(textExists('Бета')).toBe(true);
    expect(textExists('Стара точка')).toBe(true);
    expect(textExists('оператор')).toBe(true);
    expect(document.body.textContent?.match(/—/g)?.length).toBeGreaterThan(0);
  });

  it('exposes resize handles for both data columns only', async () => {
    const view = renderDialog();
    mounted = view;
    await settle();

    const resizeHeaders = Array.from(
      document.querySelectorAll('.Mui-TableHeadCell-ResizeHandle-Wrapper'),
    ).map((handle) => handle.closest('th')?.textContent?.trim());
    expect(resizeHeaders).toEqual(['Назва', 'Додано']);
    expect(
      PALITRA_HIGHLIGHT_BLACKLIST_TABLE_HEAD_CELL_PROPS.sx[
        '& .Mui-TableHeadCell-ResizeHandle-Wrapper'
      ],
    ).toEqual({ mr: '-8px' });
    for (const handle of document.querySelectorAll('.Mui-TableHeadCell-ResizeHandle-Wrapper')) {
      const header = handle.closest('th');
      expect(header).not.toBeNull();
      expect(handle.getBoundingClientRect().right).toBeLessThanOrEqual(
        header!.getBoundingClientRect().right,
      );
    }
  });

  it('filters by label, restores rows, and clears through Active Filters', async () => {
    const view = renderDialog();
    mounted = view;
    await settle();

    await act(async () => setSearch('Бета'));
    expect(textExists('Бета')).toBe(true);
    expect(textExists('Альфа')).toBe(false);
    expect(textExists('Стара точка')).toBe(false);

    await act(async () => {
      document
        .querySelector('#active-filters-button')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(document.querySelector('[role="menu"]')?.textContent).toContain('Бета');
    const clearAll = Array.from(document.querySelectorAll('button')).find(
      (button) => button.textContent === 'Очистити все',
    );
    expect(clearAll).toBeTruthy();
    await act(async () => clearAll?.click());
    expect(textExists('Альфа')).toBe(true);
    expect(textExists('Стара точка')).toBe(true);
  });

  it('invokes add and remove actions with observable row labels', async () => {
    const view = renderDialog();
    mounted = view;
    await settle();

    const add = document.querySelector(
      'button[aria-label="Додати до чорного списку"]',
    ) as HTMLButtonElement;
    const remove = document.querySelector(
      'button[aria-label="Прибрати з чорного списку"]',
    ) as HTMLButtonElement;
    act(() => add.click());
    act(() => remove.click());

    expect(view.onToggle).toHaveBeenNthCalledWith(1, 'Альфа', null);
    expect(view.onToggle).toHaveBeenNthCalledWith(2, 'Стара точка', entry);
  });

  it('disables pending and blocked row actions', async () => {
    const pending = renderDialog({ pendingEntryIds: new Set([9]) });
    mounted = pending;
    await settle();
    expect(
      document.querySelector('button[aria-label="Прибрати з чорного списку…"]'),
    ).toHaveProperty('disabled', true);
    (
      document.querySelector('button[aria-label="Прибрати з чорного списку…"]') as HTMLButtonElement
    ).click();
    expect(pending.onToggle).not.toHaveBeenCalled();
    mounted.root.unmount();
    mounted.container.remove();
    mounted = null;

    const blocked = renderDialog({ mutationBlocked: true });
    mounted = blocked;
    await settle();
    expect(
      Array.from(document.querySelectorAll('button[aria-label*="чорного списку"]')).every(
        (button) => (button as HTMLButtonElement).disabled,
      ),
    ).toBe(true);
  });

  it('keeps loading, retry, and mutation errors visible', async () => {
    const onRetry = vi.fn();
    const view = renderDialog({ loading: true, onRetry });
    mounted = view;
    await settle();
    expect(document.querySelector('[role="progressbar"]')).not.toBeNull();

    act(() => view.root.unmount());
    view.container.remove();
    mounted = null;
    const retryView = renderDialog({ error: 'не вдалося', onRetry });
    mounted = retryView;
    await settle();
    expect(textExists('не вдалося')).toBe(true);
    const retry = Array.from(document.querySelectorAll('button')).find(
      (button) => button.textContent === 'Повторити',
    );
    act(() => retry?.click());
    expect(onRetry).toHaveBeenCalledOnce();
  });
});
