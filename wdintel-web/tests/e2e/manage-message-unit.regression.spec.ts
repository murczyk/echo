import { expect, test, type Page, type Route } from '@playwright/test';
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

async function openDutyUnitEditor(
  page: Page,
  history: Record<string, unknown> = {},
  unitLookup?: (route: Route) => Promise<void>,
) {
  await page.addInitScript(
    (recent) => {
      localStorage.setItem('cyberEcho_recentMessageFields', JSON.stringify(recent));
    },
    { group: ['editor-e2e-group'], ...history },
  );
  await installRerDutyShortStateMocks(page, { signalGroups: ['editor-e2e-group'] });
  const submissions = await installUnitApi(page);
  if (unitLookup) await page.route('**/api/sigint/unit/search', unitLookup);
  await page.goto('/rer-duty-neo');
  await expect(page.getByText('Немає повідомлень', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Додати повідомлення' }).click();
  return submissions;
}

test('@regression #3535 late unit prefilling preserved text and its unsaved-change baseline', async ({
  page,
}) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await openDutyUnitEditor(page, { unit: [existingUnit.name] }, async (route) => {
    if (route.request().postDataJSON().names) await gate;
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ units: [existingUnit] }),
    });
  });
  const body = page.getByRole('textbox', { name: 'Текст повідомлення' });
  await body.fill('3535 ручний текст');
  release();
  await expect(page.getByRole('combobox', { name: 'Підрозділ' })).toHaveValue(existingUnit.name);
  await expect(body).toHaveValue('3535 ручний текст');
  await body.fill('3535 змінений текст');
  await body.fill('3535 ручний текст');
  await page.getByRole('button', { name: 'Закрити', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Відхилити незбережені зміни?' })).toBeVisible();
});

test('@regression #3535 normalized and malformed recent fields remained usable without dirtying the editor', async ({
  page,
}) => {
  await openDutyUnitEditor(page, {
    unit: [null, 3535, '  1\tрота  3535 полк '],
    callsigns: null,
    freq: '149',
  });
  const input = page.getByRole('combobox', { name: 'Підрозділ' });
  await expect(input).toHaveValue(existingUnit.name);
  await page.getByRole('button', { name: 'Закрити', exact: true }).click();
  await expect(input).toHaveCount(0);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button', { name: 'Додати повідомлення' }).click();
  await input.fill('1  рота 3535 полк');
  await expect(page.getByRole('option', { name: existingUnit.name, exact: true })).toBeVisible();
  await expect(page.getByRole('option', { name: /^Додати Підрозділ/ })).toHaveCount(0);
});

test('@regression #3535 ambiguous recent names required an explicit unit ID', async ({ page }) => {
  const submissions = await openDutyUnitEditor(page, { unit: [existingUnit.name] });
  const duplicate = { ...existingUnit, id: existingUnit.id + 100 };
  await page.route('**/api/sigint/unit/search', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ units: [existingUnit, duplicate] }),
    }),
  );
  await page.getByRole('button', { name: 'Закрити', exact: true }).click();
  await page.getByRole('button', { name: 'Додати повідомлення' }).click();
  const input = page.getByRole('combobox', { name: 'Підрозділ' });
  await expect(input).toHaveValue('');
  await input.click();
  await expect(
    page.getByRole('option', { name: `${existingUnit.name} · №${existingUnit.id}`, exact: true }),
  ).toBeVisible();
  await page
    .getByRole('option', { name: `${duplicate.name} · №${duplicate.id}`, exact: true })
    .click();
  await page.getByRole('textbox', { name: 'Текст повідомлення' }).fill('3535 selected duplicate');
  await page.getByRole('button', { name: 'Створити', exact: true }).click();
  await expect.poll(() => submissions.length).toBe(1);
  expect(submissions[0]).toMatchObject({ unit_id: duplicate.id });
  await expect(input).toHaveValue(existingUnit.name);
  await page
    .getByRole('textbox', { name: 'Текст повідомлення' })
    .fill('3535 next selected duplicate');
  const create = page.getByRole('button', { name: 'Створити', exact: true });
  await expect(create).toBeEnabled();
  await create.press('Enter');
  await expect.poll(() => submissions.length).toBe(2);
  expect(submissions[1]).toMatchObject({ unit_id: duplicate.id });
});

test('@regression #3535 failed searches showed an error and withheld creation until retry succeeded', async ({
  page,
}) => {
  await openDutyUnitEditor(page);
  await page.route('**/api/sigint/unit/search', (route) =>
    route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ message: 'Unavailable' }),
    }),
  );
  const input = page.getByRole('combobox', { name: 'Підрозділ' });
  await input.fill(newUnitName);
  await expect(page.getByText('Не вдалося завантажити довідкові дані.')).toBeVisible();
  await expect(page.getByRole('option', { name: /^Додати Підрозділ/ })).toHaveCount(0);
  await page.route('**/api/sigint/unit/search', (route) =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify({ units: [] }) }),
  );
  await page.getByRole('button', { name: 'Повторити завантаження' }).click();
  await input.click();
  await expect(
    page.getByRole('option', { name: `Додати Підрозділ «${newUnitName}»` }),
  ).toBeVisible();
});

test('@regression #3535 reopening revalidated deleted history before prefilling', async ({
  page,
}) => {
  await openDutyUnitEditor(page, { unit: [existingUnit.name] });
  const input = page.getByRole('combobox', { name: 'Підрозділ' });
  await expect(input).toHaveValue(existingUnit.name);
  await page.getByRole('button', { name: 'Закрити', exact: true }).click();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/api/sigint/unit/search', async (route) => {
    if (route.request().postDataJSON().names) await gate;
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ units: [] }) });
  });
  await page.getByRole('button', { name: 'Додати повідомлення' }).click();
  await expect(input).toHaveValue('');
  await input.fill('Ручний вибір 3535');
  release();
  await expect
    .poll(() =>
      page.evaluate(
        () => JSON.parse(localStorage.getItem('cyberEcho_recentMessageFields') ?? '{}').unit,
      ),
    )
    .toEqual([]);
  await expect(input).toHaveValue('Ручний вибір 3535');
});

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

for (const width of [390, 768]) {
  test(`@regression #3535 keyboard unit creation remained usable at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    const submissions = await openDutyUnitEditor(page);
    await page.getByRole('textbox', { name: 'Текст повідомлення' }).fill('3535 keyboard');
    const input = page.getByRole('combobox', { name: 'Підрозділ' });
    await input.fill(newUnitName);
    await expect(
      page.getByRole('option', { name: `Додати Підрозділ «${newUnitName}»` }),
    ).toBeVisible();
    await input.press('ArrowDown');
    await input.press('Enter');
    await page.getByRole('button', { name: 'Створити', exact: true }).click();
    await expect.poll(() => submissions.length).toBe(1);
    expect(submissions[0]).toMatchObject({ unit: newUnitName, create_unit: true });
  });
}
