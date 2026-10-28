import { expect, test } from '@playwright/test';

import type {
  AiCallsignWorkerSettingsItem,
  SaveAiCallsignWorkerSettingsReq,
} from '../../src/Bindings';
import { installAnalysisNeoApiMocks } from './analysis-neo.fixtures';

for (const queue of ['callsigns', 'settlements', 'positions']) {
  test(`@regression #3888 saves primary and fallback AI for ${queue}`, async ({ page }) => {
    if (queue === 'callsigns') {
      await page.setViewportSize({ width: 390, height: 844 });
    }
    await installAnalysisNeoApiMocks(page, { userRoles: ['Admin', 'Rer'] });
    let worker: AiCallsignWorkerSettingsItem = {
      enabled: true,
      aiEngineId: 'luna',
      fallbackAiEngineId: null,
    };
    const saved: SaveAiCallsignWorkerSettingsReq[] = [];
    await page.route(`**/api/admin/ai-${queue}/page`, (route) =>
      route.fulfill({
        json: {
          prompt: 'Extract',
          promptOverridden: false,
          engines: [
            { id: 'luna', name: 'Luna', modelName: 'luna' },
            { id: 'gemma', name: 'Gemma', modelName: 'gemma' },
          ],
          messages: [],
          groups: [],
          pendingJobs: 0,
          openFeedback: 0,
          worker: { ...worker, groupsExcept: false, groupMasterKeys: [] },
        },
      }),
    );
    await page.route(`**/api/admin/ai-${queue}/worker/save`, async (route) => {
      const request = route.request().postDataJSON() as SaveAiCallsignWorkerSettingsReq;
      saved.push(request);
      worker = {
        enabled: request.enabled,
        aiEngineId: request.aiEngineId,
        fallbackAiEngineId: request.fallbackAiEngineId ?? null,
      };
      await route.fulfill({ json: { ...worker, groupsExcept: false, groupMasterKeys: [] } });
    });
    const url = `/admin/ai/${queue}${queue === 'positions' ? '/settings' : ''}`;
    await page.goto(url);
    const admin = page.locator('admin-ai-agent');
    if (queue !== 'positions') {
      await admin.getByRole('tab', { name: 'Воркер', exact: true }).click();
    }
    await admin.getByRole('combobox', { name: 'Резервний ШІ движок' }).click();
    await expect(page.getByRole('option', { name: 'Luna · luna' })).toHaveCount(0);
    await page.getByRole('option', { name: 'Gemma · gemma' }).click();
    await admin.getByRole('button', { name: 'Зберегти', exact: true }).click();
    await expect.poll(() => saved.length).toBe(1);
    expect(saved[0]).toMatchObject({
      enabled: true,
      aiEngineId: 'luna',
      fallbackAiEngineId: 'gemma',
    });
    await page.reload();
    if (queue !== 'positions') {
      await admin.getByRole('tab', { name: 'Воркер', exact: true }).click();
    }
    await expect(admin.getByRole('combobox', { name: 'Резервний ШІ движок' })).toContainText(
      'Gemma',
    );
    await admin.getByRole('combobox', { name: 'Основний ШІ движок' }).click();
    await page.getByRole('option', { name: 'Gemma · gemma' }).click();
    await expect(admin.getByRole('combobox', { name: 'Резервний ШІ движок' })).toContainText(
      'Без резервного',
    );
  });
}
