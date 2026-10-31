import { expect, test, type Page } from '@playwright/test';

import { createLoadedInboxResponse, installAnalysisNeoApiMocks } from './analysis-neo.fixtures';
import { installRerDutyShortStateMocks } from './rer-duty-short-state.fixtures';

const choices = [
  ['createReport', 'Створити розвіддонесення'],
  ['reply', 'Відповісти'],
  ['important', 'Позначити як важливе'],
  ['bookmark', 'Додати в закладки'],
  ['copyText', 'Копіювати повідомлення'],
  ['copyLink', 'Копіювати посилання на повідомлення'],
  ['edit', 'Редагувати'],
  ['delete', 'Видалити'],
] as const;

const choiceIcons = {
  createReport: 'NoteAddIcon',
  reply: 'ReplyIcon',
  important: 'FlagOutlinedIcon',
  bookmark: 'BookmarkBorderOutlinedIcon',
  copyText: 'MessageIcon',
  copyLink: 'LinkIcon',
  edit: 'EditIcon',
  delete: 'DeleteIcon',
};

async function installFixture(
  page: Page,
  host: 'duty' | 'analysis',
  userRoles = ['Rer', 'DeleteMsg'],
) {
  const inboxResponse = createLoadedInboxResponse();
  if (host === 'analysis') await installAnalysisNeoApiMocks(page, { inboxResponse, userRoles });
  else await installRerDutyShortStateMocks(page, { inboxResponse, userRoles });
  await page.route('**/api/sigint/zones/list', (route) => route.fulfill({ json: [] }));
  let settings: Record<string, unknown> = {
    tagsLayout: 'compact',
    disableAutoScroll: false,
    messageCardQuickAction: 'createReport',
  };
  let failSave = false;
  let nextSaveBlocked: Promise<void> | undefined;
  const saves: Record<string, unknown>[] = [];
  await page.route('**/api/user/settings', async (route) => {
    if (route.request().method() === 'PUT') {
      if (failSave) return route.fulfill({ status: 500, body: 'Save failed' });
      const changes = route.request().postDataJSON();
      saves.push(changes);
      const blocked = nextSaveBlocked;
      nextSaveBlocked = undefined;
      await blocked;
      settings = { ...settings, ...changes };
    }
    await route.fulfill({ json: settings });
  });
  return {
    settings: () => settings,
    saves,
    blockNextSave: () => {
      let release!: () => void;
      nextSaveBlocked = new Promise<void>((resolve) => {
        release = resolve;
      });
      return release;
    },
    failSave: () => {
      failSave = true;
    },
  };
}

for (const host of ['duty', 'analysis'] as const) {
  test(`#3927 ${host}: unrelated settings keep the server default unset and preserve a personal choice @regression`, async ({
    page,
  }) => {
    const fixture = await installFixture(page, host);
    fixture.settings().messageCardQuickAction = 'copyText';
    await page.goto(`/settings-neo?section=${host}`);
    const select = page.getByRole('combobox', { name: 'Швидка дія для вузької картки' });
    await expect(select).toHaveText('Копіювати повідомлення');
    const releaseSave = fixture.blockNextSave();
    await page.getByRole('button', { name: 'Збільшений', exact: true }).click();
    await expect.poll(() => fixture.saves.length).toBe(1);
    expect(fixture.saves[0]).not.toHaveProperty('messageCardQuickAction');
    await select.click();
    await page.getByRole('option', { name: 'Створити розвіддонесення', exact: true }).click();
    await expect(select).toHaveText('Створити розвіддонесення');
    await page.getByRole('button', { name: 'Стандартний', exact: true }).click();
    releaseSave();
    await expect.poll(() => fixture.saves.length).toBe(2);
    expect(fixture.saves[1]).toMatchObject({
      messageCardQuickAction: 'createReport',
      largeMessageCardText: false,
    });
    await expect.poll(() => fixture.settings().messageCardQuickAction).toBe('createReport');
    await page.getByRole('button', { name: 'Збільшений', exact: true }).click();
    await expect.poll(() => fixture.saves.length).toBe(3);
    expect(fixture.saves[2]).not.toHaveProperty('messageCardQuickAction');
    await page.reload();
    await expect(select).toHaveText('Створити розвіддонесення');
  });

  test(`#3927 ${host}: every fixed quick action persists and appears once on narrow cards @regression`, async ({
    page,
    context,
  }, testInfo) => {
    test.setTimeout(90_000);
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.setViewportSize({ width: 1920, height: 1080 });
    const fixture = await installFixture(page, host);
    for (const [value, label] of choices) {
      await page.setViewportSize({ width: 1920, height: 1080 });
      await page.goto(`/settings-neo?section=${host}`);
      const select = page.getByRole('combobox', { name: 'Швидка дія для вузької картки' });
      await select.click();
      const listbox = page.getByRole('listbox');
      await expect(listbox.getByRole('option')).toHaveCount(choices.length);
      await expect(listbox.locator('svg')).toHaveCount(choices.length);
      await listbox.locator(`[data-value="${value}"]`).click();
      await expect(select.getByTestId(choiceIcons[value])).toBeVisible();
      const preview = page.getByRole('region', {
        name: 'Попередній перегляд картки повідомлення',
        exact: true,
      });
      await expect(
        preview.locator('[data-message-card-quick-action-preview]').getByTestId(choiceIcons[value]),
      ).toBeVisible();
      const settingsPanel = page.getByText('Картка повідомлення', { exact: true }).locator('..');
      expect((await select.boundingBox())!.width).toBeLessThan(
        (await settingsPanel.boundingBox())!.width,
      );
      if (value === 'copyText') {
        for (const width of [1920, 390]) {
          await page.setViewportSize({ width, height: 1080 });
          await select.scrollIntoViewIfNeeded();
          await page.screenshot({ path: testInfo.outputPath(`${host}-${width}-quick-action.png`) });
          await expect
            .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
            .toBe(true);
          await expect(preview.getByTestId(choiceIcons[value])).toBeVisible();
        }
      }
      await expect.poll(() => fixture.settings().messageCardQuickAction).toBe(value);
      await page.setViewportSize({ width: 390, height: 1080 });
      await page.goto(`/rer-${host}-neo${host === 'analysis' ? '?filterPanelOpen=false' : ''}`);
      const closeFilters = page.getByRole('button', { name: 'Закрити фільтри', exact: true });
      if (await closeFilters.isVisible()) await closeFilters.click();
      const card = page.locator('.message-card-root').first();
      await expect(card).toBeVisible();
      const actions = card.locator('[aria-label="Дії повідомлення"]');
      const quickAction = actions.getByRole('button', { name: label, exact: true });
      await expect(quickAction).toBeVisible();
      await expect(actions.getByRole('button')).toHaveCount(2);
      await actions.getByRole('button', { name: 'Більше дій', exact: true }).click();
      const menu = page.getByRole('menu', { name: 'Додаткові дії повідомлення' });
      await expect(menu.getByRole('menuitem', { name: label, exact: true })).toHaveCount(0);
      if (value !== 'createReport')
        await expect(
          menu.getByRole('menuitem', { name: 'Створити розвіддонесення', exact: true }),
        ).toBeVisible();
      await page.keyboard.press('Escape');
      if (value === 'copyText' || value === 'copyLink') {
        await quickAction.click();
        const copied = await page.evaluate(() => navigator.clipboard.readText());
        if (value === 'copyText') expect(copied).toBe('Analysis summary fixture message');
        else expect(new URL(copied).pathname).toBe(`/rer-${host}-neo`);
        await expect(
          page.getByRole('status').filter({
            hasText:
              value === 'copyText'
                ? 'Повідомлення скопійовано.'
                : 'Посилання на повідомлення скопійовано.',
          }),
        ).toBeVisible();
      }
    }
    await page.setViewportSize({ width: 1920, height: 1080 });
    await page.reload();
    const wideCard = page.locator('.message-card-root').first();
    await expect(
      wideCard.getByRole('button', { name: 'Створити розвіддонесення', exact: true }),
    ).toBeVisible();
    await expect(wideCard.getByRole('button', { name: 'Видалити', exact: true })).toHaveCount(0);
    await wideCard.getByRole('button', { name: 'Більше дій', exact: true }).click();
    await expect(page.getByRole('menuitem', { name: 'Видалити', exact: true })).toBeVisible();
  });

  test(`#3927 ${host}: a forbidden quick action stays hidden without replacement @regression`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 1080 });
    const fixture = await installFixture(page, host, ['CyberViewer']);
    fixture.settings().messageCardQuickAction = 'edit';
    await page.goto(`/rer-${host}-neo${host === 'analysis' ? '?filterPanelOpen=false' : ''}`);
    const card = page.locator('.message-card-root').first();
    await expect(card).toBeVisible();
    const actions = card.locator('[aria-label="Дії повідомлення"]');
    await expect(actions.getByRole('button')).toHaveCount(1);
    await expect(actions.getByRole('button', { name: 'Більше дій', exact: true })).toBeVisible();
    expect(fixture.settings().messageCardQuickAction).toBe('edit');
  });
}

test('#3927 failed quick-action saves show an error and retain the last persisted choice @regression', async ({
  page,
}) => {
  const fixture = await installFixture(page, 'analysis');
  await page.goto('/settings-neo?section=analysis');
  fixture.failSave();
  const select = page.getByRole('combobox', { name: 'Швидка дія для вузької картки' });
  await select.click();
  await page.getByRole('option', { name: 'Копіювати повідомлення', exact: true }).click();
  await expect(page.getByText(/^Помилка збереження:/)).toBeVisible();
  expect(fixture.settings().messageCardQuickAction).toBe('createReport');
  await page.reload();
  await expect(select).toHaveText('Створити розвіддонесення');
});
