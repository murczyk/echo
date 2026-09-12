/**
 * @vitest-environment happy-dom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { SignalGroupEntry } from '../../../../../Bindings';
import { minimalInboxMessage } from '../../rer-duty-neo/inbox-message-mocks';
import { MessageReferenceLink } from './MessageReferenceLink';

const mocks = vi.hoisted(() => ({
  fetchInboxItemContext: vi.fn(),
  notify: vi.fn(),
}));

vi.mock('../../../services/api/inbox-messages', () => ({
  fetchInboxItemContext: mocks.fetchInboxItemContext,
}));

vi.mock('../../../components/PowerSnackbar', () => ({
  useOptionalPowerSnackbar: () => ({ notify: mocks.notify }),
}));

const groupInfos = {
  'linked-group': {
    masterKey: 'linked-group',
    name: 'Пов’язана група',
  } as SignalGroupEntry,
};

describe('MessageReferenceLink', () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;

  afterEach(() => {
    if (root) act(() => root?.unmount());
    root = null;
    container?.remove();
    container = null;
    document.body.innerHTML = '';
    mocks.fetchInboxItemContext.mockReset();
    mocks.notify.mockReset();
    vi.restoreAllMocks();
  });

  async function renderLink() {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(
        <MessageReferenceLink
          href="https://echo.test/rer-analysis-neo?m=linked-message"
          messageIdentifier="linked-message"
          groupInfos={groupInfos}
        />,
      );
    });
    return container.querySelector('a');
  }

  async function hover(link: Element | null) {
    await act(async () => {
      link?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    });
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 750));
    });
  }

  async function click(link: Element | null) {
    const event = new MouseEvent('click', { bubbles: true, cancelable: true });
    await act(async () => {
      link?.dispatchEvent(event);
      await Promise.resolve();
      await Promise.resolve();
    });
    return event;
  }

  it('shows the linked message in the intelligence-report preview', async () => {
    mocks.fetchInboxItemContext.mockResolvedValue({
      message: [
        77,
        minimalInboxMessage({
          text: 'Текст пов’язаного повідомлення',
          media: [
            {
              id: 'attachment-1',
              contentType: 'image/png',
              fileName: 'image.png',
              sizeBytes: 100,
              href: '/image.png',
              transcription: null,
              ocr: null,
              summary: null,
            },
          ],
          timestamp: null,
          date: '2026-09-08',
          time: '14:30',
          groupMasterKey: 'linked-group',
        }),
      ],
      groupMasterKeys: ['linked-group'],
      sigintInboxItemIds: [77],
      sinceTs: null,
      tillTs: null,
    });

    const link = await renderLink();
    expect(link?.textContent).toBe('повідомлення');
    expect(link?.getAttribute('target')).toBe('_blank');
    expect(link?.getAttribute('rel')).toBe('noopener noreferrer');

    await hover(link);

    const preview = document.querySelector('[role="tooltip"]');
    expect(preview?.textContent).toContain('Повідомлення');
    expect(preview?.textContent).toContain('Текст пов’язаного повідомлення');
    expect(preview?.textContent).toContain('Пов’язана група');
    expect(preview?.textContent).toContain('2026-09-08 14:30');
    expect(preview?.textContent).toContain('Вкладення1');
  });

  it('shows the message reference with medium emphasis and no underline', async () => {
    const link = await renderLink();

    expect(link?.style.fontWeight).toBe('600');
    expect(link?.style.textDecoration).toBe('none');
  });

  it('keeps the link usable and shows a privacy-safe unavailable preview', async () => {
    mocks.fetchInboxItemContext.mockResolvedValue({
      message: null,
      groupMasterKeys: [],
      sigintInboxItemIds: [],
      sinceTs: null,
      tillTs: null,
    });

    const link = await renderLink();
    await hover(link);

    expect(document.querySelector('[role="tooltip"]')?.textContent).toContain('Прев’ю недоступне');
    expect(link?.getAttribute('href')).toBe('https://echo.test/rer-analysis-neo?m=linked-message');
  });

  it('keeps an unavailable message reference on the current page and shows a warning', async () => {
    mocks.fetchInboxItemContext.mockResolvedValue({
      message: null,
      groupMasterKeys: [],
      sigintInboxItemIds: [],
      sinceTs: null,
      tillTs: null,
    });
    const openWindow = vi.spyOn(window, 'open');

    const clickEvent = await click(await renderLink());

    expect(clickEvent.defaultPrevented).toBe(true);
    expect(openWindow).not.toHaveBeenCalled();
    expect(mocks.notify).toHaveBeenCalledWith({
      severity: 'warning',
      message: 'Повідомлення видалено або у вас немає до нього доступу.',
    });
  });

  it('opens an available message reference after checking it', async () => {
    mocks.fetchInboxItemContext.mockResolvedValue({
      message: [
        77,
        minimalInboxMessage({
          text: 'Текст пов’язаного повідомлення',
          groupMasterKey: 'linked-group',
        }),
      ],
      groupMasterKeys: ['linked-group'],
      sigintInboxItemIds: [77],
      sinceTs: null,
      tillTs: null,
    });
    const openedWindow = { opener: window } as Window;
    const openWindow = vi.spyOn(window, 'open').mockReturnValue(openedWindow);

    const clickEvent = await click(await renderLink());

    expect(clickEvent.defaultPrevented).toBe(true);
    expect(openWindow).toHaveBeenCalledWith(
      'https://echo.test/rer-analysis-neo?m=linked-message',
      '_blank',
    );
    expect(openedWindow.opener).toBeNull();
  });

  it('warns when the browser blocks an available message reference', async () => {
    mocks.fetchInboxItemContext.mockResolvedValue({
      message: [
        77,
        minimalInboxMessage({
          text: 'Текст пов’язаного повідомлення',
          groupMasterKey: 'linked-group',
        }),
      ],
      groupMasterKeys: ['linked-group'],
      sigintInboxItemIds: [77],
      sinceTs: null,
      tillTs: null,
    });
    vi.spyOn(window, 'open').mockReturnValue(null);

    await click(await renderLink());

    expect(mocks.notify).toHaveBeenCalledWith({
      severity: 'warning',
      message:
        'Не вдалося відкрити повідомлення у новій вкладці. Перевірте налаштування браузера та спробуйте ще раз.',
    });
  });

  it('starts checking availability when the pointer reaches the reference', async () => {
    mocks.fetchInboxItemContext.mockResolvedValue({
      message: null,
      groupMasterKeys: [],
      sigintInboxItemIds: [],
      sinceTs: null,
      tillTs: null,
    });
    const link = await renderLink();

    await act(async () => {
      link?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      await Promise.resolve();
    });

    expect(mocks.fetchInboxItemContext).toHaveBeenCalledTimes(1);
  });

  it('reuses the unavailable preview result when the reference is clicked', async () => {
    mocks.fetchInboxItemContext.mockResolvedValue({
      message: null,
      groupMasterKeys: [],
      sigintInboxItemIds: [],
      sinceTs: null,
      tillTs: null,
    });
    const link = await renderLink();

    await hover(link);
    await click(link);

    expect(mocks.fetchInboxItemContext).toHaveBeenCalledTimes(1);
    expect(mocks.notify).toHaveBeenCalledWith({
      severity: 'warning',
      message: 'Повідомлення видалено або у вас немає до нього доступу.',
    });
  });

  it('stays on the current page when message availability cannot be checked', async () => {
    mocks.fetchInboxItemContext.mockRejectedValue(new Error('Помилка завантаження'));
    const openWindow = vi.spyOn(window, 'open');

    const clickEvent = await click(await renderLink());

    expect(clickEvent.defaultPrevented).toBe(true);
    expect(openWindow).not.toHaveBeenCalled();
    expect(mocks.notify).toHaveBeenCalledWith({
      severity: 'error',
      message: 'Не вдалося перевірити доступність повідомлення. Спробуйте ще раз.',
    });
  });

  it('shows an error toast and an unavailable preview when loading fails', async () => {
    mocks.fetchInboxItemContext.mockRejectedValue(new Error('Помилка завантаження'));

    const link = await renderLink();
    await hover(link);

    expect(mocks.fetchInboxItemContext).toHaveBeenCalledTimes(1);
    expect(document.querySelector('[role="tooltip"]')?.textContent).toContain('Прев’ю недоступне');
    expect(mocks.notify).toHaveBeenCalledWith({
      severity: 'error',
      message: 'Помилка завантаження',
    });
  });
});
