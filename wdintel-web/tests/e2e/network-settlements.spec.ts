import { expect, test } from '@playwright/test';
import { installAnalysisNeoApiMocks } from './analysis-neo.fixtures';

for (const [count, collinear, editLocation] of [
  [1, false, false],
  [2, false, false],
  [3, false, false],
  [3, true, false],
  [3, false, true],
] as const) {
  test(`@regression #2133 direction finding displays ${count}${collinear ? ' collinear' : ''} resolved network settlements without observations${editLocation ? ' and refreshes after location edits' : ''}`, async ({
    page,
  }) => {
    await installAnalysisNeoApiMocks(page, { userRoles: ['Rer', 'Admin'] });
    if (editLocation) await page.clock.install();
    const network = {
      id: 42,
      name: 'Settlement network',
      location: '|ALPHA|BETA|GAMMA|',
      freqs: [],
      unit_ids: [],
      aor_ids: [1],
      post_ids: [],
      descriptions: [],
      created_at: Date.now(),
      radio_station: null,
      purpose: null,
      operation_mode: null,
      operation_type: null,
      operation_period: null,
      last_activity_at: null,
      last_updated_at: Date.now(),
      last_updated_by: null,
      active_from: null,
      active_to: null,
      deleted: false,
      do_not_archive: false,
      unit_mask: [],
      status: 'NetworkActive',
    };
    const settlements = [
      { id: 1, name: 'ALPHA', lat: 49.0, lng: 35.0 },
      { id: 2, name: 'BETA', lat: 49.1, lng: 35.2 },
      { id: 3, name: 'GAMMA', lat: 49.2, lng: 35.0 },
    ].slice(0, count);
    if (collinear)
      settlements.forEach((settlement) => {
        settlement.lng = 35.0;
      });
    let settlementsPending = false;
    let pointsRequests = 0;
    let resolvedSettlements = settlements;
    await page.route('**/api/**', async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === '/api/sigint/network-info-one') {
        await route.fulfill({ json: network });
      } else if (path === '/api/sigint/network-points') {
        pointsRequests += 1;
        await route.fulfill({
          json: {
            points: [],
            settlements: settlementsPending ? [] : resolvedSettlements,
            settlements_pending: settlementsPending,
          },
        });
      } else if (path === '/api/sigint/update-network') {
        network.location = route.request().postDataJSON().location;
        settlementsPending = true;
        resolvedSettlements = [{ id: 4, name: 'DELTA', lat: 49.3, lng: 35.3 }];
        await route.fulfill({ json: network });
      } else if (
        ['/api/sigint/network/update-posts', '/api/sigint/network/update-units'].includes(path)
      ) {
        await route.fulfill({ json: network });
      } else if (path === '/api/sigint/aor') {
        await route.fulfill({ json: [{ id: 1, name: 'Test AOR' }] });
      } else if (['/api/sigint/posts', '/api/sigint/encryptions-list'].includes(path)) {
        await route.fulfill({ json: [] });
      } else {
        await route.fallback();
      }
    });
    await page.goto('/rer-networks-neo/42?tab=direction-finding');
    await expect(page.locator('.network-settlement-point')).toHaveCount(count);
    const polygon = page.locator('.network-settlement-polygon');
    await expect(polygon).toHaveCount(count === 1 ? 0 : 1);
    if (count > 1) {
      await expect(polygon).toHaveAttribute('stroke', '#dc2626');
      await expect(polygon).toHaveAttribute('d', /M/);
      await expect(polygon).toHaveAttribute('fill', count === 3 && !collinear ? '#dc2626' : 'none');
    }
    await page.getByRole('button', { name: 'Розгорнути мапу', exact: true }).click();
    await expect(page.locator('.network-settlement-point')).toHaveCount(count);
    await expect(page.locator('.network-settlement-polygon')).toHaveCount(count === 1 ? 0 : 1);
    await page.keyboard.press('Escape');
    await expect(page.getByRole('button', { name: 'Розгорнути мапу', exact: true })).toBeVisible();
    if (editLocation) {
      await page.getByRole('button', { name: 'Дії з мережею', exact: true }).click();
      await page.getByRole('menuitem', { name: 'Редагувати', exact: true }).click();
      await page.getByRole('textbox', { name: 'Район функціонування/розгортання' }).fill('|DELTA|');
      await page.getByRole('button', { name: 'Зберегти', exact: true }).click();
      await expect(page.getByText('Немає пеленгації', { exact: true })).toBeVisible();
      const requestsBeforeRetry = pointsRequests;
      await page.clock.fastForward(5000);
      await expect.poll(() => pointsRequests).toBeGreaterThan(requestsBeforeRetry);
      await expect(page.getByText('Немає пеленгації', { exact: true })).toBeVisible();
      settlementsPending = false;
      await page.clock.fastForward(6000);
      await expect(page.locator('.network-settlement-point')).toHaveCount(1);
      await expect(polygon).toHaveCount(0);
      const requestsAfterResolution = pointsRequests;
      await page.clock.fastForward(15000);
      expect(pointsRequests).toBe(requestsAfterResolution);
    }
  });
}
