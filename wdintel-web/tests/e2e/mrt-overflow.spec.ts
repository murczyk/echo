import { expect, test, type Locator, type Page } from '@playwright/test';

import { installAnalysisNeoApiMocks } from './analysis-neo.fixtures';

const summaryRow = {
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
};

const summaryResponse = {
  rows: [
    summaryRow,
    ...Array.from({ length: 36 }, (_, index) => ({
      ...summaryRow,
      freq: `${summaryRow.freq}-${index + 1}`,
      callsigns: [
        `A-${index + 1}`,
        `BRAVO-VERY-LONG-CALLSIGN-${index + 1}`,
        `CHARLIE-VERY-LONG-CALLSIGN-${index + 1}`,
      ],
    })),
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
    await setCallsignColumnWidth(page, 260);
    const table = await openSummary(page);
    const callsignCell = await summaryCell(table, 'Позивні');
    await resizeColumn(table, 'Позивні', -5);
    const trigger = callsignCell.getByRole('button', { name: /Показати ще \d+ значення/ });
    await expect(trigger).toBeVisible();
    await expect.poll(() => page.locator('[data-mrt-overflow-measure]').count()).toBe(0);
    await page.evaluate(() => {
      const table = document.querySelector('table[aria-label="Таблиця частот аналізу"]');
      let scrollContainer = table?.parentElement as HTMLElement | null;
      while (scrollContainer) {
        const overflowY = getComputedStyle(scrollContainer).overflowY;
        if (
          /auto|scroll/.test(overflowY) &&
          scrollContainer.scrollHeight > scrollContainer.clientHeight
        ) {
          break;
        }
        scrollContainer = scrollContainer.parentElement;
      }
      const readGeometry = () => ({
        documentHeight: document.documentElement.scrollHeight,
        documentWidth: document.documentElement.scrollWidth,
        viewportWidth: document.documentElement.clientWidth,
        bodyHeight: document.body.scrollHeight,
        bodyWidth: document.body.scrollWidth,
        scrollTop: scrollContainer?.scrollTop ?? window.scrollY,
        measurementHosts: Array.from(
          document.querySelectorAll<HTMLElement>('[data-mrt-overflow-measurement-host]'),
        ).map((host) => {
          const rect = host.getBoundingClientRect();
          const style = getComputedStyle(host);
          return {
            width: rect.width,
            height: rect.height,
            overflow: style.overflow,
            visibility: style.visibility,
            contain: style.contain,
          };
        }),
      });
      const samples: ReturnType<typeof readGeometry>[] = [];
      const measured = new Set<Element>();
      const observer = new MutationObserver(() => {
        document.querySelectorAll('[data-mrt-overflow-measure]').forEach((measurement) => {
          if (measured.has(measurement)) return;
          measured.add(measurement);
          const root = document.documentElement;
          const descendantEscapesDocument = Array.from(
            measurement.querySelectorAll<HTMLElement>('*'),
          ).some((element) => {
            const rect = element.getBoundingClientRect();
            return (
              rect.left < 0 || rect.right > root.clientWidth || rect.bottom > root.scrollHeight
            );
          });
          samples.push({ ...readGeometry(), descendantEscapesDocument });
        });
      });
      observer.observe(document.body, { childList: true, subtree: true });
      (
        globalThis as typeof globalThis & {
          mrtOverflowGeometry?: {
            baseline: ReturnType<typeof readGeometry>;
            samples: Array<
              ReturnType<typeof readGeometry> & { descendantEscapesDocument: boolean }
            >;
            getMountCount: () => number;
            scrollToBottom: () => void;
            scrollToTop: () => void;
          };
        }
      ).mrtOverflowGeometry = {
        baseline: readGeometry(),
        samples,
        getMountCount: () => measured.size,
        scrollToBottom: () => scrollContainer?.scrollTo({ top: scrollContainer.scrollHeight }),
        scrollToTop: () => scrollContainer?.scrollTo({ top: 0 }),
      };
    });
    await page.evaluate(async () => {
      (
        globalThis as typeof globalThis & {
          mrtOverflowGeometry: { scrollToBottom: () => void };
        }
      ).mrtOverflowGeometry.scrollToBottom();
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    });
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (
              globalThis as typeof globalThis & {
                mrtOverflowGeometry?: {
                  baseline: { scrollTop: number };
                  samples: Array<{ scrollTop: number }>;
                };
              }
            ).mrtOverflowGeometry?.samples.some(
              (sample) =>
                sample.scrollTop > (globalThis as any).mrtOverflowGeometry.baseline.scrollTop,
            ) ?? false,
        ),
      )
      .toBe(true);
    await expect.poll(() => page.locator('[data-mrt-overflow-measure]').count()).toBe(0);
    await page.evaluate(async () => {
      (
        globalThis as typeof globalThis & {
          mrtOverflowGeometry: { scrollToTop: () => void };
        }
      ).mrtOverflowGeometry.scrollToTop();
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    });
    await expect(trigger).toHaveText(/^Ще \d+$/);
    const hiddenCount = Number((await trigger.textContent())!.replace('Ще ', ''));
    expect(hiddenCount).toBeGreaterThan(0);

    const fade = callsignCell.locator('[data-mrt-overflow-fade]').first();
    await expect(fade).toHaveCSS('background-image', /linear-gradient/);
    const visibleStrip = callsignCell.locator('[data-mrt-overflow-visible]');
    await expect(visibleStrip).toHaveCSS('overflow', 'hidden');
    const chipBounds = await visibleStrip.evaluate((strip) => {
      const stripBox = strip.getBoundingClientRect();
      const chips = Array.from(strip.querySelectorAll<HTMLElement>('.echo-chip'));

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
    await expect(trigger).toHaveAttribute('type', 'button');
    await expect(trigger).toHaveCSS('min-height', '24px');
    await expect(trigger).toHaveCSS('font-size', '13px');
    await expect(trigger).toHaveCSS('text-decoration-line', 'none');
    const restingBackground = await trigger.evaluate(
      (element) => getComputedStyle(element).backgroundColor,
    );
    await trigger.hover();
    const hoverBackground = await trigger.evaluate(
      (element) => getComputedStyle(element).backgroundColor,
    );
    expect(hoverBackground).not.toBe(restingBackground);
    await expect(trigger).toHaveCSS('text-decoration-line', 'none');
    const triggerBox = await trigger.boundingBox();
    expect(triggerBox).not.toBeNull();
    await page.mouse.move(
      triggerBox!.x + triggerBox!.width / 2,
      triggerBox!.y + triggerBox!.height / 2,
    );
    await page.mouse.down();
    const activeBackground = await trigger.evaluate(
      (element) => getComputedStyle(element).backgroundColor,
    );
    expect(activeBackground).not.toBe(restingBackground);
    await page.mouse.up();
    const dialog = page.getByRole('dialog', { name: 'Додаткові значення' });
    await expect(dialog).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(trigger).toBeFocused();
    await trigger.focus();
    const focusStyles = await trigger.evaluate((element) => {
      const style = getComputedStyle(element);
      const primaryProbe = document.createElement('span');
      primaryProbe.style.color = 'var(--echo-color-primary)';
      document.body.appendChild(primaryProbe);
      const primaryColor = getComputedStyle(primaryProbe).color;
      primaryProbe.remove();
      return {
        outlineWidth: style.outlineWidth,
        outlineStyle: style.outlineStyle,
        outlineColor: style.outlineColor,
        primaryColor,
      };
    });
    expect(focusStyles.outlineWidth).not.toBe('0px');
    expect(focusStyles.outlineStyle).toBe('solid');
    expect(focusStyles.outlineColor).toBe(focusStyles.primaryColor);

    const geometry = await page.evaluate(() => {
      const geometry = (
        globalThis as typeof globalThis & {
          mrtOverflowGeometry: {
            baseline: {
              documentHeight: number;
              documentWidth: number;
              viewportWidth: number;
              bodyHeight: number;
              bodyWidth: number;
              scrollTop: number;
              measurementHosts: Array<{
                width: number;
                height: number;
                overflow: string;
                visibility: string;
                contain: string;
              }>;
            };
            samples: Array<{
              documentHeight: number;
              documentWidth: number;
              viewportWidth: number;
              bodyHeight: number;
              bodyWidth: number;
              scrollTop: number;
              measurementHosts: Array<{
                width: number;
                height: number;
                overflow: string;
                visibility: string;
                contain: string;
              }>;
              descendantEscapesDocument: boolean;
            }>;
            getMountCount: () => number;
          };
        }
      ).mrtOverflowGeometry;
      return { ...geometry, mountCount: geometry.getMountCount() };
    });
    expect(geometry.samples.length).toBeGreaterThan(0);
    expect(geometry.mountCount).toBeGreaterThan(0);
    for (const sample of geometry.samples) {
      expect(sample.documentWidth).toBeLessThanOrEqual(sample.viewportWidth);
      expect(sample.bodyWidth).toBeLessThanOrEqual(sample.viewportWidth);
      expect(sample.documentHeight).toBe(geometry.baseline.documentHeight);
      expect(sample.bodyHeight).toBe(geometry.baseline.bodyHeight);
      expect(sample.descendantEscapesDocument).toBe(false);
      sample.measurementHosts.forEach((host) => {
        expect(host.width).toBe(0);
        expect(host.height).toBe(0);
        expect(host.overflow).toBe('hidden');
        expect(host.visibility).toBe('hidden');
        expect(['content', 'layout style paint']).toContain(host.contain);
      });
    }

    await page.keyboard.press('Enter');
    await expect(dialog).toBeVisible();
    await expect(dialog).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(trigger).toBeFocused();
    await page.keyboard.press('Space');
    await expect(dialog).toBeVisible();
    const summaryTab = page.getByRole('tab', { name: 'Зведена таблиця' });
    await summaryTab.click();
    await expect(dialog).toHaveCount(0);
    await expect(summaryTab).toBeFocused();

    await trigger.click();
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
    const summaryTab = page.getByRole('tab', { name: 'Зведена таблиця' });
    await summaryTab.click();
    await expect(dialog).toHaveCount(0);
    await expect(summaryTab).toBeFocused();
    await trigger.focus();
    await page.keyboard.press('Enter');
    await expect(dialog).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(trigger).toBeFocused();
    await expectNoApplicationErrors(page);
    expect(problems).toEqual([]);
  });
});
