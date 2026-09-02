/**
 * @vitest-environment happy-dom
 */
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { InboxMessage, Tag } from '../../../../../../../Bindings';
import { NeoMuiThemeProvider } from '../../../../../mui-theme';
import { PowerSnackbarProvider } from '../../../../../components/PowerSnackbar';
import { PointBlacklistPaletteNamesCacheProvider } from '../../PointBlacklistPaletteNamesCache';
import { MessageCardContent } from '../../MessageCardContent';

const api = vi.hoisted(() => ({ resolvePalitraNames: vi.fn() }));

vi.mock('../../../../../services/api/palitra', () => ({
  resolvePalitraNames: api.resolvePalitraNames,
}));

vi.mock('react-virtuoso', () => ({
  Virtuoso: ({
    data,
    itemContent,
  }: {
    data: Array<{ id: number; name: string }>;
    itemContent: (index: number, item: { id: number; name: string }) => ReactNode;
  }) =>
    createElement(
      'div',
      { 'data-testid': 'virtualized-palitra-list' },
      data.slice(0, 10).map((item, index) => itemContent(index, item)),
    ),
}));

function createMessage(palitraIds: number[]): InboxMessage {
  return {
    messageUid: null,
    text: 'Альфа',
    media: [],
    images: [],
    imageRecognized: [],
    date: null,
    time: null,
    freq: null,
    coords: null,
    callsigns: [],
    callsignsAlg2: [],
    checked: false,
    important: false,
    bookmarked: false,
    timestamp: null,
    groupMasterKey: null,
    sender: null,
    extendedForm: null,
    messageComments: [],
    post: null,
    inboxTags: [{ id: 1, tagId: 1, confidence: 1, login: null, model: null, organismId: null }],
    tags: [1],
    pointTokens: [{ etalon: 'Альфа', text: 'Альфа', palitraIds }],
    textMarked: [{ CNPointC: { text: 'Альфа', begin: 0, end: 5, etalon: ' Альфа ', palitraIds } }],
  } as InboxMessage;
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function renderMessage(
  palitraIds: number[],
  onAddPointToBlacklist: (request: {
    messageId: number;
    etalon: string;
    palitraId: number;
  }) => Promise<void>,
) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <NeoMuiThemeProvider>
        <PowerSnackbarProvider>
          <PointBlacklistPaletteNamesCacheProvider>
            <MessageCardContent
              messageId={42}
              msg={createMessage(palitraIds)}
              tagsMap={{ 1: { isPalitra: true } as Tag }}
              onAddPointHighlightBlacklist={onAddPointToBlacklist}
            />
          </PointBlacklistPaletteNamesCacheProvider>
        </PowerSnackbarProvider>
      </NeoMuiThemeProvider>,
    );
  });
  return { container, root };
}

function renderMessages(
  entries: Array<{ messageId: number; palitraIds: number[] }>,
  onAddPointToBlacklist: (request: {
    messageId: number;
    etalon: string;
    palitraId: number;
  }) => Promise<void>,
) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <NeoMuiThemeProvider>
        <PowerSnackbarProvider>
          <PointBlacklistPaletteNamesCacheProvider>
            {entries.map(({ messageId, palitraIds }) => (
              <MessageCardContent
                key={messageId}
                messageId={messageId}
                msg={createMessage(palitraIds)}
                tagsMap={{ 1: { isPalitra: true } as Tag }}
                onAddPointHighlightBlacklist={onAddPointToBlacklist}
              />
            ))}
          </PointBlacklistPaletteNamesCacheProvider>
        </PowerSnackbarProvider>
      </NeoMuiThemeProvider>,
    );
  });
  return { container, root };
}

async function openPointMenu(container: HTMLElement) {
  await act(async () => {
    container
      .querySelector('.content-token--point')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    await Promise.resolve();
  });
}

async function openPaletteChooser(container: HTMLElement, pointIndex = 0) {
  await act(async () => {
    container
      .querySelectorAll('.content-token--point')
      .item(pointIndex)
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    await Promise.resolve();
  });
  const action = Array.from(document.body.querySelectorAll('[role="menuitem"]')).find((item) =>
    item.textContent?.includes('Додати до чорного списку'),
  ) as HTMLElement;
  await act(async () => {
    action.click();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

// @test-scope safeguard: prevents point-blacklist mutations from targeting the wrong source, blocking independent choices, or hiding recoverable failures
describe('MessageCardContent point blacklist actions', () => {
  let activeRoot: Root | null = null;
  let activeContainer: HTMLElement | null = null;

  beforeEach(() => {
    api.resolvePalitraNames.mockResolvedValue([
      { id: 7, name: 'Палітра сім' },
      { id: 12, name: 'Палітра дванадцять' },
    ]);
  });

  afterEach(() => {
    if (activeRoot) act(() => activeRoot?.unmount());
    activeRoot = null;
    activeContainer?.remove();
    activeContainer = null;
    document.body.innerHTML = '';
    vi.clearAllMocks();
  });

  it('opens the multi-source dialog, shows names, and submits one selected source', async () => {
    const onAdd = vi.fn(() => Promise.resolve());
    ({ root: activeRoot, container: activeContainer } = renderMessage([7, 12, 7], onAdd));
    await openPointMenu(activeContainer);
    const multiAction = Array.from(document.body.querySelectorAll('[role="menuitem"]')).find(
      (item) => item.textContent?.includes('Додати до чорного списку'),
    ) as HTMLElement;
    await act(async () => {
      multiAction.click();
    });
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });

    expect(document.body.textContent).toContain('Палітра сім');
    expect(document.body.textContent).toContain('Палітра дванадцять');
    const paletteOption = Array.from(document.body.querySelectorAll('[role="button"]')).find(
      (item) => item.textContent?.includes('Палітра сім'),
    ) as HTMLElement;
    await act(async () => {
      paletteOption.click();
    });
    await act(async () => {
      await Promise.resolve();
    });
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 350));
    });
    expect(onAdd).toHaveBeenCalledOnce();
    expect(onAdd).toHaveBeenCalledWith({ messageId: 42, etalon: 'Альфа', palitraId: 7 });
    expect(document.body.textContent).toContain('Точку додано до чорного списку.');
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
  });

  it('shows a recoverable resolver error without fallback choices', async () => {
    api.resolvePalitraNames.mockRejectedValueOnce(new Error('lookup failed'));
    const onAdd = vi.fn(() => Promise.resolve());
    ({ root: activeRoot, container: activeContainer } = renderMessage([17, 22], onAdd));
    await openPointMenu(activeContainer);
    Array.from(document.body.querySelectorAll('[role="menuitem"]'))
      .find((item) => item.textContent?.includes('Додати до чорного списку'))
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
    expect(document.body.textContent).toContain('lookup failed');
    expect(document.body.textContent).toContain('Повторити');
    expect(onAdd).not.toHaveBeenCalled();
  });

  it('keeps direct success feedback visible after the route callback resolves', async () => {
    const onAdd = vi.fn(() => Promise.resolve());
    ({ root: activeRoot, container: activeContainer } = renderMessage([7], onAdd));
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    await openPointMenu(activeContainer);
    Array.from(document.body.querySelectorAll('[role="menuitem"]'))
      .find((item) => item.textContent?.includes('Додати до чорного списку'))
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    await act(async () => {
      await Promise.resolve();
    });
    expect(onAdd).toHaveBeenCalledWith({ messageId: 42, etalon: 'Альфа', palitraId: 7 });
    expect(document.body.textContent).toContain('Точку додано до чорного списку.');
  });

  it('keeps the direct action available and reports rejection after pending clears', async () => {
    const request = deferred<void>();
    const onAdd = vi.fn(() => request.promise);
    ({ root: activeRoot, container: activeContainer } = renderMessage([7], onAdd));
    await openPointMenu(activeContainer);
    const action = Array.from(document.body.querySelectorAll('[role="menuitem"]')).find((item) =>
      item.textContent?.includes('Додати до чорного списку'),
    ) as HTMLButtonElement;
    await act(async () => {
      action.click();
    });
    expect(onAdd).toHaveBeenCalledOnce();
    request.reject(new Error('POST failed'));
    await act(async () => {
      await Promise.resolve();
    });
    expect(document.body.textContent).toContain(
      'Не вдалося додати точку до чорного списку: POST failed',
    );
    await openPointMenu(activeContainer);
    expect(
      Array.from(document.body.querySelectorAll('[role="menuitem"]')).some((item) =>
        item.textContent?.includes('Додати до чорного списку'),
      ),
    ).toBe(true);
  });

  it('keeps other palette choices enabled while one source is pending', async () => {
    const first = deferred<void>();
    const second = deferred<void>();
    const onAdd = vi
      .fn<(request: { messageId: number; etalon: string; palitraId: number }) => Promise<void>>()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    ({ root: activeRoot, container: activeContainer } = renderMessage([7, 12], onAdd));
    await openPointMenu(activeContainer);
    const multiAction = Array.from(document.body.querySelectorAll('[role="menuitem"]')).find(
      (item) => item.textContent?.includes('Додати до чорного списку'),
    ) as HTMLElement;
    await act(async () => {
      multiAction.click();
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
    const option = (label: string) =>
      Array.from(document.body.querySelectorAll('[role="button"]')).find((item) =>
        item.textContent?.includes(label),
      ) as HTMLButtonElement;
    await act(async () => {
      option('Палітра сім').click();
    });
    expect(option('Палітра сім').getAttribute('aria-disabled')).toBe('true');
    expect(option('Палітра дванадцять').getAttribute('aria-disabled')).not.toBe('true');
    await act(async () => {
      option('Палітра дванадцять').click();
    });
    expect(onAdd).toHaveBeenCalledTimes(2);
    first.resolve();
    second.resolve();
    await act(async () => {
      await Promise.all([first.promise, second.promise]);
    });
  });

  it('keeps the dialog open and recovers both choices after a failed source mutation', async () => {
    const request = deferred<void>();
    const onAdd = vi.fn(() => request.promise);
    ({ root: activeRoot, container: activeContainer } = renderMessage([7, 12], onAdd));
    await openPointMenu(activeContainer);
    const multiAction = Array.from(document.body.querySelectorAll('[role="menuitem"]')).find(
      (item) => item.textContent?.includes('Додати до чорного списку'),
    ) as HTMLElement;
    await act(async () => {
      multiAction.click();
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
    const option = (label: string) =>
      Array.from(document.body.querySelectorAll('[role="button"]')).find((item) =>
        item.textContent?.includes(label),
      ) as HTMLButtonElement;
    await act(async () => {
      option('Палітра сім').click();
    });
    expect(onAdd).toHaveBeenCalledWith({ messageId: 42, etalon: 'Альфа', palitraId: 7 });
    request.reject(new Error('mutation failed'));
    await act(async () => {
      await Promise.resolve();
    });
    expect(document.body.querySelector('[role="dialog"]')).not.toBeNull();
    expect(document.body.textContent).toContain(
      'Не вдалося додати точку до чорного списку: mutation failed',
    );
    expect(option('Палітра сім').getAttribute('aria-disabled')).not.toBe('true');
    expect(option('Палітра дванадцять').getAttribute('aria-disabled')).not.toBe('true');
  });

  it('cancels the palette-choice dialog without submitting a mutation', async () => {
    const onAdd = vi.fn(() => Promise.resolve());
    ({ root: activeRoot, container: activeContainer } = renderMessage([7, 12], onAdd));
    await openPointMenu(activeContainer);
    const multiAction = Array.from(document.body.querySelectorAll('[role="menuitem"]')).find(
      (item) => item.textContent?.includes('Додати до чорного списку'),
    ) as HTMLElement;
    await act(async () => {
      multiAction.click();
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
    const closeButton = Array.from(document.body.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Закрити'),
    ) as HTMLButtonElement;
    await act(async () => {
      closeButton.click();
    });
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 350));
    });
    expect(onAdd).not.toHaveBeenCalled();
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
  });

  it('virtualizes a large palette set and filters its browseable choices', async () => {
    const names = Array.from({ length: 51 }, (_value, index) => ({
      id: index + 1,
      name: `Палітра ${index + 1}`,
    }));
    api.resolvePalitraNames.mockResolvedValueOnce(names);
    const onAdd = vi.fn(() => Promise.resolve());
    ({ root: activeRoot, container: activeContainer } = renderMessage(
      names.map((entry) => entry.id),
      onAdd,
    ));

    await openPaletteChooser(activeContainer);

    expect(document.body.textContent).toContain('Точка знайдена у 51 палітрах');
    expect(document.body.textContent).toContain('Палітра 1');
    expect(document.body.querySelectorAll('[role="button"]').length).toBeLessThan(51);

    const search = document.body.querySelector('input') as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
        search,
        'Палітра 51',
      );
      search.dispatchEvent(new Event('input', { bubbles: true }));
    });

    expect(document.body.textContent).toContain('Палітра 51');
    expect(document.body.textContent).not.toContain('Палітра 50');
  });

  it('shares resolver names within one provider and clears them after provider remount', async () => {
    const onAdd = vi.fn(() => Promise.resolve());
    ({ root: activeRoot, container: activeContainer } = renderMessages(
      [
        { messageId: 42, palitraIds: [7, 12] },
        { messageId: 43, palitraIds: [7, 12] },
      ],
      onAdd,
    ));

    await openPaletteChooser(activeContainer, 0);
    await act(async () => {
      (
        Array.from(document.body.querySelectorAll('button')).find((button) =>
          button.textContent?.includes('Закрити'),
        ) as HTMLButtonElement
      ).click();
    });
    await openPaletteChooser(activeContainer, 1);
    expect(api.resolvePalitraNames).toHaveBeenCalledTimes(1);

    act(() => activeRoot?.unmount());
    activeContainer?.remove();
    activeRoot = null;
    activeContainer = null;
    ({ root: activeRoot, container: activeContainer } = renderMessage([7, 12], onAdd));
    await openPaletteChooser(activeContainer);
    expect(api.resolvePalitraNames).toHaveBeenCalledTimes(2);
  });
});
