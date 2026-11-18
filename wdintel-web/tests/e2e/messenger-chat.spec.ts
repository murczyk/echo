import { expect, test, type Page } from '@playwright/test';
import { installAnalysisNeoApiMocks } from './analysis-neo.fixtures';

// The chat room of the analysis messenger: the area beside the account sidebar, as in a real chat. Header (back, title,
// unread, search), the date pill, the feed with its bubbles and arrows, the search bar with its hits, and the jump to a
// date. Read state (the dividers, the writes, "go to unread") is in messenger-read-state.spec.ts; the sidebars, the
// galleries and the members are other areas.

// UTC, so the days of the data and the days of the screen are the same ones on every machine.
test.use({ timezoneId: 'UTC', locale: 'uk-UA' });
const day = (date: string) => Date.parse(`${date}T00:00:00Z`);
const DAY_MS = 86_400_000;

// 210 messages, ten a day from 09:00 at ten-minute steps, in October 2026 with 10 October left out (a day with no
// messages). m0 is the first of 1 October, m209 the last of 22 October.
const TOTAL = 210;
const dayOffset = (index: number) => {
  const dayIndex = Math.floor(index / 10);
  return dayIndex + (dayIndex >= 9 ? 1 : 0);
};
const fixedSentAt = (index: number) =>
  day('2026-10-01') + dayOffset(index) * DAY_MS + 9 * 3_600_000 + (index % 10) * 600_000;

// A short chat whose times follow the real clock: today, yesterday, the day before. The last message has just arrived.
const relativeSentAt = (now: number, total: number) => (index: number) =>
  index === total - 1 ? now - 60_000 : now - (total - 1 - index) * DAY_MS;

// What the messages say. Every fifth one also says "склад" (41 hits: m150 says something else), a few say "танк".
const SPECIAL_TEXT: Record<number, string> = {
  7: 'Бачили танки біля мосту',
  63: 'Танк стоїть на дорозі',
  150: 'ще один танк',
  196: 'Дивись https://example.com/page і www.example.org',
  198: 'Фото',
};
const textOf = (index: number) =>
  SPECIAL_TEXT[index] ??
  (index % 5 === 0 ? `Повідомлення ${index}, склад` : `Повідомлення ${index}`);

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

type Clock = (index: number) => number;

const chat = (chatType: string, total: number, sentAt: Clock, unread: number) => ({
  id: 'c1',
  messenger_type: 'Telegram',
  external_id: 'c1',
  chat_type: chatType,
  title: chatType === 'PRIVATE' ? 'Ільвіна' : 'Команда',
  username: null,
  members_count: null,
  account_member_status: null,
  last_message_date: total > 0 ? sentAt(total - 1) : null,
  telegram: null,
  // A chat that is read to its end, or one with unread messages (the unread button needs a read span).
  oldest_read_at: total > 0 ? sentAt(0) : null,
  newest_read_at:
    total > 0 ? (unread === 0 ? sentAt(total - 1) : sentAt(Math.min(100, total - 1))) : null,
  unread_count: unread,
  total_count: total,
});

const member = (id: string, firstName: string, lastName: string) => ({
  id,
  messenger_type: 'Telegram',
  external_id: id,
  username: null,
  first_name: firstName,
  last_name: lastName,
  phone: null,
  is_bot: false,
  role: null,
  joined_date: null,
  deleted: false,
  avatar_id: null,
  telegram: null,
});
const MEMBERS = [member('mem1', 'Іван', 'Петренко'), member('mem2', 'Марія', 'Коваль')];

// Group chat: Іван, Марія, and the account itself in turn. Private chat: Іван and the account.
const message = (index: number, chatType: string, total: number, sentAt: Clock) => {
  const turn = chatType === 'PRIVATE' ? (index % 2 === 0 ? 0 : 2) : index % 3;
  // m198 has its photo; the last two announce media that is not there.
  const announced = index === 198 || index >= total - 2;
  return {
    id: `m${index}`,
    external_id: `${index}`,
    sent_at: sentAt(index),
    text: textOf(index),
    is_outgoing: turn === 2,
    has_media: announced,
    sender_chat_member_id: turn === 2 ? null : turn === 0 ? 'mem1' : 'mem2',
    attachments:
      index === 198
        ? [
            {
              media: {
                id: 'photo1',
                order_f64: null,
                content_type: 'image/png',
                file_name: 'foto.png',
                size_bytes: 70,
                href: '/api/messenger/media/photo1',
                transcription: null,
                ocr: null,
                summary: null,
                coordinate_status: null,
                kmz_conversion_status: null,
                positions: [],
              },
              external_id: 'p1',
              created_at: null,
              telegram: null,
            },
          ]
        : [],
    telegram: null,
  };
};

// `messages/list` over the messages that match `query` (all of them without it), paged by position in that list: `o<n>`
// continues older than position n, `n<n>` newer from n. Items come newest first, as from the server. null is a 404.
function listMessages(
  body: Record<string, unknown>,
  chatType: string,
  total: number,
  sentAt: Clock,
) {
  const limit = Number(body.limit ?? 50);
  const query = typeof body.query === 'string' ? body.query.trim().toLowerCase() : '';
  const pool = Array.from({ length: total }, (_, index) => index).filter(
    (index) => query === '' || textOf(index).toLowerCase().includes(query),
  );
  const n = pool.length;
  const cursor = typeof body.cursor === 'string' ? body.cursor : null;
  let [lo, hi] = [Math.max(0, n - limit), n];
  if (typeof body.around_message_id === 'string') {
    const position = pool.indexOf(Number(body.around_message_id.slice(1)));
    if (position < 0) return null;
    hi = Math.min(n, position + 1 + Math.floor(limit / 2));
    lo = Math.max(0, position + 1 - (limit - Math.floor(limit / 2)));
  } else if (typeof body.around_sent_at === 'number') {
    const newer = pool.findIndex((index) => sentAt(index) > (body.around_sent_at as number));
    const start = newer < 0 ? n : newer;
    hi = Math.min(n, start + Math.floor(limit / 2));
    lo = Math.max(0, start - (limit - Math.floor(limit / 2)));
  } else if (body.direction === 'Oldest') {
    [lo, hi] = [0, Math.min(n, limit)];
  } else if (cursor?.startsWith('o')) {
    hi = Number(cursor.slice(1));
    lo = Math.max(0, hi - limit);
  } else if (cursor?.startsWith('n')) {
    lo = Number(cursor.slice(1));
    hi = Math.min(n, lo + limit);
  }
  const pattern = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  const items = pool
    .slice(lo, hi)
    .map((index) => {
      const item = message(index, chatType, total, sentAt);
      return {
        ...item,
        headline: query === '' ? null : item.text.replace(pattern, (match) => `${match}`),
      };
    })
    .reverse();
  return { items, older_cursor: lo > 0 ? `o${lo}` : null, newer_cursor: `n${hi}` };
}

// A 1x1 PNG, for the photo of m198 and its thumbnail.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

type Options = {
  chatType?: string;
  total?: number;
  unread?: number;
  // The times follow the real clock instead of October 2026.
  relative?: boolean;
  // Appended to the URL, e.g. `&messengerAnchor=m100`.
  query?: string;
  // The first `messages/list` requests fail with a server error.
  failFirst?: number;
};

// The API speaks snake_case; the account is written in camelCase above for readability, as in the other specs.
const snake = (value: object): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`),
      item !== null && typeof item === 'object' && !Array.isArray(item) ? snake(item) : item,
    ]),
  );

async function openChat(
  page: Page,
  {
    chatType = 'GROUP',
    total = TOTAL,
    unread = 0,
    relative = false,
    query = '',
    failFirst = 0,
  }: Options = {},
) {
  const sentAt = relative ? relativeSentAt(Date.now(), total) : fixedSentAt;
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await installAnalysisNeoApiMocks(page, { userRoles: ['Rer', 'CyberMessengers'] });
  const calls = { messages: [] as Record<string, unknown>[] };
  // `failNext` makes that many of the next `messages/list` requests fail with a server error.
  const control = { failNext: failFirst };
  await page.route('**/api/messenger/media/**', (route) =>
    route.fulfill({ body: PNG, contentType: 'image/png' }),
  );
  await page.route('**/api/messengers/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    const json = (body: unknown) => route.fulfill({ json: body });
    if (path.endsWith('/accounts/list')) return json({ items: [snake(account)] });
    if (path.endsWith('/chats/list')) {
      return json({ items: [chat(chatType, total, sentAt, unread)] });
    }
    if (path.endsWith('/chats/members/list')) {
      return json({ items: chatType === 'PRIVATE' ? [MEMBERS[0]] : MEMBERS });
    }
    if (path.endsWith('/chats/read-state/update')) {
      return json({
        oldest_read_at: sentAt(0),
        newest_read_at: sentAt(total - 1),
        unread_count: 0,
      });
    }
    if (path.endsWith('/attachments/count')) return json({ items: [] });
    if (path.endsWith('/attachments/list')) {
      return json({ items: [], older_cursor: null, newer_cursor: null });
    }
    if (path.endsWith('/messages/list')) {
      const body = route.request().postDataJSON() as Record<string, unknown>;
      calls.messages.push(body);
      if (control.failNext > 0) {
        control.failNext -= 1;
        return route.fulfill({ status: 500, json: { error: 'Сервер недоступний' } });
      }
      const rsp = listMessages(body, chatType, total, sentAt);
      return rsp == null ? route.fulfill({ status: 404, json: { error: 'not found' } }) : json(rsp);
    }
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });
  await page.goto(
    `/rer-analysis-neo?leftPanelOpen=true&leftPanelTab=messenger&messengerAccount=a1&messengerChat=c1${query}`,
  );
  return { calls, control };
}

type Calls = { messages: Record<string, unknown>[] };

const chatView = (page: Page) => page.locator('[data-messenger-chat-view]');
const scroller = (page: Page) => chatView(page).locator('[data-messenger-feed-scroller]');
const bubble = (page: Page, index: number) =>
  chatView(page).locator(`[data-message-id="m${index}"]`);
const pill = (page: Page) => chatView(page).locator('[data-messenger-date-pill]');
const toStart = (page: Page) => chatView(page).getByRole('button', { name: 'На початок чату' });
const toEnd = (page: Page) => chatView(page).getByRole('button', { name: 'В кінець чату' });
const urlParam = (page: Page, name: string) => new URL(page.url()).searchParams.get(name);
const renderedIds = (page: Page) =>
  chatView(page)
    .locator('[data-message-id]')
    .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-message-id')!));
// What the feed itself asked for: every request that is not the search's.
const feedRequests = (calls: Calls) => calls.messages.filter((request) => request.query == null);
const searchRequests = (calls: Calls) => calls.messages.filter((request) => request.query != null);
const clipboard = (page: Page) => page.evaluate(() => navigator.clipboard.readText());
const snackbar = (page: Page) => page.locator('.MuiSnackbar-root');
const scrollTo = (page: Page, position: 'top' | 'bottom') =>
  scroller(page).evaluate((el, where) => {
    el.scrollTop = where === 'top' ? 0 : el.scrollHeight;
  }, position);

// Search bar.
const searchToggle = (page: Page) => chatView(page).locator('[data-messenger-chat-search-toggle]');
const searchInput = (page: Page) => chatView(page).getByRole('combobox', { name: 'Пошук у чаті' });
const hits = (page: Page) => chatView(page).locator('[data-messenger-search-hit]');
const typeQuery = (page: Page, text: string) => searchInput(page).fill(text);
async function openSearch(page: Page) {
  await searchToggle(page).click();
  await expect(searchInput(page)).toBeVisible();
  // The tooltip of the button hangs over the bar while the pointer is on it.
  await page.mouse.move(0, 0);
  await expect(page.getByRole('tooltip')).toHaveCount(0);
}

// The calendar of "Перейти до дати": to the month shown as `month` (e.g. "жовтень 2026"), then the day, by its date. The
// day is found by its timestamp: the grid of the month that is being left is still on the page while the new one slides in.
async function pickDay(page: Page, month: string, isoDate: string) {
  const popover = page.locator('.MuiPopover-root');
  const label = popover.locator('.MuiPickersCalendarHeader-label');
  const previous = popover.locator('.MuiPickersArrowSwitcher-root button').first();
  for (let step = 0; step < 36; step++) {
    if ((await label.innerText()).trim().toLowerCase() === month) break;
    await previous.click();
  }
  await expect(label).toHaveText(new RegExp(`^${month}$`, 'i'));
  await popover.locator(`button[role="gridcell"][data-timestamp="${day(isoDate)}"]`).click();
}
const dateField = (page: Page) => chatView(page).getByRole('textbox', { name: 'Перейти до дати' });
const highlighted = (page: Page) =>
  chatView(page).locator('[data-message-feed-highlighted="true"]');

// ---------------------------------------------------------------------------------------------------------------
// Opening, header, bubbles

test('@smoke messenger chat opens at the newest message with its header and arrows', async ({
  page,
}) => {
  const { calls } = await openChat(page);
  const view = chatView(page);
  await expect(view.getByRole('heading', { name: 'Команда' })).toBeVisible();
  await expect(bubble(page, TOTAL - 3)).toBeInViewport();
  await expect(view.getByText(`Повідомлення ${TOTAL - 3}`, { exact: true })).toBeVisible();
  // One page of 50 from the end, nothing else asked for.
  expect(calls.messages).toHaveLength(1);
  expect(calls.messages[0]).toMatchObject({
    account_id: 'a1',
    chat_id: 'c1',
    limit: 50,
    cursor: null,
    around_message_id: null,
  });
  // At the end of the chat there is nothing to go down to; the start is far above.
  await expect(toEnd(page)).toBeHidden();
  await expect(toStart(page)).toBeVisible();
  await expect(pill(page)).toHaveText(/^22 жовтня/);
  // The header: the search button, and no unread button for a chat that is read.
  await expect(searchToggle(page)).toBeVisible();
  await expect(view.getByRole('button', { name: /До непрочитаних/ })).toHaveCount(0);
});

test('@regression messenger chat back arrow leaves the chat for the account', async ({ page }) => {
  await openChat(page);
  await chatView(page).getByRole('button', { name: 'Назад до акаунта' }).click();
  await expect(chatView(page)).toHaveCount(0);
  await expect.poll(() => urlParam(page, 'messengerChat')).toBeNull();
  expect(urlParam(page, 'messengerAnchor')).toBeNull();
  expect(urlParam(page, 'messengerAccount')).toBe('a1');
});

test('@regression messenger bubbles: incoming on the left, outgoing on the right, names in a group', async ({
  page,
}) => {
  await openChat(page);
  // m207 is Іван's (207 % 3 = 0), m208 Марія's, m209 the account's own (209 % 3 = 2).
  const incoming = bubble(page, 207);
  const outgoing = bubble(page, 209);
  await expect(incoming.locator('[data-messenger-message]')).not.toHaveAttribute(
    'data-messenger-outgoing',
    'true',
  );
  await expect(outgoing.locator('[data-messenger-message]')).toHaveAttribute(
    'data-messenger-outgoing',
    'true',
  );
  const [left, right, box] = [
    await incoming.locator('[data-messenger-copy-text]').boundingBox(),
    await outgoing.locator('[data-messenger-copy-text]').boundingBox(),
    await scroller(page).boundingBox(),
  ];
  expect(left!.x - box!.x).toBeLessThan(box!.width / 3);
  expect(right!.x + right!.width).toBeGreaterThan(box!.x + (box!.width * 2) / 3);
  // A group shows who wrote what, for the others; the account's own messages carry no name.
  await expect(incoming.locator('[data-messenger-sender]')).toHaveText('Іван Петренко');
  await expect(bubble(page, 208).locator('[data-messenger-sender]')).toHaveText('Марія Коваль');
  await expect(outgoing.locator('[data-messenger-sender]')).toHaveCount(0);
  // The time of every message is in its bubble.
  await expect(outgoing).toContainText('22.10.2026, 10:30');
});

test('@regression messenger private chat shows no names', async ({ page }) => {
  await openChat(page, { chatType: 'PRIVATE' });
  await expect(chatView(page).getByRole('heading', { name: 'Ільвіна' })).toBeVisible();
  await expect(bubble(page, 208)).toBeInViewport();
  await expect(chatView(page).locator('[data-messenger-sender]')).toHaveCount(0);
});

test('@regression messenger links in a message open in a new tab', async ({ page }) => {
  await openChat(page, { total: 200 });
  const links = bubble(page, 196).locator('a');
  await expect(links).toHaveCount(2);
  await expect(links.nth(0)).toHaveAttribute('href', 'https://example.com/page');
  await expect(links.nth(1)).toHaveAttribute('href', /^https?:\/\/www\.example\.org/);
  for (const link of await links.all()) {
    await expect(link).toHaveAttribute('target', '_blank');
    await expect(link).toHaveAttribute('rel', /noopener/);
  }
});

test('@regression messenger empty chat says so', async ({ page }) => {
  await openChat(page, { total: 0 });
  await expect(chatView(page).getByText('Повідомлень немає.')).toBeVisible();
  await expect(pill(page)).toHaveCount(0);
  await expect(toStart(page)).toBeHidden();
});

test('@regression messenger failed first load shows the error and can be retried', async ({
  page,
}) => {
  const { calls } = await openChat(page, { failFirst: 1 });
  const view = chatView(page);
  await expect(view.getByRole('alert')).toContainText('Сервер недоступний');
  await expect(bubble(page, 207)).toHaveCount(0);

  await view.getByRole('button', { name: 'Повторити завантаження' }).click();
  await expect(view.getByRole('alert')).toHaveCount(0);
  await expect(bubble(page, 207)).toBeInViewport();
  expect(calls.messages).toHaveLength(2);
});

test('@regression messenger attachments: a photo opens in the preview, missing media says why', async ({
  page,
}) => {
  await openChat(page);
  const photo = bubble(page, 198);
  await photo.scrollIntoViewIfNeeded();
  const thumb = photo.getByRole('button', { name: 'Відкрити зображення' });
  await expect(thumb).toHaveAttribute('data-picture-thumb-state', 'loaded');
  await thumb.click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toBeHidden();

  // m208 and m209 say they had media, and nothing is there: old messages, so it is gone.
  await expect(bubble(page, 208)).toContainText('Вкладення недоступне');
  await expect(bubble(page, 209)).toContainText('Вкладення недоступне');
});

test('@regression messenger date pill says yesterday for the first message on screen, and a fresh message says its media is on the way', async ({
  page,
}) => {
  // Two messages: one from yesterday, one that has just arrived. Both announce media.
  await openChat(page, { total: 2, relative: true });
  await expect(bubble(page, 1)).toBeInViewport();
  // Both fit on the screen, so the first one on it is yesterday's.
  await expect(pill(page)).toHaveText('Вчора');
  // Just arrived: the media may still be coming. Yesterday's is gone.
  await expect(bubble(page, 1)).toContainText('Вкладення завантажується…');
  await expect(bubble(page, 0)).toContainText('Вкладення недоступне');
});

test('@regression messenger date pill says today when the first message on screen is from today', async ({
  page,
}) => {
  await openChat(page, { total: 1, relative: true });
  await expect(bubble(page, 0)).toBeInViewport();
  await expect(pill(page)).toHaveText('Сьогодні');
});

// ---------------------------------------------------------------------------------------------------------------
// Paging, arrows, date pill, address bar

test('@regression messenger chat pages older and newer messages as the reader scrolls, keeping three pages', async ({
  page,
}) => {
  const { calls } = await openChat(page);
  await expect(bubble(page, 160)).toBeAttached();

  // Up: the page before the newest. The message that was on top stays where it was, the new page is above it.
  await scrollTo(page, 'top');
  await expect.poll(() => feedRequests(calls).length).toBe(2);
  expect(feedRequests(calls)[1]).toMatchObject({ direction: 'Older', cursor: 'o160' });
  await expect(bubble(page, 159)).toBeAttached();
  await expect(bubble(page, 160)).toBeInViewport();
  await expect(bubble(page, 120)).not.toBeInViewport();
  await expect(toEnd(page)).toBeVisible();

  // Up again, three more times: the window keeps three pages, so the newest one is dropped.
  for (const [count, cursor] of [
    [3, 'o110'],
    [4, 'o60'],
    [5, 'o10'],
  ] as const) {
    await scrollTo(page, 'top');
    await expect.poll(() => feedRequests(calls).length).toBe(count);
    expect(feedRequests(calls)[count - 1]).toMatchObject({ direction: 'Older', cursor });
  }
  await expect.poll(async () => (await renderedIds(page)).includes('m0')).toBe(true);
  const ids = await renderedIds(page);
  expect(ids.length).toBeLessThanOrEqual(150);
  expect(ids).not.toContain('m209');
  // The start is loaded; the arrow goes once the reader is at it (the scroll anchor keeps them a little lower).
  await scrollTo(page, 'top');
  await expect(toStart(page)).toBeHidden();

  // Down: newer pages come back, and the end of the chat is reached again.
  await expect
    .poll(
      async () => {
        await scrollTo(page, 'bottom');
        return (await renderedIds(page)).includes('m209');
      },
      { timeout: 20_000 },
    )
    .toBe(true);
  expect(feedRequests(calls).some((request) => request.direction === 'Newer')).toBe(true);
  await expect(toEnd(page)).toBeHidden();
});

test('@regression messenger chat shows a paging error with a retry', async ({ page }) => {
  const { calls, control } = await openChat(page);
  await expect(bubble(page, 160)).toBeAttached();
  control.failNext = 1;
  await scrollTo(page, 'top');
  const alert = chatView(page).getByRole('alert');
  await expect(alert).toContainText('Сервер недоступний');
  await expect(bubble(page, 159)).toHaveCount(0);

  await alert.getByRole('button', { name: 'Повторити' }).click();
  await expect(bubble(page, 159)).toBeAttached();
  expect(feedRequests(calls).at(-1)).toMatchObject({ direction: 'Older', cursor: 'o160' });
  await expect(chatView(page).getByRole('alert')).toHaveCount(0);
});

test('@regression messenger go to the start of the chat and back to its end', async ({ page }) => {
  const { calls } = await openChat(page);
  await expect(bubble(page, 207)).toBeInViewport();

  await toStart(page).click();
  expect(feedRequests(calls).at(-1)).toMatchObject({ direction: 'Oldest', cursor: null });
  await expect(bubble(page, 0)).toBeInViewport();
  await expect(pill(page)).toHaveText(/^1 жовтня/);
  // At the start there is no arrow up, and one down.
  await expect(toStart(page)).toBeHidden();
  await expect(toEnd(page)).toBeVisible();

  await toEnd(page).click();
  await expect(bubble(page, 209)).toBeInViewport();
  await expect(toEnd(page)).toBeHidden();
  await expect(pill(page)).toHaveText(/^22 жовтня/);
});

test('@regression messenger date pill follows the first message on the screen', async ({
  page,
}) => {
  // m100 is on 12 October (the tenth day, with 10 October left out).
  await openChat(page, { query: '&messengerAnchor=m100' });
  await expect(bubble(page, 100)).toBeInViewport();
  await expect(pill(page)).toHaveText(/^12 жовтня/);

  // Further down the same page the pill changes with the day.
  await scrollTo(page, 'bottom');
  await expect(pill(page)).not.toHaveText(/^12 жовтня/);
});

test('@regression messenger keeps the first visible message in the address bar and returns to it on reload', async ({
  page,
}) => {
  const { calls } = await openChat(page);
  await expect(bubble(page, 207)).toBeInViewport();
  // The reader is at the end of the chat: nothing to keep.
  await page.waitForTimeout(700);
  expect(urlParam(page, 'messengerChat')).toBe('c1');
  expect(urlParam(page, 'messengerAnchor')).toBeNull();

  await scroller(page).evaluate((el) => {
    el.scrollTop -= 900;
  });
  await expect.poll(() => urlParam(page, 'messengerAnchor')).toMatch(/^m\d+$/);
  const anchor = urlParam(page, 'messengerAnchor')!;

  await page.reload();
  await expect.poll(() => feedRequests(calls).at(-1)?.around_message_id).toBe(anchor);
  await expect(bubble(page, Number(anchor.slice(1)))).toBeInViewport();
  await expect(toEnd(page)).toBeVisible();
});

test('@regression messenger link to a message opens around it, lines it up and flashes it', async ({
  page,
}) => {
  const { calls } = await openChat(page, { query: '&messengerAnchor=m100' });
  await expect(bubble(page, 100)).toBeInViewport();
  expect(feedRequests(calls)[0]).toMatchObject({ around_message_id: 'm100', cursor: null });
  await expect(highlighted(page)).toHaveAttribute('data-message-id', 'm100');
  // Neither end of the chat is loaded, so both arrows are there.
  await expect(toStart(page)).toBeVisible();
  await expect(toEnd(page)).toBeVisible();
});

test('@regression messenger link to a message that is gone opens the chat at its end and says so', async ({
  page,
}) => {
  const { calls } = await openChat(page, { query: '&messengerAnchor=m999' });
  await expect(bubble(page, 207)).toBeInViewport();
  await expect(snackbar(page)).toContainText(
    'Повідомлення не знайдено, можливо, його видалено. Чат відкрито з кінця.',
  );
  // The 404, then the newest page.
  expect(feedRequests(calls)[0]).toMatchObject({ around_message_id: 'm999' });
  expect(feedRequests(calls)[1]).toMatchObject({ around_message_id: null });
  await page.waitForTimeout(700);
  expect(urlParam(page, 'messengerAnchor')).toBeNull();
});

// ---------------------------------------------------------------------------------------------------------------
// Copying

test('@regression messenger copy menu copies the message text and a link to the message', async ({
  page,
}) => {
  await openChat(page);
  const target = bubble(page, 207);
  await target.locator('[data-messenger-menu]').click();
  await page.getByRole('menuitem', { name: 'Копіювати повідомлення', exact: true }).click();
  expect(await clipboard(page)).toBe('Повідомлення 207');

  await target.locator('[data-messenger-menu]').click();
  await page.getByRole('menuitem', { name: 'Копіювати посилання на повідомлення' }).click();
  const link = new URL(await clipboard(page));
  expect(link.pathname).toBe('/rer-analysis-neo');
  expect(link.searchParams.get('messengerChat')).toBe('c1');
  expect(link.searchParams.get('messengerAnchor')).toBe('m207');
  // The header says so for a moment.
  const notice = chatView(page).getByRole('status').filter({ hasText: 'Посилання скопійовано' });
  await expect(notice).toBeVisible();
  await expect(notice).toBeHidden({ timeout: 5000 });
});

test('@regression messenger copying a selection in a private chat adds the names the screen hides', async ({
  page,
}) => {
  await openChat(page, { chatType: 'PRIVATE' });
  await expect(bubble(page, 208)).toBeInViewport();
  // m207 is the account's own (odd), m208 is Іван's.
  await page.evaluate(() => {
    const first = document.querySelector('[data-message-id="m207"] [data-messenger-copy-text]')!;
    const last = document.querySelector('[data-message-id="m208"] [data-messenger-copy-text]')!;
    const range = document.createRange();
    range.setStartBefore(first);
    range.setEndAfter(last);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
  });
  await page.keyboard.press('Control+C');
  const copied = await clipboard(page);
  expect(copied).toContain('Мій акаунт: Повідомлення 207');
  expect(copied).toContain('Іван Петренко: Повідомлення 208');
});

// ---------------------------------------------------------------------------------------------------------------
// Header buttons

test('@regression messenger header buttons are blue icon buttons with tooltips, and the unread count is compact', async ({
  page,
}) => {
  await openChat(page, { unread: 6800 });
  const view = chatView(page);
  const unread = view.getByRole('button', { name: /До непрочитаних/ });
  const search = searchToggle(page);
  // 6800 is "6.8k", never MUI's "99+".
  await expect(unread).toHaveAccessibleName('До непрочитаних (6.8k)');
  await expect(unread.locator('.MuiBadge-badge')).toHaveText('6.8k');
  await expect(unread).toHaveClass(/MuiIconButton-colorPrimary/);
  await expect(search).toHaveClass(/MuiIconButton-colorPrimary/);
  await expect(search).toHaveAccessibleName('Пошук');
  // Icons, not text buttons.
  await expect(search).toHaveText('');

  await unread.hover();
  await expect(page.getByRole('tooltip').filter({ hasText: 'До непрочитаних' })).toHaveText(
    'До непрочитаних (6.8k)',
  );
  await search.hover();
  await expect(page.getByRole('tooltip').filter({ hasText: /^Пошук$/ })).toBeVisible();

  // The search button is marked while the bar is open.
  await expect(search).toHaveAttribute('aria-pressed', 'false');
  await search.click();
  await expect(search).toHaveAttribute('aria-pressed', 'true');
});

// ---------------------------------------------------------------------------------------------------------------
// Search

test('@regression messenger search asks after two letters, once the typing pauses, and shows the hits with the matches marked', async ({
  page,
}) => {
  const { calls } = await openChat(page);
  await expect(bubble(page, 207)).toBeInViewport();
  await expect(chatView(page).locator('[data-messenger-chat-search]')).toHaveCount(0);
  await openSearch(page);

  await typeQuery(page, 'т');
  await page.waitForTimeout(600);
  expect(searchRequests(calls)).toHaveLength(0);

  await typeQuery(page, 'танк');
  await expect(hits(page)).toHaveCount(3);
  expect(searchRequests(calls)).toHaveLength(1);
  expect(searchRequests(calls)[0]).toMatchObject({
    chat_id: 'c1',
    query: 'танк',
    search_mode: 'Fuzzy',
    limit: 20,
    cursor: null,
    around_message_id: null,
  });
  // Newest first: m150, m63 (both Іван's), m7 (Марія's), each with its match marked and "who · when" above it.
  await expect(hits(page).nth(0)).toContainText('Іван Петренко · 17.10.2026, 09:00');
  await expect(hits(page).nth(0).locator('mark')).toHaveText('танк');
  await expect(hits(page).nth(1).locator('mark')).toHaveText('Танк');
  await expect(hits(page).nth(2)).toContainText('Марія Коваль');
  await expect(hits(page).nth(2).locator('mark')).toHaveText('танк');
  // A search never moves the chat.
  expect(feedRequests(calls)).toHaveLength(1);
  await expect(bubble(page, 207)).toBeInViewport();
});

test('@regression messenger search says when nothing matches and when the search fails', async ({
  page,
}) => {
  const { control } = await openChat(page);
  await openSearch(page);
  await typeQuery(page, 'відсутнє');
  await expect(chatView(page).getByText('Нічого не знайдено.')).toBeVisible();

  control.failNext = 1;
  await typeQuery(page, 'танки');
  await expect(chatView(page).getByRole('alert')).toContainText('Сервер недоступний');
});

test('@regression messenger a hit that is not loaded opens the chat around it, flashes it and keeps the text', async ({
  page,
}) => {
  const { calls } = await openChat(page);
  await openSearch(page);
  await typeQuery(page, 'танк');
  await expect(hits(page)).toHaveCount(3);

  // m7 is far above the newest page.
  await hits(page).nth(2).click();
  expect(feedRequests(calls).at(-1)).toMatchObject({ around_message_id: 'm7', query: null });
  await expect(bubble(page, 7)).toBeInViewport();
  await expect(highlighted(page)).toHaveAttribute('data-message-id', 'm7');
  // The list is closed and the text is still there for the next hit.
  await expect(hits(page)).toHaveCount(0);
  await expect(searchInput(page)).toHaveValue('танк');
  await expect(toEnd(page)).toBeVisible();
});

test('@regression messenger a hit that is already loaded is only scrolled to', async ({ page }) => {
  const { calls } = await openChat(page);
  await openSearch(page);
  await typeQuery(page, 'склад');
  await expect(hits(page)).toHaveCount(20);
  // Newest first: m205 is the first hit and is on the loaded page.
  await hits(page).first().click();
  await expect(bubble(page, 205)).toBeInViewport();
  await expect(highlighted(page)).toHaveAttribute('data-message-id', 'm205');
  await page.waitForTimeout(500);
  // Nothing was loaded around it: the feed did not ask for anything.
  expect(feedRequests(calls)).toHaveLength(1);
});

test('@regression messenger search list closes on a click outside, on Escape and when a hit is opened, and comes back with the same hits', async ({
  page,
}) => {
  const { calls } = await openChat(page);
  await openSearch(page);
  await typeQuery(page, 'танк');
  await expect(hits(page)).toHaveCount(3);

  // A click outside: the list goes, the text stays, and the hits are not asked for again when it returns.
  await chatView(page).getByRole('heading', { name: 'Команда' }).click();
  await expect(hits(page)).toHaveCount(0);
  await expect(searchInput(page)).toHaveValue('танк');
  await searchInput(page).click();
  await expect(hits(page)).toHaveCount(3);
  expect(searchRequests(calls)).toHaveLength(1);

  // Escape closes it too, and the input keeps its focus: a click brings it back.
  await page.keyboard.press('Escape');
  await expect(hits(page)).toHaveCount(0);
  await searchInput(page).click();
  await expect(hits(page)).toHaveCount(3);

  // Typing shows it again after it was closed.
  await page.keyboard.press('Escape');
  await expect(hits(page)).toHaveCount(0);
  await searchInput(page).pressSequentially('ж');
  await expect(searchInput(page)).toHaveValue('танкж');
  await expect(chatView(page).getByText('Нічого не знайдено.')).toBeVisible();
});

test('@regression messenger search list works from the keyboard and marks the hit that was opened last', async ({
  page,
}) => {
  const { calls } = await openChat(page);
  await openSearch(page);
  await typeQuery(page, 'танк');
  await expect(hits(page)).toHaveCount(3);

  // Nothing is chosen until an arrow key; Enter with nothing chosen does nothing.
  await searchInput(page).press('Enter');
  expect(feedRequests(calls)).toHaveLength(1);
  await searchInput(page).press('ArrowDown');
  await searchInput(page).press('ArrowDown');
  await expect(hits(page).nth(1)).toHaveAttribute('aria-selected', 'true');
  await expect(searchInput(page)).toHaveAttribute(
    'aria-activedescendant',
    (await hits(page).nth(1).getAttribute('id'))!,
  );
  await searchInput(page).press('ArrowUp');
  await expect(hits(page).nth(0)).toHaveAttribute('aria-selected', 'true');
  await searchInput(page).press('ArrowDown');
  await searchInput(page).press('Enter');

  // m63 was the second hit: the chat is around it, the list is closed.
  await expect(bubble(page, 63)).toBeInViewport();
  await expect(hits(page)).toHaveCount(0);

  // An arrow key brings the list back, with that hit marked.
  await searchInput(page).press('ArrowDown');
  await expect(hits(page)).toHaveCount(3);
  await expect(hits(page).nth(1)).toHaveAttribute('aria-current', 'true');
  await expect(hits(page).nth(0)).not.toHaveAttribute('aria-current', 'true');
  // A new query forgets it.
  // "танки" is only in m7.
  await typeQuery(page, 'танки');
  await expect(hits(page)).toHaveCount(1);
  await expect(
    chatView(page).locator('[data-messenger-search-hit][aria-current="true"]'),
  ).toHaveCount(0);
});

test('@regression messenger search loads older hits with "Показати ще"', async ({ page }) => {
  const { calls } = await openChat(page);
  await openSearch(page);
  await typeQuery(page, 'склад');
  await expect(hits(page)).toHaveCount(20);

  const more = chatView(page).getByRole('button', { name: 'Показати ще' });
  await more.click();
  await expect(hits(page)).toHaveCount(40);
  expect(searchRequests(calls).at(-1)).toMatchObject({ query: 'склад', cursor: 'o21' });
  await more.click();
  await expect(hits(page)).toHaveCount(41);
  await expect(more).toHaveCount(0);
});

test('@regression messenger search bar keeps its text and hits when it is closed and opened again, and the cross clears them', async ({
  page,
}) => {
  const { calls } = await openChat(page);
  await openSearch(page);
  await typeQuery(page, 'танк');
  await expect(hits(page)).toHaveCount(3);

  // Closed with the header button: gone from the screen and from the tab order, but not thrown away.
  await searchToggle(page).click();
  await expect(searchInput(page)).toBeHidden();
  await expect(searchToggle(page)).toHaveAttribute('aria-pressed', 'false');
  await searchToggle(page).click();
  await expect(searchInput(page)).toHaveValue('танк');
  // The press on the header button was outside the field, so the list waits for a click on it.
  await searchInput(page).click();
  await expect(hits(page)).toHaveCount(3);
  expect(searchRequests(calls)).toHaveLength(1);

  await chatView(page).getByRole('button', { name: 'Очистити пошук' }).click();
  await expect(searchInput(page)).toHaveValue('');
  await expect(hits(page)).toHaveCount(0);
});

// ---------------------------------------------------------------------------------------------------------------
// Jump to a date

test('@regression messenger jump to a date lands on the first message of that day, with no calendar icon or typing', async ({
  page,
}) => {
  const { calls } = await openChat(page);
  await openSearch(page);
  const field = dateField(page);
  await expect(field).toHaveAttribute('readonly', '');
  await expect(chatView(page).getByRole('button', { name: 'Відкрити календар' })).toHaveCount(0);
  await field.click();
  await pickDay(page, 'жовтень 2026', '2026-10-05');

  // `around_sent_at` is the millisecond before the day starts.
  expect(feedRequests(calls).at(-1)).toMatchObject({
    around_sent_at: day('2026-10-05') - 1,
    around_message_id: null,
    query: null,
  });
  // 5 October is the fifth day, m40 to m49.
  await expect(bubble(page, 40)).toBeInViewport();
  await expect(highlighted(page)).toHaveAttribute('data-message-id', 'm40');
  await expect(pill(page)).toHaveText(/^5 жовтня/);
  await expect(snackbar(page)).toHaveCount(0);
  // The calendar closed itself, and the field shows the day.
  await expect(page.locator('.MuiPopover-root')).toBeHidden();
  await expect(field).toHaveValue('05.10.2026');
});

test('@regression messenger jump to the same day again jumps again, and the cross only clears the field', async ({
  page,
}) => {
  const { calls } = await openChat(page);
  await openSearch(page);
  await dateField(page).click();
  await pickDay(page, 'жовтень 2026', '2026-10-05');
  await expect(bubble(page, 40)).toBeInViewport();
  const jumps = () => feedRequests(calls).filter((request) => request.around_sent_at != null);
  expect(jumps()).toHaveLength(1);

  // Back to the end, then the same day again: the chosen day is a tap like any other.
  await toEnd(page).click();
  await expect(bubble(page, 209)).toBeInViewport();
  await dateField(page).click();
  await pickDay(page, 'жовтень 2026', '2026-10-05');
  await expect(bubble(page, 40)).toBeInViewport();
  expect(jumps()).toHaveLength(2);

  const before = calls.messages.length;
  await chatView(page).getByRole('button', { name: 'Очистити дату' }).click();
  await expect(dateField(page)).toHaveValue('');
  await expect(page.locator('.MuiPopover-root')).toHaveCount(0);
  expect(calls.messages).toHaveLength(before);
});

test('@regression messenger jump to a day with no messages lands on the nearest one and says so', async ({
  page,
}) => {
  const { calls } = await openChat(page);
  await openSearch(page);
  await dateField(page).click();
  // 10 October has no messages: the first after it is m90, on 11 October.
  await pickDay(page, 'жовтень 2026', '2026-10-10');
  expect(feedRequests(calls).at(-1)).toMatchObject({ around_sent_at: day('2026-10-10') - 1 });
  await expect(bubble(page, 90)).toBeInViewport();
  await expect(snackbar(page)).toContainText('За цю дату повідомлень немає. Показано найближче.');
});

test('@regression messenger jump to a day before the chat began lands on its first message and says so', async ({
  page,
}) => {
  await openChat(page);
  await openSearch(page);
  await dateField(page).click();
  await pickDay(page, 'вересень 2026', '2026-09-30');
  await expect(bubble(page, 0)).toBeInViewport();
  await expect(snackbar(page)).toContainText('За цю дату повідомлень немає. Показано найближче.');
  // At the start: no arrow up.
  await expect(toStart(page)).toBeHidden();
});

test('@regression messenger calendar does not go past the current month', async ({ page }) => {
  await openChat(page);
  await openSearch(page);
  await dateField(page).click();
  // Days after today are off, so there is no month after the current one to go to.
  const popover = page.locator('.MuiPopover-root');
  await expect(popover.locator('.MuiPickersCalendarHeader-label')).toBeVisible();
  await expect(popover.locator('.MuiPickersArrowSwitcher-root button').nth(1)).toBeDisabled();
});

// ---------------------------------------------------------------------------------------------------------------
// Phone

test.describe('on a phone', () => {
  test.use({ viewport: { width: 400, height: 800 } });

  test('@regression messenger search bar on a phone: the date is only an icon, the search takes the rest, and a tap on a day jumps', async ({
    page,
  }) => {
    const { calls } = await openChat(page);
    // The account list is a drawer over the workspace; the account is already picked from the URL.
    await page.getByRole('button', { name: 'Закрити ліву панель' }).click();
    await expect(bubble(page, 207)).toBeInViewport();
    await openSearch(page);

    // No field to read or type in: an icon button.
    await expect(dateField(page)).toHaveCount(0);
    const icon = chatView(page).getByRole('button', { name: 'Перейти до дати' });
    await expect(icon).toBeVisible();
    const [view, input, iconBox] = [
      await chatView(page).boundingBox(),
      await searchInput(page).boundingBox(),
      await icon.boundingBox(),
    ];
    // The search is the rest of the row: more than half the width, and the icon is beside it, inside the screen.
    expect(input!.width).toBeGreaterThan(view!.width / 2);
    expect(iconBox!.x).toBeGreaterThan(input!.x + input!.width - 1);
    expect(iconBox!.x + iconBox!.width).toBeLessThanOrEqual(view!.x + view!.width + 1);

    await icon.click();
    await pickDay(page, 'жовтень 2026', '2026-10-05');
    expect(feedRequests(calls).at(-1)).toMatchObject({ around_sent_at: day('2026-10-05') - 1 });
    await expect(bubble(page, 40)).toBeInViewport();
    // The day is not shown anywhere, and there is nothing to clear.
    await expect(chatView(page).getByRole('button', { name: 'Очистити дату' })).toHaveCount(0);
  });

  test('@regression messenger search on a phone: a tap on a hit opens it and closes the list', async ({
    page,
  }) => {
    await openChat(page);
    await page.getByRole('button', { name: 'Закрити ліву панель' }).click();
    await openSearch(page);
    await typeQuery(page, 'танк');
    await expect(hits(page)).toHaveCount(3);
    await hits(page).nth(2).click();
    await expect(bubble(page, 7)).toBeInViewport();
    await expect(hits(page)).toHaveCount(0);
    await expect(searchInput(page)).toHaveValue('танк');
  });
});
