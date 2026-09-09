import { expect, test, type Page } from '@playwright/test';

import { installAnalysisNeoApiMocks } from './analysis-neo.fixtures';
import { openCreateMessageDrawer } from './image-editor-drawer.fixtures';
import {
  buildMessageCardMediaPreviewInboxResponse,
  installMessageCardMediaPreviewAssetRoutes,
} from './message-card-media-preview.fixtures';
import { installRerDutyShortStateMocks } from './rer-duty-short-state.fixtures';

type ManageMessageDrawerHost = 'duty' | 'analysis';
type LinkedMessageKind =
  'with-report' | 'forwarded-report' | 'own-report-without-accessible-parent';

async function expectDrawerAtViewportRight(page: Page) {
  const drawer = page.locator('.MuiDrawer-paperAnchorRight');
  await expect(drawer).toBeVisible();
  await expect
    .poll(async () => {
      const [bounds, viewportWidth] = await Promise.all([
        drawer.boundingBox(),
        page.evaluate(() => window.innerWidth),
      ]);
      return bounds ? Math.abs(bounds.x + bounds.width - viewportWidth) : Number.POSITIVE_INFINITY;
    })
    .toBeLessThanOrEqual(1);
  const [bounds, viewport] = await Promise.all([
    drawer.boundingBox(),
    page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight })),
  ]);
  expect(bounds).not.toBeNull();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.y).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewport.width + 1);
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(viewport.height + 1);
  expect(Math.abs(bounds!.x + bounds!.width - viewport.width)).toBeLessThanOrEqual(1);
}

async function expectFullWidthDrawer(page: Page) {
  await expectDrawerAtViewportRight(page);
  const [bounds, viewportWidth] = await Promise.all([
    page.locator('.MuiDrawer-paperAnchorRight').boundingBox(),
    page.evaluate(() => window.innerWidth),
  ]);
  expect(bounds).not.toBeNull();
  expect(Math.abs(bounds!.width - viewportWidth)).toBeLessThanOrEqual(1);
}

function linkedSummary(id: number, text: string) {
  return {
    id,
    isAccessible: true,
    isDeleted: false,
    text,
    attachmentsCount: 0,
    timestamp: 1_720_000_000_000,
    date: '13.07.2026',
    time: '12:34',
    groupName: null,
    groupMasterKey: 'e2e-group',
  };
}

function buildLinkedInboxResponse(kind: LinkedMessageKind) {
  const inboxResponse = buildMessageCardMediaPreviewInboxResponse();
  const [, message] = inboxResponse.inbox_items[0]!;
  Object.assign(message as Record<string, unknown>, {
    text:
      kind === 'with-report'
        ? 'E2E message with an intelligence report'
        : kind === 'forwarded-report'
          ? 'E2E forwarded intelligence report as a message'
          : 'E2E own intelligence report without accessible parent',
    media: [],
    images: [],
    groupMasterKey: kind === 'own-report-without-accessible-parent' ? null : 'e2e-group',
    parentMessages:
      kind === 'forwarded-report'
        ? [linkedSummary(42, 'Original report')]
        : kind === 'own-report-without-accessible-parent'
          ? [{ ...linkedSummary(42, 'Original message'), isAccessible: false }]
          : [],
    intelligenceReports:
      kind === 'with-report' ? [linkedSummary(501, 'Linked intelligence report')] : [],
  });
  return inboxResponse;
}

async function openLinkedMessageEditDrawer(
  page: Page,
  host: ManageMessageDrawerHost,
  kind: LinkedMessageKind,
) {
  const inboxResponse = buildLinkedInboxResponse(kind);
  let copyRequestCount = 0;
  await installMessageCardMediaPreviewAssetRoutes(page);

  if (host === 'analysis') {
    await installAnalysisNeoApiMocks(page, { inboxResponse, signalGroups: ['e2e-group'] });
    await page.goto('/rer-analysis-neo');
  } else {
    const dutyMocks = await installRerDutyShortStateMocks(page, {
      inboxResponse,
      signalGroups: ['e2e-group'],
    });
    await page.goto('/rer-duty-neo');
    await dutyMocks.systemSettingsReady;
    await expect(page.getByText('Помилка завантаження системних налаштувань')).toHaveCount(0);
  }
  await page.route('**/api/1.1/messages/copy', async (route) => {
    copyRequestCount += 1;
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ payloads: [] }),
    });
  });

  await expect(
    page.getByText((inboxResponse.inbox_items[0]![1] as { text: string }).text),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Більше дій', exact: true }).first().click();
  await page.getByRole('menuitem', { name: 'Редагувати', exact: true }).first().click();
  return { getCopyRequestCount: () => copyRequestCount };
}

test.describe('@smoke manage message drawer linked-message regressions', () => {
  for (const host of ['duty', 'analysis'] as const satisfies ManageMessageDrawerHost[]) {
    test(`${host} creates an ordinary message drawer at the viewport right edge`, async ({
      page,
    }) => {
      await openCreateMessageDrawer(page, host);
      await expectDrawerAtViewportRight(page);

      await page.getByRole('button', { name: 'Закрити' }).click();
      await expect(page.locator('.MuiDrawer-paperAnchorRight')).toBeHidden();

      await page.getByRole('button', { name: 'Додати повідомлення' }).click();
      await expect(page.getByRole('heading', { name: 'Створити повідомлення' })).toBeVisible();
      await expectDrawerAtViewportRight(page);

      await page.setViewportSize({ width: 375, height: 500 });
      await expectDrawerAtViewportRight(page);
    });

    test(`${host} edits a message with an intelligence report as a message`, async ({ page }) => {
      await openLinkedMessageEditDrawer(page, host, 'with-report');

      await expect(page.getByRole('heading', { name: 'Редагувати повідомлення' })).toBeVisible();
      await expectDrawerAtViewportRight(page);
      await expect(page.getByRole('heading', { name: 'Редагувати розвіддонесення' })).toHaveCount(
        0,
      );
    });

    test(`${host} edits a forwarded intelligence report as a message`, async ({ page }) => {
      await openLinkedMessageEditDrawer(page, host, 'forwarded-report');

      await expect(page.getByRole('heading', { name: 'Редагувати повідомлення' })).toBeVisible();
      await expect(page.getByRole('heading', { name: 'Редагувати розвіддонесення' })).toHaveCount(
        0,
      );
    });

    test(`${host} edits an own report without accessible parents as a report`, async ({ page }) => {
      const drawer = await openLinkedMessageEditDrawer(
        page,
        host,
        'own-report-without-accessible-parent',
      );

      await expect(page.getByRole('heading', { name: 'Редагувати розвіддонесення' })).toBeVisible();
      await expectFullWidthDrawer(page);
      await expect(page.getByRole('heading', { name: 'Редагувати повідомлення' })).toHaveCount(0);
      expect(drawer.getCopyRequestCount()).toBe(0);
    });
  }
});
