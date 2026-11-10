import { expect, test } from '@playwright/test';

import { minimalInboxMessage } from '../../src/ts/react/routes/rer-duty-neo/inbox-message-mocks';
import { transformCamelToSnake } from '../../src/ts/snake-to-camel';
import { installAnalysisNeoApiMocks } from './analysis-neo.fixtures';

test('/rer-analysis-neo lets a non-admin toggle settlements and open their messages', async ({
  page,
}) => {
  await installAnalysisNeoApiMocks(page, { userRoles: ['Rer'] });
  await page.route('**/api-public/server-info', (route) =>
    route.fulfill({
      json: {
        mode: 'debug',
        public_host: 'echo.localhost',
        grafana_address: '',
        feature_delta: true,
        feature_analysis_map: true,
        enable_duty_search: false,
        feature_strict_networks: false,
        feature_my_admin_groups_edit: false,
        version: 'test',
      },
    }),
  );
  const mapRequests: Array<Record<string, unknown>> = [];
  const messageRequests: Array<Record<string, unknown>> = [];
  await page.route('**/api/rer-importer/get-inbox-map', async (route) => {
    const request = route.request().postDataJSON() as Record<string, unknown>;
    mapRequests.push(request);
    await route.fulfill({
      json: {
        network_units: [],
        points: [],
        settlements: request.show_settlements
          ? [
              {
                settlement_id: 7,
                name: 'Тестовий населений пункт',
                region: null,
                lat: 47.42135,
                lon: 35.62197,
                inbox_item_count: 2,
              },
            ]
          : [],
      },
    });
  });
  await page.route('**/api/rer-importer/map-settlement-messages', async (route) => {
    const request = route.request().postDataJSON() as Record<string, unknown>;
    messageRequests.push(request);
    const nextPage = request.before_id_noninclusive != null;
    const message = minimalInboxMessage({
      text: nextPage ? 'Older settlement message' : 'Settlement message fixture',
      messageUuid: null,
      coordsWithLocality: [],
      hasDateInHeader: false,
      messageComments: [],
      unitIds: [],
      networkName: null,
      deviceName: null,
    });
    await route.fulfill({
      json: { messages: [[nextPage ? 99 : 101, transformCamelToSnake(message)]] },
    });
  });

  await page.goto('/rer-analysis-neo');
  await page.getByRole('tab', { name: 'Мапа' }).click();

  const map = page.locator('analysis-map');
  await map.getByRole('button', { name: 'Налаштування мапи', exact: true }).click();
  const settlements = map
    .locator('.map-settings-item', { hasText: 'Показувати населені пункти' })
    .getByRole('checkbox');
  await expect(settlements).not.toBeChecked();
  await settlements.check();
  await expect.poll(() => mapRequests.at(-1)?.show_settlements).toBe(true);
  const marker = map.locator('path.leaflet-interactive');
  await expect(marker).toHaveCount(1);
  await marker.click();
  await expect.poll(() => messageRequests.at(-1)?.settlement_id).toBe(7);
  expect(messageRequests.at(-1)?.inbox_items_filter).toEqual(
    mapRequests.at(-1)?.inbox_items_filter,
  );
  await expect(map.locator('.leaflet-popup')).toContainText('Settlement message fixture');
  const loadMore = map.locator('[data-map-settlement-messages-load-more]');
  await loadMore.click();
  await expect.poll(() => messageRequests.at(-1)?.before_id_noninclusive).toBe(101);
  const updatedPopup = map
    .locator('.leaflet-popup')
    .filter({ hasText: 'Older settlement message' });
  await expect(updatedPopup).toContainText('Settlement message fixture');
  await expect(loadMore).toHaveCount(0);

  await settlements.uncheck();
  await expect(marker).toHaveCount(0);
});
