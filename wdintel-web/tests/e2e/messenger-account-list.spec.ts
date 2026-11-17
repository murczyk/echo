import { expect, test, type Locator, type Page } from '@playwright/test';
import { installAnalysisNeoApiMocks } from './analysis-neo.fixtures';

const T0 = Date.UTC(2026, 8, 12, 12);

// A 1x1 PNG: enough for the browser to count an avatar as loaded.
const AVATAR_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);
const AVATAR_OK_ID = 'ok';
const AVATAR_OK = `/api/messengers/avatars/${AVATAR_OK_ID}`;
// The server answers 404 for it, as for an avatar that is gone or not the caller's.
const AVATAR_GONE_ID = 'gone';
const AVATAR_GONE = `/api/messengers/avatars/${AVATAR_GONE_ID}`;

const account = (id: string, displayName: string, username: string, avatarId: string | null) => ({
  id,
  messengerType: 'Telegram',
  externalId: id,
  displayName,
  username,
  firstName: null,
  lastName: null,
  phone: `+10${id.slice(1)}`,
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
  avatarId,
  telegram: null,
  datasourceGroup: { id: 'g1', name: 'Група' },
});

const accounts = [
  account('a1', 'Альфа', 'alpha_user', AVATAR_OK_ID),
  account('a2', 'Браво', 'bravo_user', AVATAR_GONE_ID),
  account('a3', 'Чарлі', 'charlie_user', null),
];

const chat = (
  id: string,
  title: string,
  chatType: string,
  isBot: boolean | null,
  avatarId: string | null,
) => ({
  id,
  messengerType: 'Telegram',
  externalId: id,
  chatType,
  title,
  username: null,
  membersCount: null,
  accountMemberStatus: null,
  lastMessageDate: T0,
  isBot,
  avatarId,
  telegram: null,
  oldestReadAt: null,
  newestReadAt: null,
  unreadCount: 0,
  totalCount: 3,
});

const chats = [
  chat('c1', 'Помічник', 'PRIVATE', true, AVATAR_OK_ID),
  chat('c2', 'Іван', 'PRIVATE', false, null),
  chat('c3', 'Команда', 'GROUP', null, null),
];

// The API speaks snake_case; the client turns it into camelCase.
function snake(value: object): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`),
      item !== null && typeof item === 'object' && !Array.isArray(item) ? snake(item) : item,
    ]),
  );
}

type State = {
  roles: string[];
  accounts: typeof accounts;
  // How many `accounts/list` requests fail before one succeeds.
  accountsFailures: number;
  // While set, `accounts/list` answers only after it has settled.
  accountsGate: Promise<void> | null;
  accountsCalls: number;
};

async function openLeftPanel(page: Page, query = '', overrides: Partial<State> = {}) {
  const state: State = {
    roles: ['Rer', 'CyberMessengers'],
    accounts,
    accountsFailures: 0,
    accountsGate: null,
    accountsCalls: 0,
    ...overrides,
  };
  await installAnalysisNeoApiMocks(page, { userRoles: state.roles });
  // Registered after the shared mocks, so it answers first and also the image requests, which they let through.
  await page.route('**/api/messengers/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    const json = (body: unknown) => route.fulfill({ json: body });
    if (path === AVATAR_OK) {
      return route.fulfill({ body: AVATAR_PNG, contentType: 'image/png' });
    }
    if (path === AVATAR_GONE) return route.fulfill({ status: 404, json: { error: 'not found' } });
    if (path.endsWith('/accounts/list')) {
      state.accountsCalls += 1;
      if (state.accountsGate) await state.accountsGate;
      if (state.accountsFailures > 0) {
        state.accountsFailures -= 1;
        return route.fulfill({ status: 500, json: { error: 'Збій сервера' } });
      }
      return json({ items: state.accounts.map(snake) });
    }
    if (path.endsWith('/chats/list')) return json({ items: chats.map(snake) });
    if (path.endsWith('/chats/members/list')) return json({ items: [] });
    if (path.endsWith('/attachments/count')) return json({ items: [] });
    if (path.endsWith('/attachments/list')) {
      return json({ items: [], older_cursor: null, newer_cursor: null });
    }
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });
  await page.goto(`/rer-analysis-neo?leftPanelOpen=true${query}`);
  return state;
}

// The width of the picture of an avatar, which is 0 until it has loaded.
const loadedWidth = (avatar: Locator) =>
  avatar.locator('img').evaluate((image: HTMLImageElement) => image.naturalWidth);

test('@regression messenger left panel switches between echo groups and telegram accounts', async ({
  page,
}) => {
  await openLeftPanel(page);
  const source = page.getByRole('group', { name: 'Джерело' });
  const echoGroups = source.getByRole('button', { name: 'Ехо групи' });
  const telegram = source.getByRole('button', { name: 'Телеграм' });
  const list = page.getByRole('navigation', { name: 'Телеграм акаунти' });

  await expect(echoGroups).toHaveAttribute('aria-pressed', 'true');
  await expect(list).toBeHidden();

  await telegram.click();
  await expect(telegram).toHaveAttribute('aria-pressed', 'true');
  await expect(list.locator('[data-messenger-account-item]')).toHaveCount(3);
  await expect(page).toHaveURL(/leftPanelTab=messenger/);

  await echoGroups.click();
  await expect(echoGroups).toHaveAttribute('aria-pressed', 'true');
  await expect(list).toBeHidden();
});

test('@regression messenger accounts show their avatar, or the initials when there is none', async ({
  page,
}) => {
  await openLeftPanel(page, '&leftPanelTab=messenger');
  const items = page.locator('[data-messenger-account-item]');
  await expect(items).toHaveCount(3);
  const avatar = (index: number) => items.nth(index).locator('[data-messenger-account-avatar]');

  // The picture of the first account loaded.
  await expect(avatar(0).locator('img')).toHaveAttribute('src', AVATAR_OK);
  await expect.poll(() => loadedWidth(avatar(0))).toBeGreaterThan(0);
  // The second one's picture is gone (404): the initials take its place, not an empty circle.
  await expect(avatar(1)).toHaveText('Б');
  await expect(avatar(1).locator('img')).toHaveCount(0);
  // The third has none.
  await expect(avatar(2)).toHaveText('Ч');
  await expect(avatar(2).locator('img')).toHaveCount(0);
});

test('@regression messenger account search narrows the list and an account opens its chats by kind', async ({
  page,
}) => {
  await openLeftPanel(page, '&leftPanelTab=messenger');
  const items = page.locator('[data-messenger-account-item]');
  await expect(items).toHaveCount(3);

  const search = page.getByRole('textbox', { name: 'Пошук телеграм акаунту' });
  // A search that matches nothing says so, like an empty list.
  await search.fill('zzz');
  await expect(items).toHaveCount(0);
  await expect(page.getByRole('status').filter({ hasText: 'Акаунтів не знайдено.' })).toBeVisible();

  await search.fill('bravo');
  await expect(items).toHaveCount(1);
  await expect(items.first()).toContainText('Браво');
  await page.getByRole('button', { name: 'Очистити пошук' }).click();
  await expect(items).toHaveCount(3);

  await items.first().click();
  await expect(items.first()).toHaveAttribute('aria-current', 'true');
  await expect(page).toHaveURL(/messengerAccount=a1/);

  // A private chat flagged as a bot is listed under the bots, with its avatar, and not under the private chats.
  const sidebar = page.getByRole('complementary', { name: 'Навігація акаунту', exact: true });
  const kind = (title: string) => sidebar.locator('section').filter({ hasText: title });
  await expect(kind('Боти (1)')).toContainText('Помічник');
  await expect(kind('Боти (1)').locator('[data-messenger-account-avatar] img')).toHaveAttribute(
    'src',
    AVATAR_OK,
  );
  await expect(kind('Приватні (1)')).toContainText('Іван');
  await expect(kind('Приватні (1)')).not.toContainText('Помічник');
  await expect(kind('Групи (1)')).toContainText('Команда');
});

const accountItems = (page: Page) => page.locator('[data-messenger-account-item]');
const refresh = (page: Page) => page.getByRole('button', { name: 'Оновити', exact: true });
const infoCard = (page: Page) => page.getByRole('region', { name: 'Інформація', exact: true });

test('@regression messenger tab is not offered without the CyberMessengers role, and no account is asked for', async ({
  page,
}) => {
  // A shared link to a messenger account, opened by someone who may not see messengers.
  const state = await openLeftPanel(page, '&leftPanelTab=messenger&messengerAccount=a1', {
    roles: ['Rer'],
  });
  await expect(page.locator('[data-analysis-group-list]')).toBeVisible();
  await expect(page.getByRole('group', { name: 'Джерело' })).toHaveCount(0);
  await expect(page.getByRole('navigation', { name: 'Телеграм акаунти' })).toHaveCount(0);
  // The link's messenger state is dropped from the address, and the endpoint was never called.
  await expect.poll(() => page.url()).not.toMatch(/leftPanelTab=messenger|messengerAccount=/);
  expect(state.accountsCalls).toBe(0);
});

test('@regression messenger accounts show a loading note until the list arrives', async ({
  page,
}) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  await openLeftPanel(page, '&leftPanelTab=messenger', { accountsGate: gate });
  const loading = page.getByRole('status').filter({ hasText: 'Завантажуємо акаунти…' });
  await expect(loading).toBeVisible();
  await expect(accountItems(page)).toHaveCount(0);

  release();
  await expect(accountItems(page)).toHaveCount(3);
  await expect(loading).toBeHidden();
});

test('@regression messenger accounts show a failed load, and the header refresh retries it', async ({
  page,
}) => {
  const state = await openLeftPanel(page, '&leftPanelTab=messenger', { accountsFailures: 1 });
  const alert = page.locator('[data-analysis-group-list]').getByRole('alert');
  await expect(alert).toBeVisible();
  await expect(accountItems(page)).toHaveCount(0);
  expect(state.accountsCalls).toBe(1);

  // The list has no retry of its own: the refresh button of the page header asks again.
  await refresh(page).click();
  await expect(accountItems(page)).toHaveCount(3);
  await expect(alert).toBeHidden();
  expect(state.accountsCalls).toBe(2);
});

test('@regression messenger account link keeps its account after a reload', async ({ page }) => {
  await openLeftPanel(page, '&leftPanelTab=messenger&messengerAccount=a2');
  await expect(accountItems(page).nth(1)).toHaveAttribute('aria-current', 'true');
  await expect(infoCard(page)).toContainText('Браво');

  await page.reload();
  await expect(accountItems(page).nth(1)).toHaveAttribute('aria-current', 'true', {
    timeout: 20_000,
  });
  await expect(infoCard(page)).toContainText('Браво');
  await expect(page).toHaveURL(/leftPanelTab=messenger/);
  await expect(page).toHaveURL(/messengerAccount=a2/);
});

test('@regression messenger account stays chosen after a visit to the echo groups', async ({
  page,
}) => {
  await openLeftPanel(page, '&leftPanelTab=messenger&messengerAccount=a2');
  const source = page.getByRole('group', { name: 'Джерело' });
  await expect(accountItems(page).nth(1)).toHaveAttribute('aria-current', 'true');

  await source.getByRole('button', { name: 'Ехо групи' }).click();
  await expect(page.getByRole('navigation', { name: 'Телеграм акаунти' })).toBeHidden();
  await expect(infoCard(page)).toBeHidden();

  await source.getByRole('button', { name: 'Телеграм' }).click();
  await expect(accountItems(page).nth(1)).toHaveAttribute('aria-current', 'true');
  await expect(infoCard(page)).toContainText('Браво');
});

test('@regression messenger accounts say so when there are none', async ({ page }) => {
  await openLeftPanel(page, '&leftPanelTab=messenger', { accounts: [] });
  await expect(page.getByRole('status').filter({ hasText: 'Акаунтів не знайдено.' })).toBeVisible();
  await expect(accountItems(page)).toHaveCount(0);
});
