import { expect, test, type Page, type Route } from '@playwright/test';

function fulfillJson(route: Route, body: unknown) {
  return route.fulfill({
    contentType: 'application/json; charset=utf-8',
    body: JSON.stringify(body),
  });
}

async function selectCsv(page: Page, name: string, contents: string) {
  const chooserPromise = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: /Вибрати CSV|Змінити CSV/ }).click();
  const chooser = await chooserPromise;
  await chooser.setFiles({
    name,
    mimeType: 'text/csv',
    buffer: Buffer.from(contents),
  });
}

test('@regression #3650 historical CSV import requires preflight', async ({ page }) => {
  let preflightRequests = 0;
  const importUrls: URL[] = [];
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    if (!['fetch', 'xhr'].includes(request.resourceType())) {
      await route.continue();
      return;
    }
    const url = new URL(request.url());
    if (url.pathname === '/api/user') {
      await fulfillJson(route, {
        id: 'csv-import-tester',
        name: 'csv-import-tester',
        roles: ['Admin'],
        sigint_zone_id: null,
        organism_id: null,
        delta_login: null,
        goi_configured_for_organism: false,
        goi_full_access_for_organism: false,
        goi_host: null,
        goi_integrations: [],
        last_release_seen: null,
      });
      return;
    }
    if (url.pathname === '/api/rer/csv-import/preflight') {
      preflightRequests += 1;
      if (preflightRequests === 2) {
        await route.fulfill({ status: 500, body: 'preflight failed' });
        return;
      }
      const hasSkippedRows = preflightRequests === 1;
      await route.fulfill({
        contentType: 'text/csv; charset=utf-8',
        headers: {
          'x-echo-rer-csv-total': hasSkippedRows ? '2' : '1',
          'x-echo-rer-csv-valid': '1',
          'x-echo-rer-csv-missing-timestamp': hasSkippedRows ? '1' : '0',
          'x-echo-rer-csv-invalid-message-size': '0',
        },
        body: hasSkippedRows ? '"missing, timestamp"\r\n' : '',
      });
      return;
    }
    if (url.pathname === '/api/rer/csv-import') {
      importUrls.push(url);
      await fulfillJson(route, 3650);
      return;
    }
    if (url.pathname === '/api/bgtask/3650/status-and-logs') {
      await fulfillJson(route, {
        running: false,
        loglines: [],
        finished_with_error: null,
        finished_with_error_code: null,
        progress: 100,
      });
      return;
    }
    if (url.pathname === '/api/event-stream/long-poll') {
      await fulfillJson(route, { events: [], last_event_id: null });
      return;
    }
    if (url.pathname === '/api/user/keep-alive') {
      await fulfillJson(route, null);
      return;
    }
    await fulfillJson(route, {});
  });

  await page.goto('/admin/rer-csv-import');
  const preflight = page.getByRole('button', { name: 'Перевірити дані' });
  const importButton = page.getByRole('button', { name: 'Імпортувати' });
  await expect(preflight).toBeDisabled();
  await expect(importButton).toBeDisabled();

  await selectCsv(page, 'first.csv', 'missing timestamp');
  await expect(preflight).toBeEnabled();
  await expect(importButton).toBeDisabled();
  const downloadPromise = page.waitForEvent('download');
  await preflight.click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('first-skipped-messages.csv');
  await expect(page.getByText(/1 повідомлень із 2 буде пропущено/)).toBeVisible();
  await expect(importButton).toBeEnabled();

  await selectCsv(page, 'second.csv', 'Дата: 2026-10-02;');
  await expect(importButton).toBeDisabled();
  await preflight.click();
  await expect(
    page.getByText('Перевірка не завершилась. Виправте помилку та повторіть.'),
  ).toBeVisible();
  await expect(page.getByText('Помилка перевірки CSV')).toBeVisible();
  await expect(importButton).toBeDisabled();

  await preflight.click();
  await expect(
    page.getByText('Перевірку завершено: до імпорту готово 1 із 1 повідомлень.'),
  ).toBeVisible();
  await expect(importButton).toBeEnabled();
  await importButton.click();
  await expect.poll(() => importUrls.length).toBe(1);
  expect(importUrls[0]!.searchParams.get('isHistorical')).toBe('true');
});
