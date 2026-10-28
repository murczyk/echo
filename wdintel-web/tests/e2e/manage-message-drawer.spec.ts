import { expect, test, type Page } from '@playwright/test';

import {
  createOverflowingInboxResponse,
  installAnalysisNeoApiMocks,
} from './analysis-neo.fixtures';
import { clickCreateMessage, openCreateMessageDrawer } from './image-editor-drawer.fixtures';
import {
  buildMessageCardMediaPreviewInboxResponse,
  installMessageCardMediaPreviewAssetRoutes,
} from './message-card-media-preview.fixtures';
import { installRerDutyShortStateMocks } from './rer-duty-short-state.fixtures';

type ManageMessageDrawerHost = 'duty' | 'analysis';
type LinkedMessageKind =
  'with-report' | 'forwarded-report' | 'own-report-without-accessible-parent';

async function dismissSettingsFailureNotifications(page: Page, host: ManageMessageDrawerHost) {
  const settingsFailure = page
    .getByRole('alert')
    .filter({ hasText: 'Помилка завантаження системних налаштувань' });
  await expect(settingsFailure).toBeVisible();
  await settingsFailure.getByRole('button', { name: 'Закрити сповіщення' }).click();
  await expect(settingsFailure).toHaveCount(0);
  if (host === 'duty') {
    const requestFailure = page
      .getByRole('alert')
      .filter({ hasText: 'System settings unavailable' });
    await expect(requestFailure).toBeVisible();
    await requestFailure.getByRole('button', { name: 'Закрити сповіщення' }).click();
    await expect(requestFailure).not.toBeVisible();
  }
}

async function expectEmbeddedEditor(page: Page) {
  const editor = page.locator('[data-manage-message-presentation="embedded"]');
  await expect(editor).toBeVisible();
  await expect(page.locator('.MuiBackdrop-root:visible')).toHaveCount(0);
  const width = await editor.evaluate((element) => element.getBoundingClientRect().width);
  expect(width).toBeGreaterThan(0);
  const surfaceStyle = await editor.evaluate((element) => {
    const style = getComputedStyle(element);
    return { animationDuration: style.animationDuration, boxShadow: style.boxShadow };
  });
  expect(surfaceStyle.boxShadow).toBe('none');
  expect(Number.parseFloat(surfaceStyle.animationDuration)).toBeGreaterThan(0);
}

async function expectModalEditor(page: Page) {
  await expect(page.locator('[data-manage-message-presentation="modal"]')).toBeVisible();
  await expect(page.locator('.MuiBackdrop-root:visible')).toHaveCount(1);
}

async function scrollEditorContent(source: ReturnType<Page['getByRole']>) {
  const scrollTop = await source.evaluate((element) => {
    const surface = element.closest('[data-manage-message-presentation]');
    let candidate = element.parentElement;
    while (candidate && candidate !== surface?.parentElement) {
      const overflowY = getComputedStyle(candidate).overflowY;
      if (
        candidate.scrollHeight > candidate.clientHeight + 1 &&
        (overflowY === 'auto' || overflowY === 'scroll')
      ) {
        candidate.dataset.e2eEditorScroller = 'true';
        candidate.scrollTop = Math.min(300, candidate.scrollHeight - candidate.clientHeight);
        return candidate.scrollTop;
      }
      candidate = candidate.parentElement;
    }
    return 0;
  });
  return { scrollTop, scroller: source.page().locator('[data-e2e-editor-scroller="true"]') };
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
  {
    hideNetworks = false,
    systemSettingsFailure = false,
    withNetworkSource = false,
    beforeEdit,
  }: {
    hideNetworks?: boolean;
    systemSettingsFailure?: boolean;
    withNetworkSource?: boolean;
    beforeEdit?: () => void;
  } = {},
) {
  const inboxResponse = buildLinkedInboxResponse(kind);
  let copyRequestCount = 0;
  if (withNetworkSource) {
    Object.assign(inboxResponse.inbox_items[0]![1] as Record<string, unknown>, {
      networkIds: [7],
      networkName: 'E2E source network',
    });
  }
  await installMessageCardMediaPreviewAssetRoutes(page);

  if (host === 'analysis') {
    await installAnalysisNeoApiMocks(page, {
      inboxResponse,
      hideNetworks,
      systemSettingsFailure,
      signalGroups: ['e2e-group'],
    });
    await page.goto('/rer-analysis-neo');
  } else {
    const dutyMocks = await installRerDutyShortStateMocks(page, {
      inboxResponse,
      hideNetworks,
      systemSettingsFailure,
      signalGroups: ['e2e-group'],
    });
    await page.goto('/rer-duty-neo');
    await dutyMocks.systemSettingsReady;
  }
  if (systemSettingsFailure) {
    await dismissSettingsFailureNotifications(page, host);
  } else if (host === 'duty') {
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
  beforeEdit?.();
  await page.getByRole('button', { name: 'Більше дій', exact: true }).first().click();
  await page.getByRole('menuitem', { name: 'Редагувати', exact: true }).first().click();
  return { getCopyRequestCount: () => copyRequestCount };
}

async function openOverflowingMessageEditor(
  page: Page,
  host: ManageMessageDrawerHost,
  hideNetworks = false,
  systemSettingsFailure = false,
) {
  const inboxResponse = createOverflowingInboxResponse();
  const dutyMocks =
    host === 'duty'
      ? await installRerDutyShortStateMocks(page, {
          inboxResponse,
          hideNetworks,
          systemSettingsFailure,
          signalGroups: ['analysis-summary-e2e-group'],
        })
      : null;
  if (host === 'analysis') {
    await installAnalysisNeoApiMocks(page, {
      inboxResponse,
      hideNetworks,
      systemSettingsFailure,
      signalGroups: ['analysis-summary-e2e-group'],
    });
  }
  await page.goto(host === 'duty' ? '/rer-duty-neo' : '/rer-analysis-neo');
  if (dutyMocks) await dutyMocks.systemSettingsReady;
  await expect(page.getByText('Analysis narrow fixture message 0')).toBeVisible();
  if (systemSettingsFailure) {
    await dismissSettingsFailureNotifications(page, host);
  }
  await clickCreateMessage(page, host);
  await expect(page.getByRole('heading', { name: 'Створити повідомлення' })).toBeVisible();
  await expectEmbeddedEditor(page);
}

async function openCreateEditorWithLinkedMessage(
  page: Page,
  host: ManageMessageDrawerHost,
  sourceMetadata: Record<string, unknown> = {},
): Promise<void> {
  const inboxResponse = buildMessageCardMediaPreviewInboxResponse({
    messageText: 'E2E source for dirty replacement',
  });
  Object.assign(inboxResponse.inbox_items[0]![1] as Record<string, unknown>, sourceMetadata);
  await installMessageCardMediaPreviewAssetRoutes(page);
  const dutyMocks =
    host === 'duty'
      ? await installRerDutyShortStateMocks(page, {
          inboxResponse,
          signalGroups: ['e2e-group'],
        })
      : null;
  if (host === 'analysis') {
    await installAnalysisNeoApiMocks(page, { inboxResponse, signalGroups: ['e2e-group'] });
  }
  await page.goto(host === 'duty' ? '/rer-duty-neo' : '/rer-analysis-neo');
  if (dutyMocks) await dutyMocks.systemSettingsReady;
  await expect(page.getByText('E2E source for dirty replacement')).toBeVisible();
  await clickCreateMessage(page, host);
  await expectEmbeddedEditor(page);
}

test.describe('@smoke manage message drawer linked-message regressions', () => {
  test.describe.configure({ timeout: 60_000 });
  test('analysis focuses the message text when creation opens', async ({ page }) => {
    await openCreateMessageDrawer(page, 'analysis');

    await expect(page.getByRole('textbox', { name: 'Текст повідомлення' })).toBeFocused();
  });

  test('analysis restores focus to the create action after closing with Escape', async ({
    page,
  }) => {
    await openCreateMessageDrawer(page, 'analysis');

    await page.getByRole('textbox', { name: 'Текст повідомлення' }).press('Escape');

    await expect(page.locator('[data-manage-message-presentation]')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Додати повідомлення' })).toBeFocused();
    await expect(page.locator('[data-manage-message-focus-fallback]')).not.toBeFocused();
  });

  test('duty restores focus to the create action after closing with Escape', async ({ page }) => {
    await openCreateMessageDrawer(page, 'duty');

    await page.getByRole('textbox', { name: 'Текст повідомлення' }).press('Escape');

    await expect(page.locator('[data-manage-message-presentation]')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Додати повідомлення' })).toBeFocused();
    await expect(page.locator('[data-manage-message-focus-fallback]')).toHaveCount(0);
  });

  for (const host of ['duty', 'analysis'] as const satisfies ManageMessageDrawerHost[]) {
    for (const hideNetworks of [true, false]) {
      test(`#3598 ${host} editor network field follows hideNetworks=${hideNetworks}`, async ({
        page,
      }) => {
        await page.setViewportSize({ width: 1920, height: 900 });
        const networkSearches: string[] = [];
        page.on('request', (request) => {
          if (new URL(request.url()).pathname === '/api/sigint/network/search') {
            networkSearches.push(request.url());
          }
        });
        await openOverflowingMessageEditor(page, host, hideNetworks);
        const editor = page.locator('[data-manage-message-presentation]');
        await expect(editor.getByRole('combobox', { name: 'Мережа', exact: true })).toHaveCount(
          hideNetworks ? 0 : 1,
        );
        await expect(
          editor.getByRole('combobox', { name: 'Частота (МГц)', exact: true }),
        ).toBeVisible();
        if (hideNetworks) expect(networkSearches).toEqual([]);
        else await expect.poll(() => networkSearches.length).toBeGreaterThan(0);
      });
    }

    test(`#3598 ${host} keeps editor networks hidden when settings fail`, async ({ page }) => {
      await page.setViewportSize({ width: 1920, height: 900 });
      const networkSearches: string[] = [];
      page.on('request', (request) => {
        if (new URL(request.url()).pathname === '/api/sigint/network/search') {
          networkSearches.push(request.url());
        }
      });
      await openOverflowingMessageEditor(page, host, false, true);
      const editor = page.locator('[data-manage-message-presentation]');
      await expect(editor.getByRole('combobox', { name: 'Мережа', exact: true })).toHaveCount(0);
      await expect(
        editor.getByRole('combobox', { name: 'Частота (МГц)', exact: true }),
      ).toBeVisible();
      const frequency = editor.getByRole('combobox', { name: 'Частота (МГц)', exact: true });
      await frequency.click();
      await frequency.press('Control+A');
      await frequency.pressSequentially('149.500');
      await frequency.press('Tab');
      await expect(frequency).toHaveValue('149.500');
      expect(networkSearches).toEqual([]);
    });

    for (const { label, hideNetworks, systemSettingsFailure } of [
      { label: 'hidden', hideNetworks: true, systemSettingsFailure: false },
      { label: 'settings unavailable', hideNetworks: false, systemSettingsFailure: true },
    ]) {
      test(`#3598 ${host} suppresses source network hydration when ${label}`, async ({ page }) => {
        const networkRequests: string[] = [];
        await openLinkedMessageEditDrawer(page, host, 'with-report', {
          hideNetworks,
          systemSettingsFailure,
          withNetworkSource: true,
          beforeEdit: () => {
            page.on('request', (request) => {
              const pathname = new URL(request.url()).pathname;
              if (
                pathname === '/api/sigint/network/search' ||
                pathname === '/api/sigint/network-info-batch-id'
              ) {
                networkRequests.push(pathname);
              }
            });
          },
        });

        const editor = page.locator('[data-manage-message-presentation]');
        await expect(editor).toBeVisible();
        await expect(editor.getByRole('combobox', { name: 'Мережа', exact: true })).toHaveCount(0);
        expect(networkRequests).toEqual([]);
      });
    }

    test(`${host} restores focus to the report action after closing`, async ({ page }) => {
      await page.setViewportSize({ width: 1600, height: 900 });
      await openCreateEditorWithLinkedMessage(page, host);
      await page.getByRole('textbox', { name: 'Текст повідомлення' }).press('Escape');

      const sourceCard = page.locator('[data-message-card-root]').first();
      const reportAction = sourceCard.getByRole('button', {
        name: 'Створити розвіддонесення',
        exact: true,
      });
      await reportAction.click();
      const sourceOutlineStyle = await sourceCard.evaluate(
        (element) => getComputedStyle(element).outlineStyle,
      );
      expect(sourceOutlineStyle).toBe('solid');
      await expect(page.getByRole('heading', { name: 'Створити розвіддонесення' })).toBeVisible();
      await page.getByRole('button', { name: 'Закрити', exact: true }).click();

      await expect(page.locator('[data-manage-message-presentation]')).toHaveCount(0);
      await expect(reportAction).toBeFocused();
    });

    test(`@regression #3891 ${host} preserves inherited metadata through report text changes and manual edits`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: 1600, height: 1000 });
      await openCreateEditorWithLinkedMessage(page, host, {
        date: '2026-10-20',
        time: '09:46',
        timestamp: Date.parse('2026-10-21T10:20:00Z'),
        unit: '51 пдп',
        networkIds: [7],
        networkName: 'Source network',
      });
      await page.getByRole('textbox', { name: 'Текст повідомлення' }).press('Escape');
      await page.route('**/api/1.1/messages/copy', (route) =>
        route.fulfill({
          json: {
            payloads: [
              {
                full_body: '20.10.2026, 09:46 original',
                timestamp: '2026-10-20T06:46:00Z',
                unit: '51 пдп',
                freq: '149.500',
                comment: 'Source comment',
                network: { name: 'Source network' },
              },
            ],
          },
        }),
      );
      await page.route('**/api/sigint/unit/search', (route) =>
        route.fulfill({
          json: {
            units: [
              { id: 51, name: '51 пдп' },
              { id: 52, name: '51 пдп' },
            ],
          },
        }),
      );
      await page.route('**/api/1.1/intelligence-reports/quick-suggestion', (route) =>
        route.fulfill({ json: { suggestions: ['Suggested report'] } }),
      );
      await page.route('**/api/1.1/submit-direct', (route) =>
        route.fulfill({ json: { signal_message_id: 501 } }),
      );
      await page
        .getByRole('button', { name: 'Створити розвіддонесення', exact: true })
        .first()
        .click();
      const editor = page.locator('[data-manage-message-presentation]');
      const body = editor.getByRole('textbox', { name: 'Текст розвіддонесення' });
      const unit = editor.getByRole('combobox', { name: 'Підрозділ', exact: true });
      const date = editor.getByLabel('Дата перехоплення', { exact: true });
      const time = editor.getByLabel('Час перехоплення', { exact: true });
      await expect(unit).toHaveValue('51 пдп');
      await expect(date).toHaveValue(/20.*10.*2026/);
      await expect(time).toHaveValue(/09.*46/);
      await expect(editor.getByText('Підрозділ не обрано', { exact: true })).toHaveCount(0);
      await time.fill('07:12');
      await body.fill('Report draft');
      await body.clear();
      await expect(unit).toHaveValue('51 пдп');
      await expect(date).toHaveValue(/20.*10.*2026/);
      await expect(time).toHaveValue(/07.*12/);
      await body.fill('Final report');
      await editor.getByRole('combobox', { name: 'Відправити в групу' }).click();
      await page.getByRole('option', { name: 'Не відправляти', exact: true }).click();
      const submitted = page.waitForRequest('**/api/1.1/submit-direct');
      await editor.getByRole('button', { name: 'Створити', exact: true }).click();
      const payload = (await submitted).postDataJSON();
      expect(payload).toMatchObject({
        unit: '51 пдп',
        timestamp: '2026-10-20T04:12:00.000Z',
        comment: 'Source comment',
        signal_group_master_key: null,
      });
      expect(payload.unit_id).toBeUndefined();
      expect(payload.create_unit).toBeUndefined();
      await expect(editor).toHaveCount(0);
    });

    test(`${host} closes the report composer after successful creation`, async ({ page }) => {
      await page.setViewportSize({ width: 1600, height: 900 });
      await openCreateEditorWithLinkedMessage(page, host);
      await page.getByRole('textbox', { name: 'Текст повідомлення' }).press('Escape');
      await page.route('**/api/1.1/messages/copy', async (route) => {
        await route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({
            payloads: [{ full_body: 'Copied report source', parent_signal_message_ids: [42] }],
          }),
        });
      });
      await page.route('**/api/1.1/submit-direct', async (route) => {
        await route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({ signal_message_id: 501 }),
        });
      });

      await page
        .getByRole('button', { name: 'Створити розвіддонесення', exact: true })
        .first()
        .click();
      await page
        .getByRole('textbox', { name: 'Текст розвіддонесення' })
        .fill('Created intelligence report');
      await page.getByRole('combobox', { name: 'Відправити в групу' }).click();
      await page.getByRole('option', { name: 'Не відправляти', exact: true }).click();
      await page.getByRole('button', { name: 'Створити', exact: true }).click();

      await expect(page.locator('[data-manage-message-presentation]')).toHaveCount(0);
    });
  }

  test('@regression #3620 auto-parses by default and allows saving after an AI warning', async ({
    page,
  }) => {
    await openCreateMessageDrawer(page, 'duty');
    await page.route('**/api/1.1/submit-direct/parse', async (route) => {
      expect(route.request().postDataJSON().include_ai_callsigns).toBe(true);
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          text: 'Ярус, прием',
          freq: '149.500',
          coords: [],
          to: ['ярус'],
          locations: [],
          ai_callsign_warning: 'ШІ недоступний. Застосовано звичайний парсинг.',
        }),
      });
    });
    await expect(page.getByRole('button', { name: 'Авто-парсинг', exact: true })).toBeVisible();
    await page
      .getByRole('textbox', { name: 'Текст повідомлення' })
      .fill('Ярус, прием, частота 149.500');
    await expect(page.getByLabel('Частота (МГц)')).toHaveValue('149.500');
    await expect(page.getByText('ШІ недоступний. Застосовано звичайний парсинг.')).toBeVisible();
    await page.getByRole('combobox', { name: 'Група', exact: true }).click();
    await page.getByRole('option', { name: 'editor-e2e-group', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Створити', exact: true })).toBeEnabled();
  });

  test('ownership journey preserves manual fields while parsed values follow source text', async ({
    page,
  }) => {
    await openCreateMessageDrawer(page, 'duty');
    await page.route('**/api/1.1/submit-direct/parse', async (route) => {
      const body = route.request().postDataJSON() as { full_body?: string };
      const firstVersion = body.full_body?.includes('перша версія');
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          text: '',
          freq: firstVersion ? '149.500' : '151.000',
          coords: firstVersion ? [{ lat: 49.123457, lon: 37.234568 }] : [],
          to: [],
          locations: [],
        }),
      });
    });
    const source = page.getByRole('textbox', { name: 'Текст повідомлення' });

    await source.fill('49.123457, 37.234568 частота 149.500 перша версія');
    await expect(page.getByText('37U CQ 71194 42681')).toBeVisible();
    await expect(page.getByLabel('Частота (МГц)')).toHaveValue('149.500');

    const coordinateInput = page.getByRole('textbox', { name: 'Додати координату' });
    await coordinateInput.fill('49.22346, 37.33457');
    await coordinateInput.press('Enter');
    await expect(page.getByRole('button', { name: /^Видалити координату/ })).toHaveCount(2);
    await page.getByLabel('Частота (МГц)').fill('150.000');

    await source.fill('частота 151.000 друга версія');

    await expect(page.getByRole('button', { name: /^Видалити координату/ })).toHaveCount(1);
    await expect(page.getByText('37U CQ 71194 42681')).toHaveCount(0);
    await expect(page.getByLabel('Частота (МГц)')).toHaveValue('150.000');
    const frequencyFeedback = page.getByTestId('parser-feedback-freq');
    await expect(frequencyFeedback).toHaveAttribute('data-state', 'conflict');

    await page.waitForTimeout(3100);
    await expect(frequencyFeedback).toHaveAttribute('data-state', 'conflict');
    await page.getByRole('button', { name: 'Взяти частоту із тексту' }).click();
    await expect(page.getByLabel('Частота (МГц)')).toHaveValue('151.000');
    await expect(frequencyFeedback).toHaveAttribute('data-state', 'updated');
    await expect(frequencyFeedback).toHaveAttribute('data-state', 'idle', { timeout: 4000 });
    await expect(page.getByRole('button', { name: /^Видалити координату/ })).toHaveCount(1);

    await source.fill('');

    await expect(page.getByLabel('Частота (МГц)')).toHaveValue('151.000');
    await expect(page.getByRole('button', { name: /^Видалити координату/ })).toHaveCount(1);
  });

  for (const host of ['duty', 'analysis'] as const satisfies ManageMessageDrawerHost[]) {
    test(`${host} keeps the draft while switching between embedded and modal presentation`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: 1280, height: 800 });
      await openCreateMessageDrawer(page, host);
      await expectEmbeddedEditor(page);
      const source = page.getByRole('textbox', { name: 'Текст повідомлення' });
      await source.fill(`${host} responsive draft`);

      await page.setViewportSize({ width: 768, height: 800 });
      await expectModalEditor(page);
      await expect(source).toHaveValue(`${host} responsive draft`);

      await page.setViewportSize({ width: 1023, height: 800 });
      await expectModalEditor(page);
      await expect(source).toHaveValue(`${host} responsive draft`);

      await page.setViewportSize({ width: 1024, height: 800 });
      await expectEmbeddedEditor(page);
      await expect(source).toHaveValue(`${host} responsive draft`);

      await page.getByRole('button', { name: 'Закрити', exact: true }).click();
      await page.getByRole('button', { name: 'Відхилити зміни' }).click();
      await expect(page.locator('[data-manage-message-presentation]')).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Додати повідомлення' })).toBeFocused();
    });
    test(`${host} edits a message with an intelligence report as a message`, async ({ page }) => {
      await openLinkedMessageEditDrawer(page, host, 'with-report');

      await expect(page.getByRole('heading', { name: 'Редагувати повідомлення' })).toBeVisible();
      await expectEmbeddedEditor(page);
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
      await expectEmbeddedEditor(page);
      await expect(page.getByRole('heading', { name: 'Редагувати повідомлення' })).toHaveCount(0);
      expect(drawer.getCopyRequestCount()).toBe(0);
    });
  }

  for (const host of ['duty', 'analysis'] as const satisfies ManageMessageDrawerHost[]) {
    test(`${host} keeps editor draft and scroll independent from the message workspace`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: 1280, height: 800 });
      await openOverflowingMessageEditor(page, host);
      const source = page.getByRole('textbox', { name: 'Текст повідомлення' });
      await source.fill(`${host} concurrent scroll draft`);
      await page.getByRole('button', { name: 'Розширені поля', exact: true }).first().click();
      const { scrollTop: editorScrollTop, scroller: editorScroller } =
        await scrollEditorContent(source);
      expect(editorScrollTop).toBeGreaterThan(0);

      const workspaceScroller =
        host === 'duty'
          ? page.locator('[data-duty-feed-scroller="true"]').first()
          : page.locator('[data-analysis-message-scroller]');
      await workspaceScroller.evaluate((element) => {
        element.scrollTop = Math.min(300, element.scrollHeight - element.clientHeight);
        element.dispatchEvent(new Event('scroll'));
      });
      await expect
        .poll(() => workspaceScroller.evaluate((element) => element.scrollTop))
        .toBeGreaterThan(0);
      await expect(source).toHaveValue(`${host} concurrent scroll draft`);
      await expect
        .poll(() => editorScroller.evaluate((element) => element.scrollTop))
        .toBe(editorScrollTop);
    });

    test(`${host} guards a dirty draft before replacing it from a message card`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: 1280, height: 800 });
      await openCreateEditorWithLinkedMessage(page, host);
      const source = page.getByRole('textbox', { name: 'Текст повідомлення' });
      await source.fill(`${host} protected draft`);

      const requestReport = async () => {
        await page
          .getByRole('button', { name: 'Створити розвіддонесення', exact: true })
          .first()
          .click();
      };
      await requestReport();
      await expect(page.getByText('Відхилити незбережені зміни?')).toBeVisible();
      await page.getByRole('button', { name: 'Продовжити редагування' }).click();
      await expect(source).toHaveValue(`${host} protected draft`);
      await expect(page.getByRole('heading', { name: 'Створити повідомлення' })).toBeVisible();

      await requestReport();
      await page.getByRole('button', { name: 'Відхилити зміни' }).click();
      await expect(page.getByRole('heading', { name: 'Створити розвіддонесення' })).toBeVisible();
      await expect(page.getByRole('heading', { name: 'Створити повідомлення' })).toHaveCount(0);
      await expect(page.locator('[data-manage-message-presentation]')).toHaveCount(1);
      await expect(page.locator('.MuiBackdrop-root:visible')).toHaveCount(0);
    });
  }

  test('workspace paste and submit shortcut do not leak into an inactive editor', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    let submissionCount = 0;
    await page.route('**/api/1.1/submit-direct', async (route) => {
      submissionCount += 1;
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ signal_message_id: 701 }),
      });
    });
    await openOverflowingMessageEditor(page, 'analysis');
    const search = page.getByPlaceholder('Пошук');
    await search.focus();
    await search.evaluate((element) => {
      const data = new DataTransfer();
      data.items.add(new File(['workspace'], 'workspace.txt', { type: 'text/plain' }));
      element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, clipboardData: data }));
    });
    await search.press('Control+Enter');

    await expect(page.getByText('Вкладення (0)')).toBeVisible();
    expect(submissionCount).toBe(0);
  });

  test('Duty uses one active feed while a four-feed workspace shares width with the editor', async ({
    page,
  }) => {
    const shortState = {
      waterfalls: Array.from({ length: 4 }, (_, index) => [
        `mf-${index}`,
        {
          groups_selected: [`group-${index + 1}`],
          groups_denied: null,
          senders_selected: [],
          denied_senders: null,
          freqs_selected: null,
          freqs_denied: null,
          posts_selected: null,
          posts_denied: null,
          units_selected: null,
          units_denied: null,
          selected_unit_ids: null,
          denied_unit_ids: null,
          selected_device_names: null,
          denied_device_names: null,
          units_exact_match_only: null,
          last_viewed_message_id: null,
          highlight_keywords_enabled: null,
          highlight_keyword_set_id: null,
        },
      ]),
    };
    const dutyMocks = await installRerDutyShortStateMocks(page, { shortState });
    const scenarios = [
      { width: 1280, visibleFeeds: 1, tabsVisible: true, density: 'compact', mainColumns: 1 },
      { width: 1440, visibleFeeds: 1, tabsVisible: true, density: 'compact', mainColumns: 1 },
      { width: 1600, visibleFeeds: 1, tabsVisible: true, density: 'compact', mainColumns: 2 },
      { width: 3440, visibleFeeds: 4, tabsVisible: false, density: 'compact', mainColumns: 2 },
    ];
    await page.setViewportSize({ width: scenarios[0]!.width, height: 800 });
    await page.goto('/rer-duty-neo?state-short=short-1');
    await dutyMocks.systemSettingsReady;

    for (const scenario of scenarios) {
      await page.setViewportSize({ width: scenario.width, height: 800 });
      await expect(page.locator('[data-duty-feed-column]')).toHaveCount(4);

      await clickCreateMessage(page, 'duty');
      const editor = page.locator('[data-manage-message-presentation="embedded"]');
      await expect(editor).toBeVisible();
      await expect
        .poll(() => editor.evaluate((element) => element.getBoundingClientRect().width))
        .toBeLessThanOrEqual(800);
      await expect(page.getByRole('tablist', { name: 'Стрічки' })).toHaveCount(
        scenario.tabsVisible ? 1 : 0,
      );
      await expect(page.locator('[data-duty-feed-column]')).toHaveCount(scenario.visibleFeeds);
      await expect(page.locator('#create-message-form')).toHaveAttribute(
        'data-manage-message-form-layout',
        scenario.density,
      );
      await expect
        .poll(() =>
          page
            .locator('#create-message-form')
            .evaluate((element) => getComputedStyle(element).gridTemplateColumns.split(' ').length),
        )
        .toBe(scenario.mainColumns);

      await page.getByRole('button', { name: 'Закрити', exact: true }).click();
      await expect(page.locator('[data-duty-feed-column]')).toHaveCount(4);
    }
  });

  test('Duty caps the adaptive editor and preserves an 8px workspace gap', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 800 });
    const inboxResponse = buildMessageCardMediaPreviewInboxResponse({
      messageText: 'E2E responsive card width',
    });
    const dutyMocks = await installRerDutyShortStateMocks(page, {
      inboxResponse,
      signalGroups: ['e2e-group'],
    });
    await page.goto('/rer-duty-neo');
    await dutyMocks.systemSettingsReady;
    await expect(page.getByText('E2E responsive card width')).toBeVisible();

    await clickCreateMessage(page, 'duty');
    await expectEmbeddedEditor(page);
    await page
      .locator('[data-manage-message-presentation="embedded"]')
      .evaluate((element) =>
        Promise.all(element.getAnimations().map((animation) => animation.finished)),
      );

    const bounds = await page.evaluate(() => {
      const workspace = document
        .querySelector<HTMLElement>('[data-duty-workspace-main]')
        ?.getBoundingClientRect();
      const card = document
        .querySelector<HTMLElement>('[data-message-card-root]')
        ?.getBoundingClientRect();
      const editor = document
        .querySelector<HTMLElement>('[data-manage-message-presentation="embedded"]')
        ?.getBoundingClientRect();
      return workspace && card && editor
        ? {
            workspaceWidth: workspace.width,
            workspaceLeft: workspace.left,
            workspaceRight: workspace.right,
            cardLeft: card.left,
            cardRight: card.right,
            editorLeft: editor.left,
            editorWidth: editor.width,
            layoutWidth: document
              .querySelector<HTMLElement>('[data-duty-editor-layout]')!
              .getBoundingClientRect().width,
            editorBackground: getComputedStyle(
              document.querySelector<HTMLElement>('[data-manage-message-presentation="embedded"]')!,
            ).backgroundColor,
            editorBorderLeft: getComputedStyle(
              document.querySelector<HTMLElement>('[data-manage-message-presentation="embedded"]')!,
            ).borderLeftStyle,
          }
        : null;
    });
    expect(bounds).not.toBeNull();
    expect(bounds!.cardLeft).toBeGreaterThanOrEqual(bounds!.workspaceLeft);
    expect(bounds!.cardRight).toBeLessThanOrEqual(bounds!.workspaceRight);
    expect(bounds!.editorLeft - bounds!.workspaceRight).toBeCloseTo(8, 0);
    expect(bounds!.editorWidth).toBeCloseTo(
      Math.min(800, Math.max(640, bounds!.layoutWidth * 0.48)),
      0,
    );
    expect(bounds!.workspaceWidth).toBeGreaterThan(600);
    expect(bounds!.editorBackground).toBe('rgba(0, 0, 0, 0)');
    expect(bounds!.editorBorderLeft).toBe('none');
    await expect(page.locator('#create-message-form')).toHaveAttribute(
      'data-manage-message-form-layout',
      'compact',
    );
    await expect
      .poll(() =>
        page
          .locator('#create-message-form')
          .evaluate((element) => getComputedStyle(element).gridTemplateColumns.split(' ').length),
      )
      .toBe(1);
    await expect
      .poll(() =>
        page.getByLabel('Дата перехоплення').evaluate((element) => {
          const form = element.closest('form');
          let parent = element.parentElement;
          while (parent && parent !== form) {
            const style = getComputedStyle(parent);
            if (style.display === 'grid') return style.gridTemplateColumns.split(' ').length;
            parent = parent.parentElement;
          }
          return 0;
        }),
      )
      .toBe(2);
  });

  test('Analysis editor uses a viable minimum and stays capped through ultrawide', async ({
    page,
  }) => {
    await installAnalysisNeoApiMocks(page, { inboxResponse: createOverflowingInboxResponse() });
    const scenarios = [
      {
        width: 1280,
        leftPanelOpen: false,
        editorWidth: 640,
        density: 'compact',
        mainColumns: 1,
        pairedColumns: 2,
        nestedSectionColumns: 2,
      },
      {
        width: 1440,
        leftPanelOpen: false,
        editorWidth: 691,
        density: 'compact',
        mainColumns: 1,
        pairedColumns: 2,
        nestedSectionColumns: 2,
      },
      {
        width: 1600,
        leftPanelOpen: true,
        editorWidth: 768,
        density: 'compact',
        mainColumns: 2,
        pairedColumns: 2,
        nestedSectionColumns: 1,
      },
      {
        width: 3440,
        leftPanelOpen: true,
        editorWidth: 800,
        density: 'compact',
        mainColumns: 2,
        pairedColumns: 2,
        nestedSectionColumns: 1,
      },
    ] as const;

    for (const scenario of scenarios) {
      await page.setViewportSize({ width: scenario.width, height: 900 });
      await page.goto(`/rer-analysis-neo?leftPanelOpen=${scenario.leftPanelOpen}`);
      await expect(page.getByText('Analysis narrow fixture message 0')).toBeVisible();
      await page.getByRole('button', { name: 'Додати повідомлення' }).click();

      const editor = page.locator('[data-manage-message-presentation="embedded"]');
      await expect(editor).toBeVisible();
      await expect(page.locator('#create-message-form')).toHaveAttribute(
        'data-manage-message-form-layout',
        scenario.density,
      );
      await expect
        .poll(() => editor.evaluate((element) => element.getBoundingClientRect().width))
        .toBeCloseTo(scenario.editorWidth, 0);
      const form = page.locator('#create-message-form');
      await expect
        .poll(() =>
          form.evaluate(
            (element) => getComputedStyle(element).gridTemplateColumns.split(' ').length,
          ),
        )
        .toBe(scenario.mainColumns);
      const dateInput = page.getByLabel('Дата перехоплення');
      await expect
        .poll(() =>
          dateInput.evaluate((element) => {
            const form = element.closest('form');
            let parent = element.parentElement;
            while (parent && parent !== form) {
              const style = getComputedStyle(parent);
              if (style.display === 'grid') return style.gridTemplateColumns.split(' ').length;
              parent = parent.parentElement;
            }
            return 0;
          }),
        )
        .toBe(scenario.pairedColumns);
      const frequencyInput = page.getByLabel('Частота (МГц)');
      await expect
        .poll(() =>
          frequencyInput.evaluate((element) => {
            const form = element.closest('form');
            let parent = element.parentElement;
            while (parent && parent !== form) {
              const style = getComputedStyle(parent);
              if (style.display === 'grid') return style.gridTemplateColumns.split(' ').length;
              parent = parent.parentElement;
            }
            return 0;
          }),
        )
        .toBe(scenario.pairedColumns);
      const groupInput = page.getByRole('combobox', { name: 'Група', exact: true });
      await expect
        .poll(() =>
          groupInput.evaluate((element) => {
            const form = element.closest('form');
            let parent = element.parentElement;
            while (parent && parent !== form) {
              const style = getComputedStyle(parent);
              if (style.display === 'grid') return style.gridTemplateColumns.split(' ').length;
              parent = parent.parentElement;
            }
            return 0;
          }),
        )
        .toBe(scenario.nestedSectionColumns);

      if (scenario.mainColumns === 2) {
        const [messageBounds, unitBounds] = await Promise.all([
          page.getByRole('textbox', { name: 'Текст повідомлення' }).evaluate((element) => {
            const inputRoot = element.closest('.MuiInputBase-root');
            if (!inputRoot) throw new Error('Message input root not found');
            const bounds = inputRoot.getBoundingClientRect();
            return { bottom: bounds.bottom, height: bounds.height, top: bounds.top };
          }),
          page.getByRole('combobox', { name: 'Підрозділ' }).evaluate((element) => {
            const inputRoot = element.closest('.MuiInputBase-root');
            if (!inputRoot) throw new Error('Unit input root not found');
            const bounds = inputRoot.getBoundingClientRect();
            return { bottom: bounds.bottom, height: bounds.height, top: bounds.top };
          }),
        ]);
        expect(
          Math.abs(messageBounds.bottom - unitBounds.bottom),
          JSON.stringify({ messageBounds, unitBounds, width: scenario.width }),
        ).toBeLessThanOrEqual(2);
      }

      const editorHeader = page
        .getByRole('heading', { name: 'Створити повідомлення' })
        .locator('..');
      const firstMessageCard = page.locator('[data-message-card-root]').first();
      const [headerBounds, cardBounds] = await Promise.all([
        editorHeader.boundingBox(),
        firstMessageCard.boundingBox(),
      ]);
      expect(headerBounds).not.toBeNull();
      expect(cardBounds).not.toBeNull();
      expect(headerBounds!.y + headerBounds!.height).toBeLessThanOrEqual(cardBounds!.y);

      const emptyCoordinatesPanel = page.getByText('Координати ще не додані').locator('..');
      await expect
        .poll(() =>
          emptyCoordinatesPanel.evaluate((element) => getComputedStyle(element).backgroundColor),
        )
        .toBe('rgba(0, 0, 0, 0)');

      if (scenario.width === 1440) {
        const dropzoneInstruction = page.getByText(
          'Натисніть, перетягніть або вставте (Cmd/Ctrl+V) файли сюди',
        );
        await expect
          .poll(() =>
            dropzoneInstruction.evaluate((element) => ({
              fits: element.scrollWidth <= element.clientWidth,
              whiteSpace: getComputedStyle(element).whiteSpace,
            })),
          )
          .toEqual({ fits: true, whiteSpace: 'normal' });

        const emptyCoordinates = page.getByText('Координати ще не додані');
        const emptyCoordinatePreview = page.getByText('Превʼю координат');
        await expect
          .poll(async () => ({
            coordinates: await emptyCoordinates.evaluate(
              (element) => getComputedStyle(element).fontSize,
            ),
            preview: await emptyCoordinatePreview.evaluate(
              (element) => getComputedStyle(element).fontSize,
            ),
          }))
          .toEqual({ coordinates: '12px', preview: '12px' });
      }

      if (scenario.width === 1440 || scenario.width === 3440) {
        const coordinateInput = page.getByRole('textbox', { name: 'Додати координату' });
        await coordinateInput.fill('49.123457, 37.234568');
        await coordinateInput.press('Enter');

        const coordinateText = page.getByText(/^37U CQ \d{5} \d{5}$/);
        await expect(coordinateText).toBeVisible();
        const coordinateFontSize = await coordinateText.evaluate((element) =>
          Number.parseFloat(getComputedStyle(element).fontSize),
        );
        expect(coordinateFontSize).toBeGreaterThan(11.5);
        await expect
          .poll(() =>
            coordinateText.evaluate((element) => element.scrollWidth <= element.clientWidth),
          )
          .toBe(true);

        const compactActions = page.getByRole('button', { name: 'Дії координати 1' });
        const copyAction = page.getByRole('button', { name: 'Копіювати координату 1' });
        if (scenario.mainColumns === 2) {
          await expect(compactActions).toBeVisible();
          await expect(copyAction).toBeHidden();
        } else {
          await expect(compactActions).toBeHidden();
          await expect(copyAction).toBeVisible();
        }
      }
    }
  });

  test('Analysis gives Network the full row when radio fields are unavailable', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 3440, height: 900 });
    await installAnalysisNeoApiMocks(page, {
      inboxResponse: createOverflowingInboxResponse(),
      userRoles: ['Cyber'],
    });
    await page.goto('/rer-analysis-neo?leftPanelOpen=true');
    await expect(page.getByText('Analysis narrow fixture message 0')).toBeVisible();
    await page.getByRole('button', { name: 'Додати повідомлення' }).click();

    await expect(page.getByLabel('Частота (МГц)')).toHaveCount(0);
    const networkWidths = await page.getByLabel('Мережа').evaluate((element) => {
      const feedback = element.closest('[data-testid="parser-feedback-network_name"]');
      const grid = feedback?.parentElement;
      if (!feedback || !grid) throw new Error('Network grid not found');
      return {
        field: feedback.getBoundingClientRect().width,
        grid: grid.getBoundingClientRect().width,
      };
    });
    expect(networkWidths.field).toBeCloseTo(networkWidths.grid, 0);
  });

  test('Analysis editor matches the app text scale while keeping phone inputs zoom-safe', async ({
    page,
  }) => {
    await installAnalysisNeoApiMocks(page, { inboxResponse: createOverflowingInboxResponse() });

    for (const scenario of [
      { width: 320, fontSize: '16px' },
      { width: 375, fontSize: '16px' },
      { width: 1440, fontSize: '14px' },
    ]) {
      await page.setViewportSize({ width: scenario.width, height: 900 });
      await page.goto('/rer-analysis-neo?leftPanelOpen=false');
      await expect(page.getByText('Analysis narrow fixture message 0')).toBeVisible();
      await page.getByRole('button', { name: 'Додати повідомлення' }).click();

      const fields = [
        page.getByRole('textbox', { name: 'Текст повідомлення' }),
        page.getByRole('combobox', { name: 'Підрозділ' }),
        page.getByLabel('Дата перехоплення'),
      ];
      await expect
        .poll(() =>
          Promise.all(
            fields.map((field) => field.evaluate((element) => getComputedStyle(element).fontSize)),
          ),
        )
        .toEqual(fields.map(() => scenario.fontSize));

      const emptyFieldLabels = ['Пост', 'Теги', 'Позивні'].map((label) =>
        page.locator('label').filter({ hasText: label }),
      );
      await expect
        .poll(() =>
          Promise.all(
            emptyFieldLabels.map((label) =>
              label.evaluate((element) => getComputedStyle(element).fontSize),
            ),
          ),
        )
        .toEqual(emptyFieldLabels.map(() => scenario.fontSize));
    }
  });

  test('Analysis keeps the editor and Analytics mutually exclusive', async ({ page }) => {
    await page.setViewportSize({ width: 1600, height: 800 });
    await installAnalysisNeoApiMocks(page, { inboxResponse: createOverflowingInboxResponse() });
    await page.goto('/rer-analysis-neo');
    await expect(page.getByText('Analysis narrow fixture message 0')).toBeVisible();
    await page.getByRole('button', { name: 'Розгорнути праву панель' }).click();
    const dock = page.getByTestId('analysis-right-dock');
    await expect(dock.locator('[data-analysis-dock-panel="analytics"]')).toBeVisible();

    await page.getByRole('button', { name: 'Додати повідомлення' }).click();
    await expectEmbeddedEditor(page);
    await expect(page.getByRole('button', { name: 'Додати повідомлення' })).toHaveCount(0);
    await expect(dock.locator('[data-analysis-dock-panel="analytics"]')).toHaveCount(0);
    await expect(dock.getByRole('tablist')).toHaveCount(0);
    await expect
      .poll(() =>
        page.locator('[data-manage-message-presentation="embedded"]').evaluate((element) => {
          const style = getComputedStyle(element);
          return {
            backgroundColor: style.backgroundColor,
            borderLeftStyle: style.borderLeftStyle,
          };
        }),
      )
      .toEqual({ backgroundColor: 'rgba(0, 0, 0, 0)', borderLeftStyle: 'none' });
    await page
      .locator('[data-manage-message-presentation="embedded"]')
      .evaluate((element) =>
        Promise.all(element.getAnimations().map((animation) => animation.finished)),
      );
    const [dockBounds, editorBounds] = await Promise.all([
      dock.boundingBox(),
      page.locator('[data-manage-message-presentation="embedded"]').boundingBox(),
    ]);
    expect(dockBounds).not.toBeNull();
    expect(editorBounds).not.toBeNull();
    expect(editorBounds!.x).toBeCloseTo(dockBounds!.x, 0);

    const source = page.getByRole('textbox', { name: 'Текст повідомлення' });
    await source.fill('analysis dock draft');

    await page.getByRole('button', { name: 'Розгорнути праву панель' }).click();
    await expect(page.getByText('Відхилити незбережені зміни?')).toBeVisible();
    await page.getByRole('button', { name: 'Продовжити редагування' }).click();
    await expect(source).toHaveValue('analysis dock draft');
    await expect(dock.locator('[data-analysis-dock-panel="analytics"]')).toHaveCount(0);

    await page.getByRole('button', { name: 'Розгорнути праву панель' }).click();
    await page.getByRole('button', { name: 'Відхилити зміни' }).click();
    await expect(dock.locator('[data-analysis-dock-panel="editor"]')).toHaveCount(0);
    await expect(dock.locator('[data-analysis-dock-panel="analytics"]')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Додати повідомлення' })).toBeVisible();
    await expect(page.locator('#analysis-groups-title')).toBeVisible();
  });
});
