import { expect, test, type Page } from '@playwright/test';
import type { AiAgentAdminRequestItem } from '../../src/Bindings';
import { installAnalysisNeoApiMocks } from './analysis-neo.fixtures';

async function installRequests(page: Page) {
  await installAnalysisNeoApiMocks(page, { userRoles: ['Admin', 'Rer'] });
  const requests: AiAgentAdminRequestItem[] = Array.from({ length: 65 }, (_, index) => ({
    id: `request-${index + 1}`,
    conversationId: 'conversation',
    humanLoginId: 'human',
    humanLogin: 'admin',
    aiEngineId: 'engine',
    aiEngineName: 'Engine',
    prompt: `Audit prompt ${index + 1}`,
    response: null,
    state: 'completed',
    error: null,
    queuedAt: 1_700_000_000_000 - index,
    startedAt: null,
    completedAt: null,
    review: null,
  }));
  const state = { fail: false, starts: [] as (string | null)[] };
  await page.route('**/api/admin/ai-agent/requests/list', async (route) => {
    const { pageStartId } = route.request().postDataJSON();
    state.starts.push(pageStartId);
    if (state.fail) {
      await route.fulfill({ status: 500, body: 'Pagination unavailable' });
      return;
    }
    const start = pageStartId ? requests.findIndex((request) => request.id === pageStartId) : 0;
    await route.fulfill({
      json: {
        items: requests.slice(start, start + 20),
        pageSize: 20,
        total: null,
        pageStartIds: [requests[start]?.id, requests[start + 20]?.id].filter(Boolean),
      },
    });
  });
  return state;
}

test('AI request pages discover bounded cursors and allow navigation to the final page', async ({
  page,
}) => {
  const state = await installRequests(page);
  await page.goto('/admin/ai/requests');
  const rows = page.locator('tbody tr');
  await expect(rows).toHaveCount(20);
  await expect(page.getByText('Усього:', { exact: false })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Go to page 3', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'SHOW MORE', exact: true }).click();
  await expect(rows).toHaveCount(40);
  expect(state.starts).toEqual([null, 'request-21']);
  await page.getByRole('button', { name: 'Go to page 3', exact: true }).click();
  await expect(rows).toHaveCount(20);
  await page.getByRole('button', { name: 'Go to page 4', exact: true }).click();
  await expect(rows).toHaveCount(5);
  await expect(page.getByText('Audit prompt 61', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'SHOW MORE', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Go to page 2', exact: true }).click();
  await expect(rows).toHaveCount(20);
  await expect(page.getByText('Audit prompt 21', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Go to page 4', exact: true }).click();
  await expect(rows).toHaveCount(5);
  await page.getByRole('button', { name: 'Go to page 3', exact: true }).click();
  await expect(rows).toHaveCount(20);
  await page.getByRole('button', { name: 'SHOW MORE', exact: true }).click();
  await expect(rows).toHaveCount(25);
  await expect(page.getByRole('button', { name: 'SHOW MORE', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Оновити', exact: true }).click();
  await expect(rows).toHaveCount(20);
  await expect(page.getByText('Audit prompt 1', { exact: true })).toBeVisible();
  expect(state.starts).toEqual([
    null,
    'request-21',
    'request-41',
    'request-61',
    'request-21',
    'request-61',
    'request-41',
    'request-61',
    null,
  ]);
});

test('AI request pagination failures preserve the current entries and allow retry', async ({
  page,
}) => {
  const state = await installRequests(page);
  await page.goto('/admin/ai/requests');
  const rows = page.locator('tbody tr');
  await expect(rows).toHaveCount(20);
  state.fail = true;
  const showMore = page.getByRole('button', { name: 'SHOW MORE', exact: true });
  await showMore.click();
  await expect(
    page.getByRole('alert').filter({ hasText: 'Не вдалося завантажити запити' }).first(),
  ).toBeVisible();
  await expect(rows).toHaveCount(20);
  await expect(showMore).toBeEnabled();
  state.fail = false;
  await showMore.click({ delay: 450 });
  await expect(rows).toHaveCount(40);
  expect(state.starts).toEqual([null, 'request-21', 'request-21']);
});
