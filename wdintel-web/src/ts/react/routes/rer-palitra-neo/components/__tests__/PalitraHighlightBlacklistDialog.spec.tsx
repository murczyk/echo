/** @vitest-environment happy-dom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Palitra, PalitraHighlightBlacklistEntry } from '../../../../../../Bindings';
import { NeoMuiThemeProvider } from '../../../../mui-theme';
import { PalitraHighlightBlacklistDialog } from '.././PalitraHighlightBlacklistDialog';

const entry: PalitraHighlightBlacklistEntry = {
  id: 9,
  palitraId: 7,
  label: 'Стара точка',
  createdByLoginId: 'id',
  createdByLogin: 'оператор',
};
function renderDialog(
  overrides: Partial<React.ComponentProps<typeof PalitraHighlightBlacklistDialog>> = {},
) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const onDelete = vi.fn();
  act(() =>
    root.render(
      <NeoMuiThemeProvider>
        <PalitraHighlightBlacklistDialog
          palitra={{ id: 7, name: 'Палітра сім', highlightBlacklistCount: 1 } as Palitra}
          entries={[entry]}
          loading={false}
          error={null}
          mutationError={null}
          mutationBlocked={false}
          pendingEntryIds={new Set()}
          onRetry={vi.fn()}
          onDelete={onDelete}
          onClose={vi.fn()}
          {...overrides}
        />
      </NeoMuiThemeProvider>,
    ),
  );
  return { root, container, onDelete };
}
async function settle() {
  await act(async () => await new Promise((resolve) => setTimeout(resolve, 0)));
}
function has(text: string) {
  return document.body.textContent?.includes(text) ?? false;
}
describe('PalitraHighlightBlacklistDialog', () => {
  let mounted: { root: Root; container: HTMLElement } | null = null;
  afterEach(() => {
    if (mounted) act(() => mounted?.root.unmount());
    mounted?.container.remove();
    mounted = null;
    document.body.innerHTML = '';
  });

  it('shows only blacklist entries and author', async () => {
    mounted = renderDialog();
    await settle();
    expect(has('Стара точка')).toBe(true);
    expect(has('оператор')).toBe(true);
    expect(document.querySelector('[aria-label="Видалити"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="DeleteIcon"]')).not.toBeNull();
    expect(document.querySelector('button[aria-label="Видалити"]')?.className).toContain(
      'MuiIconButton',
    );
  });

  it('renders headers in utility-column then data-column order', async () => {
    mounted = renderDialog();
    await settle();
    const headers = Array.from(document.querySelectorAll('thead th')).map((header) =>
      header.textContent?.trim(),
    );
    expect(headers).toEqual(['№', 'Дії', 'Назва', 'Додано']);
  });

  it('deletes the selected entry and protects pending requests', async () => {
    mounted = renderDialog({ pendingEntryIds: new Set([9]) });
    await settle();
    const action = document.querySelector('button[aria-label="Видалити"]') as HTMLButtonElement;
    expect(action.disabled).toBe(true);

    mounted.root.unmount();
    mounted.container.remove();
    mounted = renderDialog();
    await settle();
    const freshAction = document.querySelector(
      'button[aria-label="Видалити"]',
    ) as HTMLButtonElement;
    act(() => freshAction.click());
    expect(mounted.onDelete).toHaveBeenCalledWith(entry);
  });

  it('keeps loading, empty, and retry error states available', async () => {
    mounted = renderDialog({ loading: true });
    await settle();
    expect(document.querySelector('[role="progressbar"]')).not.toBeNull();
    mounted.root.unmount();
    mounted.container.remove();
    mounted = renderDialog({ entries: [], error: null });
    await settle();
    expect(has('У чорному списку немає точок.')).toBe(true);
    mounted.root.unmount();
    mounted.container.remove();
    const onRetry = vi.fn();
    mounted = renderDialog({ error: 'Помилка', onRetry });
    await settle();
    expect(has('Помилка')).toBe(true);
    document.querySelector('button')?.click();
  });
});
