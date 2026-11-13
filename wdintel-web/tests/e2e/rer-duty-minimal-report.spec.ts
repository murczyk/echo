import { expect, test, type Locator, type Page, type Request } from '@playwright/test';

import {
  buildMessageCardMediaPreviewInboxResponse,
  installMessageCardMediaPreviewAssetRoutes,
} from './message-card-media-preview.fixtures';
import { installRerDutyShortStateMocks } from './rer-duty-short-state.fixtures';

const SOURCE_TEXT = 'E2E source for the minimal report window';
const OTHER_SOURCE_TEXT = 'E2E second source message';
const COPIED_TEXT = 'E2E copied original body';

async function openThreeColumnDuty(
  page: Page,
  minimalReportWindowEnabled: boolean,
  enableDutySearch = false,
) {
  await page.setViewportSize({ width: 1920, height: 1000 });
  const inboxResponse = buildMessageCardMediaPreviewInboxResponse({ messageText: SOURCE_TEXT });
  const [sourceId, sourceMessage] = inboxResponse.inbox_items[0]! as [number, object];
  inboxResponse.inbox_items.push([
    sourceId + 1,
    { ...sourceMessage, messageUid: 'e2e-second-source', text: OTHER_SOURCE_TEXT },
  ] as (typeof inboxResponse.inbox_items)[number]);
  await installMessageCardMediaPreviewAssetRoutes(page);
  const dutyMocks = await installRerDutyShortStateMocks(page, {
    enableDutySearch,
    inboxResponse,
    signalGroups: ['e2e-group'],
  });
  await page.route('**/api/user/settings', async (route) => {
    const response = await route.fetch().catch(() => null);
    const settings = response ? await response.json().catch(() => ({})) : {};
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        tagsLayout: 'compact',
        ...settings,
        messageCardQuickAction: 'createReport',
        minimalReportWindowEnabled,
      }),
    });
  });
  await page.route('**/api/1.1/messages/copy', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        payloads: [
          { full_body: COPIED_TEXT, text: COPIED_TEXT, to: [], parent_signal_message_ids: [1] },
        ],
      }),
    }),
  );
  await page.route('**/api/sigint/units/hierarchy', (route) =>
    route.fulfill({ json: { revision: 'e2e', groups: [], units: [] } }),
  );
  await page.goto('/rer-duty-neo');
  await dutyMocks.systemSettingsReady;
  await expect(page.getByText(SOURCE_TEXT).first()).toBeVisible();
  for (let added = 0; added < 2; added += 1) {
    await page.getByRole('button', { name: 'Додати стрічку' }).click();
  }
  await expect(page.locator('[data-duty-feed-column]')).toHaveCount(3);
  await expect(columnCards(page, 2).filter({ hasText: OTHER_SOURCE_TEXT })).toBeVisible();
}

function columnCards(page: Page, index: number): Locator {
  return page.locator('[data-duty-feed-column]').nth(index).locator('[data-message-card-root]');
}

function openReportFromColumn(page: Page, index: number, text = SOURCE_TEXT) {
  return columnCards(page, index)
    .filter({ hasText: text })
    .getByRole('button', { name: 'Створити розвіддонесення', exact: true })
    .click();
}

function columnBoxes(page: Page) {
  return page.locator('[data-duty-feed-column]').evaluateAll((columns) =>
    columns.map((column) => {
      const { left, top, width, height } = column.getBoundingClientRect();
      return { left, top, width, height };
    }),
  );
}

test.describe('#4008 minimal report window', () => {
  test('writes a report over the source column without moving the feeds', async ({ page }) => {
    await openThreeColumnDuty(page, true);
    const columnsBefore = await columnBoxes(page);

    await openReportFromColumn(page, 1);

    const panel = page.locator('[data-manage-message-presentation="minimal"]');
    await expect(panel).toBeVisible();
    await expect(panel.getByText(COPIED_TEXT)).toBeVisible();
    await expect(panel.getByText('Без надсилання в групу.')).toBeVisible();
    await expect(page.locator('[data-manage-message-presentation="embedded"]')).toHaveCount(0);
    await expect(panel.getByRole('combobox')).toHaveCount(0);
    expect(await columnBoxes(page)).toEqual(columnsBefore);
    await expect(page.locator('[data-duty-feed-column]').nth(1).locator(panel)).toHaveCount(1);

    const panelBox = await panel.boundingBox();
    const column = columnsBefore[1]!;
    expect(panelBox!.x).toBeGreaterThanOrEqual(column.left);
    expect(panelBox!.x + panelBox!.width).toBeLessThanOrEqual(column.left + column.width);
    const columnMiddle = column.top + column.height / 2;
    expect(Math.abs(panelBox!.y + panelBox!.height / 2 - columnMiddle)).toBeLessThanOrEqual(1);

    const fade = page
      .locator('[data-duty-feed-column]')
      .nth(1)
      .locator('[data-manage-message-minimal-scrim]');
    await expect(fade).toHaveCSS('pointer-events', 'none');
    expect(await fade.boundingBox()).toMatchObject({ y: column.top, height: column.height });

    const originalBox = await panel.getByText(COPIED_TEXT).boundingBox();
    const titleBox = await panel.getByRole('heading').boundingBox();
    expect(originalBox!.y + originalBox!.height).toBeLessThanOrEqual(titleBox!.y);

    const reportText = panel.getByRole('textbox', { name: 'Текст розвіддонесення' });
    await expect(reportText).toBeFocused();
    await reportText.fill('Швидке розвіддонесення');
    const submitted: Promise<Request> = page.waitForRequest('**/api/1.1/submit-direct');
    await reportText.press('Control+Enter');

    expect((await submitted).postDataJSON()).toMatchObject({
      full_body: 'Швидке розвіддонесення',
      signal_group_master_key: null,
    });
    await expect(panel).toHaveCount(0);
    expect(await columnBoxes(page)).toEqual(columnsBefore);
    await expect(
      columnCards(page, 1)
        .filter({ hasText: SOURCE_TEXT })
        .getByRole('button', { name: 'Створити розвіддонесення', exact: true }),
    ).toBeFocused();
  });

  test('expands into the full side panel and keeps the draft', async ({ page }) => {
    const cpu = await page.context().newCDPSession(page);
    await cpu.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    await openThreeColumnDuty(page, true, true);
    const source = page.locator('[data-duty-feed-column]').nth(2);
    await source.getByRole('button', { name: 'Пошук у стрічці', exact: true }).click();
    await source.getByRole('combobox', { name: /пошук/i }).fill('E2E');
    await source.getByRole('combobox', { name: /пошук/i }).press('Escape');
    await openReportFromColumn(page, 2);
    const panel = page.locator('[data-manage-message-presentation="minimal"]');
    await expect(panel).toBeVisible();
    await panel.getByRole('textbox', { name: 'Текст розвіддонесення' }).fill('Чернетка');

    await panel.getByRole('button', { name: 'Розгорнути в повну бічну панель' }).click();

    const editor = page.locator('[data-manage-message-presentation="embedded"]');
    await expect(editor).toBeVisible();
    await expect(panel).toHaveCount(0);
    await expect(page.locator('[data-duty-feed-column]')).toHaveCount(1);
    const column = page.locator('[data-duty-feed-column]');
    await expect(column.getByRole('combobox', { name: /пошук/i })).toHaveValue('E2E');
    await expect
      .poll(async () => {
        const [feed, workspace] = await Promise.all([
          column.boundingBox(),
          page.locator('[data-duty-workspace-main]').boundingBox(),
        ]);
        return (
          feed!.x >= workspace!.x - 1 &&
          feed!.x + feed!.width <= workspace!.x + workspace!.width + 1
        );
      })
      .toBe(true);
    await expect(editor.getByRole('textbox', { name: 'Текст розвіддонесення' })).toHaveValue(
      'Чернетка',
    );
    await expect(editor.getByRole('combobox', { name: 'Відправити в групу' })).toHaveValue(
      'Не відправляти',
    );

    const submitted = page.waitForRequest('**/api/1.1/submit-direct');
    await editor.getByRole('button', { name: 'Створити', exact: true }).click();
    expect((await submitted).postDataJSON()).toMatchObject({
      full_body: 'Чернетка',
      signal_group_master_key: null,
    });
  });

  test('moves to another message and guards a dirty draft', async ({ page }) => {
    await openThreeColumnDuty(page, true);
    await openReportFromColumn(page, 0);
    const panel = page.locator('[data-manage-message-presentation="minimal"]');
    await expect(panel).toBeVisible();
    await panel.getByRole('textbox', { name: 'Текст розвіддонесення' }).fill('Чернетка');

    await page.keyboard.press('Escape');
    await expect(page.getByText('Відхилити незбережені зміни?')).toBeVisible();
    await page.getByRole('button', { name: 'Продовжити редагування' }).click();
    await expect(panel.getByRole('textbox', { name: 'Текст розвіддонесення' })).toHaveValue(
      'Чернетка',
    );

    await openReportFromColumn(page, 2, OTHER_SOURCE_TEXT);
    await page.getByRole('button', { name: 'Відхилити зміни' }).click();
    await expect(page.locator('[data-duty-feed-column]').nth(2).locator(panel)).toHaveCount(1);
    const reportText = panel.getByRole('textbox', { name: 'Текст розвіддонесення' });
    await expect(reportText).toHaveValue('');
    await expect(reportText).toBeFocused();

    await page.keyboard.press('Escape');
    await expect(panel).toHaveCount(0);
  });

  test('keeps the panel actions reachable on a short viewport', async ({ page }) => {
    await openThreeColumnDuty(page, true);
    await openReportFromColumn(page, 1);
    const panel = page.locator('[data-manage-message-presentation="minimal"]');
    await expect(panel).toBeVisible();
    await page.setViewportSize({ width: 1920, height: 350 });
    const reportText = panel.getByRole('textbox', { name: 'Текст розвіддонесення' });
    await reportText.fill(Array.from({ length: 8 }, (_, line) => `Рядок ${line}`).join('\n'));

    // A real wheel gesture: programmatic scrolling also moves overflow-hidden boxes.
    await panel.getByRole('heading').hover();
    await page.mouse.wheel(0, 1000);

    const submit = panel.getByRole('button', { name: 'Створити', exact: true });
    await expect
      .poll(async () => {
        const [panelBox, submitBox] = await Promise.all([
          panel.boundingBox(),
          submit.boundingBox(),
        ]);
        return submitBox!.y + submitBox!.height - (panelBox!.y + panelBox!.height);
      })
      .toBeLessThanOrEqual(0);
    const submitted = page.waitForRequest('**/api/1.1/submit-direct');
    await submit.click();
    await submitted;
  });

  test('keeps the full side panel while the option is off', async ({ page }) => {
    await openThreeColumnDuty(page, false);

    await openReportFromColumn(page, 1);

    await expect(page.locator('[data-manage-message-presentation="embedded"]')).toBeVisible();
    await expect(page.locator('[data-manage-message-presentation="minimal"]')).toHaveCount(0);
  });
});
