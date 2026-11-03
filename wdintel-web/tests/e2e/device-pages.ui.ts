import { expect, type Page } from '@playwright/test';

export async function openDeviceSection(page: Page, label: string) {
  const overview =
    label === 'Пристрій' || label === 'Аналітичні відомості' || label === 'Аналітика';
  const suffix = ({ Файли: 'files', Журнал: 'journal', Аудіо: 'audio' } as Record<string, string>)[
    label
  ];
  if (suffix && new URL(page.url()).pathname.endsWith(`/${suffix}`)) {
    await expect(page.locator('device-details-page')).toHaveAttribute('page-section', suffix);
    return;
  }
  if (/\/devices\/[^/]+\/(files|journal|audio)$/.test(new URL(page.url()).pathname)) {
    await page.getByRole('button', { name: 'До пристрою', exact: true }).click();
    await expect(page.getByRole('navigation', { name: 'Меню пристрою' })).toBeVisible();
  }
  if (!overview) {
    await page.getByRole('link', { name: label, exact: true }).click();
    await expect(page.locator('device-details-page')).toHaveAttribute('page-section', suffix);
  }
}
