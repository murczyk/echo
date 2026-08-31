import { expect, test, type Page } from '@playwright/test';

import { installAnalysisNeoApiMocks } from './analysis-neo.fixtures';
import {
  buildMessageCardMediaPreviewInboxResponse,
  installMessageCardMediaPreviewAssetRoutes,
} from './message-card-media-preview.fixtures';
import { installRerDutyShortStateMocks } from './rer-duty-short-state.fixtures';

type ManageMessageDrawerHost = 'duty' | 'analysis';
type LinkedMessageKind = 'with-report' | 'forwarded-report';

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
        : 'E2E forwarded intelligence report as a message',
    media: [],
    images: [],
    parentMessages: kind === 'forwarded-report' ? [linkedSummary(42, 'Original report')] : [],
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

  await expect(
    page.getByText((inboxResponse.inbox_items[0]![1] as { text: string }).text),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Редагувати', exact: true }).first().click();
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
  }
});
