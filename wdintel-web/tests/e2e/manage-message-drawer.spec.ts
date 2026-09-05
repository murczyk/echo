import { expect, test, type Page } from '@playwright/test';

import { installAnalysisNeoApiMocks } from './analysis-neo.fixtures';
import { IMAGE_EDITOR_DRAWER_PNG, openCreateReportDrawer } from './image-editor-drawer.fixtures';
import {
  buildMessageCardMediaPreviewInboxResponse,
  installMessageCardMediaPreviewAssetRoutes,
} from './message-card-media-preview.fixtures';
import { installRerDutyShortStateMocks } from './rer-duty-short-state.fixtures';

type ManageMessageDrawerHost = 'duty' | 'analysis';
type LinkedMessageKind =
  'with-report' | 'forwarded-report' | 'own-report-without-accessible-parent';

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
  await page.getByRole('button', { name: 'Редагувати', exact: true }).first().click();
  return { getCopyRequestCount: () => copyRequestCount };
}

test.describe('@smoke manage message drawer linked-message regressions', () => {
  for (const host of ['duty', 'analysis'] as const satisfies ManageMessageDrawerHost[]) {
    test(`${host} edits a message with an intelligence report as a message`, async ({ page }) => {
      await openLinkedMessageEditDrawer(page, host, 'with-report');

      await expect(page.getByRole('heading', { name: 'Редагувати повідомлення' })).toBeVisible();
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
      await expect(page.getByRole('heading', { name: 'Редагувати повідомлення' })).toHaveCount(0);
      expect(drawer.getCopyRequestCount()).toBe(0);
    });
  }
});

test.describe('@smoke manage message drawer attachment preview', () => {
  test('keeps report text shared across image and video previews', async ({ page }) => {
    await openCreateReportDrawer(page);

    const drawerReportText = page.getByRole('textbox', { name: 'Текст розвіддонесення' });
    await expect(drawerReportText).toHaveValue('');
    await drawerReportText.fill('Початковий текст розвіддонесення');
    await page.locator('input[type="file"]').setInputFiles({
      name: 'report-preview.mp4',
      mimeType: 'video/mp4',
      buffer: Buffer.from('report-preview-video'),
    });

    await page.getByRole('button', { name: `Переглянути ${IMAGE_EDITOR_DRAWER_PNG.name}` }).click();

    const preview = page.locator('[role="dialog"][aria-label^="Перегляд"]');
    await expect(preview).toHaveAttribute('aria-label', 'Перегляд зображення');
    await expect(preview.getByRole('textbox', { name: 'Текст розвіддонесення' })).toHaveCount(0);

    const reportAction = preview.getByRole('button', { name: 'Писати розвіддонесення' });
    await expect(reportAction).toHaveAttribute('aria-pressed', 'false');
    await reportAction.click();

    const previewReportText = preview.getByRole('textbox', {
      name: 'Текст розвіддонесення',
    });
    await expect(previewReportText).toHaveValue('Початковий текст розвіддонесення');
    await expect(previewReportText).not.toBeFocused();
    await previewReportText.fill('Оновлений текст розвіддонесення');

    await preview.getByRole('button', { name: 'Наступне' }).click();
    await expect(preview).toHaveAttribute('aria-label', 'Перегляд відео');
    await expect(previewReportText).toHaveValue('Оновлений текст розвіддонесення');

    const videoControls = preview.locator('[data-attachment-preview-video-controls]');
    const reportPane = preview.locator('[data-attachment-preview-report-pane]');
    await expect(videoControls).toBeVisible();
    await expect(reportPane).toBeVisible();
    const controlsBox = await videoControls.boundingBox();
    const reportPaneBox = await reportPane.boundingBox();
    expect(controlsBox).not.toBeNull();
    expect(reportPaneBox).not.toBeNull();
    expect(controlsBox!.y + controlsBox!.height).toBeLessThanOrEqual(reportPaneBox!.y + 1);

    await preview.getByRole('button', { name: 'Закрити' }).click();
    await expect(drawerReportText).toHaveValue('Оновлений текст розвіддонесення');
  });
});
