import { expect, test, type Page } from '@playwright/test';

import { createLoadedInboxResponse, installAnalysisNeoApiMocks } from './analysis-neo.fixtures';

function reportHistoryRow(
  id: number,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    report_kind: 'tags',
    requested_by: 'analysis-tester',
    created_at: '2026-10-09 12:00:00',
    started_at: '2026-10-09 12:00:01',
    planned_for_ts: null,
    queue_position: null,
    blocked_by_report_id: null,
    blocked_by_started_at: null,
    blocked_by_bgtask_id: null,
    status: 'in_progress',
    completed_at: null,
    has_file: false,
    file_name: null,
    content_type: null,
    bgtask_id: 77,
    last_error: null,
    is_cancelled: false,
    details: '',
    progress: 50,
    error_log: null,
    ...overrides,
  };
}

async function openReportsDialog(page: Page) {
  const reportsButton = page.getByRole('button', { name: 'Звіти' }).first();
  await expect(reportsButton).toBeVisible();
  await reportsButton.click();

  const dialog = page.getByRole('dialog', { name: 'Звіти' });
  await expect(dialog).toBeVisible();
  return dialog;
}

test.describe('Analysis report characterization @regression', () => {
  for (const fileType of ['Docx', 'Xlsx']) {
    for (const summaryOnly of [false, true]) {
      test(`#3864 launches REO ${fileType} with summaryOnly=${summaryOnly}`, async ({ page }) => {
        await installAnalysisNeoApiMocks(page, {
          userRoles: ['Rer', 'AdvancedReports'],
          inboxResponse: createLoadedInboxResponse(),
        });
        const launchBodies: unknown[] = [];
        await page.route('**/api/rer/report-docx-task-launch', async (route) => {
          launchBodies.push(route.request().postDataJSON());
          await route.fulfill({ contentType: 'application/json', body: '3864' });
        });
        await page.route('**/api/report-history/status', async (route) => {
          await route.fulfill({
            contentType: 'application/json',
            body: JSON.stringify(
              reportHistoryRow(3864, {
                report_kind: 'reo',
                status: 'planned',
                bgtask_id: null,
              }),
            ),
          });
        });
        await page.goto('/rer-analysis-neo?freqs=123.4');
        const dialog = await openReportsDialog(page);
        await dialog.getByRole('button', { name: /РЕО/ }).click();
        const summaryCheckbox = dialog.getByRole('checkbox', {
          name: 'Лише підсумкова активність',
        });
        await expect(summaryCheckbox).toBeEnabled();
        await expect(summaryCheckbox).not.toBeChecked();
        if (summaryOnly) {
          await summaryCheckbox.check();
        }
        if (fileType === 'Xlsx') {
          await dialog.getByRole('combobox', { name: 'Формат' }).click();
          await page.getByRole('option', { name: 'xlsx', exact: true }).click();
        }
        await dialog.getByRole('button', { name: 'Завантажити docx/xlsx' }).click();
        await expect.poll(() => launchBodies.length).toBe(1);
        expect(launchBodies[0]).toEqual(
          expect.objectContaining({
            kind: 'reo',
            report_type: {
              Reo: [
                { adjacent_freqs_distance: 0, no_comments: false, summary_only: summaryOnly },
                fileType,
              ],
            },
            req: expect.objectContaining({ selected_freqs: ['123.4'] }),
          }),
        );
      });
    }
  }

  for (const [includeWithoutComments, onlyThisUnitComments] of [
    [true, true],
    [true, false],
    [false, true],
    [false, false],
  ]) {
    test(`#3827 launches report 1.2.17 with includeWithoutComments=${includeWithoutComments}, onlyThisUnitComments=${onlyThisUnitComments}`, async ({
      page,
    }) => {
      await installAnalysisNeoApiMocks(page, {
        userRoles: ['Rer', 'AdvancedReports'],
        inboxResponse: createLoadedInboxResponse(),
      });
      const launchBodies: unknown[] = [];
      await page.route('**/api/rer/report-docx-task-launch', async (route) => {
        launchBodies.push(route.request().postDataJSON());
        await route.fulfill({ contentType: 'application/json', body: '1217' });
      });
      await page.route('**/api/report-history/status', async (route) => {
        await route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify(
            reportHistoryRow(1217, {
              report_kind: 'report_1217',
              status: 'planned',
              bgtask_id: null,
            }),
          ),
        });
      });
      await page.goto('/rer-analysis-neo?freqs=123.4');
      const dialog = await openReportsDialog(page);
      await dialog.getByRole('button', { name: /Звіт 1\.2\.17/ }).click();
      const includeCheckbox = dialog.getByRole('checkbox', {
        name: 'Включати перехоплення без коментарів',
      });
      await expect(includeCheckbox).toBeChecked();
      if (!includeWithoutComments) {
        await includeCheckbox.uncheck();
      }
      const onlyThisUnitCheckbox = dialog.getByRole('checkbox', {
        name: 'Лише коментарі мого підрозділу',
      });
      await expect(onlyThisUnitCheckbox).toBeChecked();
      if (!onlyThisUnitComments) {
        await onlyThisUnitCheckbox.uncheck();
      }
      await dialog.getByRole('button', { name: 'Завантажити docx/xlsx' }).click();
      await expect.poll(() => launchBodies.length).toBe(1);
      expect(launchBodies[0]).toEqual(
        expect.objectContaining({
          kind: 'report_1217',
          report_type: null,
          report_1217_include_without_comments: includeWithoutComments,
          report_tags_only_this_unit: onlyThisUnitComments,
          req: expect.objectContaining({ selected_freqs: ['123.4'] }),
        }),
      );
    });
  }

  test('@smoke launches the selected report, renders progress logs, and downloads the result', async ({
    page,
  }) => {
    await installAnalysisNeoApiMocks(page, {
      inboxResponse: createLoadedInboxResponse(),
    });

    const launchBodies: unknown[] = [];
    const statusBodies: unknown[] = [];
    const bgtaskSkips: string[] = [];
    const downloadBodies: unknown[] = [];

    await page.route('**/api/rer/report-docx-task-launch', async (route) => {
      launchBodies.push(route.request().postDataJSON());
      await route.fulfill({ contentType: 'application/json', body: '123' });
    });
    await page.route('**/api/report-history/status', async (route) => {
      statusBodies.push(route.request().postDataJSON());
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify(reportHistoryRow(123)),
      });
    });
    await page.route('**/api/bgtask/77/status-and-logs?*', async (route) => {
      bgtaskSkips.push(new URL(route.request().url()).searchParams.get('skip') ?? '');
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          running: false,
          loglines: ['[1/2] Підготовка даних', '[2/2] Формування документа'],
          finished_with_error: null,
          finished_with_error_code: null,
          progress: 100,
        }),
      });
    });
    await page.route('**/api/report-history/download', async (route) => {
      downloadBodies.push(route.request().postDataJSON());
      await route.fulfill({
        contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        body: 'report-bytes',
      });
    });

    await page.goto('/rer-analysis-neo?freqs=123.4');
    const dialog = await openReportsDialog(page);

    await expect(dialog.getByRole('tab', { name: 'СТВОРЕННЯ' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await dialog.getByRole('button', { name: /З донесенням/ }).click();
    await dialog.getByRole('button', { name: 'Завантажити docx/xlsx' }).click();

    await expect.poll(() => launchBodies.length).toBe(1);
    expect(launchBodies[0]).toEqual(
      expect.objectContaining({
        kind: 'tags',
        report_type: 'Tags',
        req: expect.objectContaining({ selected_freqs: ['123.4'] }),
      }),
    );
    await expect.poll(() => statusBodies).toEqual([{ id: 123 }]);
    await expect.poll(() => bgtaskSkips).toEqual(['0']);
    await expect.poll(() => downloadBodies).toEqual([{ id: 123 }]);
    await expect(dialog.getByText('Готово', { exact: true })).toBeVisible();

    await dialog.getByRole('button', { name: 'Показати деталі' }).click();
    const runSummary = dialog.getByRole('button', { name: /донесення.*Успішно/i });
    await runSummary.click();
    await expect(dialog.getByText('[1/2] Підготовка даних')).toBeVisible();
    await expect(dialog.getByText('[2/2] Формування документа')).toBeVisible();
  });

  test('keeps a failed run visible and repeats it with the original snapshot', async ({ page }) => {
    await installAnalysisNeoApiMocks(page, {
      inboxResponse: createLoadedInboxResponse(),
    });

    const launchBodies: unknown[] = [];
    const downloadedTaskIds: number[] = [];
    await page.route('**/api/rer/report-docx-task-launch', async (route) => {
      launchBodies.push(route.request().postDataJSON());
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify(launchBodies.length === 1 ? 456 : 457),
      });
    });
    await page.route('**/api/report-history/status', async (route) => {
      const { id } = route.request().postDataJSON() as { id: number };
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify(
          id === 456
            ? reportHistoryRow(id, {
                status: 'failed',
                completed_at: '2026-10-09 12:00:02',
                bgtask_id: null,
                last_error: 'generation failed',
                progress: 0,
              })
            : reportHistoryRow(id, { bgtask_id: 78 }),
        ),
      });
    });
    await page.route('**/api/bgtask/78/status-and-logs?*', async (route) => {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          running: false,
          loglines: ['[1/1] Повтор завершено'],
          finished_with_error: null,
          finished_with_error_code: null,
          progress: 100,
        }),
      });
    });
    await page.route('**/api/report-history/download', async (route) => {
      const { id } = route.request().postDataJSON() as { id: number };
      downloadedTaskIds.push(id);
      await route.fulfill({ contentType: 'application/octet-stream', body: 'report-bytes' });
    });

    await page.goto('/rer-analysis-neo?freqs=123.4');
    const dialog = await openReportsDialog(page);
    await dialog.getByRole('button', { name: 'Завантажити docx/xlsx' }).click();

    await expect(dialog.getByText('Помилка', { exact: true })).toBeVisible();
    await expect(
      dialog.getByText('Сталася помилка під час формування звіту.', { exact: true }),
    ).toBeVisible();
    expect(downloadedTaskIds).toEqual([]);

    await dialog.getByRole('button', { name: 'Сформувати повторно' }).first().click();

    await expect.poll(() => launchBodies.length).toBe(2);
    expect(launchBodies[1]).toEqual(launchBodies[0]);
    await expect.poll(() => downloadedTaskIds).toEqual([457]);
    await expect(dialog.getByText('Готово', { exact: true })).toBeVisible();
  });
});
