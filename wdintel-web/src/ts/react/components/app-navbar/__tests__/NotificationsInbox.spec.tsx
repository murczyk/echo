/**
 * @vitest-environment happy-dom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

const listNotifications = vi.hoisted(() => vi.fn());
const notificationUnreadCount = vi.hoisted(() => vi.fn());
const readAllNotifications = vi.hoisted(() => vi.fn());
const readNotification = vi.hoisted(() => vi.fn());
const notify = vi.hoisted(() => vi.fn());

vi.mock('../../../services/api/notifications', () => ({
  listNotifications,
  notificationUnreadCount,
  readAllNotifications,
  readNotification,
  NOTIFICATION_POLL_INTERVAL_MS: 30_000,
}));
vi.mock('../../PowerSnackbar', () => ({ useOptionalPowerSnackbar: () => ({ notify }) }));

import { NotificationsInbox } from '../NotificationsInbox';

const roots: Root[] = [];

function item(receiptId: string, createdAt = 1) {
  return {
    receiptId,
    eventId: receiptId,
    actorId: 'actor',
    actorLogin: 'alpha',
    groupName: 'Група',
    createdAt,
    readAt: null,
    quote: {
      messageId: 17,
      messageUuid: null,
      messageUid: null,
      text: 'Текст повідомлення',
      attachmentsCount: 0,
      mediaFileNames: [],
      coords: null,
    },
  };
}

function renderInbox(identity = 'user-a') {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  act(() => root.render(<NotificationsInbox identity={identity} />));
  return { container, root };
}

async function openInbox() {
  await act(async () => {
    document.querySelector<HTMLButtonElement>('button[aria-label="Вхідні"]')?.click();
  });
}

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
  vi.clearAllMocks();
});

describe('NotificationsInbox', () => {
  it.each([
    { name: 'empty', items: [] },
    { name: 'populated', items: [item('existing')] },
  ])('#3610 keeps the $name panel stable during background refresh', async ({ items }) => {
    const response = {
      items,
      unreadCount: items.length,
      nextCursor: null,
      markAllBoundary: 'boundary',
      removedReceiptIds: [],
    };
    let resolveRefresh!: (value: typeof response) => void;
    const pendingRefresh = new Promise<typeof response>((resolve) => {
      resolveRefresh = resolve;
    });
    listNotifications.mockResolvedValueOnce(response).mockReturnValueOnce(pendingRefresh);
    notificationUnreadCount.mockResolvedValueOnce(items.length);
    renderInbox();
    await openInbox();

    const panel = document.querySelector('section[aria-label="Вхідні"]')!;
    const content = panel.innerHTML;
    await act(async () => window.dispatchEvent(new Event('focus')));

    expect(listNotifications).toHaveBeenCalledTimes(2);
    expect(panel.innerHTML).toBe(content);
    expect(panel.querySelector('[role="progressbar"]')).toBeNull();

    await act(async () => {
      resolveRefresh({ ...response, items: [item('new')], unreadCount: 1 });
    });
    expect(panel.querySelectorAll('a')).toHaveLength(items.length + 1);
    expect(panel.querySelector('[role="progressbar"]')).toBeNull();
  });

  it('#3610 ignores a failed refresh superseded by a newer successful refresh', async () => {
    const initial = {
      items: [item('initial')],
      unreadCount: 1,
      nextCursor: null,
      markAllBoundary: 'boundary',
    };
    const newerItem = {
      ...item('newer'),
      quote: { ...item('newer').quote, text: 'newer refresh' },
    };
    let resolveNewer!: (value: typeof initial) => void;
    let rejectOlder!: (reason: Error) => void;
    const newer = new Promise<typeof initial>((resolve) => {
      resolveNewer = resolve;
    });
    const older = new Promise<typeof initial>((_, reject) => {
      rejectOlder = reject;
    });
    listNotifications
      .mockResolvedValueOnce(initial)
      .mockReturnValueOnce(older)
      .mockReturnValueOnce(newer);
    notificationUnreadCount.mockResolvedValue(1);
    renderInbox();
    await openInbox();

    await act(async () => window.dispatchEvent(new Event('focus')));
    await act(async () => window.dispatchEvent(new Event('focus')));
    await act(async () => {
      resolveNewer({ ...initial, items: [newerItem], unreadCount: 1 });
    });
    await act(async () => {
      rejectOlder(new Error('older refresh failed'));
      await Promise.resolve();
    });

    expect(document.body.textContent).toContain('newer refresh');
    expect(document.body.textContent).not.toContain('older refresh failed');
    expect(notify).not.toHaveBeenCalled();
  });

  it('#3610 ignores a failed refresh invalidated by an identity change', async () => {
    const initial = {
      items: [item('receipt')],
      unreadCount: 1,
      nextCursor: null,
      markAllBoundary: 'boundary',
    };
    let rejectStaleRefresh!: (reason: Error) => void;
    const staleRefresh = new Promise<typeof initial>((_, reject) => {
      rejectStaleRefresh = reject;
    });
    listNotifications
      .mockResolvedValue(initial)
      .mockResolvedValueOnce(initial)
      .mockReturnValueOnce(staleRefresh);
    notificationUnreadCount.mockResolvedValue(0);
    const { root } = renderInbox();
    await openInbox();

    await act(async () => window.dispatchEvent(new Event('focus')));
    await act(async () => root.render(<NotificationsInbox identity="user-b" />));
    await act(async () => {
      rejectStaleRefresh(new Error('identity refresh failed'));
      await Promise.resolve();
    });

    expect(document.body.textContent).not.toContain('identity refresh failed');
    expect(notify).not.toHaveBeenCalled();
  });

  it('#3610 ignores a failed refresh invalidated by a receipt-read mutation', async () => {
    const initial = {
      items: [item('receipt')],
      unreadCount: 1,
      nextCursor: null,
      markAllBoundary: 'boundary',
    };
    let rejectStaleRefresh!: (reason: Error) => void;
    const staleRefresh = new Promise<typeof initial>((_, reject) => {
      rejectStaleRefresh = reject;
    });
    listNotifications
      .mockResolvedValue(initial)
      .mockResolvedValueOnce(initial)
      .mockReturnValueOnce(staleRefresh);
    notificationUnreadCount.mockResolvedValue(0);
    readNotification.mockResolvedValueOnce(0);
    renderInbox();
    await openInbox();

    await act(async () => window.dispatchEvent(new Event('focus')));
    const preventNavigation = (event: MouseEvent) => event.preventDefault();
    document.addEventListener('click', preventNavigation, true);
    await act(async () => document.querySelector<HTMLAnchorElement>('a')?.click());
    document.removeEventListener('click', preventNavigation, true);
    await act(async () => {
      rejectStaleRefresh(new Error('mutation refresh failed'));
      await Promise.resolve();
    });

    expect(document.body.textContent).not.toContain('mutation refresh failed');
    expect(notify).not.toHaveBeenCalled();
  });

  it('#3610 marks only receipts returned by the persisted boundary as read', async () => {
    listNotifications.mockResolvedValueOnce({
      items: [item('covered'), item('newer', 2)],
      unreadCount: 2,
      nextCursor: null,
      markAllBoundary: 'boundary',
    });
    readAllNotifications.mockResolvedValueOnce({
      outcome: 'NotificationReadAllApplied',
      unreadCount: 1,
      receiptIds: ['covered'],
    });
    notificationUnreadCount.mockResolvedValueOnce(1);
    renderInbox();

    await openInbox();
    await act(async () => {
      Array.from(document.querySelectorAll<HTMLButtonElement>('button'))
        .find((button) => button.textContent === 'Позначити всі як прочитані')
        ?.click();
    });

    expect(readAllNotifications).toHaveBeenCalledWith({ boundaryReceiptId: 'boundary' });
    expect(document.querySelector('h2')?.textContent).toBe('Вхідні');
    expect(document.querySelector('button[aria-label="Вхідні"]')?.textContent).toContain('1');
    expect(document.querySelectorAll('[data-testid="notification-unread-dot"]')).toHaveLength(1);
  });

  it('#3610 tracks a link activation without delaying navigation', async () => {
    listNotifications.mockResolvedValueOnce({
      items: [item('receipt')],
      unreadCount: 1,
      nextCursor: null,
      markAllBoundary: 'boundary',
    });
    readNotification.mockResolvedValueOnce(0);
    renderInbox();

    await openInbox();
    const preventNavigation = (event: MouseEvent) => event.preventDefault();
    document.addEventListener('click', preventNavigation, true);
    await act(async () => document.querySelector<HTMLAnchorElement>('a')?.click());
    document.removeEventListener('click', preventNavigation, true);

    expect(readNotification).toHaveBeenCalledWith({ receiptId: 'receipt' });
  });

  it('#3610 does not let a poll begun before or during a receipt read restore unread state', async () => {
    let resolvePoll: (response: {
      items: ReturnType<typeof item>[];
      unreadCount: number;
      nextCursor: null;
      markAllBoundary: string;
    }) => void;
    listNotifications
      .mockResolvedValueOnce({
        items: [item('receipt')],
        unreadCount: 1,
        nextCursor: null,
        markAllBoundary: 'boundary',
      })
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolvePoll = resolve;
          }),
      );
    readNotification.mockResolvedValueOnce(0);
    notificationUnreadCount.mockResolvedValue(0);
    renderInbox();
    await openInbox();

    await act(async () => window.dispatchEvent(new Event('focus')));
    const preventNavigation = (event: MouseEvent) => event.preventDefault();
    document.addEventListener('click', preventNavigation, true);
    await act(async () => document.querySelector<HTMLAnchorElement>('a')?.click());
    document.removeEventListener('click', preventNavigation, true);
    await act(async () => {
      resolvePoll!({
        items: [item('receipt')],
        unreadCount: 1,
        nextCursor: null,
        markAllBoundary: 'boundary',
      });
    });

    expect(document.querySelectorAll('[data-testid="notification-unread-dot"]')).toHaveLength(0);
    expect(document.body.textContent).not.toContain('Вхідні (1)');
  });

  it('#3610 does not present an empty-inbox claim after initial loading fails', async () => {
    listNotifications.mockRejectedValueOnce(new Error('network failure'));
    renderInbox();

    await openInbox();

    expect(document.body.textContent).toContain('network failure');
    expect(document.body.textContent).not.toContain('Поки що немає згадок');
  });

  it('#3610 deduplicates repeated polling failures and exposes a retry action', async () => {
    listNotifications
      .mockRejectedValueOnce(new Error('network failure'))
      .mockRejectedValueOnce(new Error('network failure'))
      .mockResolvedValueOnce({
        items: [],
        unreadCount: 0,
        nextCursor: null,
        markAllBoundary: null,
      });
    renderInbox();

    await openInbox();
    await act(async () => window.dispatchEvent(new Event('focus')));

    expect(notify).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).toContain('network failure');
    const retry = Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent === 'Повторити',
    );
    expect(retry).toBeDefined();

    await act(async () => retry?.click());

    expect(document.body.textContent).not.toContain('network failure');
    expect(document.body.textContent).toContain('Поки що немає згадок');
  });

  it('#3610 retries an initial unread-count failure after the panel list loads', async () => {
    notificationUnreadCount
      .mockRejectedValueOnce(new Error('Internal server error'))
      .mockResolvedValueOnce(1);
    listNotifications.mockResolvedValueOnce({
      items: [item('receipt')],
      unreadCount: 1,
      nextCursor: null,
      markAllBoundary: 'boundary',
    });
    renderInbox();

    await openInbox();

    expect(document.body.textContent).toContain('Не вдалося оновити Вхідні');
    const retry = Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent === 'Повторити',
    );
    await act(async () => retry?.click());

    expect(notificationUnreadCount).toHaveBeenCalledTimes(2);
    expect(document.body.textContent).not.toContain('Не вдалося оновити Вхідні');
  });

  it('#3610 loads the unread badge before the panel is opened', async () => {
    notificationUnreadCount.mockResolvedValueOnce(3);
    renderInbox();

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(document.body.textContent).toContain('3');
  });

  it('#3610 removes a receipt revoked during a refresh', async () => {
    listNotifications
      .mockResolvedValueOnce({
        items: [item('revoked', 2), item('kept', 1)],
        unreadCount: 2,
        nextCursor: null,
        markAllBoundary: 'boundary',
      })
      .mockResolvedValueOnce({
        items: [item('kept', 1)],
        unreadCount: 1,
        nextCursor: null,
        markAllBoundary: 'boundary',
        removedReceiptIds: ['revoked'],
      });
    renderInbox();
    await openInbox();

    await act(async () => window.dispatchEvent(new Event('focus')));

    expect(document.body.textContent).not.toContain('revoked');
  });

  it('#3610 recovers from an expired mark-all boundary without marking visible items', async () => {
    listNotifications
      .mockResolvedValueOnce({
        items: [item('covered'), item('newer', 2)],
        unreadCount: 2,
        nextCursor: null,
        markAllBoundary: 'expired-boundary',
      })
      .mockResolvedValueOnce({
        items: [item('covered'), item('newer', 2)],
        unreadCount: 2,
        nextCursor: null,
        markAllBoundary: 'replacement-boundary',
      })
      .mockResolvedValue({
        items: [item('covered'), item('newer', 2)],
        unreadCount: 2,
        nextCursor: null,
        markAllBoundary: 'replacement-boundary',
      });
    readAllNotifications.mockResolvedValueOnce({
      outcome: 'NotificationReadAllBoundaryExpired',
      unreadCount: 2,
      receiptIds: [],
    });
    renderInbox();

    await openInbox();
    await act(async () => {
      Array.from(document.querySelectorAll<HTMLButtonElement>('button'))
        .find((button) => button.textContent === 'Позначити всі як прочитані')
        ?.click();
    });

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(document.querySelectorAll('[data-testid="notification-unread-dot"]')).toHaveLength(2);
    expect(readAllNotifications).toHaveBeenCalledWith({
      boundaryReceiptId: 'expired-boundary',
    });
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ severity: 'warning' }));
  });

  it('#3610 records simultaneous reads for different receipts', async () => {
    listNotifications.mockResolvedValueOnce({
      items: [item('first'), item('second', 2)],
      unreadCount: 2,
      nextCursor: null,
      markAllBoundary: 'boundary',
    });
    let resolveFirst: (count: number) => void;
    let resolveSecond: (count: number) => void;
    readNotification
      .mockImplementationOnce(() => new Promise((resolve) => (resolveFirst = resolve)))
      .mockImplementationOnce(() => new Promise((resolve) => (resolveSecond = resolve)));
    notificationUnreadCount.mockResolvedValue(0);
    renderInbox();
    await openInbox();

    await act(async () => {
      document.querySelectorAll<HTMLAnchorElement>('a').forEach((link) => link.click());
      resolveSecond!(1);
      resolveFirst!(0);
    });

    expect(document.querySelectorAll('[data-testid="notification-unread-dot"]')).toHaveLength(0);
    expect(document.body.textContent).not.toContain('Вхідні (1)');
  });

  it('#3610 preserves loaded notification history when pagination appends a page', async () => {
    listNotifications
      .mockResolvedValueOnce({
        items: [item('first')],
        unreadCount: 1,
        nextCursor: 'next-page',
        markAllBoundary: 'boundary',
      })
      .mockResolvedValueOnce({
        items: [item('second', 2)],
        unreadCount: 1,
        nextCursor: null,
        markAllBoundary: null,
      });
    renderInbox();
    await openInbox();

    const list = document.querySelector<HTMLDivElement>('.overflow-y-auto')!;
    Object.defineProperties(list, {
      clientHeight: { configurable: true, value: 100 },
      scrollHeight: { configurable: true, value: 200 },
      scrollTop: { configurable: true, value: 200 },
    });
    await act(async () => list.dispatchEvent(new Event('scroll', { bubbles: true })));

    expect(listNotifications).toHaveBeenLastCalledWith(
      expect.objectContaining({ cursor: 'next-page' }),
    );
    expect(document.querySelectorAll('[data-testid="notification-unread-dot"]')).toHaveLength(2);
  });

  it('#3610 reconciles the badge when reads finish in request order', async () => {
    listNotifications.mockResolvedValueOnce({
      items: [item('first'), item('second', 2)],
      unreadCount: 2,
      nextCursor: null,
      markAllBoundary: 'boundary',
    });
    let resolveFirst: (count: number) => void;
    let resolveSecond: (count: number) => void;
    readNotification
      .mockImplementationOnce(() => new Promise((resolve) => (resolveFirst = resolve)))
      .mockImplementationOnce(() => new Promise((resolve) => (resolveSecond = resolve)));
    notificationUnreadCount.mockResolvedValue(0);
    renderInbox();
    await openInbox();

    await act(async () => {
      document.querySelectorAll<HTMLAnchorElement>('a').forEach((link) => link.click());
      resolveFirst!(1);
      resolveSecond!(0);
    });

    expect(document.querySelectorAll('[data-testid="notification-unread-dot"]')).toHaveLength(0);
    expect(document.body.textContent).not.toContain('Вхідні (1)');
  });
});
