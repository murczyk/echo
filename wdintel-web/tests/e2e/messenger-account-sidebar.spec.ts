import { expect, test, type Page } from '@playwright/test';
import { installAnalysisNeoApiMocks } from './analysis-neo.fixtures';

const T0 = Date.UTC(2026, 8, 12, 12);
const EXTERNAL_URL = 'https://example.com/accounts/1';
const SIDEBAR_OPEN_KEY = 'messenger-account-sidebar-open';

const makeAccount = (externalUrl: string | null = EXTERNAL_URL) => ({
  id: 'a1',
  messengerType: 'Telegram',
  externalId: '7',
  displayName: 'Альфа',
  username: 'alpha_user',
  firstName: null,
  lastName: null,
  phone: '380501234567',
  status: null,
  statusError: null,
  statusChangedAt: null,
  isActive: true,
  isPaused: false,
  createdAt: null,
  lastSync: null,
  notes: null,
  internalNotes: null,
  externalUrl,
  avatarUrl: null,
  telegram: null,
  datasourceGroup: { id: 'g1', name: 'Група' },
});

type ChatOptions = { unread?: number; isBot?: boolean | null; username?: string | null };
const chat = (id: string, title: string, chatType: string, options: ChatOptions = {}) => ({
  id,
  messengerType: 'Telegram',
  externalId: id,
  chatType,
  title,
  username: options.username ?? null,
  membersCount: null,
  accountMemberStatus: null,
  lastMessageDate: T0,
  isBot: options.isBot ?? null,
  avatarUrl: null,
  telegram: null,
  oldestReadAt: null,
  newestReadAt: null,
  unreadCount: options.unread ?? 0,
  totalCount: 3,
});

// Two private chats, a group, a channel and a bot; two of them have unread messages.
const defaultChats = () => [
  chat('c1', 'Іван', 'PRIVATE', { unread: 4, isBot: false }),
  chat('c2', 'Марія', 'PRIVATE', { isBot: false }),
  chat('c3', 'Команда', 'GROUP'),
  chat('c4', 'Канал новин', 'CHANNEL', { unread: 7, username: 'news_channel' }),
  chat('c5', 'Помічник', 'PRIVATE', { isBot: true, username: 'helper_bot' }),
];

type State = {
  account: ReturnType<typeof makeAccount>;
  chats: ReturnType<typeof chat>[];
  // How many `chats/list` requests fail before one succeeds.
  chatsFailures: number;
  markAllStatus: number;
  markAllCalls: number;
};

// The API speaks snake_case; the client turns it into camelCase.
function snake(value: object): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`),
      item !== null && typeof item === 'object' && !Array.isArray(item) ? snake(item) : item,
    ]),
  );
}

async function openSidebar(page: Page, overrides: Partial<State> = {}, query = '') {
  const state: State = {
    account: makeAccount(),
    chats: defaultChats(),
    chatsFailures: 0,
    markAllStatus: 200,
    markAllCalls: 0,
    ...overrides,
  };
  await installAnalysisNeoApiMocks(page, { userRoles: ['Rer', 'CyberMessengers'] });
  await page.route('**/api/messengers/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    const json = (body: unknown) => route.fulfill({ json: body });
    if (path.endsWith('/accounts/list')) return json({ items: [snake(state.account)] });
    if (path.endsWith('/chats/list')) {
      if (state.chatsFailures > 0) {
        state.chatsFailures -= 1;
        return route.fulfill({ status: 500, json: { error: 'Збій сервера' } });
      }
      return json({ items: state.chats.map(snake) });
    }
    if (path.endsWith('/chats/mark-all-read')) {
      state.markAllCalls += 1;
      if (state.markAllStatus !== 200) {
        return route.fulfill({ status: state.markAllStatus, json: { error: 'Збій сервера' } });
      }
      state.chats = state.chats.map((item) => ({ ...item, unreadCount: 0 }));
      return json(null);
    }
    if (path.endsWith('/messages/list')) {
      return json({ items: [], older_cursor: null, newer_cursor: null });
    }
    if (path.endsWith('/contacts/list')) {
      return json({ items: [], total: 0, page: 1, page_size: 50 });
    }
    if (path.endsWith('/attachments/count')) return json({ items: [] });
    if (path.endsWith('/attachments/list')) {
      return json({ items: [], older_cursor: null, newer_cursor: null });
    }
    if (path.endsWith('/chats/members/list')) return json({ items: [] });
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });
  await page.goto(
    `/rer-analysis-neo?leftPanelOpen=true&leftPanelTab=messenger&messengerAccount=a1${query}`,
  );
  return state;
}

const sidebar = (page: Page) =>
  page.getByRole('complementary', { name: 'Навігація акаунту', exact: true });
const rail = (page: Page) => page.locator('[data-messenger-sidebar-rail]');
const kind = (page: Page, title: string) =>
  sidebar(page).locator('section').filter({ hasText: title });
const row = (page: Page, title: string) =>
  sidebar(page).locator('[data-messenger-chat]').filter({ hasText: title });
const chatView = (page: Page) => page.locator('[data-messenger-chat-view]');
// The cards of the account, which show while no chat, contacts or gallery is open.
const accountCards = (page: Page) => page.getByText('Внутрішній опис').first();
const hideSidebar = (page: Page) =>
  page.getByRole('button', { name: 'Згорнути панель акаунту' }).click();
const showSidebar = (page: Page) =>
  page.getByRole('button', { name: 'Розгорнути панель акаунту' }).click();

test('@regression messenger sidebar sorts chats into private, groups, channels and bots, and folds each kind', async ({
  page,
}) => {
  await openSidebar(page);
  await expect(kind(page, 'Приватні (2)')).toContainText('Іван');
  await expect(kind(page, 'Приватні (2)')).toContainText('Марія');
  await expect(kind(page, 'Групи (1)')).toContainText('Команда');
  await expect(kind(page, 'Канали (1)')).toContainText('Канал новин');
  await expect(kind(page, 'Боти (1)')).toContainText('Помічник');
  // A bot is a private chat flagged as one, and is listed only under the bots.
  await expect(kind(page, 'Приватні (2)')).not.toContainText('Помічник');

  const header = kind(page, 'Групи (1)').getByRole('button', { name: 'Групи (1)' });
  await expect(header).toHaveAttribute('aria-expanded', 'true');
  await header.click();
  await expect(header).toHaveAttribute('aria-expanded', 'false');
  await expect(row(page, 'Команда')).toBeHidden();
  await header.click();
  await expect(header).toHaveAttribute('aria-expanded', 'true');
  await expect(row(page, 'Команда')).toBeVisible();
});

test('@regression messenger sidebar opens a chat of every kind, marks it, and marks the folded kind that holds it', async ({
  page,
}) => {
  await openSidebar(page);
  for (const title of ['Іван', 'Команда', 'Канал новин', 'Помічник']) {
    await row(page, title).click();
    await expect(chatView(page).getByRole('heading', { name: title })).toBeVisible();
    // Exactly one row is open, and it is this one.
    await expect(sidebar(page).locator('[data-messenger-chat][data-selected="true"]')).toHaveCount(
      1,
    );
    await expect(row(page, title)).toHaveAttribute('data-selected', 'true');
    await expect(row(page, title)).toHaveAttribute('aria-current', 'true');
  }

  // The bot is open: folding its kind marks the kind, so the open chat is not lost; unfolding clears the mark.
  const bots = kind(page, 'Боти (1)');
  await expect(bots).toHaveAttribute('data-selected', 'false');
  await bots.getByRole('button', { name: 'Боти (1)' }).click();
  await expect(bots).toHaveAttribute('data-selected', 'true');
  await bots.getByRole('button', { name: 'Боти (1)' }).click();
  await expect(bots).toHaveAttribute('data-selected', 'false');

  // The back arrow of the chat leads to the account cards and nothing stays open.
  await chatView(page).getByRole('button', { name: 'Назад до акаунта' }).click();
  await expect(chatView(page)).toBeHidden();
  await expect(accountCards(page)).toBeVisible();
  await expect(sidebar(page).locator('[data-messenger-chat][data-selected="true"]')).toHaveCount(0);
});

test('@regression messenger sidebar search filters the chats by title and username, and clearing it brings them back', async ({
  page,
}) => {
  await openSidebar(page);
  const search = sidebar(page).getByRole('textbox', { name: 'Пошук чату' });

  // By title, whatever the case.
  await search.fill('ІВАН');
  await expect(kind(page, 'Приватні (1)')).toContainText('Іван');
  await expect(kind(page, 'Групи (0)')).toContainText('Немає чатів');
  await expect(kind(page, 'Канали (0)')).toContainText('Немає чатів');
  await expect(kind(page, 'Боти (0)')).toContainText('Немає чатів');

  // By username.
  await search.fill('news_chan');
  await expect(kind(page, 'Канали (1)')).toContainText('Канал новин');
  await expect(kind(page, 'Приватні (0)')).toBeVisible();
  await search.fill('helper');
  await expect(kind(page, 'Боти (1)')).toContainText('Помічник');

  // Nothing matches: every kind is empty.
  await search.fill('zzz');
  for (const title of ['Приватні (0)', 'Групи (0)', 'Канали (0)', 'Боти (0)']) {
    await expect(kind(page, title)).toContainText('Немає чатів');
  }

  // Blanks do not filter; the clear button empties the field.
  await search.fill('   ');
  await expect(kind(page, 'Приватні (2)')).toBeVisible();
  await search.fill('Марія');
  await expect(kind(page, 'Приватні (1)')).toContainText('Марія');
  await sidebar(page).getByRole('button', { name: 'Очистити пошук' }).click();
  await expect(search).toHaveValue('');
  await expect(kind(page, 'Приватні (2)')).toBeVisible();
  await expect(kind(page, 'Групи (1)')).toBeVisible();
});

test('@regression messenger sidebar offers the source link only for an http(s) address, and opens it in a new tab', async ({
  page,
  context,
}) => {
  const state = await openSidebar(page);
  // The source is not fetched from the network.
  await context.route('https://example.com/**', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<title>Джерело</title>' }),
  );
  const link = sidebar(page).locator('a[data-messenger-nav="external"]');
  await expect(link).toHaveText('Відкрити джерело');
  await expect(link).toHaveAttribute('href', EXTERNAL_URL);
  await expect(link).toHaveAttribute('target', '_blank');
  await expect(link).toHaveAttribute('rel', /noopener/);

  const [tab] = await Promise.all([context.waitForEvent('page'), link.click()]);
  await tab.waitForLoadState();
  expect(tab.url()).toBe(EXTERNAL_URL);
  await tab.close();
  // The analysis page stays where it was, and the link is no page: it is never marked as the open item.
  await expect(page).toHaveURL(/messengerAccount=a1/);
  await expect(link).not.toHaveAttribute('data-selected', 'true');
  await expect(link).not.toHaveAttribute('aria-current', 'true');

  // The rail has the same link, as a button with the same name.
  await hideSidebar(page);
  const railLink = rail(page).locator('a[data-messenger-rail-external]');
  await expect(railLink).toHaveAttribute('href', EXTERNAL_URL);
  await expect(railLink).toHaveAttribute('aria-label', 'Відкрити джерело');
  await expect(railLink).toHaveAttribute('target', '_blank');
  const [railTab] = await Promise.all([context.waitForEvent('page'), railLink.click()]);
  await railTab.waitForLoadState();
  expect(railTab.url()).toBe(EXTERNAL_URL);
  await railTab.close();
});

// No address, or one that is not http(s), gives no link in either layer.
for (const [name, externalUrl] of [
  ['has no address', null],
  ['has a javascript: address', 'javascript:alert(1)'],
  ['has an address that is not http(s)', 'ftp://example.com/accounts/1'],
] as const) {
  test(`@regression messenger sidebar has no source link when the account ${name}`, async ({
    page,
  }) => {
    await openSidebar(page, { account: makeAccount(externalUrl) });
    await expect(sidebar(page).locator('[data-messenger-nav="gallery"]')).toBeVisible();
    await hideSidebar(page);
    await expect(rail(page).locator('[data-messenger-rail-nav="gallery"]')).toBeVisible();
    await expect(
      page.locator('a[data-messenger-nav="external"], a[data-messenger-rail-external]'),
    ).toHaveCount(0);
  });
}

test('@regression messenger sidebar opens the gallery and the contacts, marks them, and leads back to the account', async ({
  page,
}) => {
  await openSidebar(page);
  const gallery = sidebar(page).locator('[data-messenger-nav="gallery"]');
  const contacts = sidebar(page).locator('[data-messenger-nav="contacts"]');
  await expect(gallery).toHaveText('Галерея');
  await expect(contacts).toHaveText('Контакти');
  await expect(accountCards(page)).toBeVisible();

  await gallery.click();
  await expect(page.getByRole('heading', { name: 'Галерея акаунту' })).toBeVisible();
  await expect(page).toHaveURL(/messengerView=gallery/);
  await expect(gallery).toHaveAttribute('aria-current', 'true');
  await expect(contacts).not.toHaveAttribute('aria-current', 'true');
  await expect(accountCards(page)).toBeHidden();

  await contacts.click();
  await expect(page.getByRole('heading', { name: 'Контакти акаунту' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Галерея акаунту' })).toBeHidden();
  await expect(page).toHaveURL(/messengerView=contacts/);
  await expect(contacts).toHaveAttribute('aria-current', 'true');
  await expect(gallery).not.toHaveAttribute('aria-current', 'true');

  // The back arrow of the view leads to the account cards and drops the view from the address.
  await page.getByRole('button', { name: 'Назад до акаунта' }).click();
  await expect(accountCards(page)).toBeVisible();
  await expect(page).not.toHaveURL(/messengerView=/);

  // A view takes the place of an open chat, and a chat the place of a view.
  await row(page, 'Іван').click();
  await expect(chatView(page)).toBeVisible();
  await gallery.click();
  await expect(page.getByRole('heading', { name: 'Галерея акаунту' })).toBeVisible();
  await expect(chatView(page)).toBeHidden();
  await expect(sidebar(page).locator('[data-messenger-chat][data-selected="true"]')).toHaveCount(0);
  await row(page, 'Команда').click();
  await expect(chatView(page)).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Галерея акаунту' })).toBeHidden();
  await expect(gallery).not.toHaveAttribute('aria-current', 'true');

  // The rail opens the same pages and marks the open one.
  await hideSidebar(page);
  const railContacts = rail(page).locator('[data-messenger-rail-nav="contacts"]');
  const railGallery = rail(page).locator('[data-messenger-rail-nav="gallery"]');
  await railContacts.click();
  await expect(page.getByRole('heading', { name: 'Контакти акаунту' })).toBeVisible();
  await expect(railContacts).toHaveAttribute('aria-current', 'true');
  await railGallery.click();
  await expect(page.getByRole('heading', { name: 'Галерея акаунту' })).toBeVisible();
  await expect(railGallery).toHaveAttribute('aria-current', 'true');
  await expect(railContacts).not.toHaveAttribute('aria-current', 'true');
});

test('@regression messenger sidebar copies the account details, and a click on the blank or the avatar goes back to the cards', async ({
  page,
  context,
}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  // Tall enough for the list to end above the bottom of the sidebar, which leaves some blank space under it.
  await page.setViewportSize({ width: 1280, height: 1500 });
  await openSidebar(page);
  const copied = () => page.evaluate(() => navigator.clipboard.readText());
  for (const [value, text] of [
    ['Альфа', 'Альфа'],
    ['+380501234567', '+380501234567'],
    ['@alpha_user', '@alpha_user'],
  ]) {
    await sidebar(page).getByText(value, { exact: true }).click();
    await expect.poll(copied).toBe(text);
    // The one of the previous value may still be fading out, so it is the newest that counts.
    await expect(page.getByRole('tooltip', { name: 'Скопійовано' }).last()).toBeVisible();
  }
  // Copying is not navigating: the account cards are still the open item.
  await expect(accountCards(page)).toBeVisible();

  await row(page, 'Іван').click();
  await expect(chatView(page)).toBeVisible();
  // The avatar in the account info is not a copy value: it leads back to the account cards.
  await sidebar(page).locator('[data-messenger-account-avatar]').first().click();
  await expect(chatView(page)).toBeHidden();
  await expect(accountCards(page)).toBeVisible();

  await row(page, 'Команда').click();
  await expect(chatView(page)).toBeVisible();
  // So does a click on the blank space under the list.
  const box = (await sidebar(page).boundingBox())!;
  await sidebar(page).click({ position: { x: 8, y: box.height - 8 } });
  await expect(chatView(page)).toBeHidden();
  await expect(accountCards(page)).toBeVisible();
});

test('@regression messenger sidebar unread filter keeps the unread chats and the open one, and read all asks first', async ({
  page,
}) => {
  const state = await openSidebar(page);
  const only = sidebar(page).getByRole('checkbox', { name: 'Лише непрочитані' });
  const readAll = sidebar(page).getByRole('button', { name: 'Прочитати всі' });
  await expect(sidebar(page).locator('[data-messenger-unread-badge]')).toHaveText(['4', '7']);
  await expect(readAll).toBeEnabled();

  await only.check();
  await expect(kind(page, 'Приватні (1)')).toContainText('Іван');
  await expect(kind(page, 'Групи (0)')).toBeVisible();
  await expect(kind(page, 'Канали (1)')).toContainText('Канал новин');
  await expect(kind(page, 'Боти (0)')).toBeVisible();
  await only.uncheck();
  await expect(kind(page, 'Приватні (2)')).toBeVisible();

  // The open chat stays in the filtered list although it has nothing unread, so it does not vanish under the reader.
  await row(page, 'Марія').click();
  await expect(chatView(page)).toBeVisible();
  await only.check();
  await expect(kind(page, 'Приватні (2)')).toContainText('Марія');
  await only.uncheck();

  // "No" changes nothing; "Yes" marks every chat read, once, and then there is nothing left to read.
  await readAll.click();
  await expect(page.getByRole('dialog', { name: 'Прочитати всі чати?' })).toBeVisible();
  await page.getByRole('dialog').getByRole('button', { name: 'Ні', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeHidden();
  expect(state.markAllCalls).toBe(0);
  await expect(sidebar(page).locator('[data-messenger-unread-badge]')).toHaveCount(2);

  await readAll.click();
  await page.getByRole('dialog').getByRole('button', { name: 'Так', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeHidden();
  await expect(sidebar(page).locator('[data-messenger-unread-badge]')).toHaveCount(0);
  await expect(readAll).toBeDisabled();
  expect(state.markAllCalls).toBe(1);
  // With nothing unread the filter shows nothing but the open chat.
  await only.check();
  await expect(kind(page, 'Приватні (1)')).toContainText('Марія');
  await expect(kind(page, 'Канали (0)')).toBeVisible();
});

test('@regression messenger sidebar says so when read all fails, and keeps the unread counts', async ({
  page,
}) => {
  const state = await openSidebar(page, { markAllStatus: 500 });
  await sidebar(page).getByRole('button', { name: 'Прочитати всі' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Так', exact: true }).click();
  await expect(page.getByText('Не вдалося позначити чати прочитаними.')).toBeVisible();
  await expect(page.getByRole('dialog')).toBeHidden();
  expect(state.markAllCalls).toBe(1);
  await expect(sidebar(page).locator('[data-messenger-unread-badge]')).toHaveText(['4', '7']);
  await expect(sidebar(page).getByRole('button', { name: 'Прочитати всі' })).toBeEnabled();
});

test('@regression messenger sidebar folds into a rail that remembers its state and keeps the search text', async ({
  page,
}) => {
  await openSidebar(page);
  const box = page.locator('[data-messenger-sidebar]');
  await expect(box).toHaveAttribute('data-open', 'true');
  const search = () => sidebar(page).getByRole('textbox', { name: 'Пошук чату' });
  await search().fill('Іван');

  await hideSidebar(page);
  await expect(box).toHaveAttribute('data-open', 'false');
  await expect(
    page.getByRole('complementary', { name: 'Навігація акаунту (згорнуто)' }),
  ).toBeVisible();
  // The hidden layer is neither read out nor reachable.
  await expect(sidebar(page)).toHaveCount(0);
  expect(await page.evaluate((key) => localStorage.getItem(key), SIDEBAR_OPEN_KEY)).toBe('false');

  // The rail: every kind has its icon with the number of chats, folded at first. The chat search does not filter it.
  const toggle = (key: string) =>
    rail(page).locator(`[data-messenger-rail-section-toggle="${key}"]`);
  await expect(toggle('private')).toHaveAttribute('aria-label', 'Приватні: 2');
  await expect(toggle('private')).toHaveAttribute('aria-expanded', 'false');
  await expect(rail(page).locator('[data-messenger-rail-chat]')).toHaveCount(0);

  // The toggle brings the full sidebar back, with the search text as it was left.
  await showSidebar(page);
  await expect(box).toHaveAttribute('data-open', 'true');
  await expect(search()).toHaveValue('Іван');
  expect(await page.evaluate((key) => localStorage.getItem(key), SIDEBAR_OPEN_KEY)).toBe('true');

  // The account button of the rail opens the account cards and does not unfold the rail.
  await hideSidebar(page);
  await rail(page).locator('[data-messenger-rail-account]').click();
  await expect(accountCards(page)).toBeVisible();
  await expect(box).toHaveAttribute('data-open', 'false');

  // The choice survives a reload.
  await page.reload();
  await expect(box).toHaveAttribute('data-open', 'false', { timeout: 20_000 });
});

test('@regression messenger rail opens the avatars of a kind, opens a chat, and has the unread filter and read all', async ({
  page,
}) => {
  const state = await openSidebar(page);
  await hideSidebar(page);
  const toggle = (key: string) =>
    rail(page).locator(`[data-messenger-rail-section-toggle="${key}"]`);
  const chats = rail(page).locator('[data-messenger-rail-chat]');
  await expect(toggle('private')).toHaveAttribute('aria-label', 'Приватні: 2');
  await expect(toggle('group')).toHaveAttribute('aria-label', 'Групи: 1');
  await expect(toggle('channel')).toHaveAttribute('aria-label', 'Канали: 1');
  await expect(toggle('bot')).toHaveAttribute('aria-label', 'Боти: 1');

  await toggle('private').click();
  await expect(toggle('private')).toHaveAttribute('aria-expanded', 'true');
  await expect(chats).toHaveCount(2);
  await expect(rail(page).locator('[data-messenger-rail-chat="c1"]')).toHaveAttribute(
    'aria-label',
    'Іван, непрочитаних: 4',
  );
  await toggle('private').click();
  await expect(toggle('private')).toHaveAttribute('aria-expanded', 'false');
  await expect(chats).toHaveCount(0);

  // A chat opens from its avatar and is marked; its folded kind is marked too.
  await toggle('group').click();
  await rail(page).locator('[data-messenger-rail-chat="c3"]').click();
  await expect(chatView(page).getByRole('heading', { name: 'Команда' })).toBeVisible();
  await expect(rail(page).locator('[data-messenger-rail-chat="c3"]')).toHaveAttribute(
    'data-selected',
    'true',
  );
  await toggle('group').click();
  await expect(toggle('group')).toHaveAttribute('data-selected', 'true');

  // The unread filter is a switch; a kind with nothing left in it cannot be opened.
  const unread = rail(page).locator('[data-messenger-rail-unread]');
  await expect(unread).toHaveAttribute('aria-pressed', 'false');
  await unread.click();
  await expect(unread).toHaveAttribute('aria-pressed', 'true');
  await expect(toggle('bot')).toHaveAttribute('aria-label', 'Боти: 0');
  await expect(toggle('bot')).toHaveAttribute('aria-disabled', 'true');
  await expect(toggle('bot')).toHaveAttribute('aria-expanded', 'false');
  await expect(toggle('channel')).toHaveAttribute('aria-label', 'Канали: 1');
  await unread.click();
  await expect(unread).toHaveAttribute('aria-pressed', 'false');

  // Read all, from the rail, asks first as well.
  const readAll = rail(page).locator('[data-messenger-rail-read-all]');
  await expect(readAll).toBeEnabled();
  await readAll.click();
  await page.getByRole('dialog').getByRole('button', { name: 'Так', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeHidden();
  expect(state.markAllCalls).toBe(1);
  await expect(readAll).toBeDisabled();
});

test('@regression messenger sidebar keeps a long list of chats light, and a chat far down is reachable', async ({
  page,
}) => {
  const many = Array.from({ length: 120 }, (_, index) =>
    chat(`m${index + 1}`, `Чат ${String(index + 1).padStart(3, '0')}`, 'PRIVATE', {
      isBot: false,
    }),
  );
  await openSidebar(page, { chats: many });
  await expect(kind(page, 'Приватні (120)')).toBeVisible();
  await expect(page.locator('[data-messenger-virtual-list]')).toHaveCount(1);
  // Only the rows near the view are in the page.
  const rendered = await sidebar(page).locator('[data-messenger-chat]').count();
  expect(rendered).toBeGreaterThan(0);
  expect(rendered).toBeLessThan(120);
  await expect(row(page, 'Чат 120')).toHaveCount(0);

  await sidebar(page).evaluate((element) => element.scrollTo(0, element.scrollHeight));
  await expect(row(page, 'Чат 120')).toBeVisible();
  await row(page, 'Чат 120').click();
  await expect(chatView(page).getByRole('heading', { name: 'Чат 120' })).toBeVisible();
});

test('@regression messenger sidebar on a phone takes the whole width, and what it leads to closes it', async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 800 });
  await openSidebar(page);
  // On a phone the account list is a drawer over the workspace; the account is already picked from the URL.
  await page.getByRole('button', { name: 'Закрити ліву панель' }).click();
  const box = page.locator('[data-messenger-sidebar]');
  await expect(box).toHaveAttribute('data-mobile', 'true');
  // It starts closed, as a rail.
  await expect(box).toHaveAttribute('data-open', 'false');

  await showSidebar(page);
  await expect(box).toHaveAttribute('data-open', 'true');
  await expect.poll(async () => (await box.boundingBox())!.width).toBeGreaterThan(360);

  // Choosing a chat closes it to show the chat.
  await row(page, 'Іван').click();
  await expect(box).toHaveAttribute('data-open', 'false');
  await expect(chatView(page).getByRole('heading', { name: 'Іван' })).toBeVisible();

  // So do the pages and the account cards.
  await showSidebar(page);
  await sidebar(page).locator('[data-messenger-nav="gallery"]').click();
  await expect(box).toHaveAttribute('data-open', 'false');
  await expect(page.getByRole('heading', { name: 'Галерея акаунту' })).toBeVisible();
  await showSidebar(page);
  await sidebar(page).locator('[data-messenger-nav="contacts"]').click();
  await expect(box).toHaveAttribute('data-open', 'false');
  await expect(page.getByRole('heading', { name: 'Контакти акаунту' })).toBeVisible();

  // That state is not remembered: it does not touch the choice made on a wide screen.
  expect(await page.evaluate((key) => localStorage.getItem(key), SIDEBAR_OPEN_KEY)).toBeNull();
});

test('@regression messenger sidebar shows a failed chat list with a retry that loads it', async ({
  page,
}) => {
  await openSidebar(page, { chatsFailures: 1 });
  const alert = sidebar(page).getByRole('alert');
  await expect(alert).toBeVisible();
  await expect(kind(page, 'Приватні')).toHaveCount(0);
  await sidebar(page).getByRole('button', { name: 'Повторити завантаження' }).click();
  await expect(alert).toBeHidden();
  await expect(kind(page, 'Приватні (2)')).toContainText('Іван');
});
