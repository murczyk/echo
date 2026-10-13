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

function renderInbox() {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  act(() => root.render(<NotificationsInbox identity="user-a" />));
  return container;
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
    expect(document.body.textContent).toContain('Вхідні (1)');
    expect(document.querySelectorAll('a.font-medium')).toHaveLength(1);
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

    expect(document.querySelectorAll('a.font-medium')).toHaveLength(0);
    expect(document.body.textContent).not.toContain('Вхідні (1)');
  });

  it('#3610 does not present an empty-inbox claim after initial loading fails', async () => {
    listNotifications.mockRejectedValueOnce(new Error('network failure'));
    renderInbox();

    await openInbox();

    expect(document.body.textContent).toContain('network failure');
    expect(document.body.textContent).not.toContain('Поки що немає згадок');
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

    expect(document.querySelectorAll('a.font-medium')).toHaveLength(2);
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

    expect(document.querySelectorAll('a.font-medium')).toHaveLength(0);
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
    expect(document.querySelectorAll('a.font-medium')).toHaveLength(2);
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

    expect(document.querySelectorAll('a.font-medium')).toHaveLength(0);
    expect(document.body.textContent).not.toContain('Вхідні (1)');
  });
});
