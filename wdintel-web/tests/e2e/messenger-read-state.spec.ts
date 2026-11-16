import { expect, test, type Locator, type Page } from '@playwright/test';
import { installAnalysisNeoApiMocks } from './analysis-neo.fixtures';

const T0 = Date.UTC(2026, 8, 12, 12);

const account = {
  id: 'a1',
  messengerType: 'Telegram',
  externalId: '7',
  displayName: 'Мій акаунт',
  username: 'me',
  firstName: null,
  lastName: null,
  phone: '+10',
  status: null,
  statusError: null,
  statusChangedAt: null,
  isActive: true,
  isPaused: false,
  createdAt: null,
  lastSync: null,
  notes: null,
  internalNotes: null,
  externalUrl: null,
  telegram: null,
  datasourceGroup: { id: 'g1', name: 'Група' },
};

const chat = (
  id: string,
  title: string,
  unread: number,
  newestReadAt: number | null = null,
  oldestReadAt: number | null = newestReadAt == null ? null : T0,
) => ({
  id,
  messengerType: 'Telegram',
  externalId: id,
  chatType: 'GROUP',
  title,
  username: null,
  membersCount: null,
  accountMemberStatus: null,
  lastMessageDate: T0,
  telegram: null,
  oldestReadAt,
  newestReadAt,
  unreadCount: unread,
  // Filled with the number of messages of the chat unless a test sets it.
  totalCount: undefined as number | undefined,
});

// Messages a minute apart, oldest first.
const message = (index: number) => ({
  id: `m${index}`,
  externalId: `${index}`,
  sentAt: T0 + index * 60_000,
  text: `Повідомлення ${index}`,
  isOutgoing: false,
  hasMedia: false,
  senderChatMemberId: null,
  attachments: [],
  telegram: null,
});

// The paging of `messages/list` over `total` messages: `o<n>` continues older than index n, `n<n>` newer from index n.
function messagesPage(total: number, body: Record<string, unknown>) {
  const limit = Number(body.limit ?? 50);
  let [lo, hi] = [Math.max(0, total - limit), total];
  const cursor = typeof body.cursor === 'string' ? body.cursor : null;
  if (typeof body.around_sent_at === 'number') {
    // The messages sent at or before the time end the older half, the newer half starts after it.
    const newer = Math.floor((body.around_sent_at - T0) / 60_000) + 1;
    [lo, hi] = [Math.max(0, newer - limit / 2), Math.min(total, newer + limit / 2)];
  } else if (body.direction === 'Oldest') {
    [lo, hi] = [0, Math.min(total, limit)];
  } else if (cursor?.startsWith('o')) {
    hi = Number(cursor.slice(1));
    lo = Math.max(0, hi - limit);
  } else if (cursor?.startsWith('n')) {
    lo = Number(cursor.slice(1));
    hi = Math.min(total, lo + limit);
  }
  const items = Array.from({ length: hi - lo }, (_, index) => message(lo + index)).reverse();
  return {
    items: items.map(snake),
    older_cursor: lo > 0 ? `o${lo}` : null,
    newer_cursor: `n${hi}`,
  };
}

// The API speaks snake_case; the client turns it into camelCase.
function snake(value: object): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`),
      item !== null && typeof item === 'object' && !Array.isArray(item) ? snake(item) : item,
    ]),
  );
}

// The totals of messages shown in the rows of the full sidebar.
const totals = (page: Page) =>
  page
    .getByRole('complementary', { name: 'Навігація акаунту', exact: true })
    .locator('[data-messenger-total-count]');

async function openMessenger(
  page: Page,
  initialChats: ReturnType<typeof chat>[],
  query = '',
  total = 5,
) {
  let chats = initialChats.map((item) => ({ ...item, totalCount: item.totalCount ?? total }));
  await installAnalysisNeoApiMocks(page, { userRoles: ['Rer', 'CyberMessengers'] });
  const calls = {
    updates: [] as Record<string, unknown>[],
    pages: [] as Record<string, unknown>[],
    markAll: 0,
  };
  await page.route('**/api/messengers/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    const json = (body: unknown) => route.fulfill({ json: body });
    if (path.endsWith('/accounts/list')) return json({ items: [snake(account)] });
    if (path.endsWith('/chats/list')) return json({ items: chats.map(snake) });
    if (path.endsWith('/chats/members/list')) return json({ items: [] });
    // The galleries: counts per Telegram type and no tiles, which is enough for the tabs.
    if (path.endsWith('/attachments/count')) {
      return json({
        items: [
          // The widest numbers the phone layout is built for: 9999 photos, 999 videos, 99 audio, 99 documents.
          { telegram_media_type: 'photo', count: 9999 },
          { telegram_media_type: 'video', count: 999 },
          { telegram_media_type: 'voice', count: 99 },
          { telegram_media_type: 'document', count: 99 },
        ],
      });
    }
    if (path.endsWith('/attachments/list')) {
      return json({ items: [], older_cursor: null, newer_cursor: null });
    }
    if (path.endsWith('/messages/list')) {
      const body = route.request().postDataJSON() as Record<string, unknown>;
      calls.pages.push(body);
      return json(messagesPage(total, body));
    }
    if (path.endsWith('/chats/read-state/update')) {
      const body = route.request().postDataJSON() as {
        oldest_read_at: number;
        newest_read_at: number;
      };
      calls.updates.push(body as unknown as Record<string, unknown>);
      // As the server does: the span only widens, the unread count is what lies outside it.
      const stored = chats[0];
      const oldest = Math.min(body.oldest_read_at, stored.oldestReadAt ?? Infinity);
      const newest = Math.max(body.newest_read_at, stored.newestReadAt ?? -Infinity);
      const read = Math.max(0, Math.floor((newest - oldest) / 60_000) + 1);
      chats = [
        { ...stored, oldestReadAt: oldest, newestReadAt: newest, unreadCount: total - read },
      ];
      return json({ oldest_read_at: oldest, newest_read_at: newest, unread_count: total - read });
    }
    if (path.endsWith('/chats/mark-all-read')) {
      calls.markAll += 1;
      chats = chats.map((item) => ({ ...item, unreadCount: 0 }));
      return json(null);
    }
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });
  await page.goto(
    `/rer-analysis-neo?leftPanelOpen=true&leftPanelTab=messenger&messengerAccount=a1${query}`,
  );
  return calls;
}

test('@regression messenger sidebar shows unread counts, filters to them and reads all', async ({
  page,
}) => {
  const calls = await openMessenger(page, [chat('c1', 'Команда', 12), chat('c2', 'Новини', 0, T0)]);
  const sidebar = page.getByRole('complementary', { name: 'Навігація акаунту', exact: true });
  await expect(sidebar.getByText('Команда')).toBeVisible();
  await expect(sidebar.locator('[data-messenger-unread-badge]')).toHaveText(['12']);
  // Both rows carry the total of their messages (5 in this mock), read or not.
  await expect(totals(page)).toHaveText(['5', '5']);

  await sidebar.getByRole('checkbox', { name: 'Лише непрочитані' }).check();
  await expect(sidebar.getByText('Новини')).toBeHidden();
  await expect(sidebar.getByText('Команда')).toBeVisible();
  await sidebar.getByRole('checkbox', { name: 'Лише непрочитані' }).uncheck();
  await expect(sidebar.getByText('Новини')).toBeVisible();

  // It asks first: "Ні" changes nothing.
  await sidebar.getByRole('button', { name: 'Прочитати всі' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Ні', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeHidden();
  expect(calls.markAll).toBe(0);
  await expect(sidebar.locator('[data-messenger-unread-badge]')).toHaveCount(1);

  await sidebar.getByRole('button', { name: 'Прочитати всі' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Так', exact: true }).click();
  await expect(sidebar.locator('[data-messenger-unread-badge]')).toHaveCount(0);
  await expect(sidebar.getByRole('button', { name: 'Прочитати всі' })).toBeDisabled();
  expect(calls.markAll).toBe(1);
  // Reading changes the unread counts, not the totals.
  await expect(totals(page)).toHaveText(['5', '5']);
});

test('@regression messenger chat stops at the first unread message and writes what the reader saw', async ({
  page,
}) => {
  // Read up to the second message, three unread after it.
  const calls = await openMessenger(
    page,
    [chat('c1', 'Команда', 3, T0 + 60_000)],
    '&messengerChat=c1',
  );
  const view = page.locator('[data-messenger-chat-view]');
  await expect(view.getByText('Повідомлення 4')).toBeVisible();
  await expect(view.getByRole('separator')).toHaveText('Ви зупинились тут');
  await expect(view.getByRole('button', { name: /До непрочитаних \(3\)/ })).toBeVisible();

  // Everything fits on the screen: after the delay the whole page, from its first message, is written as read.
  await expect.poll(() => calls.updates.length, { timeout: 5000 }).toBe(1);
  expect(calls.updates[0]).toMatchObject({
    account_id: 'a1',
    chat_id: 'c1',
    oldest_read_at: T0,
    newest_read_at: T0 + 4 * 60_000,
  });
  // The answer clears the badge of the chat in the sidebar; the divider stays where the reader stopped.
  await expect(page.locator('[data-messenger-unread-badge]')).toHaveCount(0);
  // The total stays: 5 messages, read or not.
  await expect(totals(page)).toHaveText('5');
  await expect(view.getByRole('separator')).toHaveText('Ви зупинились тут');
});

test('@regression messenger go to unread loads the page around the read bound and scrolls to the divider', async ({
  page,
}) => {
  // 200 messages, the first 100 read: the newest page (150..199) holds no read message, so the divider is not loaded.
  const calls = await openMessenger(
    page,
    [chat('c1', 'Команда', 100, T0 + 99 * 60_000)],
    '&messengerChat=c1',
    200,
  );
  const view = page.locator('[data-messenger-chat-view]');
  await expect(view.getByText('Повідомлення 199', { exact: true })).toBeVisible();
  await expect(view.getByRole('separator')).toHaveCount(0);

  await view.getByRole('button', { name: /До непрочитаних \(100\)/ }).click();
  expect(calls.pages.at(-1)).toMatchObject({ around_sent_at: T0 + 99 * 60_000 });
  await expect(view.getByRole('separator')).toHaveText('Ви зупинились тут');
  await expect(view.getByRole('separator')).toBeInViewport();
  await expect(view.getByText('Повідомлення 100', { exact: true })).toBeInViewport();
  await expect(view.getByText('Повідомлення 99', { exact: true })).not.toBeInViewport();
});

test('@regression messenger go to unread reaches unread history above the read span and keeps the reader there', async ({
  page,
}) => {
  // The shape of a real chat: 409 messages, the first 354 never read, the last 55 (to the newest) read.
  const calls = await openMessenger(
    page,
    [chat('c1', 'Команда', 354, T0 + 408 * 60_000, T0 + 354 * 60_000)],
    '&messengerChat=c1',
    409,
  );
  const view = page.locator('[data-messenger-chat-view]');
  await expect(view.getByText('Повідомлення 408', { exact: true })).toBeVisible();
  // The newest page holds only read messages and the history is above it: no divider yet.
  await expect(view.getByRole('separator')).toHaveCount(0);

  await view.getByRole('button', { name: /До непрочитаних \(354\)/ }).click();
  // Nothing is newer than the span, so the page around its lower bound is the only request.
  expect(calls.pages.at(-1)).toMatchObject({ around_sent_at: T0 + 354 * 60_000 - 1 });
  await expect(view.getByRole('separator')).toHaveText('Вище — непрочитані');
  await expect(view.getByRole('separator')).toBeInViewport();
  await expect(view.getByText('Повідомлення 353', { exact: true })).toBeInViewport();

  // The unread messages on screen are written as read, widening the span downwards.
  await expect.poll(() => calls.updates.length, { timeout: 5000 }).toBeGreaterThan(0);
  expect(Number(calls.updates[0].oldest_read_at)).toBeLessThan(T0 + 354 * 60_000);

  // Scrolling up from there stays up: the reader is not thrown to the newest message.
  const scroller = view.locator('[data-messenger-feed-scroller]');
  await scroller.hover();
  for (let step = 0; step < 4; step++) {
    await page.mouse.wheel(0, -500);
    await page.waitForTimeout(300);
  }
  const distanceFromEnd = await scroller.evaluate(
    (el) => el.scrollHeight - el.clientHeight - el.scrollTop,
  );
  expect(distanceFromEnd).toBeGreaterThan(1000);
  await expect(view.getByText('Повідомлення 408', { exact: true })).not.toBeInViewport();
});

// "До непрочитаних (N)" -> N
const buttonCount = async (view: Locator) =>
  Number(
    (await view.getByRole('button', { name: /До непрочитаних/ }).textContent())?.match(
      /\((\d+)\)/,
    )?.[1],
  );

test('@regression messenger unread badges are short, exact in the tooltip, and the rail has them too', async ({
  page,
}) => {
  await page.addInitScript(() => localStorage.setItem('messenger-account-sidebar-open', 'false'));
  await openMessenger(page, [
    chat('c1', 'Однозначна', 9),
    chat('c2', 'Тисячі', 7100),
    chat('c3', 'Прочитана', 0, T0),
  ]);
  const rail = page.locator('[data-messenger-sidebar-rail]');
  await rail.locator('[data-messenger-rail-section-toggle="group"]').click();
  await expect(rail.locator('[data-messenger-rail-chat]')).toHaveCount(3);
  await expect(rail.locator('[data-messenger-total-count]')).toHaveCount(0);

  // On the corner of the avatar, in the short format; the exact number is in the tooltip; a read chat has no badge.
  const badges = rail.locator('[data-messenger-unread-badge]');
  await expect(badges).toHaveText(['9', '7.1k']);
  await expect(badges.nth(1)).toHaveAttribute('title', /7\D*100/);
  await expect(
    rail.locator('[data-messenger-rail-chat="c3"] [data-messenger-unread-badge]'),
  ).toHaveCount(0);

  // The unread filter of the rail leaves the chats with unread messages.
  await expect(rail.getByRole('button', { name: 'Лише непрочитані' })).toHaveAttribute(
    'aria-pressed',
    'false',
  );
  await rail.getByRole('button', { name: 'Лише непрочитані' }).click();
  await expect(rail.getByRole('button', { name: 'Лише непрочитані' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(rail.locator('[data-messenger-rail-chat]')).toHaveCount(2);
  await expect(rail.locator('[data-messenger-rail-chat="c3"]')).toHaveCount(0);

  // The full sidebar shows the same badges and shares the filter.
  await page.getByRole('button', { name: 'Розгорнути панель акаунту' }).click();
  const sidebar = page.getByRole('complementary', { name: 'Навігація акаунту', exact: true });
  await expect(sidebar.locator('[data-messenger-unread-badge]')).toHaveText(['9', '7.1k']);
  await expect(sidebar.getByRole('checkbox', { name: 'Лише непрочитані' })).toBeChecked();
  await expect(sidebar.getByText('Прочитана')).toBeHidden();
});

test('@regression messenger unread count follows the reader: the sidebar badge and the button go down together', async ({
  page,
}) => {
  const calls = await openMessenger(
    page,
    [chat('c1', 'Команда', 100, T0 + 99 * 60_000)],
    '&messengerChat=c1',
    200,
  );
  const view = page.locator('[data-messenger-chat-view]');
  const sidebar = page.getByRole('complementary', { name: 'Навігація акаунту', exact: true });
  const badge = sidebar.locator('[data-messenger-unread-badge]');
  await expect(badge).toHaveText('100');
  await expect(totals(page)).toHaveText('200');
  expect(await buttonCount(view)).toBe(100);

  // Nothing is written while the reader is among messages that are read or not next to the span.
  await view.getByRole('button', { name: /До непрочитаних/ }).click();
  await expect(view.getByRole('separator')).toBeInViewport();
  // The first screen of unread messages is written as read once the reader settles.
  await expect.poll(() => calls.updates.length, { timeout: 5000 }).toBeGreaterThan(0);
  await expect.poll(() => buttonCount(view)).toBeLessThan(100);
  const afterFirst = await buttonCount(view);
  await expect(badge).toHaveText(String(afterFirst));

  // Reading further down lowers both again.
  const scroller = view.locator('[data-messenger-feed-scroller]');
  await scroller.hover();
  for (let step = 0; step < 3; step++) {
    await page.mouse.wheel(0, 600);
    await page.waitForTimeout(300);
  }
  await expect.poll(() => buttonCount(view), { timeout: 6000 }).toBeLessThan(afterFirst);
  const afterScroll = await buttonCount(view);
  await expect(badge).toHaveText(String(afterScroll));
  // Reading lowers the unread count only, the total of the chat stays 200.
  await expect(totals(page)).toHaveText('200');
  // The divider is where the reader stopped when the chat was opened, not where the reader is now.
  await expect(view.getByRole('separator')).toHaveText('Ви зупинились тут');
});

test('@regression messenger shows both dividers when unread messages lie on both sides of the read span', async ({
  page,
}) => {
  // 60 messages: 0..19 and 40..59 unread, 20..39 read. The newest page (10..59) holds both boundaries.
  await openMessenger(
    page,
    [chat('c1', 'Команда', 40, T0 + 39 * 60_000, T0 + 20 * 60_000)],
    '&messengerChat=c1',
    60,
  );
  const view = page.locator('[data-messenger-chat-view]');
  await expect(view.getByText('Повідомлення 59', { exact: true })).toBeVisible();
  // 60 messages in all, 40 of them unread: the row shows both numbers.
  await expect(totals(page)).toHaveText('60');
  await expect(
    page.locator('[data-messenger-chat-counts] [data-messenger-unread-badge]'),
  ).toHaveText('40');
  await expect(view.getByRole('separator')).toHaveText(['Вище — непрочитані', 'Ви зупинились тут']);
  await expect(view.locator('[data-message-id="m20"]').getByRole('separator')).toHaveText(
    'Вище — непрочитані',
  );
  await expect(view.locator('[data-message-id="m40"]').getByRole('separator')).toHaveText(
    'Ви зупинились тут',
  );

  // The button goes to the first unread message after the span, with its divider on top.
  await view.getByRole('button', { name: /До непрочитаних \(40\)/ }).click();
  await expect(view.locator('[data-message-id="m40"]').getByRole('separator')).toBeInViewport();
});

test('@regression messenger draws no divider and no jump button for a chat never read', async ({
  page,
}) => {
  const calls = await openMessenger(page, [chat('c1', 'Команда', 5)], '&messengerChat=c1');
  const view = page.locator('[data-messenger-chat-view]');
  await expect(view.getByText('Повідомлення 4', { exact: true })).toBeVisible();
  // Everything is unread, so there is no place to stop at; the badge counts every message.
  await expect(view.getByRole('separator')).toHaveCount(0);
  await expect(view.getByRole('button', { name: /До непрочитаних/ })).toHaveCount(0);
  await expect(
    page
      .getByRole('complementary', { name: 'Навігація акаунту', exact: true })
      .locator('[data-messenger-unread-badge]'),
  ).toHaveText('5');
  await expect(totals(page)).toHaveText('5');
  // Reading it starts the span: the page shown is written, and the badge goes. The total stays.
  await expect.poll(() => calls.updates.length, { timeout: 5000 }).toBe(1);
  await expect(page.locator('[data-messenger-unread-badge]')).toHaveCount(0);
  await expect(totals(page)).toHaveText('5');
});

test('@regression messenger draws nothing for a fully read chat and writes nothing', async ({
  page,
}) => {
  const calls = await openMessenger(
    page,
    [chat('c1', 'Команда', 0, T0 + 4 * 60_000, T0)],
    '&messengerChat=c1',
  );
  const view = page.locator('[data-messenger-chat-view]');
  await expect(view.getByText('Повідомлення 4', { exact: true })).toBeVisible();
  await expect(view.getByRole('separator')).toHaveCount(0);
  await expect(view.getByRole('button', { name: /До непрочитаних/ })).toHaveCount(0);
  await expect(page.locator('[data-messenger-unread-badge]')).toHaveCount(0);
  // Nothing unread, but the row still says how many messages the chat has.
  await expect(totals(page)).toHaveText('5');
  // Messages inside the read span are not written again, even after the delay.
  await page.waitForTimeout(2500);
  expect(calls.updates).toEqual([]);
});

test('@regression messenger says so when the jump finds nothing unread', async ({ page }) => {
  // The counter says 3 unread, but the span covers every message: nothing to go to.
  await openMessenger(page, [chat('c1', 'Команда', 3, T0 + 4 * 60_000, T0)], '&messengerChat=c1');
  const view = page.locator('[data-messenger-chat-view]');
  await expect(view.getByText('Повідомлення 4', { exact: true })).toBeVisible();
  await view.getByRole('button', { name: /До непрочитаних \(3\)/ }).click();
  await expect(page.getByText('Непрочитаних повідомлень не знайдено.')).toBeVisible();
});

test('@regression messenger read all with a chat open clears its button and keeps the divider', async ({
  page,
}) => {
  const calls = await openMessenger(
    page,
    [chat('c1', 'Команда', 40, T0 + 19 * 60_000, T0 + 10 * 60_000)],
    '&messengerChat=c1',
    60,
  );
  const view = page.locator('[data-messenger-chat-view]');
  const sidebar = page.getByRole('complementary', { name: 'Навігація акаунту', exact: true });
  await expect(view.getByRole('button', { name: /До непрочитаних \(40\)/ })).toBeVisible();
  await expect(view.getByRole('separator')).not.toHaveCount(0);

  await sidebar.getByRole('button', { name: 'Прочитати всі' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Так', exact: true }).click();
  await expect.poll(() => calls.markAll).toBe(1);
  await expect(sidebar.locator('[data-messenger-unread-badge]')).toHaveCount(0);
  await expect(view.getByRole('button', { name: /До непрочитаних/ })).toHaveCount(0);
  // The messages were not scrolled away or reloaded under the reader.
  await expect(view.getByText('Повідомлення 59', { exact: true })).toBeVisible();
  // "Read all" leaves the total of the chat as it was.
  await expect(totals(page)).toHaveText('60');
});

test('@regression messenger rows show the total of messages above the unread count, and the rail only the unread one', async ({
  page,
}) => {
  await openMessenger(page, [
    { ...chat('c1', 'Тисячі', 3), totalCount: 1234 },
    { ...chat('c2', 'Прочитана', 0, T0), totalCount: 56 },
  ]);
  const sidebar = page.getByRole('complementary', { name: 'Навігація акаунту', exact: true });
  const first = sidebar.locator('[data-messenger-chat]').filter({ hasText: 'Тисячі' });
  const total = first.locator('[data-messenger-total-count]');
  const unread = first.locator('[data-messenger-unread-badge]');
  await expect(total).toHaveText('1.2k');
  await expect(unread).toHaveText('3');
  // One under the other, the total plain and muted.
  const [totalBox, unreadBox] = [await total.boundingBox(), await unread.boundingBox()];
  expect(totalBox!.y + totalBox!.height).toBeLessThanOrEqual(unreadBox!.y + 1);
  expect(Math.abs(totalBox!.x + totalBox!.width - (unreadBox!.x + unreadBox!.width))).toBeLessThan(
    2,
  );
  expect(await total.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(
    'rgba(0, 0, 0, 0)',
  );
  // A read chat has the total only.
  const read = sidebar.locator('[data-messenger-chat]').filter({ hasText: 'Прочитана' });
  await expect(read.locator('[data-messenger-total-count]')).toHaveText('56');
  await expect(read.locator('[data-messenger-unread-badge]')).toHaveCount(0);

  // The rail has no total.
  await page.getByRole('button', { name: 'Згорнути панель акаунту' }).click();
  const rail = page.locator('[data-messenger-sidebar-rail]');
  await rail.locator('[data-messenger-rail-section-toggle="group"]').click();
  await expect(rail.locator('[data-messenger-rail-chat]')).toHaveCount(2);
  await expect(rail.locator('[data-messenger-total-count]')).toHaveCount(0);
  await expect(rail.locator('[data-messenger-unread-badge]')).toHaveText('3');
});

test('@regression messenger rows name their counts for assistive tech', async ({ page }) => {
  await openMessenger(page, [{ ...chat('c1', 'Тисячі', 3), totalCount: 1234 }]);
  const sidebar = page.getByRole('complementary', { name: 'Навігація акаунту', exact: true });
  await expect(
    sidebar.getByRole('button', { name: 'Тисячі, усього повідомлень: 1234, непрочитаних: 3' }),
  ).toBeVisible();
});

test('@regression messenger header button stays inside the header on a phone', async ({ page }) => {
  await page.setViewportSize({ width: 400, height: 800 });
  await openMessenger(
    page,
    [chat('c1', 'Дуже довга назва чату для перевірки', 237, T0 + 99 * 60_000, T0 + 20 * 60_000)],
    '&messengerChat=c1',
    200,
  );
  // On a phone the account list is a drawer over the workspace; the account is already picked from the URL.
  await page.getByRole('button', { name: 'Закрити ліву панель' }).click();
  const view = page.locator('[data-messenger-chat-view]');
  const button = view.getByRole('button', { name: /До непрочитаних/ });
  await expect(button).toBeVisible();
  const [header, box, title, font] = [
    await view.locator('header').boundingBox(),
    await button.boundingBox(),
    await view.locator('header h2').boundingBox(),
    await button.evaluate((el) => parseFloat(getComputedStyle(el).fontSize)),
  ];
  // Smaller than the 13 px of a desktop button, inside the header, on one line...
  expect(font).toBeLessThanOrEqual(11);
  expect(box!.x + box!.width).toBeLessThanOrEqual(header!.x + header!.width + 1);
  expect(box!.height).toBeLessThan(32);
  // ...and the title keeps room to show something.
  expect(title!.width).toBeGreaterThan(60);
});

test('@regression messenger gallery tabs share one line on a 375 px phone, with a tighter padding', async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 800 });
  await openMessenger(page, [chat('c1', 'Команда', 0, T0)], '&messengerView=gallery');
  await page.getByRole('button', { name: 'Закрити ліву панель' }).click();
  const gallery = page.locator('[data-messenger-gallery]');
  const tabs = gallery.getByRole('group', { name: 'Тип медіа' });
  await expect(tabs.getByRole('button', { name: /Документи/ })).toBeVisible();

  // Four tabs, each on one line, inside the screen, with nothing scrolled out of the group.
  const buttons = await tabs.getByRole('button').all();
  expect(buttons).toHaveLength(4);
  for (const button of buttons) {
    expect((await button.boundingBox())!.height).toBeLessThan(32);
  }
  const group = await tabs.boundingBox();
  expect(group!.x + group!.width).toBeLessThanOrEqual(375);
  expect(await tabs.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
  expect(
    await buttons[0].evaluate((el) => parseFloat(getComputedStyle(el).fontSize)),
  ).toBeLessThanOrEqual(12);

  // `p-2`: half a rem, which is smaller than the `p-3` of a desktop.
  const pad =
    0.5 *
    (await page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).fontSize)));
  // The tabs fill the row, with no empty space on the right, and the actions below them do too.
  const bar = await gallery.locator(':scope > div:first-child').boundingBox();
  expect(Math.abs(group!.x + group!.width - (bar!.x + bar!.width - pad))).toBeLessThan(2);
  const select = await gallery.getByRole('button', { name: 'Вибрати всі' }).boundingBox();
  const zip = await gallery.getByRole('button', { name: /ZIP/ }).boundingBox();
  expect(Math.abs(zip!.x + zip!.width - (bar!.x + bar!.width - pad))).toBeLessThan(2);
  expect(Math.abs(select!.x - (bar!.x + pad))).toBeLessThan(2);

  // The bar of the tabs and the grid below it have the same, smaller padding.
  const paddingOf = (selector: string) =>
    gallery
      .locator(selector)
      .first()
      .evaluate((el) => getComputedStyle(el).padding);
  expect(await paddingOf(':scope > div:first-child')).toBe(`${pad}px`);
  expect(await paddingOf('.slim-scrollbar')).toBe(`${pad}px`);
});

test('@regression messenger chat chosen in the list opens at its first unread message, one opened by a link at its end', async ({
  page,
}) => {
  // 200 messages, the first 100 read.
  const calls = await openMessenger(
    page,
    [chat('c1', 'Команда', 100, T0 + 99 * 60_000)],
    '&messengerChat=c1',
    200,
  );
  const view = page.locator('[data-messenger-chat-view]');
  const sidebar = page.getByRole('complementary', { name: 'Навігація акаунту', exact: true });

  // From the address bar (a link, a reload): the end of the chat, no request around the read bound.
  await expect(view.getByText('Повідомлення 199', { exact: true })).toBeVisible();
  expect(calls.pages.every((body) => body.around_sent_at == null)).toBe(true);

  // Back to the account, then the chat from the list: at the first unread message, with its divider on top.
  await view.getByRole('button', { name: 'Назад до акаунта' }).click();
  const before = calls.pages.length;
  await sidebar.getByRole('button', { name: /^Команда, усього/ }).click();
  await expect(view.getByRole('separator')).toHaveText('Ви зупинились тут');
  await expect(view.getByRole('separator')).toBeInViewport();
  await expect(view.getByText('Повідомлення 100', { exact: true })).toBeInViewport();
  await expect(view.getByText('Повідомлення 199', { exact: true })).not.toBeInViewport();
  // One request, around the read bound; no newest page first.
  expect(calls.pages.slice(before)).toHaveLength(1);
  expect(calls.pages[before]).toMatchObject({ around_sent_at: T0 + 99 * 60_000 });
});

test('@regression messenger chat chosen in the list opens at unread history above the read span', async ({
  page,
}) => {
  // 409 messages, the first 354 never read, the last 55 read.
  const calls = await openMessenger(
    page,
    [chat('c1', 'Команда', 354, T0 + 408 * 60_000, T0 + 354 * 60_000)],
    '',
    409,
  );
  const view = page.locator('[data-messenger-chat-view]');
  await page
    .getByRole('complementary', { name: 'Навігація акаунту', exact: true })
    .getByRole('button', { name: /^Команда, усього/ })
    .click();
  await expect(view.getByRole('separator')).toHaveText('Вище — непрочитані');
  await expect(view.getByRole('separator')).toBeInViewport();
  await expect(view.getByText('Повідомлення 353', { exact: true })).toBeInViewport();
  await expect(view.getByText('Повідомлення 408', { exact: true })).not.toBeInViewport();
  // Nothing newer than the span, so the second request goes below its lower bound.
  expect(calls.pages.map((body) => body.around_sent_at)).toEqual([
    T0 + 408 * 60_000,
    T0 + 354 * 60_000 - 1,
  ]);
});

test('@regression messenger chat never read, or read to its end, opens at its end when chosen in the list', async ({
  page,
}) => {
  const calls = await openMessenger(page, [chat('c1', 'Команда', 5)], '');
  const view = page.locator('[data-messenger-chat-view]');
  await page
    .getByRole('complementary', { name: 'Навігація акаунту', exact: true })
    .getByRole('button', { name: /^Команда, усього/ })
    .click();
  await expect(view.getByText('Повідомлення 4', { exact: true })).toBeVisible();
  expect(calls.pages.every((body) => body.around_sent_at == null)).toBe(true);
  await expect(view.getByRole('separator')).toHaveCount(0);
});

test('@regression messenger rail badges sit low enough on a phone to leave the letters of the avatar readable', async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 800 });
  await openMessenger(page, [
    chat('c1', 'Тест', 82),
    chat('c2', 'Один', 9),
    chat('c3', 'Багато', 7100),
  ]);
  await page.getByRole('button', { name: 'Закрити ліву панель' }).click();
  const rail = page.locator('[data-messenger-sidebar-rail]');
  await rail.locator('[data-messenger-rail-section-toggle="group"]').click();
  await expect(rail.locator('[data-messenger-rail-chat]')).toHaveCount(3);

  for (const id of ['c1', 'c2', 'c3']) {
    const row = rail.locator(`[data-messenger-rail-chat="${id}"]`);
    const avatar = (await row.locator('[data-messenger-account-avatar]').boundingBox())!;
    const badge = (await row.locator('[data-messenger-unread-badge]').boundingBox())!;
    // The letters sit in the middle of the avatar; the badge starts below them and hangs past the bottom edge.
    expect(badge.y).toBeGreaterThanOrEqual(avatar.y + avatar.height / 2 + 5);
    expect(badge.y + badge.height).toBeGreaterThan(avatar.y + avatar.height);
    // And does not reach the avatar of the next row.
    expect(badge.y + badge.height).toBeLessThan(avatar.y + avatar.height + 12);
    // The badge stays inside the rail.
    const railBox = (await rail.boundingBox())!;
    expect(badge.x + badge.width).toBeLessThanOrEqual(railBox.x + railBox.width + 1);
  }
});

test('@regression messenger a jump within the debounce never marks the unseen messages between two windows read', async ({
  page,
}) => {
  // A chat never read, 300 messages: the newest page is shown, then "go to start" replaces the window before the 1.5 s delay is over.
  const calls = await openMessenger(page, [chat('c1', 'Команда', 300)], '&messengerChat=c1', 300);
  const view = page.locator('[data-messenger-chat-view]');
  await expect(view.getByText('Повідомлення 299', { exact: true })).toBeVisible();
  await view.getByRole('button', { name: 'На початок чату' }).click();
  await expect(view.getByText('Повідомлення 0', { exact: true })).toBeVisible();
  await expect.poll(() => calls.updates.length, { timeout: 6000 }).toBeGreaterThan(0);
  await page.waitForTimeout(2500);

  // What was seen on the newest page is written, what was seen on the oldest page is not next to it, so it is not: no write spans both.
  for (const update of calls.updates) {
    const span = Number(update.newest_read_at) - Number(update.oldest_read_at);
    expect(span).toBeLessThan(100 * 60_000);
  }
  expect(calls.updates.some((update) => Number(update.oldest_read_at) === T0)).toBe(false);
  // The messages in between are still unread: the badge shows far more than the 50 of one page.
  const badge = Number(
    await page
      .getByRole('complementary', { name: 'Навігація акаунту', exact: true })
      .locator('[data-messenger-unread-badge]')
      .textContent(),
  );
  expect(badge).toBeGreaterThan(200);
});
