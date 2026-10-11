import { expect, test, type Page } from '@playwright/test';
import type {
  AiSettlementWorkerSettingsItem,
  SaveAiSettlementWorkerSettingsReq,
} from '../../src/Bindings';
import { installAnalysisNeoApiMocks } from './analysis-neo.fixtures';

async function installWorker(page: Page) {
  await installAnalysisNeoApiMocks(page, { userRoles: ['Admin', 'Rer'] });
  let settings: AiSettlementWorkerSettingsItem = {
    enabled: true,
    aiEngineId: 'engine-a',
    groupsExcept: false,
    groupMasterKeys: [],
  };
  const saves: SaveAiSettlementWorkerSettingsReq[] = [];
  await page.route('**/api/admin/ai-settlements/page', (route) =>
    route.fulfill({
      json: {
        prompt: 'Find settlements',
        promptOverridden: false,
        engines: [{ id: 'engine-a', name: 'Engine A', modelName: 'test' }],
        messages: [],
        groups: [
          { masterKey: 'north', name: 'Північ' },
          { masterKey: 'south', name: 'Південь' },
        ],
        worker: settings,
      },
    }),
  );
  await page.route('**/api/admin/ai-settlements/worker/save', async (route) => {
    const req: SaveAiSettlementWorkerSettingsReq = route.request().postDataJSON();
    saves.push(req);
    settings = req;
    await route.fulfill({ json: settings });
  });
  await page.goto('/admin/ai/settlements');
  const admin = page.locator('admin-ai-agent');
  await admin.getByRole('tab', { name: 'Воркер', exact: true }).click();
  return { admin, saves };
}

test('@regression #3383 saves only/except group restrictions and restores them on reload', async ({
  page,
}) => {
  const { admin, saves } = await installWorker(page);
  const groups = admin.getByRole('combobox', { name: 'Групи', exact: true });
  await groups.fill('Північ');
  await page.getByRole('option', { name: 'Північ', exact: true }).click();
  await groups.press('Escape');
  await admin.getByRole('button', { name: 'Зберегти', exact: true }).click();
  await expect.poll(() => saves.length).toBe(1);
  expect(saves[0]).toEqual({
    enabled: true,
    aiEngineId: 'engine-a',
    groupsExcept: false,
    groupMasterKeys: ['north'],
  });
  await page.reload();
  await admin.getByRole('tab', { name: 'Воркер', exact: true }).click();
  await expect(admin.getByRole('button', { name: 'Лише', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(admin.getByText('Північ', { exact: true })).toBeVisible();
  await admin.getByRole('button', { name: 'Окрім', exact: true }).click();
  await groups.fill('Південь');
  await page.getByRole('option', { name: 'Південь', exact: true }).click();
  await groups.press('Escape');
  await admin.getByRole('button', { name: 'Зберегти', exact: true }).click();
  await expect.poll(() => saves.length).toBe(2);
  expect(saves[1]).toEqual({
    enabled: true,
    aiEngineId: 'engine-a',
    groupsExcept: true,
    groupMasterKeys: ['north', 'south'],
  });
  await page.reload();
  await admin.getByRole('tab', { name: 'Воркер', exact: true }).click();
  await expect(admin.getByRole('button', { name: 'Окрім', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(admin.getByText('Північ', { exact: true })).toBeVisible();
  await expect(admin.getByText('Південь', { exact: true })).toBeVisible();
  await groups.focus();
  await admin.getByRole('button', { name: 'Очистити', exact: true }).click();
  await admin.getByRole('button', { name: 'Зберегти', exact: true }).click();
  await expect.poll(() => saves.length).toBe(3);
  expect(saves[2].groupMasterKeys).toEqual([]);
  expect(saves[2].groupsExcept).toBe(true);
});

test('@regression #3383 retains group selection and reports a failed settings save', async ({
  page,
}) => {
  const { admin, saves } = await installWorker(page);
  await page.route('**/api/admin/ai-settlements/worker/save', (route) =>
    route.fulfill({ status: 500, json: { error: 'Група недоступна' } }),
  );
  const groups = admin.getByRole('combobox', { name: 'Групи', exact: true });
  await groups.fill('Північ');
  await page.getByRole('option', { name: 'Північ', exact: true }).click();
  await groups.press('Escape');
  await admin.getByRole('button', { name: 'Окрім', exact: true }).click();
  await admin.getByRole('button', { name: 'Зберегти', exact: true }).click();
  await expect(admin.getByRole('alert')).toContainText('Помилка збереження воркера');
  await expect(admin.getByText('Північ', { exact: true })).toBeVisible();
  await expect(admin.getByRole('button', { name: 'Окрім', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  expect(saves).toEqual([]);
});
