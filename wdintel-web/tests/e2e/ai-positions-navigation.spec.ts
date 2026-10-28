import { expect, test, type Page } from '@playwright/test';
import type { AiPositionKnowledgeItem, AiPositionPageRsp } from '../../src/Bindings';
import { installAnalysisNeoApiMocks } from './analysis-neo.fixtures';
import { systemSettingsCurrentResponse } from './fixture-responses';

const position: AiPositionKnowledgeItem = {
  id: '019a4aa8-0000-7000-8000-000000000008',
  scopeKind: 'aor',
  scopeKey: '1',
  scopeName: 'Тестовий район',
  scopeIsSecret: false,
  name: 'Циркон 9',
  nameKey: 'циркон 9',
  kind: 'position',
  mgrs: '36T XT 75734 68963',
  lat: 46.65,
  lng: 33.98,
  certainty: 'high',
  factCount: 1,
  conflicting: false,
  firstFactAt: 1791072000000,
  lastFactAt: 1791072000000,
  feedback: [],
};

async function installPositions(page: Page) {
  await installAnalysisNeoApiMocks(page, { userRoles: ['Admin', 'Rer'] });
  await page.route('**/api/system-settings/current', (route) =>
    route.fulfill({
      json: { ...systemSettingsCurrentResponse(), exclude_orbit_other_units: false },
    }),
  );
  const settings: AiPositionPageRsp = {
    prompt: 'Знайди позиції',
    promptOverridden: false,
    engines: [],
    worker: { enabled: false, fallbackAiEngineId: null, aiEngineId: null },
    pendingJobs: 0,
    openFeedback: 0,
  };
  await page.route('**/api/admin/ai-positions/page', (route) => route.fulfill({ json: settings }));
  await page.route('**/api/admin/ai-positions/knowledge/list', (route) =>
    route.fulfill({ json: { items: [position], nextCursor: null } }),
  );
  await page.route('**/api/admin/ai-positions/mentions/list', (route) =>
    route.fulfill({ json: { items: [], nextCursor: null } }),
  );
  await page.route('**/api/admin/ai-positions/feedback/list', (route) =>
    route.fulfill({ json: { items: [] } }),
  );
}

for (const width of [1280, 390]) {
  test(`@regression #3064 position details return to the known positions tab at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 844 });
    await installPositions(page);
    await page.goto('/admin/ai/positions');
    const admin = page.locator('admin-ai-agent');
    await expect(admin.getByRole('tab', { name: 'Згадки', exact: true })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await admin.getByRole('tab', { name: 'Відомі позиції', exact: true }).click();
    await expect(page).toHaveURL(/\/admin\/ai\/positions\/knowledge$/);
    await admin.getByRole('link', { name: position.name, exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/admin/ai/positions/${position.id}$`));
    await expect(admin.getByRole('heading', { name: position.name })).toBeVisible();
    await page.goBack();
    await expect(page).toHaveURL(/\/admin\/ai\/positions\/knowledge$/);
    await expect(admin.getByRole('tab', { name: 'Відомі позиції', exact: true })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await page.goForward();
    await expect(admin.getByRole('heading', { name: position.name })).toBeVisible();
    await admin.getByRole('link', { name: 'Позиції', exact: true }).click();
    await expect(page).toHaveURL(/\/admin\/ai\/positions\/knowledge$/);
    await expect(admin.getByRole('link', { name: position.name, exact: true })).toBeVisible();
    await page.goto(`/admin/ai/positions/${position.id}`);
    await admin.getByRole('link', { name: 'Позиції', exact: true }).click();
    await expect(page).toHaveURL(/\/admin\/ai\/positions\/knowledge$/);
  });
}

test('@regression #3064 position tabs switch without document reloads and preserve URLs', async ({
  page,
}) => {
  await installPositions(page);
  let documentRequests = 0;
  page.on('request', (request) => {
    if (request.resourceType() === 'document') documentRequests += 1;
  });
  await page.goto('/admin/ai/positions/mentions');
  const admin = page.locator('admin-ai-agent');
  const tabs = [
    ['knowledge', 'Відомі позиції'],
    ['feedback', 'Відгуки'],
    ['settings', 'Налаштування'],
    ['mentions', 'Згадки'],
  ];
  for (const [path, label] of tabs) {
    const requestsBeforeClick = documentRequests;
    await admin.getByRole('tab', { name: label, exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/admin/ai/positions/${path}$`));
    await expect(admin.getByRole('tab', { name: label, exact: true })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(documentRequests).toBe(requestsBeforeClick);
    await page.reload();
    await expect(admin.getByRole('tab', { name: label, exact: true })).toHaveAttribute(
      'aria-selected',
      'true',
    );
  }
  await page.goBack();
  await expect(page).toHaveURL(/\/admin\/ai\/positions\/settings$/);
  await expect(admin.getByRole('tab', { name: 'Налаштування', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await page.goForward();
  await expect(admin.getByRole('tab', { name: 'Згадки', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
});
