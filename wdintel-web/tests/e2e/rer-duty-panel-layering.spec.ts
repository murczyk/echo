import { expect, test, type Locator, type Page } from '@playwright/test';

import {
  MESSAGE_CARD_MEDIA_PREVIEW_ATTACHMENT_NAMES,
  openMessageCardPreviewHost,
} from './message-card-media-preview.fixtures';

type Point = { x: number; y: number };

async function overlapPoint(panel: Locator, control: Locator): Promise<Point> {
  const [panelBox, controlBox] = await Promise.all([panel.boundingBox(), control.boundingBox()]);
  if (!panelBox || !controlBox)
    throw new Error('Expected visible filter panel and download control');

  const left = Math.max(panelBox.x, controlBox.x);
  const right = Math.min(panelBox.x + panelBox.width, controlBox.x + controlBox.width);
  const top = Math.max(panelBox.y, controlBox.y);
  const bottom = Math.min(panelBox.y + panelBox.height, controlBox.y + controlBox.height);
  if (left >= right || top >= bottom)
    throw new Error('Filter panel does not overlap the download control');

  return { x: (left + right) / 2, y: (top + bottom) / 2 };
}

async function controlReceivesPoint(control: Locator, point: Point): Promise<boolean> {
  return control.evaluate((element, location) => {
    const target = document.elementFromPoint(location.x, location.y);
    return target != null && element.contains(target);
  }, point);
}

async function registerClickCounter(page: Page, control: Locator, key: string) {
  await control.evaluate((element, counterKey) => {
    const counters = ((
      window as Window & { __dutyLayeringClicks?: Record<string, number> }
    ).__dutyLayeringClicks ??= {});
    counters[counterKey] = 0;
    element.addEventListener('click', (event) => {
      event.preventDefault();
      counters[counterKey] += 1;
    });
  }, key);
}

async function clickCount(page: Page, key: string): Promise<number> {
  return page.evaluate(
    (counterKey) =>
      (window as Window & { __dutyLayeringClicks?: Record<string, number> }).__dutyLayeringClicks?.[
        counterKey
      ] ?? 0,
    key,
  );
}
test('keeps image and video download controls below an open Duty filter panel', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await openMessageCardPreviewHost(page, 'duty');

  const downloads = [
    page.getByRole('link', {
      name: `Завантажити вкладення: ${MESSAGE_CARD_MEDIA_PREVIEW_ATTACHMENT_NAMES.image1}`,
    }),
    page.getByRole('link', {
      name: `Завантажити вкладення: ${MESSAGE_CARD_MEDIA_PREVIEW_ATTACHMENT_NAMES.video1}`,
    }),
  ];
  await Promise.all(downloads.map((control) => expect(control).toBeVisible()));
  await Promise.all(
    downloads.map((control, index) => registerClickCounter(page, control, String(index))),
  );

  const filters = page.getByRole('button', { name: 'Фільтри' });
  await filters.click();
  const panel = page.getByLabel('Панель фільтрів');
  await expect(panel).toBeVisible();

  for (const [index, control] of downloads.entries()) {
    const point = await overlapPoint(panel, control);
    expect(await controlReceivesPoint(control, point)).toBe(false);
    expect(
      await panel.evaluate((element, location) => {
        const target = document.elementFromPoint(location.x, location.y);
        return target != null && element.contains(target);
      }, point),
    ).toBe(true);
    await page.mouse.click(point.x, point.y);
    expect(await clickCount(page, String(index))).toBe(0);
  }

  await filters.click();
  await expect(panel).toBeHidden();
  for (const [index, control] of downloads.entries()) {
    const box = await control.boundingBox();
    if (!box) throw new Error('Expected visible download control');
    const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    expect(await controlReceivesPoint(control, point)).toBe(true);
    await page.mouse.click(point.x, point.y);
    expect(await clickCount(page, String(index))).toBe(1);
  }
});
