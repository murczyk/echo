import { expect, test, type Page } from '@playwright/test';
import { installAnalysisNeoApiMocks } from './analysis-neo.fixtures';
import { openCreateReportDrawer } from './image-editor-drawer.fixtures';
import { installRerDutyShortStateMocks } from './rer-duty-short-state.fixtures';

const existingUnit = { id: 35351, name: '1 рота 3535 полк', active: true };
const inactiveChild = { id: 35352, name: '2 рота 3535 полк', active: false };
const unknownLabel = 'Невідомий текстовий лейбл';
const newUnitName = 'Новий підрозділ 3535';

test.use({ viewport: { width: 1600, height: 900 } });
test.setTimeout(60_000);

async function installUnitApi(page: Page) {
  await page.route('**/api/sigint/unit/search', async (route) => {
    const request = route.request().postDataJSON();
    expect(request.include_inactive).toBe(true);
    const units = request.names
      ? [existingUnit]
      : request.search === newUnitName
        ? []
        : [existingUnit, inactiveChild];
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ units }) });
  });
  const submissions: Record<string, unknown>[] = [];
  await page.route('**/api/1.1/submit-direct', async (route) => {
    submissions.push(route.request().postDataJSON());
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ signal_message_id: 3535 }),
    });
  });
  return submissions;
}

for (const host of ['duty', 'analysis', 'report'] as const) {
  for (const selection of ['existing', 'new'] as const) {
    test(`@regression #3535 ${host} selected ${selection} unit and discarded unknown history`, async ({
      page,
    }) => {
      let submissions: Record<string, unknown>[];
      if (host === 'report') {
        await openCreateReportDrawer(page);
        submissions = await installUnitApi(page);
        await page.getByRole('textbox', { name: 'Текст розвіддонесення' }).fill('Донесення 3535');
        await page.getByRole('combobox', { name: 'Відправити в групу' }).click();
        await page.getByRole('option', { name: 'Не відправляти', exact: true }).click();
      } else {
        await page.addInitScript(
          ({ existingName, unknown }) => {
            localStorage.setItem(
              'cyberEcho_recentMessageFields',
              JSON.stringify({ unit: [unknown, existingName], group: ['editor-e2e-group'] }),
            );
          },
          { existingName: existingUnit.name, unknown: unknownLabel },
        );
        if (host === 'duty') {
          await installRerDutyShortStateMocks(page, { signalGroups: ['editor-e2e-group'] });
        } else {
          await installAnalysisNeoApiMocks(page, { signalGroups: ['editor-e2e-group'] });
        }
        submissions = await installUnitApi(page);
        await page.goto(host === 'duty' ? '/rer-duty-neo' : '/rer-analysis-neo');
        await expect(
          page.getByText(
            host === 'duty' ? 'Немає повідомлень' : 'Немає жодного повідомлення для аналізу.',
            { exact: true },
          ),
        ).toBeVisible();
        await page.getByRole('button', { name: 'Додати повідомлення' }).click();
        await expect(page.getByRole('combobox', { name: 'Підрозділ' })).toHaveValue(
          existingUnit.name,
        );
        await expect
          .poll(() =>
            page.evaluate(
              () => JSON.parse(localStorage.getItem('cyberEcho_recentMessageFields') ?? '{}').unit,
            ),
          )
          .toEqual([existingUnit.name]);
        await page.getByRole('textbox', { name: 'Текст повідомлення' }).fill('Перехоплення 3535');
      }

      const input = page.getByRole('combobox', { name: 'Підрозділ' });
      await input.fill(selection === 'existing' ? '3535 полк' : newUnitName);
      await expect(page.getByRole('option', { name: unknownLabel, exact: true })).toHaveCount(0);
      if (selection === 'existing') {
        await page.getByRole('option', { name: inactiveChild.name, exact: true }).click();
      } else {
        await page.getByRole('option', { name: `Додати Підрозділ «${newUnitName}»` }).click();
      }
      await page.getByRole('button', { name: 'Створити', exact: true }).click();
      await expect.poll(() => submissions.length).toBe(1);
      expect(submissions[0]).toMatchObject(
        selection === 'existing'
          ? { unit: inactiveChild.name, unit_id: inactiveChild.id }
          : { unit: newUnitName, create_unit: true },
      );
      if (host === 'report') expect(submissions[0].parent_signal_message_ids).toHaveLength(1);
    });
  }
}
