import { expect, test, type Locator, type Page } from '@playwright/test';

import { installAnalysisNeoApiMocks } from './analysis-neo.fixtures';

const summaryResponse = {
  rows: [
    {
      freq: '123.456789012345678901234567890',
      count: 1,
      callsigns: ['A', 'BRAVO-VERY-LONG-CALLSIGN', 'CHARLIE-VERY-LONG-CALLSIGN'],
      units: [
        'Перший надзвичайно довгий підрозділ для перевірки переповнення',
        'Другий надзвичайно довгий підрозділ для перевірки переповнення',
      ],
      locations: ['Локація з дуже довгою назвою для перевірки переповнення'],
      coords: [],
      locality_coords: [],
    },
  ],
};

function recordBrowserProblems(page: Page) {
  const problems: string[] = [];
  page.on('pageerror', (error) => problems.push(error.message));
  page.on('console', (message) => {
    const text = message.text();
    if (
      (message.type() === 'error' && !text.startsWith('Warning:')) ||
      /each child|accessib|aria-|failed prop type|invalid prop .* supplied/i.test(text)
    ) {
      problems.push(text);
    }
  });
  return problems;
}

async function expectNoApplicationErrors(page: Page) {
  await expect(page.getByRole('alert')).toHaveCount(0);
}

async function openSummary(page: Page) {
  await page.setViewportSize({ width: 1920, height: 900 });
  await installAnalysisNeoApiMocks(page);
  await page.route('**/api/rer/analysis/summary-table-freq', async (route) => {
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(summaryResponse) });
  });
  await page.goto('/rer-analysis-neo');
  await page.getByRole('tab', { name: 'Зведена таблиця' }).click();
  const table = page.getByRole('table', { name: 'Таблиця частот аналізу' });
  await expect(table).toBeVisible();
  await expectNoApplicationErrors(page);
  return table;
}

async function setCallsignColumnWidth(page: Page, width: number) {
  await page.addInitScript((columnWidth) => {
    localStorage.setItem(
      'columnSizing-rer-analysis-summary-table',
      JSON.stringify({ callsignSearchText: columnWidth }),
    );
  }, width);
}

async function resizeColumn(table: Locator, column: string, deltaX: number) {
  const header = table.getByRole('columnheader', { name: new RegExp(`^${column}`) });
  const handle = header.locator('.Mui-TableHeadCell-ResizeHandle-Wrapper');
  await handle.scrollIntoViewIfNeeded();
  const widthBefore = await header.evaluate((element) => element.getBoundingClientRect().width);
  const box = await handle.boundingBox();
  expect(box).not.toBeNull();
  const viewport = table.page().viewportSize();
  expect(viewport).not.toBeNull();
  const startX = box!.x + box!.width / 2;
  const startY = box!.y + box!.height / 2;
  expect(startX).toBeGreaterThan(0);
  expect(startX).toBeLessThan(viewport!.width);
  const endX = Math.max(2, Math.min(viewport!.width - 2, startX + deltaX));
  await table.page().mouse.move(startX, startY);
  await table.page().mouse.down();
  await table.page().mouse.move(endX, startY, { steps: 12 });
  await table.page().mouse.up();
  if (deltaX < 0) {
    await expect
      .poll(() => header.evaluate((element) => element.getBoundingClientRect().width))
      .toBeLessThan(widthBefore - 2);
  } else {
    await expect
      .poll(() => header.evaluate((element) => element.getBoundingClientRect().width))
      .toBeGreaterThan(widthBefore + 2);
  }
}

async function summaryCell(table: Locator, column: string) {
  const header = table.getByRole('columnheader', { name: new RegExp(`^${column}`) });
  const index = await header.evaluate((element) =>
    Array.from(element.parentElement?.children ?? []).indexOf(element),
  );
  return table.locator('tbody tr').first().locator('td').nth(index);
}

test.describe('Analysis Neo MRT overflow @smoke', () => {
  test('shows scalar ellipsis and full text only while the column overflows', async ({ page }) => {
    const problems = recordBrowserProblems(page);
    const table = await openSummary(page);
    const cell = await summaryCell(table, 'Частота');
    const text = cell.locator('span').filter({ hasText: summaryResponse.rows[0].freq }).last();

    await resizeColumn(table, 'Частота', -105);
    await expect
      .poll(() => text.evaluate((element) => element.scrollWidth > element.clientWidth))
      .toBe(true);
    await expect(text).toHaveAttribute('tabindex', '0');
    await expect(text).toHaveCSS('overflow', 'hidden');
    await expect(text).toHaveCSS('white-space', 'nowrap');
    await expect(text).toHaveCSS('text-overflow', 'ellipsis');

    await text.hover();
    await expect(page.getByRole('tooltip')).toHaveText(summaryResponse.rows[0].freq);
    await page.keyboard.press('Escape');
    await expect(page.getByRole('tooltip')).toHaveCount(0);
    await text.focus();
    await expect(page.getByRole('tooltip')).toHaveText(summaryResponse.rows[0].freq);

    await resizeColumn(table, 'Частота', 300);
    await expect
      .poll(() => text.evaluate((element) => element.scrollWidth <= element.clientWidth))
      .toBe(true);
    await expect(text).not.toHaveAttribute('tabindex');
    await text.hover();
    await expect(page.getByRole('tooltip')).toHaveCount(0);
    await expectNoApplicationErrors(page);
    expect(problems).toEqual([]);
  });

  test('keeps callsign chips whole and restores them after widening', async ({ page }) => {
    const problems = recordBrowserProblems(page);
    await setCallsignColumnWidth(page, 700);
    const table = await openSummary(page);
    const callsignCell = await summaryCell(table, 'Позивні');

    await expect(callsignCell.locator('.MuiChip-root')).toHaveCount(3);
    await expect(callsignCell.getByRole('button', { name: /Показати ще/ })).toHaveCount(0);
    await expect(callsignCell.locator('[data-mrt-overflow-fade]')).toHaveCount(0);
    await resizeColumn(table, 'Позивні', -500);

    const trigger = callsignCell.getByRole('button', { name: /Показати ще \d+ значення/ });
    await expect(trigger).toBeVisible();
    await expect(trigger).toHaveText(/^Ще \d+$/);
    const hiddenCount = Number((await trigger.textContent())!.replace('Ще ', ''));
    expect(hiddenCount).toBeGreaterThan(0);

    const fade = callsignCell.locator('[data-mrt-overflow-fade]').first();
    await expect(fade).toHaveCSS('background-image', /linear-gradient/);
    const visibleStrip = callsignCell.locator('[data-mrt-overflow-visible]');
    await expect(visibleStrip).toHaveCSS('overflow', 'hidden');
    const chipBounds = await visibleStrip.evaluate((strip) => {
      const stripBox = strip.getBoundingClientRect();
      const chips = Array.from(strip.querySelectorAll<HTMLElement>('.MuiChip-root'));

      return {
        strip: {
          left: stripBox.left,
          right: stripBox.right,
        },
        chips: chips.map((chip) => {
          const box = chip.getBoundingClientRect();
          return {
            text: chip.textContent?.trim() ?? '',
            left: box.left,
            right: box.right,
            width: box.width,
          };
        }),
      };
    });
    expect(chipBounds.chips.length).toBeGreaterThan(0);
    expect(chipBounds.chips.every((chip) => chip.width > 0)).toBe(true);
    expect(
      chipBounds.chips.every(
        (chip) =>
          chip.left >= chipBounds.strip.left - 1 && chip.right <= chipBounds.strip.right + 1,
      ),
    ).toBe(true);
    const visible = chipBounds.chips.map((chip) => chip.text);
    const hidden = summaryResponse.rows[0].callsigns.filter(
      (callsign) => !visible.includes(callsign),
    );
    expect(hidden).toHaveLength(hiddenCount);
    expect(visible.length + hidden.length).toBe(summaryResponse.rows[0].callsigns.length);
    expect(hiddenCount).toBe(2);
    expect(visible).toEqual(['A']);
    expect(hidden).toEqual(['BRAVO-VERY-LONG-CALLSIGN', 'CHARLIE-VERY-LONG-CALLSIGN']);
    await expect(trigger).toHaveText('Ще 2');
    await expect(trigger).toHaveAccessibleName('Показати ще 2 значення');

    await trigger.click();
    const dialog = page.getByRole('dialog', { name: 'Додаткові значення' });
    await expect(dialog).toBeVisible();
    for (const callsign of hidden) {
      await expect(dialog.getByText(callsign, { exact: true })).toBeVisible();
    }
    for (const callsign of visible) {
      await expect(dialog.getByText(callsign, { exact: true })).toHaveCount(0);
    }

    await resizeColumn(table, 'Позивні', 700);
    const widenedTrigger = callsignCell.getByRole('button', { name: /Показати ще/ });
    await expect.poll(() => widenedTrigger.count()).toBe(0);
    for (const callsign of summaryResponse.rows[0].callsigns) {
      await expect(callsignCell.getByText(callsign, { exact: true })).toBeVisible();
    }
    await expect(dialog).toHaveCount(0);
    await expect(fade).toHaveCount(0);
    await expectNoApplicationErrors(page);
    expect(problems).toEqual([]);
  });

  test('opens callsign disclosure from the keyboard and restores focus on Escape', async ({
    page,
  }) => {
    const problems = recordBrowserProblems(page);
    await setCallsignColumnWidth(page, 700);
    const table = await openSummary(page);
    await resizeColumn(table, 'Позивні', -500);
    const trigger = (await summaryCell(table, 'Позивні')).getByRole('button', {
      name: /Показати ще \d+ значення/,
    });
    await expect(trigger).toBeVisible();
    await expect(trigger).toHaveAccessibleName('Показати ще 2 значення');
    await trigger.focus();
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog', { name: 'Додаткові значення' });
    await expect(dialog).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(trigger).toBeFocused();
    await expectNoApplicationErrors(page);
    expect(problems).toEqual([]);
  });
});
