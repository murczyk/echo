import { expect, test, type Page, type Route } from '@playwright/test';
import { installAnalysisNeoApiMocks } from './analysis-neo.fixtures';
import { openCreateReportDrawer } from './image-editor-drawer.fixtures';
import { installRerDutyShortStateMocks } from './rer-duty-short-state.fixtures';
import { systemSettingsCurrentResponse } from './fixture-responses';

const existingUnit = { id: 35351, name: '1 рота 3535 полк', active: true };
const inactiveChild = { id: 35352, name: '2 рота 3535 полк', active: false };
const unknownLabel = 'Невідомий текстовий лейбл';
const newUnitName = 'Новий підрозділ 3535';
const createdUnitId = 35353;

test.use({ viewport: { width: 1600, height: 900 } });
test.setTimeout(60_000);

async function installUnitCreationApi(page: Page) {
  const creations: Record<string, unknown>[] = [];
  await page.route('**/api/sigint/unit/combat-types', (route) =>
    route.fulfill({
      json: { combat_types: [{ id: 'combat-3535', name: 'Мотострілецькі війська' }] },
    }),
  );
  await page.route('**/api/sigint/unit/create-duplicate-candidates', (route) =>
    route.fulfill({ json: { units: [] } }),
  );
  for (const endpoint of ['create', 'create-with-auto-network', 'create-for-message']) {
    await page.route(`**/api/sigint/unit/${endpoint}`, async (route) => {
      const request = route.request().postDataJSON();
      creations.push(request);
      const details = endpoint === 'create' ? request : request.unit;
      const unit = { ...details, id: createdUnitId, name: details.name || details.battalion };
      await route.fulfill({
        json:
          endpoint !== 'create-with-auto-network'
            ? unit
            : { unit, network_id: request.skip_network_creation ? null : 3535 },
      });
    });
  }
  return creations;
}

async function saveNewUnit(page: Page, name = newUnitName) {
  await expect(page.getByText('Новий підрозділ', { exact: true })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Назва', exact: true })).toHaveValue(name);
  await page.getByRole('button', { name: 'Створити', exact: true }).click();
  await expect(page.getByText('Новий підрозділ', { exact: true })).toHaveCount(0);
}

async function installUnitApi(page: Page) {
  await installUnitCreationApi(page);
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

for (const entry of ['message', 'units'] as const) {
  for (const hideNetworks of [true, false]) {
    test(`@regression #3535 ${entry} unit popup respected hideNetworks=${hideNetworks} and saved immediately`, async ({
      page,
    }) => {
      let submissions: Record<string, unknown>[] = [];
      if (entry === 'message') {
        submissions = await openDutyUnitEditor(page);
        await page.getByRole('textbox', { name: 'Текст повідомлення' }).fill('3535 full unit form');
      } else {
        await installAnalysisNeoApiMocks(page, { userRoles: ['Rer', 'UnitsEditor'] });
        await page.route('**/api/sigint/units', (route) =>
          route.fulfill({
            json: {
              units: [],
              total_count: 0,
              show_load_more: false,
              status_counts: { active: 0, inactive: 0 },
            },
          }),
        );
        await page.route('**/api/sigint/unit/attachment-unit-ids', (route) =>
          route.fulfill({ json: { unit_ids: [] } }),
        );
      }
      const creations = await installUnitCreationApi(page);
      await page.route('**/api/system-settings/current', (route) =>
        route.fulfill({
          json: {
            ...systemSettingsCurrentResponse({ hideNetworks }),
            devices_section_enabled: true,
            default_neo_analysis: true,
          },
        }),
      );
      if (entry === 'message') {
        await page.getByRole('combobox', { name: 'Підрозділ' }).fill(newUnitName);
        await page.getByRole('option', { name: `Додати Підрозділ «${newUnitName}»` }).click();
        await expect(page.getByRole('textbox', { name: 'Назва', exact: true })).toHaveValue(
          newUnitName,
        );
      } else {
        await page.goto('/rer-units-neo');
        await page.getByRole('button', { name: 'Додати підрозділ', exact: true }).click();
      }
      await page.getByRole('textbox', { name: 'Батальйон', exact: true }).fill('1 батальйон');
      await page.getByRole('textbox', { name: 'Бригада', exact: true }).fill('3535 бригада');
      await page.getByRole('textbox', { name: 'Коментар', exact: true }).fill('Повні відомості');
      await page.getByRole('combobox', { name: 'Види та роди ЗС' }).click();
      await page.getByRole('option', { name: 'Мотострілецькі війська', exact: true }).click();
      expect(creations).toHaveLength(0);
      if (!hideNetworks) {
        await page.getByRole('button', { name: 'Далі', exact: true }).click();
        await expect(page.getByText('Налаштування радіомережі', { exact: true })).toBeVisible();
        const location = page.getByRole('combobox', { name: 'Локації' });
        await location.fill('Київ');
        await location.press('Enter');
      } else {
        await expect(page.getByRole('button', { name: 'Далі', exact: true })).toHaveCount(0);
      }
      await page.getByRole('button', { name: 'Створити', exact: true }).click();
      await expect.poll(() => creations.length).toBe(1);
      const details = entry === 'units' && hideNetworks ? creations[0] : creations[0].unit;
      if (!hideNetworks) {
        expect(creations[0]).toMatchObject({ skip_network_creation: false, locations: ['Київ'] });
      }
      expect(details).toMatchObject({
        name: entry === 'message' ? newUnitName : null,
        battalion: '1 батальйон',
        brigade: '3535 бригада',
        combat_type_id: 'combat-3535',
        comment: 'Повні відомості',
      });
      await expect(page.getByText('Новий підрозділ', { exact: true })).toHaveCount(0);
      expect(submissions).toHaveLength(0);
      if (entry === 'message') {
        await expect(page.getByRole('combobox', { name: 'Підрозділ' })).toHaveValue(newUnitName);
        await page.getByRole('button', { name: 'Створити', exact: true }).click();
        await expect.poll(() => submissions.length).toBe(1);
        expect(submissions[0]).toMatchObject({ unit: newUnitName, unit_id: createdUnitId });
        expect(submissions[0].create_unit).toBeUndefined();
      }
    });
  }
}

test('@regression #3535 cancelled unit form kept the message unresolved and reopened cleanly', async ({
  page,
}) => {
  const submissions = await openDutyUnitEditor(page);
  const creations = await installUnitCreationApi(page);
  await page.getByRole('textbox', { name: 'Текст повідомлення' }).fill('3535 cancelled unit');
  const input = page.getByRole('combobox', { name: 'Підрозділ' });
  await input.fill(newUnitName);
  await page.getByRole('option', { name: `Додати Підрозділ «${newUnitName}»` }).click();
  await expect(page.getByRole('textbox', { name: 'Назва', exact: true })).toHaveValue(newUnitName);
  await page.getByRole('button', { name: 'Скасувати', exact: true }).click();
  await expect(input).toHaveValue(newUnitName);
  await expect(input).toHaveAttribute('aria-invalid', 'true');
  await expect(page.getByRole('button', { name: 'Створити', exact: true })).toBeDisabled();
  expect(creations).toHaveLength(0);
  expect(submissions).toHaveLength(0);
  await input.click();
  await page.getByRole('option', { name: `Додати Підрозділ «${newUnitName}»` }).click();
  await saveNewUnit(page);
  await expect.poll(() => creations.length).toBe(1);
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: 'Закрити', exact: true }).click();
  expect(creations).toHaveLength(1);
  expect(submissions).toHaveLength(0);
});

test('@regression #3535 unit save failure preserved fields and keyboard input did not submit the message', async ({
  page,
}) => {
  const submissions = await openDutyUnitEditor(page);
  let attempts = 0;
  await page.route('**/api/sigint/unit/create-for-message', async (route) => {
    attempts += 1;
    await route.fulfill(
      attempts === 1
        ? { status: 500, json: { error: 'Не вдалося зберегти підрозділ' } }
        : { json: { ...route.request().postDataJSON().unit, id: createdUnitId } },
    );
  });
  await page.getByRole('textbox', { name: 'Текст повідомлення' }).fill('3535 unit retry');
  await page.getByRole('combobox', { name: 'Підрозділ' }).fill(newUnitName);
  await page.getByRole('option', { name: `Додати Підрозділ «${newUnitName}»` }).click();
  const comment = page.getByRole('textbox', { name: 'Коментар', exact: true });
  const renamedUnit = `${newUnitName} уточнений`;
  await page.getByRole('textbox', { name: 'Назва', exact: true }).fill(renamedUnit);
  await comment.fill('Збережіть ці дані');
  await comment.press('Control+Enter');
  expect(submissions).toHaveLength(0);
  await page.getByRole('button', { name: 'Створити', exact: true }).click();
  await expect(page.getByText('Не вдалося зберегти підрозділ', { exact: true })).toBeVisible();
  await expect(comment).toHaveValue('Збережіть ці дані');
  expect(submissions).toHaveLength(0);
  await expect(page.getByRole('textbox', { name: 'Назва', exact: true })).toHaveValue(renamedUnit);
  await expect
    .poll(async () => {
      if (attempts < 2) await page.getByRole('button', { name: 'Створити', exact: true }).click();
      return attempts;
    })
    .toBe(2);
  await expect(page.getByText('Новий підрозділ', { exact: true })).toHaveCount(0);
  expect(attempts).toBe(2);
  await expect(page.getByRole('combobox', { name: 'Підрозділ' })).toHaveValue(renamedUnit);
});

for (const rename of [false, true]) {
  test(`@regression #3535 message unit reused the server exact match with rename=${rename}`, async ({
    page,
  }) => {
    const submissions = await openDutyUnitEditor(page);
    await page.getByRole('textbox', { name: 'Текст повідомлення' }).fill('3535 reused unit');
    await page.getByRole('combobox', { name: 'Підрозділ' }).fill(newUnitName);
    await page.getByRole('option', { name: `Додати Підрозділ «${newUnitName}»` }).click();
    const name = rename ? existingUnit.name : newUnitName;
    await page.getByRole('textbox', { name: 'Назва', exact: true }).fill(name);
    const reused = { ...existingUnit, name };
    await page.route('**/api/sigint/unit/create-for-message', (route) => {
      expect(route.request().postDataJSON().unit.name).toBe(name);
      return route.fulfill({ json: reused });
    });
    await saveNewUnit(page, name);
    await expect(page.getByRole('combobox', { name: 'Підрозділ' })).toHaveValue(name);
    await page.getByRole('button', { name: 'Створити', exact: true }).click();
    await expect.poll(() => submissions.length).toBe(1);
    expect(submissions[0]).toMatchObject({ unit: name, unit_id: existingUnit.id });
  });
}

test('@regression #3535 ambiguous unit names preserved the form and displayed the server error', async ({
  page,
}) => {
  const submissions = await openDutyUnitEditor(page);
  await page.getByRole('textbox', { name: 'Текст повідомлення' }).fill('3535 ambiguous unit');
  await page.getByRole('combobox', { name: 'Підрозділ' }).fill(newUnitName);
  await page.getByRole('option', { name: `Додати Підрозділ «${newUnitName}»` }).click();
  await page.getByRole('textbox', { name: 'Коментар', exact: true }).fill('Збережені дані');
  await page.route('**/api/sigint/unit/create-for-message', (route) =>
    route.fulfill({ status: 400, json: { error: 'Оберіть підрозділ зі списку.' } }),
  );
  await page.getByRole('button', { name: 'Створити', exact: true }).click();
  await expect(page.getByText('Оберіть підрозділ зі списку.', { exact: true })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Назва', exact: true })).toHaveValue(newUnitName);
  await expect(page.getByRole('textbox', { name: 'Коментар', exact: true })).toHaveValue(
    'Збережені дані',
  );
  expect(submissions).toHaveLength(0);
});

test('@regression #3535 message writers created full units without unit editing permissions', async ({
  page,
}) => {
  await installAnalysisNeoApiMocks(page, {
    signalGroups: ['editor-e2e-group'],
    userRoles: ['Rer'],
  });
  await installUnitApi(page);
  let duplicateChecks = 0;
  await page.route('**/api/sigint/unit/create-duplicate-candidates', (route) => {
    duplicateChecks += 1;
    return route.fulfill({ status: 403, json: { error: 'UnitsEditor required' } });
  });
  await page.goto('/rer-analysis-neo');
  await page.getByRole('button', { name: 'Додати повідомлення' }).click();
  await page.getByRole('combobox', { name: 'Група', exact: true }).click();
  await page.getByRole('option', { name: 'editor-e2e-group', exact: true }).click();
  await page.getByRole('textbox', { name: 'Текст повідомлення' }).fill('3535 writer-created unit');
  await page.getByRole('combobox', { name: 'Підрозділ' }).fill(newUnitName);
  await page.getByRole('option', { name: `Додати Підрозділ «${newUnitName}»` }).click();
  await saveNewUnit(page);
  expect(duplicateChecks).toBe(0);
  await expect(page.getByRole('button', { name: 'Створити', exact: true })).toBeEnabled();
});

test('@regression #3535 echelon ordering kept brigades before recent subordinate units', async ({
  page,
}) => {
  const brigade = { id: 35360, name: '123 омбр', brigade: '123 омбр' };
  const battalion = {
    ...brigade,
    id: 35361,
    name: '1 мб 123 омбр',
    battalion: '1 мб',
  };
  const company = { ...battalion, id: 35362, name: '1 мр 1 мб 123 омбр', company: '1 мр' };
  const crew = {
    ...company,
    id: 35363,
    name: '1 екіпаж 1 мр 1 мб 123 омбр',
    team_or_crew: '1 екіпаж',
    other: '   ',
  };
  const unclassified = { id: 35364, name: 'Невідомий ешелон 123 омбр' };
  const units = [brigade, battalion, company, crew, unclassified];
  await openDutyUnitEditor(page, { unit: [crew.name] }, async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ units: route.request().postDataJSON().names ? [crew] : units }),
    });
  });
  const input = page.getByRole('combobox', { name: 'Підрозділ' });
  await expect(input).toHaveValue(crew.name);
  await input.fill('123 омб');
  await expect(page.getByRole('option')).toHaveText(units.map((unit) => unit.name));
  await input.press('ArrowDown');
  await input.press('Enter');
  await expect(input).toHaveValue(brigade.name);
  await expect(input).toHaveAttribute('aria-invalid', 'false');
});

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
  await page.getByRole('textbox', { name: 'Текст повідомлення' }).fill('3535 selected duplicate');
  await input.fill(existingUnit.name);
  await expect(input).toHaveAttribute('aria-invalid', 'true');
  await expect(page.getByRole('button', { name: 'Створити', exact: true })).toBeDisabled();
  await expect(page.getByRole('option', { name: /^Додати Підрозділ/ })).toHaveCount(0);
  await expect(
    page.getByRole('option', { name: `${existingUnit.name} · №${existingUnit.id}`, exact: true }),
  ).toBeVisible();
  await page
    .getByRole('option', { name: `${duplicate.name} · №${duplicate.id}`, exact: true })
    .click();
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
          await installAnalysisNeoApiMocks(page, {
            signalGroups: ['editor-e2e-group'],
            userRoles: ['Rer', 'UnitsEditor'],
          });
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
        await saveNewUnit(page);
        expect(submissions).toHaveLength(0);
      }
      await page.getByRole('button', { name: 'Створити', exact: true }).click();
      await expect.poll(() => submissions.length).toBe(1);
      expect(submissions[0]).toMatchObject(
        selection === 'existing'
          ? { unit: inactiveChild.name, unit_id: inactiveChild.id }
          : { unit: newUnitName, unit_id: createdUnitId },
      );
      expect(submissions[0].create_unit).toBeUndefined();
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
    await saveNewUnit(page);
    await page.getByRole('button', { name: 'Створити', exact: true }).click();
    await expect.poll(() => submissions.length).toBe(1);
    expect(submissions[0]).toMatchObject({ unit: newUnitName, unit_id: createdUnitId });
    expect(submissions[0].create_unit).toBeUndefined();
  });
}

test('@regression #3535 parsed exact names selected inactive units by ID', async ({ page }) => {
  const submissions = await openDutyUnitEditor(page);
  await page.route('**/api/1.1/submit-direct/parse', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        text: '3535 parsed message',
        unit_v2: '  2\tРОТА  3535 ПОЛК ',
        coords: [],
        to: [],
        locations: [],
      }),
    }),
  );
  await page
    .getByRole('textbox', { name: 'Текст повідомлення' })
    .fill(`Підрозділ: ${inactiveChild.name}\n3535 parsed message`);
  const input = page.getByRole('combobox', { name: 'Підрозділ' });
  await expect(input).toHaveValue('  2\tРОТА  3535 ПОЛК ');
  await expect(input).toHaveAttribute('aria-invalid', 'false');
  await input.click();
  await expect(page.getByRole('option', { name: inactiveChild.name, exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await page.getByRole('button', { name: 'Створити', exact: true }).click();
  await expect.poll(() => submissions.length).toBe(1);
  expect(submissions[0]).toMatchObject({ unit_id: inactiveChild.id, text: '3535 parsed message' });
});

test('@regression #3535 typed partial names blocked creation and offered Add only without candidates', async ({
  page,
}) => {
  const submissions = await openDutyUnitEditor(page);
  const body = page.getByRole('textbox', { name: 'Текст повідомлення' });
  await body.fill('3535 selection validation');
  const input = page.getByRole('combobox', { name: 'Підрозділ' });
  const create = page.getByRole('button', { name: 'Створити', exact: true });
  await expect(create).toBeEnabled();
  await input.fill('3535 полк');
  await expect(page.getByRole('option', { name: inactiveChild.name, exact: true })).toBeVisible();
  await expect(page.getByRole('option', { name: /^Додати Підрозділ/ })).toHaveCount(0);
  await expect(input).toHaveAttribute('aria-invalid', 'true');
  await expect(page.getByText('Підрозділ не обрано', { exact: true })).toBeVisible();
  await expect(create).toBeDisabled();
  await input.press('Enter');
  await body.press('Control+Enter');
  expect(submissions).toHaveLength(0);
  await input.fill(newUnitName);
  await expect(
    page.getByRole('option', { name: `Додати Підрозділ «${newUnitName}»` }),
  ).toBeVisible();
  await expect(create).toBeDisabled();
  await page.getByRole('option', { name: `Додати Підрозділ «${newUnitName}»` }).click();
  await saveNewUnit(page);
  await expect(input).toHaveAttribute('aria-invalid', 'false');
  await expect(create).toBeEnabled();
  await input.fill('3535 полк');
  await expect(create).toBeDisabled();
  await input.fill('  ');
  await expect(input).toHaveAttribute('aria-invalid', 'false');
  await expect(create).toBeEnabled();
  await create.click();
  await expect.poll(() => submissions.length).toBe(1);
  expect(submissions[0].unit_id).toBeUndefined();
  expect(submissions[0].create_unit).toBeUndefined();
});

test('@regression #3535 accepted parser suggestions replaced manually selected unit IDs', async ({
  page,
}) => {
  const submissions = await openDutyUnitEditor(page);
  await page.route('**/api/1.1/submit-direct/parse', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        text: '3535 ownership',
        unit_v2: inactiveChild.name,
        coords: [],
        to: [],
        locations: [],
      }),
    }),
  );
  const input = page.getByRole('combobox', { name: 'Підрозділ' });
  await input.fill(existingUnit.name);
  await expect(input).toHaveAttribute('aria-invalid', 'false');
  await page
    .getByRole('textbox', { name: 'Текст повідомлення' })
    .fill(`Підрозділ: ${inactiveChild.name}\n3535 ownership`);
  const accept = page.getByRole('button', { name: 'Взяти підрозділ із тексту', exact: true });
  await expect(accept).toBeVisible();
  await expect(input).toHaveValue(existingUnit.name);
  await accept.click();
  await expect(input).toHaveValue(inactiveChild.name);
  await expect(input).toHaveAttribute('aria-invalid', 'false');
  await page.getByRole('button', { name: 'Створити', exact: true }).click();
  await expect.poll(() => submissions.length).toBe(1);
  expect(submissions[0]).toMatchObject({ unit_id: inactiveChild.id });
});

test('@regression #3535 stale exact searches could not replace a newly saved unit', async ({
  page,
}) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let requested = false;
  const submissions = await openDutyUnitEditor(page, {}, async (route) => {
    const search = route.request().postDataJSON().search;
    if (search === existingUnit.name) {
      requested = true;
      await gate;
    }
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        units: search === existingUnit.name ? [existingUnit] : [],
      }),
    });
  });
  await page.getByRole('textbox', { name: 'Текст повідомлення' }).fill('3535 stale search');
  const input = page.getByRole('combobox', { name: 'Підрозділ' });
  await input.fill(existingUnit.name);
  await expect.poll(() => requested).toBe(true);
  await input.fill(newUnitName);
  await page.getByRole('option', { name: `Додати Підрозділ «${newUnitName}»` }).click();
  release();
  await saveNewUnit(page);
  await expect(input).toHaveValue(newUnitName);
  await page.getByRole('button', { name: 'Створити', exact: true }).click();
  await expect.poll(() => submissions.length).toBe(1);
  expect(submissions[0]).toMatchObject({ unit: newUnitName, unit_id: createdUnitId });
  expect(submissions[0].create_unit).toBeUndefined();
});

test('@regression #3535 report destination handling could not bypass unresolved unit validation', async ({
  page,
}) => {
  await openCreateReportDrawer(page);
  const submissions = await installUnitApi(page);
  await page.getByRole('textbox', { name: 'Текст розвіддонесення' }).fill('3535 report validation');
  const input = page.getByRole('combobox', { name: 'Підрозділ' });
  await input.fill('3535 полк');
  await expect(page.getByRole('option', { name: inactiveChild.name, exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Створити', exact: true })).toBeDisabled();
  await expect(input).toHaveAttribute('aria-invalid', 'true');
  await page.getByRole('option', { name: inactiveChild.name, exact: true }).click();
  await page.getByRole('combobox', { name: 'Відправити в групу' }).click();
  await page.getByRole('option', { name: 'Не відправляти', exact: true }).click();
  await page.getByRole('button', { name: 'Створити', exact: true }).click();
  await expect.poll(() => submissions.length).toBe(1);
  expect(submissions[0]).toMatchObject({ unit_id: inactiveChild.id });
});

test('@regression #3535 network assignments required every unit and remained usable after retry', async ({
  page,
}) => {
  const submissions = await openDutyUnitEditor(page);
  const network = {
    id: 3535,
    name: 'Мережа 3535',
    unit_ids: [existingUnit.id, inactiveChild.id],
    freqs: [],
  };
  await page.route('**/api/sigint/network/search', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ networks: [network] }),
    }),
  );
  let complete = false;
  await page.route('**/api/sigint/units-by-id', (route) => {
    const ids: number[] = route.request().postDataJSON().ids;
    expect(ids.every((id) => network.unit_ids.includes(id))).toBe(true);
    return route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        units: (complete ? [inactiveChild, existingUnit] : [existingUnit]).filter((unit) =>
          ids.includes(unit.id),
        ),
      }),
    });
  });
  const body = page.getByRole('textbox', { name: 'Текст повідомлення' });
  await body.fill('3535 network assignment');
  await page.getByRole('combobox', { name: 'Мережа', exact: true }).fill(network.name);
  await page.getByRole('option', { name: new RegExp(`^${network.name}`) }).click();
  await expect(page.getByText('Не вдалося завантажити довідкові дані.')).toBeVisible();
  const input = page.getByRole('combobox', { name: 'Підрозділ' });
  const create = page.getByRole('button', { name: 'Створити', exact: true });
  await expect(create).toBeDisabled();
  await expect(input).toBeDisabled();
  complete = true;
  await page.getByRole('button', { name: 'Повторити завантаження' }).click();
  await expect(input).toHaveValue(`${existingUnit.name}, ${inactiveChild.name}`);
  await expect(input).toBeDisabled();
  await expect(input).toHaveAttribute('aria-invalid', 'false');
  await expect(create).toBeEnabled();
  await create.click();
  await expect.poll(() => submissions.length).toBe(1);
  expect(submissions[0]).toMatchObject({
    unit: `${existingUnit.name}, ${inactiveChild.name}`,
    network: { name: network.name },
  });
  expect(submissions[0].unit_id).toBeUndefined();
  await body.fill('3535 next network assignment');
  await expect(create).toBeEnabled();
  await create.press('Enter');
  await expect.poll(() => submissions.length).toBe(2);
  expect(submissions[1]).toMatchObject({ network: { name: network.name, signal_name: 'DMR' } });
});

for (const units of [[existingUnit], [existingUnit, inactiveChild]]) {
  test(`@regression #3535 clearing a ${units.length}-unit network reconciled its selection`, async ({
    page,
  }) => {
    const submissions = await openDutyUnitEditor(page);
    const network = {
      id: 3535,
      name: 'Мережа 3535',
      unit_ids: units.map((unit) => unit.id),
      freqs: [],
    };
    await page.route('**/api/sigint/network/search', (route) =>
      route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ networks: [network] }),
      }),
    );
    await page.route('**/api/sigint/units-by-id', (route) =>
      route.fulfill({ contentType: 'application/json', body: JSON.stringify({ units }) }),
    );
    await page.route('**/api/sigint/unit/search', (route) =>
      route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ units: [existingUnit, { ...existingUnit, id: 99999 }] }),
      }),
    );
    await page.getByRole('textbox', { name: 'Текст повідомлення' }).fill('3535 cleared network');
    const networkInput = page.getByRole('combobox', { name: 'Мережа', exact: true });
    await networkInput.fill(network.name);
    await page.getByRole('option', { name: new RegExp(`^${network.name}`) }).click();
    const input = page.getByRole('combobox', { name: 'Підрозділ' });
    await expect(input).toHaveValue(units.map((unit) => unit.name).join(', '));
    await expect(input).toBeDisabled();
    await networkInput.fill('');
    await expect(input).toBeEnabled();
    await expect(input).toHaveValue(units.length === 1 ? existingUnit.name : '');
    const create = page.getByRole('button', { name: 'Створити', exact: true });
    await expect(create).toBeEnabled();
    await create.click();
    await expect.poll(() => submissions.length).toBe(1);
    expect(submissions[0].unit_id).toBe(units.length === 1 ? existingUnit.id : undefined);
  });
}

test('@regression #3535 automatic name resolution preserved a changed identity and dirty baseline', async ({
  page,
}) => {
  const replacement = { ...existingUnit, id: 99999 };
  await openDutyUnitEditor(page, { unit: [existingUnit.name] }, async (route) => {
    const request = route.request().postDataJSON();
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ units: request.names ? [existingUnit] : [replacement] }),
    });
  });
  const input = page.getByRole('combobox', { name: 'Підрозділ' });
  await expect(input).toHaveValue(existingUnit.name);
  await input.fill('');
  await input.fill(existingUnit.name);
  await expect(input).toHaveAttribute('aria-invalid', 'false');
  await input.press('Tab');
  await page.getByRole('button', { name: 'Закрити', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Відхилити незбережені зміни?' })).toBeVisible();
});

test('@regression #3535 a network selected its known unit ID despite duplicate catalog names', async ({
  page,
}) => {
  const submissions = await openDutyUnitEditor(page);
  const network = { id: 3535, name: 'Мережа 3535', unit_ids: [inactiveChild.id], freqs: [] };
  await page.route('**/api/sigint/network/search', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ networks: [network] }),
    }),
  );
  await page.route('**/api/sigint/unit/search', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ units: [inactiveChild, { ...inactiveChild, id: existingUnit.id }] }),
    }),
  );
  await page.route('**/api/sigint/units-by-id', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ units: [inactiveChild] }),
    }),
  );
  await page.getByRole('textbox', { name: 'Текст повідомлення' }).fill('3535 network unit ID');
  await page.getByRole('combobox', { name: 'Мережа', exact: true }).fill(network.name);
  await page.getByRole('option', { name: new RegExp(`^${network.name}`) }).click();
  const input = page.getByRole('combobox', { name: 'Підрозділ' });
  await expect(input).toHaveValue(inactiveChild.name);
  await expect(input).toBeDisabled();
  await page.getByRole('button', { name: 'Створити', exact: true }).click();
  await expect.poll(() => submissions.length).toBe(1);
  expect(submissions[0]).toMatchObject({ unit_id: inactiveChild.id });
});

test('@regression #3535 accepting a parsed unit released its network assignment before submission', async ({
  page,
}) => {
  const submissions = await openDutyUnitEditor(page);
  const network = { id: 3535, name: 'Мережа 3535', unit_ids: [existingUnit.id], freqs: [] };
  await page.route('**/api/sigint/network/search', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ networks: [network] }),
    }),
  );
  await page.route('**/api/sigint/units-by-id', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ units: [existingUnit] }),
    }),
  );
  await page.route('**/api/1.1/submit-direct/parse', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        text: '3535 parsed network unit',
        unit_v2: inactiveChild.name,
        coords: [],
        to: [],
        locations: [],
      }),
    }),
  );
  const networkInput = page.getByRole('combobox', { name: 'Мережа', exact: true });
  await networkInput.fill(network.name);
  await page.getByRole('option', { name: new RegExp(`^${network.name}`) }).click();
  const input = page.getByRole('combobox', { name: 'Підрозділ' });
  await expect(input).toHaveValue(existingUnit.name);
  await expect(input).toBeDisabled();
  await page
    .getByRole('textbox', { name: 'Текст повідомлення' })
    .fill(`Підрозділ: ${inactiveChild.name}\n3535 parsed network unit`);
  await page.getByRole('button', { name: 'Взяти підрозділ із тексту', exact: true }).click();
  await expect(input).toHaveValue(inactiveChild.name);
  await expect(input).toBeEnabled();
  await expect(input).toHaveAttribute('aria-invalid', 'false');
  await page.getByRole('button', { name: 'Створити', exact: true }).click();
  await expect.poll(() => submissions.length).toBe(1);
  expect(submissions[0]).toMatchObject({
    unit_id: inactiveChild.id,
    network: { name: network.name },
  });
});
