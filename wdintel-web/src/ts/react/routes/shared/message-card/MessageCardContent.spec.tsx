/**
 * @vitest-environment happy-dom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { InboxMessage, Tag } from '../../../../../Bindings';
import { NeoMuiThemeProvider } from '../../../mui-theme';
import { PowerSnackbarProvider } from '../../../components/PowerSnackbar';
import { MessageCardContent } from './MessageCardContent';

const api = vi.hoisted(() => ({ listPalitras: vi.fn() }));

vi.mock('../../../services/api/palitra', () => ({
  listPalitras: api.listPalitras,
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
          <MessageCardContent
            messageId={42}
            msg={createMessage(palitraIds)}
            tagsMap={{ 1: { isPalitra: true } as Tag }}
            onAddPointHighlightBlacklist={onAddPointToBlacklist}
          />
        </PowerSnackbarProvider>
      </NeoMuiThemeProvider>,
    );
  });
  return { container, root };
}

async function openPointMenu(container: HTMLElement) {
  await act(async () => {
    container
      .querySelector('button[aria-label="Показати на мапі"]')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    await Promise.resolve();
  });
}

describe('MessageCardContent point blacklist actions', () => {
  let activeRoot: Root | null = null;
  let activeContainer: HTMLElement | null = null;

  beforeEach(() => {
    api.listPalitras.mockResolvedValue([
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
      (item) => item.textContent?.includes('Додати до чорного списку…'),
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

  it('keeps fallback choices active when palette lookup fails and retries', async () => {
    api.listPalitras.mockRejectedValueOnce(new Error('lookup failed'));
    const onAdd = vi.fn(() => Promise.resolve());
    ({ root: activeRoot, container: activeContainer } = renderMessage([7, 12], onAdd));
    await openPointMenu(activeContainer);
    Array.from(document.body.querySelectorAll('[role="menuitem"]'))
      .find((item) => item.textContent?.includes('Додати до чорного списку…'))
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
    expect(document.body.textContent).toContain('Палітра #7');
    expect(document.body.textContent).toContain('lookup failed');
    expect(document.body.textContent).toContain('Повторити');
    const fallbackOption = Array.from(document.body.querySelectorAll('[role="button"]')).find(
      (item) => item.textContent?.includes('Палітра #7'),
    ) as HTMLButtonElement;
    await act(async () => {
      fallbackOption.click();
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(onAdd).toHaveBeenCalledWith({ messageId: 42, etalon: 'Альфа', palitraId: 7 });
  });

  it('keeps direct success feedback visible after the route callback resolves', async () => {
    const onAdd = vi.fn(() => Promise.resolve());
    ({ root: activeRoot, container: activeContainer } = renderMessage([7], onAdd));
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
      (item) => item.textContent?.includes('Додати до чорного списку…'),
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
      (item) => item.textContent?.includes('Додати до чорного списку…'),
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
      (item) => item.textContent?.includes('Додати до чорного списку…'),
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
});
