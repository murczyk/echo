import { expect, test, type Page } from '@playwright/test';
import { installAnalysisNeoApiMocks } from './analysis-neo.fixtures';

const network = {
  id: 42,
  name: 'Bulk delete network',
  location: '',
  freqs: [],
  unit_ids: [1],
  aor_ids: [],
  post_ids: [],
  descriptions: [],
  created_at: 0,
  radio_station: null,
  purpose: null,
  operation_mode: null,
  operation_type: null,
  operation_period: null,
  last_activity_at: null,
  last_updated_at: 0,
  last_updated_by: null,
  active_from: null,
  active_to: null,
  deleted: false,
  do_not_archive: false,
  unit_mask: [],
  status: 'NetworkActive',
};

function networkCallsign(id: number, callsign: string, knownCallsignId: number | null) {
  return {
    id,
    network_id: 42,
    callsign,
    known_callsign_id: knownCallsignId,
    position: 'Оператор',
    comment: '',
    full_name: '',
    unit_id: 1,
    unit_name: '1',
    source_id: 1,
    radio_freq: null,
    created_at: 0,
    active: true,
    developing: false,
    message_count: 0,
    last_datetime: null,
    freqs: null,
    unit_developing: false,
    main_radio_station: false,
    command_control: false,
  };
}

async function installBulkDeleteMocks(page: Page) {
  const deleteRequests: Array<Record<string, unknown>> = [];
  let callsigns = [
    networkCallsign(7, 'СОКІЛ', 70),
    networkCallsign(8, 'ОРЕЛ', null),
    networkCallsign(9, 'ЛИС', null),
  ];
  await installAnalysisNeoApiMocks(page, { userRoles: ['Rer', 'Admin'] });
  for (const endpoint of ['aor', 'posts', 'encryptions-list']) {
    await page.route(`**/api/sigint/${endpoint}`, (route) => route.fulfill({ json: [] }));
  }
  await page.route('**/api/sigint/network-info-one', (route) => route.fulfill({ json: network }));
  await page.route('**/api/sigint/sources', (route) =>
    route.fulfill({ json: { sources: [{ id: 1, name: 'OSINT', created_at: 0 }] } }),
  );
  await page.route('**/api/sigint/network-callsigns-list', (route) =>
    route.fulfill({ json: { callsigns: [] } }),
  );
  await page.route('**/api/sigint/network-callsigns/list', (route) =>
    route.fulfill({ json: { network_callsigns: callsigns } }),
  );
  await page.route('**/api/sigint/network-callsign/delete-many', async (route) => {
    const payload = route.request().postDataJSON();
    deleteRequests.push(payload);
    callsigns = callsigns.filter((row) => !payload.ids.includes(row.id));
    await route.fulfill({
      json: { deleted_ids: payload.ids, deleted_catalog_callsign_ids: [70] },
    });
  });
  await page.goto('/rer-networks-neo/42?tab=callsigns');
  await expect(page.getByRole('row', { name: /СОКІЛ/ }).first()).toBeVisible();
  return deleteRequests;
}

test('@regression #4242 selects several network callsigns and unlinks them at once', async ({
  page,
}) => {
  const deleteRequests = await installBulkDeleteMocks(page);

  await expect(page.getByRole('checkbox')).toHaveCount(0);
  await page.getByRole('button', { name: 'Вибрати', exact: true }).click();
  await expect(page.getByText('Обрано: 0')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Видалити обрані' })).toBeDisabled();

  await page.getByRole('row', { name: /СОКІЛ/ }).getByRole('checkbox').check();
  await page.getByRole('row', { name: /ОРЕЛ/ }).getByRole('checkbox').check();
  await expect(page.getByText('Обрано: 2')).toBeVisible();
  await page.getByRole('button', { name: 'Видалити обрані' }).click();

  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText("Відв'язати від мережі позивних: 2?")).toBeVisible();
  await dialog.getByLabel('Видалити також з каталогу (1)').check();
  await dialog.getByRole('button', { name: "Відв'язати", exact: true }).click();

  await expect(dialog).toBeHidden();
  expect(deleteRequests).toHaveLength(1);
  expect(deleteRequests[0]).toMatchObject({ network_id: 42, also_delete_from_catalog: true });
  expect([...(deleteRequests[0].ids as number[])].sort()).toEqual([7, 8]);
  await expect(page.getByRole('row', { name: /СОКІЛ/ })).toHaveCount(0);
  await expect(page.getByRole('row', { name: /ЛИС/ })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Вибрати', exact: true })).toBeVisible();
  await expect(page.getByRole('checkbox')).toHaveCount(0);
});

test('@regression #4242 leaves selection mode without deleting on «Скасувати»', async ({
  page,
}) => {
  const deleteRequests = await installBulkDeleteMocks(page);

  await page.getByRole('button', { name: 'Вибрати', exact: true }).click();
  await page.getByRole('row', { name: /ЛИС/ }).getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Скасувати', exact: true }).click();

  await expect(page.getByRole('checkbox')).toHaveCount(0);
  await expect(page.getByRole('row', { name: /ЛИС/ })).toBeVisible();
  expect(deleteRequests).toHaveLength(0);
});
