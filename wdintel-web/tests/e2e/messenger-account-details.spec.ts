import { expect, test, type Locator, type Page } from '@playwright/test';
import { installAnalysisNeoApiMocks } from './analysis-neo.fixtures';

// The dates are shown in the time zone of the browser; Kyiv is UTC+2 in winter.
test.use({ timezoneId: 'Europe/Kyiv' });

const EXTERNAL_URL = 'https://example.com/accounts/1';
const NO_DATA = '—';
const INTERNAL_NOTES_MAX_LENGTH = 512;

const makeAccount = (overrides: Record<string, unknown> = {}) => ({
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
  createdAt: Date.UTC(2026, 0, 15, 10, 30),
  lastSync: Date.UTC(2026, 1, 20, 18, 45),
  notes: 'Опис від джерела',
  internalNotes: 'Приватна примітка',
  externalUrl: EXTERNAL_URL,
  avatarId: null,
  telegram: { userId: '7012345678' },
  datasourceGroup: { id: 'g1', name: 'Група' },
  ...overrides,
});

type State = {
  accounts: ReturnType<typeof makeAccount>[];
  // The bodies of the `accounts/update` requests, as sent.
  updates: Record<string, unknown>[];
  updateStatus: number;
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

async function openDetails(page: Page, accounts = [makeAccount()], accountId = 'a1') {
  const state: State = { accounts, updates: [], updateStatus: 200 };
  await installAnalysisNeoApiMocks(page, { userRoles: ['Rer', 'CyberMessengers'] });
  await page.route('**/api/messengers/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    const json = (body: unknown) => route.fulfill({ json: body });
    if (path.endsWith('/accounts/list')) return json({ items: state.accounts.map(snake) });
    if (path.endsWith('/accounts/update')) {
      const body = route.request().postDataJSON() as {
        account_id: string;
        internal_notes: string | null;
      };
      state.updates.push(body);
      if (state.updateStatus !== 200) {
        return route.fulfill({ status: state.updateStatus, json: { error: 'Збій сервера' } });
      }
      state.accounts = state.accounts.map((item) =>
        item.id === body.account_id ? { ...item, internalNotes: body.internal_notes } : item,
      );
      return json(null);
    }
    if (path.endsWith('/chats/list')) return json({ items: [] });
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });
  await page.goto(
    `/rer-analysis-neo?leftPanelOpen=true&leftPanelTab=messenger&messengerAccount=${accountId}`,
  );
  return state;
}

const card = (page: Page, title: string) => page.getByRole('region', { name: title, exact: true });
// The value next to a label of the information card.
const info = (page: Page, label: string): Locator =>
  card(page, 'Інформація').getByText(label, { exact: true }).locator('xpath=..');
const pencil = (page: Page, title: string) =>
  card(page, title).getByRole('button', { name: 'Редагувати' });

test('@regression messenger account cards show what the collector sent about the account', async ({
  page,
}) => {
  await openDetails(page);
  await expect(card(page, 'Внутрішній опис')).toContainText('Приватна примітка');
  await expect(card(page, 'Опис')).toContainText('Опис від джерела');

  await expect(info(page, "Ім'я")).toContainText('Альфа');
  // The phone has its plus, whatever the collector sent.
  await expect(info(page, 'Телефон')).toContainText('+380501234567');
  await expect(info(page, "Ім'я користувача")).toContainText('@alpha_user');
  await expect(info(page, 'External ID')).toContainText('7');
  await expect(info(page, 'User ID')).toContainText('7012345678');
  await expect(info(page, 'Створено')).toContainText(/15\.01\.2026.*12:30/);
  await expect(info(page, 'Оновлено')).toContainText(/20\.02\.2026.*20:45/);
});

test('@regression messenger account cards show a dash for what is missing, and no link', async ({
  page,
}) => {
  await openDetails(page, [
    makeAccount({
      username: null,
      phone: null,
      notes: null,
      internalNotes: null,
      externalUrl: null,
      telegram: null,
      createdAt: null,
      lastSync: null,
    }),
  ]);
  await expect(card(page, 'Інформація')).toBeVisible();
  await expect(card(page, 'Внутрішній опис')).toContainText(NO_DATA);
  await expect(card(page, 'Опис')).toContainText(NO_DATA);
  for (const label of [
    'Телефон',
    "Ім'я користувача",
    'User ID',
    'Посилання',
    'Створено',
    'Оновлено',
  ]) {
    await expect(info(page, label)).toContainText(NO_DATA);
  }
  // What the collector always sends is still there.
  await expect(info(page, "Ім'я")).toContainText('Альфа');
  await expect(info(page, 'External ID')).toContainText('7');
  await expect(card(page, 'Інформація').getByRole('link')).toHaveCount(0);
});

test('@regression messenger account info links to the source in a new tab', async ({
  page,
  context,
}) => {
  await openDetails(page);
  await context.route('https://example.com/**', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<title>Джерело</title>' }),
  );
  const link = card(page, 'Інформація').getByRole('link', { name: 'Відкрити джерело' });
  await expect(link).toHaveAttribute('href', EXTERNAL_URL);
  await expect(link).toHaveAttribute('target', '_blank');
  await expect(link).toHaveAttribute('rel', /noopener/);
  const [tab] = await Promise.all([context.waitForEvent('page'), link.click()]);
  await tab.waitForLoadState();
  expect(tab.url()).toBe(EXTERNAL_URL);
  await tab.close();
  // The page stays on the account cards.
  await expect(card(page, 'Інформація')).toBeVisible();
});

// An address that is not http(s) is no link, whatever the collector sent.
for (const [name, externalUrl] of [
  ['javascript:', 'javascript:alert(1)'],
  ['ftp:', 'ftp://example.com/accounts/1'],
] as const) {
  test(`@regression messenger account info shows no link for a ${name} address`, async ({
    page,
  }) => {
    await openDetails(page, [makeAccount({ externalUrl })]);
    await expect(info(page, 'Посилання')).toContainText(NO_DATA);
    await expect(card(page, 'Інформація').getByRole('link')).toHaveCount(0);
  });
}

test('@regression messenger account description is read-only, the internal one has a pencil', async ({
  page,
}) => {
  await openDetails(page);
  await expect(card(page, 'Опис')).toBeVisible();
  await expect(pencil(page, 'Внутрішній опис')).toBeVisible();
  await expect(pencil(page, 'Опис')).toHaveCount(0);
  await expect(pencil(page, 'Інформація')).toHaveCount(0);
});

test('@regression messenger account internal note is edited, counted, cancelled and saved', async ({
  page,
}) => {
  const state = await openDetails(page);
  const note = card(page, 'Внутрішній опис');
  const editor = note.getByRole('textbox', { name: 'Внутрішній опис' });

  // The editor opens with the text, a counter and a limit; the pencil is gone while it is open.
  await pencil(page, 'Внутрішній опис').click();
  await expect(editor).toHaveValue('Приватна примітка');
  await expect(editor).toHaveAttribute('maxlength', String(INTERNAL_NOTES_MAX_LENGTH));
  await expect(note).toContainText(`${'Приватна примітка'.length}/${INTERNAL_NOTES_MAX_LENGTH}`);
  await expect(pencil(page, 'Внутрішній опис')).toHaveCount(0);
  await editor.fill('abc');
  await expect(note).toContainText(`3/${INTERNAL_NOTES_MAX_LENGTH}`);

  // Cancelling drops the draft and sends nothing.
  await note.getByRole('button', { name: 'Скасувати' }).click();
  await expect(editor).toHaveCount(0);
  await expect(note).toContainText('Приватна примітка');
  expect(state.updates).toHaveLength(0);

  // Saving sends the whole text, with its lines, and shows it.
  await pencil(page, 'Внутрішній опис').click();
  await editor.fill('Нова примітка\nдруга лінія');
  await note.getByRole('button', { name: 'Зберегти' }).click();
  await expect(editor).toHaveCount(0);
  await expect(note).toContainText('Нова примітка');
  await expect(note).toContainText('друга лінія');
  expect(state.updates).toEqual([
    { account_id: 'a1', internal_notes: 'Нова примітка\nдруга лінія' },
  ]);
  await expect(pencil(page, 'Внутрішній опис')).toBeVisible();

  // The note belongs to the account in the list: it can be found by it.
  const search = page.getByRole('textbox', { name: 'Пошук телеграм акаунту' });
  await search.fill('друга лінія');
  await expect(page.locator('[data-messenger-account-item]')).toHaveCount(1);
  await search.fill('немає такого');
  await expect(page.locator('[data-messenger-account-item]')).toHaveCount(0);
});

test('@regression messenger account internal note is cleared by a blank text', async ({ page }) => {
  const state = await openDetails(page);
  const note = card(page, 'Внутрішній опис');
  await pencil(page, 'Внутрішній опис').click();
  await note.getByRole('textbox', { name: 'Внутрішній опис' }).fill('   ');
  await note.getByRole('button', { name: 'Зберегти' }).click();
  await expect(note).toContainText(NO_DATA);
  // A blank text clears the note: the API gets null, not the blanks.
  expect(state.updates).toEqual([{ account_id: 'a1', internal_notes: null }]);
});

test('@regression messenger account internal note keeps the draft and says so when saving fails', async ({
  page,
}) => {
  const state = await openDetails(page);
  state.updateStatus = 500;
  const note = card(page, 'Внутрішній опис');
  const editor = note.getByRole('textbox', { name: 'Внутрішній опис' });
  await pencil(page, 'Внутрішній опис').click();
  await editor.fill('Не збережеться');
  await note.getByRole('button', { name: 'Зберегти' }).click();

  await expect(note.getByRole('alert')).toBeVisible();
  // The editor stays open with the draft, so nothing typed is lost.
  await expect(editor).toHaveValue('Не збережеться');
  expect(state.updates).toHaveLength(1);

  // The old text is what the card shows after cancelling; saving works once the server does.
  await note.getByRole('button', { name: 'Скасувати' }).click();
  await expect(note).toContainText('Приватна примітка');
  await expect(note.getByRole('alert')).toHaveCount(0);
  state.updateStatus = 200;
  await pencil(page, 'Внутрішній опис').click();
  await editor.fill('Збережеться');
  await note.getByRole('button', { name: 'Зберегти' }).click();
  await expect(note).toContainText('Збережеться');
  await expect(note.getByRole('alert')).toHaveCount(0);
});

test('@regression messenger account cards follow the account, and a draft stays with its own', async ({
  page,
}) => {
  const state = await openDetails(page, [
    makeAccount({ internalNotes: 'Примітка першого' }),
    makeAccount({
      id: 'a2',
      displayName: 'Браво',
      username: 'bravo_user',
      externalId: '8',
      internalNotes: 'Примітка другого',
    }),
  ]);
  const note = card(page, 'Внутрішній опис');
  await expect(note).toContainText('Примітка першого');

  // An unsaved draft of one account does not leak into the next one.
  await pencil(page, 'Внутрішній опис').click();
  await note.getByRole('textbox', { name: 'Внутрішній опис' }).fill('Чернетка');
  await page.locator('[data-messenger-account-item]').filter({ hasText: 'Браво' }).click();
  await expect(info(page, "Ім'я")).toContainText('Браво');
  await expect(note).toContainText('Примітка другого');
  await expect(note.getByRole('textbox')).toHaveCount(0);

  await page.locator('[data-messenger-account-item]').filter({ hasText: 'Альфа' }).click();
  await expect(info(page, "Ім'я")).toContainText('Альфа');
  await expect(note).toContainText('Примітка першого');
  await expect(note.getByRole('textbox')).toHaveCount(0);
  expect(state.updates).toHaveLength(0);
});
