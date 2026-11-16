import { expect, test } from '@playwright/test';
import { installRouteLoadComparisonMocks } from './page-loading-comparison.fixtures';

// Regression: https://github.com/echoua/echo/issues/3575
test('@smoke @regression #3575 profile saves update classic author widgets and keyboard panels', async ({
  page,
}) => {
  await installRouteLoadComparisonMocks(page, 'palitra');
  const author = {
    id: '00000000-0000-0000-0000-000000003575',
    login: 'operator',
    display_name: 'Сокіл',
    delta_login: 'delta-operator',
  };
  await page.route('**/api/user', (route) =>
    route.fulfill({
      json: {
        id: author.id,
        name: author.login,
        display_name: author.display_name,
        roles: ['Rer', 'Admin'],
        sigint_zone_id: null,
        organism_id: null,
        delta_login: author.delta_login,
        goi_configured_for_organism: false,
        goi_full_access_for_organism: false,
        goi_host: null,
        goi_integrations: [],
        last_release_seen: null,
        administered_organism_ids: [],
        rer_report_eligible: false,
      },
    }),
  );
  await page.route('**/api/user/author-identities', (route) =>
    route.fulfill({ json: { authors: [author] } }),
  );
  await page.route('**/api/user/display-name', (route) => {
    author.display_name = route.request().postDataJSON().display_name;
    return route.fulfill({ json: author });
  });
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.text().includes('Blocked aria-hidden')) errors.push(message.text());
  });
  await page.goto('/settings-neo?section=profile');
  await expect(page.getByRole('tab', { name: 'Профіль' })).toHaveAttribute(
    'aria-selected',
    'true',
    { timeout: 20000 },
  );
  const name = page.getByLabel('Відображуване ім’я');
  await expect(name).toHaveValue('Сокіл');
  await page.evaluate(() => {
    const author = document.createElement('echo-author-label');
    author.setAttribute('login', 'operator');
    document.body.append(author);
  });
  const label = page.locator('echo-author-label').getByRole('button');
  await expect(label).toHaveText('Сокіл');
  await label.focus();
  await page.keyboard.press('Enter');
  const panel = page.getByRole('dialog', { name: 'Інформація про автора' });
  await expect(panel).toContainText('operator');
  await expect(panel).toContainText('delta-operator');
  await page.keyboard.press('Escape');
  await expect(panel).toHaveCount(0);
  await expect(label).toBeFocused();
  await name.fill('Нове ім’я');
  await page.getByRole('button', { name: 'Зберегти', exact: true }).click();
  await expect(label).toHaveText('Нове ім’я');
  await name.fill('');
  await page.getByRole('button', { name: 'Зберегти', exact: true }).click();
  await expect(page.locator('echo-author-label')).toHaveText('operator');
  await expect(label).toHaveCount(0);
  expect(errors).toEqual([]);
});
