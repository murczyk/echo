import { expect, test } from '@playwright/test';

import {
  createLoadedInboxResponse,
  createOverflowingInboxResponse,
  installAnalysisNeoApiMocks,
} from './analysis-neo.fixtures';

async function setupAnalysisNeoPage(
  page: Parameters<typeof installAnalysisNeoApiMocks>[0],
  options?: Parameters<typeof installAnalysisNeoApiMocks>[1],
) {
  await installAnalysisNeoApiMocks(page, options);
}

// Regression: https://github.com/echoua/echo/pull/3268
test.describe('@smoke @regression', () => {
  // Regression: https://github.com/echoua/echo/issues/2726
  for (const { roles, from, to } of [
    { roles: ['Rer'], from: '2026-09-24T00:00', to: '2026-09-25T00:00' },
    { roles: ['Cyber'], from: '2026-08-10T00:00', to: '2026-11-08T00:00' },
  ]) {
    test(`@regression opens an older linked message in the ${roles[0]} period and survives reload`, async ({
      page,
    }) => {
      await page.clock.setFixedTime(new Date('2026-12-28T12:00:00Z'));
      const response = createLoadedInboxResponse();
      const [messageId, message] = response.inbox_items[0];
      Object.assign(message, { date: '24.09.2026', time: '12:34:56', timestamp: null });
      await setupAnalysisNeoPage(page, { inboxResponse: response, userRoles: roles });
      const expectedParams = { m: message.messageUid, fromDateTime: from, toDateTime: to };
      const readParams = () => {
        const params = new URL(page.url()).searchParams;
        return Object.fromEntries(Object.keys(expectedParams).map((key) => [key, params.get(key)]));
      };
      const windows: Record<string, unknown>[] = [];
      await page.route('**/api/rer-importer/get-inbox', async (route) => {
        const request = route.request().postDataJSON();
        if (request.around_message_ref) {
          expect(readParams()).toEqual(expectedParams);
          expect(request.since_date_inclusive_ms).toEqual(expect.any(Number));
          expect(request.till_date_inclusive_ms).toEqual(expect.any(Number));
          expect(request.since_date_inclusive_ms).toBeLessThan(Date.parse('2026-09-24T09:34:56Z'));
          expect(request.till_date_inclusive_ms).toBeGreaterThan(
            Date.parse('2026-09-24T09:34:56Z'),
          );
          windows.push(request);
        }
        await route.fulfill({
          json: {
            ...response,
            around_message_messages_before: 0,
            around_message_messages_after: 0,
          },
        });
      });
      await page.goto(`/rer-analysis-neo?m=${message.messageUid}`);
      await expect(page.locator(`[data-message-id="${messageId}"]`)).toBeVisible();
      await expect.poll(readParams).toEqual(expectedParams);
      await page.reload();
      await expect(page.locator(`[data-message-id="${messageId}"]`)).toBeVisible();
      await expect.poll(readParams).toEqual(expectedParams);
      expect(windows).toHaveLength(2);
      expect(windows[1]).toMatchObject({
        since_date_inclusive_ms: windows[0].since_date_inclusive_ms,
        till_date_inclusive_ms: windows[0].till_date_inclusive_ms,
      });
    });
  }

  test('analysis neo summary flow loads a known row', async ({ page }) => {
    await setupAnalysisNeoPage(page, { inboxResponse: createLoadedInboxResponse() });
    await page.goto('/rer-analysis-neo');

    await expect(page).toHaveTitle('Аналіз');
    await expect(page.getByRole('heading', { name: 'Аналіз' })).toBeVisible();

    await expect(page.getByText('Analysis summary fixture message', { exact: true })).toBeVisible();

    const summaryTab = page.getByRole('tab', { name: 'Зведена таблиця' });
    await summaryTab.click();
    await expect(summaryTab).toHaveAttribute('aria-selected', 'true');

    const summaryPanel = page.getByRole('tabpanel', { name: 'Зведена таблиця' });
    await expect(summaryPanel).toBeVisible();
    await expect(summaryPanel.getByRole('table', { name: 'Таблиця частот аналізу' })).toBeVisible();
    await expect(summaryPanel.getByText('123.4', { exact: true })).toBeVisible();
  });

  // Regression: https://github.com/echoua/echo/issues/3452
  test('@regression marks retained summary data as stale after a sidebar refresh failure', async ({
    page,
  }) => {
    let failRefresh = false;
    await setupAnalysisNeoPage(page);
    await page.route('**/api/rer/analysis/stats/units', async (route) => {
      if (failRefresh) {
        await route.fulfill({ status: 500, contentType: 'application/json', body: '{}' });
        return;
      }
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ units: [{ unit_id: 1, name: 'Старий підрозділ', count: 3 }] }),
      });
    });
    await page.route('**/api/rer/analysis/stats/locations', async (route) => {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ locations: [{ location: 'Київ', count: 2 }] }),
      });
    });
    await page.goto('/rer-analysis-neo');
    await page.getByRole('button', { name: 'Розгорнути праву панель' }).click();
    await page.getByRole('tab', { name: 'Зведення' }).click();
    await expect(page.getByText('Старий підрозділ', { exact: true })).toBeVisible();

    failRefresh = true;
    await page.getByRole('button', { name: 'Оновити' }).click();

    await expect(page.getByText('Дані зведення відповідають попереднім фільтрам.')).toBeVisible();
    await expect(page.getByText('Дані зведення оновлюються для поточних фільтрів.')).toHaveCount(0);
    await expect(page.getByText('Старий підрозділ', { exact: true })).toBeVisible();
  });

  test('@regression browses bounded callsign pages and retains a selected group', async ({
    page,
  }) => {
    await setupAnalysisNeoPage(page, {
      callsignPageResponse: ({ cursor }) =>
        cursor == null
          ? {
              entries: [{ value: 'Alpha', label: 'ALPHA', values: ['Alpha', 'alpha'], count: 2 }],
              has_more: true,
              next_cursor: 'next-page',
            }
          : {
              entries: [{ value: 'Bravo', label: 'BRAVO', values: ['Bravo'], count: 1 }],
              has_more: false,
              next_cursor: null,
            },
    });
    await page.goto('/rer-analysis-neo');

    await page.getByRole('button', { name: 'Розгорнути праву панель' }).click();
    const callsignsTab = page.getByRole('tab', { name: 'Позивні' });
    await callsignsTab.click();
    await expect(
      page.getByRole('button', { name: 'Додати ALPHA до поточного фільтра' }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Додати ALPHA до поточного фільтра' }).click();
    await expect(page.getByRole('button', { name: 'Прибрати ALPHA з фільтра' })).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Додати ALPHA до поточного фільтра' }),
    ).toHaveCount(0);

    await page.getByRole('button', { name: 'Наступна сторінка позивних' }).click();
    await expect(
      page.getByRole('button', { name: 'Додати BRAVO до поточного фільтра' }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Додати BRAVO до поточного фільтра' }).click();
    await expect(page.getByRole('button', { name: 'Прибрати ALPHA з фільтра' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Прибрати BRAVO з фільтра' })).toBeVisible();
    await page.getByRole('button', { name: 'Попередня сторінка позивних' }).click();
    await page.getByRole('button', { name: 'ALPHA 2 повідомлень' }).click();
    await expect(page.getByRole('button', { name: 'Прибрати ALPHA з фільтра' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Прибрати BRAVO з фільтра' })).toBeVisible();
    await page.screenshot({ path: test.info().outputPath('callsigns-pagination.png') });
    await page.evaluate(() => document.documentElement.setAttribute('data-bs-theme', 'dark'));
    await page.screenshot({ path: test.info().outputPath('callsigns-pagination-dark-wide.png') });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByRole('button', { name: 'Прибрати BRAVO з фільтра' })).toBeVisible();
    await page.screenshot({ path: test.info().outputPath('callsigns-pagination-dark-narrow.png') });
    await expect(page.getByRole('button', { name: 'ALPHA 2 повідомлень' })).toBeVisible();
    await page.screenshot({ path: test.info().outputPath('callsigns-populated-dark-narrow.png') });
    for (const mode of ['light', 'dark']) {
      await page.evaluate(
        (mode) => document.documentElement.setAttribute('data-bs-theme', mode),
        mode,
      );
      await expect
        .poll(() =>
          page.locator('[data-analysis-callsign-pagination]').evaluate((footer) => {
            let surface = footer.parentElement;
            while (surface && getComputedStyle(surface).backgroundColor === 'rgba(0, 0, 0, 0)') {
              surface = surface.parentElement;
            }
            return (
              surface != null &&
              getComputedStyle(footer).backgroundColor === getComputedStyle(surface).backgroundColor
            );
          }),
        )
        .toBe(true);
    }
  });

  test('@regression keeps callsign chips in server order without premature wrapping', async ({
    page,
  }, testInfo) => {
    await setupAnalysisNeoPage(page, {
      callsignPageResponse: () => ({
        entries: [
          { value: 'uzhorod', label: 'УЖГОРОД', values: ['uzhorod'], count: 12 },
          { value: 'arbuz', label: 'АРБУЗ', values: ['arbuz'], count: 8 },
          {
            value: 'long-callsign',
            label: 'ДОВГИЙ-ПОЗИВНИЙ-З-ГРУПОЮ-ВАРІАНТІВ',
            values: ['long-callsign'],
            count: 1_234,
          },
        ],
        has_more: false,
        next_cursor: null,
      }),
    });
    await page.goto('/rer-analysis-neo');
    await page.getByRole('button', { name: 'Розгорнути праву панель' }).click();
    await page.getByRole('tab', { name: 'Позивні' }).click();

    const uzhorod = page.getByRole('button', { name: 'УЖГОРОД 12 повідомлень' });
    const arbuz = page.getByRole('button', { name: 'АРБУЗ 8 повідомлень' });
    await expect(uzhorod).toBeVisible();
    await expect(arbuz).toBeVisible();
    const wideLayout = await page.evaluate(() => {
      const firstChip = document.querySelector<HTMLElement>(
        '[aria-label="УЖГОРОД 12 повідомлень"]',
      );
      const chips = ['УЖГОРОД 12 повідомлень', 'АРБУЗ 8 повідомлень'].map((label) => {
        const chip = document.querySelector<HTMLElement>(`[aria-label="${label}"]`);
        return chip?.parentElement?.getBoundingClientRect() ?? null;
      });
      return {
        availableWidth: firstChip?.parentElement?.parentElement?.clientWidth ?? 0,
        first: chips[0] && { top: chips[0].top, width: chips[0].width },
        second: chips[1] && { top: chips[1].top, width: chips[1].width },
      };
    });
    expect(wideLayout.first).not.toBeNull();
    expect(wideLayout.second).not.toBeNull();
    expect(wideLayout.availableWidth).toBeGreaterThanOrEqual(
      (wideLayout.first?.width ?? 0) + (wideLayout.second?.width ?? 0) + 4,
    );
    expect(wideLayout.first?.top).toBe(wideLayout.second?.top);

    await page.setViewportSize({ width: 768, height: 844 });
    await expect(uzhorod).toBeVisible();
    await expect(arbuz).toBeVisible();
    const mediumChipsFit = await page
      .locator('[aria-label$="повідомлень"]')
      .evaluateAll((chips) => chips.every((chip) => chip.scrollWidth <= chip.clientWidth));
    expect(mediumChipsFit).toBe(true);

    await page.setViewportSize({ width: 390, height: 844 });
    await expect(uzhorod).toBeVisible();
    await expect(arbuz).toBeVisible();
    const narrowLabels = await page
      .locator('[aria-label$="повідомлень"]')
      .evaluateAll((chips) => chips.map((chip) => chip.getAttribute('aria-label')));
    expect(narrowLabels).toEqual([
      'УЖГОРОД 12 повідомлень',
      'АРБУЗ 8 повідомлень',
      'ДОВГИЙ-ПОЗИВНИЙ-З-ГРУПОЮ-ВАРІАНТІВ 1234 повідомлень',
    ]);
    const chipsFit = await page
      .locator('[aria-label$="повідомлень"]')
      .evaluateAll((chips) => chips.every((chip) => chip.scrollWidth <= chip.clientWidth));
    expect(chipsFit).toBe(true);
    await page.evaluate(() => document.documentElement.setAttribute('data-bs-theme', 'dark'));
    await page.screenshot({ path: testInfo.outputPath('callsigns-wrapping-dark-narrow.png') });
  });

  test('@regression shows callsign load failures in a toast and keeps retry available', async ({
    page,
  }) => {
    let requests = 0;
    await setupAnalysisNeoPage(page);
    await page.route('**/api/rer/analysis/callsigns-page', async (route) => {
      requests += 1;
      if (requests === 1) {
        await route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({ message: 'Помилка завантаження позивних.' }),
        });
        return;
      }
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          entries: [{ value: 'Alpha', label: 'ALPHA', values: ['Alpha'], count: 1 }],
          has_more: false,
          next_cursor: null,
        }),
      });
    });
    await page.goto('/rer-analysis-neo');
    await page.getByRole('button', { name: 'Розгорнути праву панель' }).click();
    await page.getByRole('tab', { name: 'Позивні' }).click();

    await expect(
      page.getByRole('alert').filter({ hasText: 'Помилка завантаження позивних.' }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Повторити' }).click();
    await expect(page.getByRole('button', { name: 'ALPHA 1 повідомлень' })).toBeVisible();
  });

  test('@regression completes empty left callsign searches and matches normalized selections', async ({
    page,
  }) => {
    const requests: Array<{ query?: string }> = [];
    await setupAnalysisNeoPage(page, {
      callsignPageResponse: ({ query }) => {
        requests.push({ query });
        return query === 'alpha'
          ? {
              entries: [{ value: 'Alpha', label: 'ALPHA', values: ['Alpha', 'alpha'], count: 2 }],
              has_more: false,
              next_cursor: null,
            }
          : { entries: [], has_more: false, next_cursor: null };
      },
    });
    await page.goto('/rer-analysis-neo');
    await page.getByRole('button', { name: /^Позивні 0$/ }).click();
    const callsignInput = page.getByRole('combobox', { name: 'Позивні' });

    await callsignInput.fill('none');
    await expect(page.getByText('Завантаження…')).toBeVisible();
    await expect(page.getByText('Немає варіантів')).toBeVisible();

    await callsignInput.press('Control+A');
    await callsignInput.type('alpha');
    await expect.poll(() => requests.some((request) => request.query === 'alpha')).toBe(true);
    const alphaOption = page.getByRole('option', { name: /ALPHA/ });
    await expect(alphaOption).toBeVisible();
    await alphaOption.click();
    await page.keyboard.press('Escape');
    const selectedAlpha = page.locator('.MuiChip-root').filter({ hasText: 'ALPHA' });
    await expect(selectedAlpha).toHaveCount(1);

    await callsignInput.click();
    await expect(alphaOption).toHaveAttribute('aria-selected', 'true');
    await alphaOption.click();
    await page.keyboard.press('Escape');
    await expect(selectedAlpha).toHaveCount(0);
  });

  // Regression: https://github.com/echoua/echo/issues/3452
  test('@regression preserves left callsign search during keyboard pagination', async ({
    page,
  }) => {
    const requests: Array<{ query?: string; cursor?: string | null }> = [];
    await setupAnalysisNeoPage(page, {
      callsignPageResponse: (request) => {
        requests.push(request);
        const index = request.cursor == null ? 0 : Number(request.cursor.slice(1));
        return {
          entries: [
            { value: `left-${index}`, label: `LEFT-${index}`, values: [`left-${index}`], count: 1 },
          ],
          has_more: index < 3,
          next_cursor: index < 3 ? `p${index + 1}` : null,
        };
      },
    });
    await page.goto('/rer-analysis-neo');
    await page.getByRole('button', { name: /^Позивні 0$/ }).click();
    const input = page.getByRole('combobox', { name: 'Позивні' });
    await input.fill('left');
    const next = page.getByRole('button', { name: 'Наступні', exact: true });
    await expect(next).toBeEnabled();
    await next.click();
    await expect.poll(() => requests.at(-1)?.cursor).toBe('p1');
    const first = page.getByRole('button', { name: 'Перша', exact: true });
    await expect(first).toBeEnabled();
    await input.focus();
    for (let index = 0; index < 6; index += 1) {
      await page.keyboard.press('Tab');
      if (await first.evaluate((element) => document.activeElement === element)) break;
    }
    await expect(first).toBeFocused();
    await expect(input).toHaveValue('left');
    await expect(first).toBeEnabled();
    await page.keyboard.press('Enter');
    await expect.poll(() => requests.at(-1)?.cursor).toBeNull();
    await expect(first).toBeDisabled();
    await expect(input).toHaveValue('left');
    expect(requests.map(({ query, cursor }) => ({ query, cursor }))).toEqual([
      { query: 'left', cursor: null },
      { query: 'left', cursor: 'p1' },
      { query: 'left', cursor: null },
    ]);
    await input.click();
    await input.press('Control+A');
    await input.press('Backspace');
    await expect.poll(() => requests.at(-1)?.query).toBe('');
  });

  test('@regression exposes first-page recovery in the left callsign filter after cursor eviction', async ({
    page,
  }) => {
    const requests: Array<{ cursor?: string | null; query?: string }> = [];
    await setupAnalysisNeoPage(page, {
      callsignPageResponse: (request) => {
        requests.push(request);
        const index = request.cursor == null ? 0 : Number(request.cursor.slice(1));
        return {
          entries: [
            {
              value: `left-${index}`,
              label: `LEFT-${index}`,
              values: [`left-${index}`],
              count: 1,
            },
          ],
          has_more: index < 24,
          next_cursor: index < 24 ? `p${index + 1}` : null,
        };
      },
    });
    await page.goto('/rer-analysis-neo');
    await page.getByRole('button', { name: /^Позивні 0$/ }).click();
    const callsignInput = page.getByRole('combobox', { name: 'Позивні' });
    await callsignInput.fill('left');
    await expect.poll(() => requests.filter((request) => request.query === 'left').length).toBe(1);

    const first = page.getByRole('button', { name: 'Перша' });
    const previous = page.getByRole('button', { name: 'Попередні' });
    const next = page.getByRole('button', { name: 'Наступні' });
    for (let index = 1; index <= 21; index += 1) {
      await expect(next).toBeEnabled();
      await next.click();
      await expect
        .poll(() => requests.filter((request) => request.query === 'left').length)
        .toBe(index + 1);
    }
    for (let index = 21; index > 3; index -= 1) {
      await expect(previous).toBeEnabled();
      await previous.click();
      await expect
        .poll(() => requests.filter((request) => request.query === 'left').length)
        .toBe(44 - index);
    }
    await expect(previous).toBeDisabled();
    await expect(first).toBeEnabled();
    await first.click();
    await expect
      .poll(() => {
        const { cursor, query } = requests.at(-1) ?? {};
        return { cursor, query };
      })
      .toEqual({ cursor: null, query: 'left' });
    await expect(first).toBeDisabled();
  });

  test('@regression keeps callsign pagination progress visible at the scrolled footer', async ({
    page,
  }, testInfo) => {
    const firstPage = Array.from({ length: 50 }, (_, index) => ({
      value: `callsign-${index + 1}`,
      label: `CALLSIGN-${index + 1}`,
      values: [`callsign-${index + 1}`],
      count: index + 1,
    }));
    let nextRequestStarted!: () => void;
    const nextRequestStartedPromise = new Promise<void>((resolve) => {
      nextRequestStarted = resolve;
    });
    let releaseNextResponse!: () => void;
    const nextResponsePromise = new Promise<void>((resolve) => {
      releaseNextResponse = resolve;
    });
    let retryRequestStarted!: () => void;
    const retryRequestStartedPromise = new Promise<void>((resolve) => {
      retryRequestStarted = resolve;
    });
    let releaseRetryResponse!: () => void;
    const retryResponsePromise = new Promise<void>((resolve) => {
      releaseRetryResponse = resolve;
    });
    let nextRequests = 0;
    await setupAnalysisNeoPage(page);
    await page.route('**/api/rer/analysis/callsigns-page', async (route) => {
      const { cursor } = route.request().postDataJSON() as { cursor?: string | null };
      if (cursor == null) {
        await route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({ entries: firstPage, has_more: true, next_cursor: 'next-page' }),
        });
        return;
      }
      nextRequests += 1;
      if (nextRequests === 1) {
        nextRequestStarted();
        await nextResponsePromise;
      } else if (nextRequests === 2) {
        await route.fulfill({ status: 500, contentType: 'application/json', body: '{}' });
        return;
      } else {
        retryRequestStarted();
        await retryResponsePromise;
      }
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          entries: [{ value: 'next', label: 'NEXT PAGE', values: ['next'], count: 1 }],
          has_more: false,
          next_cursor: null,
        }),
      });
    });
    await page.goto('/rer-analysis-neo');
    await page.getByRole('button', { name: 'Розгорнути праву панель' }).click();
    await page.getByRole('tab', { name: 'Позивні' }).click();
    await expect(page.getByRole('button', { name: 'CALLSIGN-50 50 повідомлень' })).toBeVisible();

    const sidebar = page.locator('[data-analysis-sidebar-scroll-body]');
    const expectNoFabOverlap = async () => {
      const overlaps = await page
        .getByRole('button', { name: 'Додати повідомлення' })
        .evaluate((fab) => {
          const fabRect = fab.getBoundingClientRect();
          const controls = Array.from(
            document.querySelectorAll<HTMLElement>(
              '[aria-label$="повідомлень"], [aria-label^="Додати CALLSIGN-"], [aria-label="Перша сторінка позивних"], [aria-label="Попередня сторінка позивних"], [aria-label="Наступна сторінка позивних"]',
            ),
          );
          return controls
            .filter((control) => {
              const rect = control.getBoundingClientRect();
              return (
                rect.width > 0 &&
                rect.height > 0 &&
                rect.left < fabRect.right &&
                rect.right > fabRect.left &&
                rect.top < fabRect.bottom &&
                rect.bottom > fabRect.top
              );
            })
            .map((control) => control.getAttribute('aria-label'));
        });
      expect(overlaps).toEqual([]);
    };

    await sidebar.evaluate((element) => {
      element.scrollTop = 0;
    });
    await expectNoFabOverlap();
    await sidebar.evaluate((element) => {
      element.scrollTop = element.scrollHeight / 2;
    });
    await expectNoFabOverlap();
    await sidebar.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    await expectNoFabOverlap();
    const nextButton = page.getByRole('button', { name: 'Наступна сторінка позивних' });
    await expect(nextButton).toBeVisible();
    await nextButton.click();
    await nextRequestStartedPromise;

    const progress = page.getByRole('status', { name: 'Оновлення позивних' });
    await expect(progress).toBeVisible();
    await expect(nextButton).toBeDisabled();
    await expect(page.locator('[aria-label="CALLSIGN-50 50 повідомлень"]')).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    await page.screenshot({ path: testInfo.outputPath('callsigns-pagination-progress.png') });

    releaseNextResponse();
    await expect(page.getByRole('button', { name: 'NEXT PAGE 1 повідомлень' })).toBeVisible();
    await expect(progress).toHaveCount(0);

    await page.getByRole('button', { name: 'Перша сторінка позивних' }).click();
    await expect(page.getByRole('button', { name: 'CALLSIGN-50 50 повідомлень' })).toBeVisible();
    await nextButton.click();
    await expect(
      page.getByText('Не вдалося завантажити наступну сторінку позивних.'),
    ).toBeVisible();
    await expect(progress).toHaveCount(0);
    await page.getByRole('button', { name: 'Повторити' }).click();
    await retryRequestStartedPromise;
    await expect(progress).toBeVisible();
    releaseRetryResponse();
    await expect(page.getByRole('button', { name: 'NEXT PAGE 1 повідомлень' })).toBeVisible();
  });

  test('@regression loads frequency callsign suggestions only after the selector is used', async ({
    page,
  }, testInfo) => {
    let frequencySuggestionRequests = 0;
    await setupAnalysisNeoPage(page, {
      callsignPageResponse: ({ order }) => {
        if (order === 'match_then_name') frequencySuggestionRequests += 1;
        return {
          entries: [{ value: 'alpha', label: 'ALPHA', values: ['alpha'], count: 2 }],
          has_more: false,
          next_cursor: null,
        };
      },
    });
    await page.goto('/rer-analysis-neo');
    await page.getByRole('button', { name: 'Розгорнути праву панель' }).click();
    await page.getByRole('tab', { name: 'Позивні' }).click();

    await expect(page.getByRole('button', { name: 'ALPHA 2 повідомлень' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Частоти за позивними' })).toBeVisible();
    await expect(page.getByText('Знайти частоти зі спільними позивними.')).toBeVisible();
    const selector = page.getByRole('combobox', { name: 'Позивні' });
    await expect(selector).toBeVisible();
    await expect.poll(() => frequencySuggestionRequests).toBe(0);
    await page.screenshot({ path: testInfo.outputPath('callsigns-frequency-expanded.png') });

    await selector.fill('a');
    await expect.poll(() => frequencySuggestionRequests).toBe(1);
    await page.getByRole('button', { name: 'Згорнути Частоти за позивними' }).click();
    await expect(selector).toHaveCount(0);
    await page.getByRole('button', { name: 'Розгорнути Частоти за позивними' }).click();
    await expect(selector).toBeVisible();
  });

  test('@regression discards stale callsign frequency matches after matching inputs change', async ({
    page,
  }) => {
    let matchingRequests = 0;
    let releaseFirstRequest: (() => void) | undefined;
    let firstRequestStarted!: () => void;
    const firstRequestStartedPromise = new Promise<void>((resolve) => {
      firstRequestStarted = resolve;
    });
    let releaseThirdRequest: (() => void) | undefined;
    let thirdRequestStarted!: () => void;
    const thirdRequestStartedPromise = new Promise<void>((resolve) => {
      thirdRequestStarted = resolve;
    });
    await setupAnalysisNeoPage(page, {
      callsignPageResponse: () => ({
        entries: [
          { value: 'alpha', label: 'ALPHA', values: ['alpha'], count: 2 },
          { value: 'bravo', label: 'BRAVO', values: ['bravo'], count: 2 },
        ],
        has_more: false,
        next_cursor: null,
      }),
    });
    await page.route('**/api/rer/analysis/callsign-frequency-matches', async (route) => {
      matchingRequests += 1;
      if (matchingRequests === 1) {
        firstRequestStarted();
        await new Promise<void>((resolve) => {
          releaseFirstRequest = resolve;
        });
      }
      if (matchingRequests === 3) {
        thirdRequestStarted();
        await new Promise<void>((resolve) => {
          releaseThirdRequest = resolve;
        });
      }
      await route.fulfill({
        contentType: 'application/json; charset=utf-8',
        body: JSON.stringify({
          frequencies: [
            { freq: `${matchingRequests}00.00`, callsigns: ['alpha', 'bravo'], message_count: 2 },
          ],
        }),
      });
    });
    await page.goto('/rer-analysis-neo');

    await page.getByRole('button', { name: 'Розгорнути праву панель' }).click();
    await page.getByRole('tab', { name: 'Позивні' }).click();
    const callsignInput = page.getByRole('combobox', { name: 'Позивні' });
    await callsignInput.fill('alpha');
    await page.getByRole('option', { name: 'ALPHA', exact: true }).click();
    await callsignInput.fill('bravo');
    await page.getByRole('option', { name: 'BRAVO', exact: true }).click();

    await page.getByRole('button', { name: 'Знайти', exact: true }).click();
    await firstRequestStartedPromise;
    await page.getByRole('button', { name: 'Збільшити мінімум збігів' }).click();
    releaseFirstRequest?.();
    await expect(page.getByText('100.00', { exact: true })).toHaveCount(0);

    await page.getByRole('button', { name: 'Зменшити мінімум збігів' }).click();
    await page.getByRole('button', { name: 'Знайти', exact: true }).click();
    await expect(page.getByText('200.00', { exact: true })).toBeVisible();

    await page.getByRole('button', { name: 'Знайти', exact: true }).click();
    await thirdRequestStartedPromise;
    await page.getByRole('textbox', { name: 'Пошук', exact: true }).fill('оновлений фільтр');
    releaseThirdRequest?.();
    await expect(page.getByText('300.00', { exact: true })).toHaveCount(0);
  });

  test('analysis neo keeps narrow controls fixed while messages scroll', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 844 });
    await setupAnalysisNeoPage(page, { inboxResponse: createOverflowingInboxResponse() });
    await page.goto('/rer-analysis-neo');

    const messageList = page.locator('section[aria-labelledby] ul').first();
    const messageScrollContainer = messageList.locator('..');
    await expect(messageList.locator('li')).toHaveCount(20);
    await expect
      .poll(() =>
        messageScrollContainer.evaluate((element) => element.scrollHeight > element.clientHeight),
      )
      .toBe(true);

    const tab = page.getByRole('tab', { name: 'Повідомлення' });
    const tabBoxBefore = await tab.boundingBox();
    const card = messageList.locator('li').first();
    const cardBox = await card.boundingBox();
    expect(tabBoxBefore).not.toBeNull();
    expect(cardBox).not.toBeNull();

    const scrollBefore = await messageScrollContainer.evaluate((element) => element.scrollTop);
    const documentScrollBefore = await page.evaluate(
      () => document.scrollingElement?.scrollTop ?? 0,
    );
    await page.mouse.move(cardBox!.x + cardBox!.width / 2, cardBox!.y + cardBox!.height / 2);
    await page.mouse.wheel(0, 600);
    await expect
      .poll(() => messageScrollContainer.evaluate((element) => element.scrollTop))
      .toBeGreaterThan(scrollBefore);

    const tabBoxAfter = await tab.boundingBox();
    const documentScrollAfter = await page.evaluate(
      () => document.scrollingElement?.scrollTop ?? 0,
    );
    expect(tabBoxAfter?.y).toBe(tabBoxBefore!.y);
    expect(documentScrollAfter).toBe(documentScrollBefore);

    const cardBoxes = await messageList.locator('li').evaluateAll((items) =>
      items.map((item) => {
        const box = item.getBoundingClientRect();
        return { left: box.left, right: box.right };
      }),
    );
    expect(cardBoxes.every(({ left, right }) => left >= 0 && right <= 375)).toBe(true);
  });

  test('analysis neo keeps the visible message anchored after creating a message', async ({
    page,
  }) => {
    const initialPage = createOverflowingInboxResponse();
    const refreshedPage = {
      ...initialPage,
      inbox_items: initialPage.inbox_items.map(([id, message], index) => [
        id,
        index === 0
          ? {
              ...message,
              text: Array.from(
                { length: 80 },
                () => 'Creation refresh changes content above the visible message.',
              ).join(' '),
            }
          : message,
      ]),
    } as typeof initialPage;
    let created = false;
    let inboxRequestCount = 0;
    await setupAnalysisNeoPage(page, {
      inboxResponse: initialPage,
      signalGroups: ['editor-e2e-group'],
    });
    await page.route('**/api/rer-importer/get-inbox', async (route) => {
      inboxRequestCount += 1;
      await route.fulfill({
        contentType: 'application/json; charset=utf-8',
        body: JSON.stringify(created ? refreshedPage : initialPage),
      });
    });
    await page.route('**/api/1.1/submit-direct', async (route) => {
      created = true;
      await route.fulfill({
        contentType: 'application/json; charset=utf-8',
        body: JSON.stringify({ signal_message_id: 701 }),
      });
    });
    await page.goto('/rer-analysis-neo');

    const anchor = page.locator('[data-message-id="105"]');
    await expect(anchor).toBeVisible();
    await anchor.evaluate((element) => {
      const container = element.closest('ul')?.parentElement;
      if (container == null) throw new Error('Message scroll container is missing');
      container.scrollTop +=
        element.getBoundingClientRect().top - container.getBoundingClientRect().top - 24;
      container.dispatchEvent(new Event('scroll', { bubbles: true }));
    });
    await page.getByRole('button', { name: 'Додати повідомлення' }).click();
    await page.getByRole('button', { name: 'Закрити ліву панель' }).click();
    await expect(page.getByRole('heading', { name: 'Створити повідомлення' })).toBeVisible();
    const offsetBefore = await anchor.evaluate((element) => {
      const container = element.closest('ul')?.parentElement;
      if (container == null) throw new Error('Message scroll container is missing');
      return Math.round(
        element.getBoundingClientRect().top -
          container.getBoundingClientRect().top -
          container.clientTop,
      );
    });
    await page.getByRole('textbox', { name: 'Текст повідомлення' }).fill('Нове повідомлення');
    await page.getByRole('combobox', { name: 'Група', exact: true }).click();
    await page.getByRole('option', { name: 'editor-e2e-group', exact: true }).click();
    const inboxRequestsBeforeCreate = inboxRequestCount;
    await page.getByRole('button', { name: 'Створити', exact: true }).click();

    await expect(page.getByText('Повідомлення успішно створено.')).toBeVisible();
    await expect.poll(() => inboxRequestCount).toBeGreaterThan(inboxRequestsBeforeCreate);
    await expect
      .poll(() =>
        anchor.evaluate((element) => {
          const container = element.closest('ul')?.parentElement;
          if (container == null) return null;
          return Math.round(
            element.getBoundingClientRect().top -
              container.getBoundingClientRect().top -
              container.clientTop,
          );
        }),
      )
      .toBe(offsetBefore);
  });

  test('analysis neo keeps the visible message anchored after refreshing loaded history', async ({
    page,
  }) => {
    const template = createOverflowingInboxResponse();
    const buildPage = (startId: number) => ({
      ...template,
      inbox_items: template.inbox_items.map(([, message], index) => {
        const id = startId - index;
        return [
          id,
          {
            ...message,
            messageUid: `analysis-refresh-e2e-message-${id}`,
            text: `Analysis refresh fixture message ${id}`,
          },
        ];
      }),
    });
    const newestPage = buildPage(140);
    const olderPage = buildPage(120);
    const refreshedOlderPage = {
      ...olderPage,
      inbox_items: olderPage.inbox_items.map(([id, message], index) => [
        id,
        index === 0
          ? {
              ...message,
              text: 'Refreshed older analysis message',
            }
          : message,
      ]),
    } as typeof olderPage;
    let olderPageRequestCount = 0;
    await setupAnalysisNeoPage(page, { inboxResponse: newestPage });
    await page.route('**/api/rer-importer/get-inbox', async (route) => {
      const body = route.request().postDataJSON() as {
        before_id_noninclusive?: number | null;
      };
      if (body.before_id_noninclusive != null) olderPageRequestCount += 1;
      const response =
        body.before_id_noninclusive == null
          ? newestPage
          : olderPageRequestCount > 1
            ? refreshedOlderPage
            : olderPage;
      await route.fulfill({
        contentType: 'application/json; charset=utf-8',
        body: JSON.stringify(response),
      });
    });
    await page.goto('/rer-analysis-neo');

    const messageList = page.locator('section[aria-labelledby] ul').first();
    const scrollContainer = messageList.locator('..');
    await scrollContainer.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
      element.dispatchEvent(new Event('scroll', { bubbles: true }));
    });
    await expect(messageList.locator('li')).toHaveCount(40);

    const anchor = page.locator('[data-message-id="122"]');
    await expect(anchor).toBeVisible();
    await anchor.evaluate((element) => {
      const container = element.closest('ul')?.parentElement;
      if (container == null) throw new Error('Message scroll container is missing');
      container.scrollTop +=
        element.getBoundingClientRect().top - container.getBoundingClientRect().top - 24;
      container.dispatchEvent(new Event('scroll', { bubbles: true }));
    });
    const offsetBefore = await anchor.evaluate((element) => {
      const container = element.closest('ul')?.parentElement;
      if (container == null) throw new Error('Message scroll container is missing');
      return Math.round(
        element.getBoundingClientRect().top -
          container.getBoundingClientRect().top -
          container.clientTop,
      );
    });

    await page.getByRole('button', { name: 'Оновити' }).click();

    await expect(page.getByText('Refreshed older analysis message', { exact: true })).toBeVisible();
    await expect(anchor).toBeVisible();
    await expect
      .poll(() =>
        anchor.evaluate((element) => {
          const container = element.closest('ul')?.parentElement;
          if (container == null) return null;
          return Math.round(
            element.getBoundingClientRect().top -
              container.getBoundingClientRect().top -
              container.clientTop,
          );
        }),
      )
      .toBe(offsetBefore);
  });

  // Regression: https://github.com/echoua/echo/issues/3694
  test('analysis neo shows a newly prepended message after refreshing at the top', async ({
    page,
  }) => {
    const initialPage = createOverflowingInboxResponse();
    const [, template] = initialPage.inbox_items[0];
    const newMessageId = 1000;
    const refreshedPage = {
      ...initialPage,
      inbox_items: [
        [
          newMessageId,
          {
            ...template,
            messageUid: 'analysis-refresh-e2e-new-message',
            text: 'Newly received analysis message',
          },
        ],
        ...initialPage.inbox_items,
      ],
    } as typeof initialPage;
    let refreshRequested = false;
    await setupAnalysisNeoPage(page, { inboxResponse: initialPage });
    await page.route('**/api/rer-importer/get-inbox', async (route) => {
      await route.fulfill({
        contentType: 'application/json; charset=utf-8',
        body: JSON.stringify(refreshRequested ? refreshedPage : initialPage),
      });
    });
    await page.goto('/rer-analysis-neo');

    const messageList = page.locator('section[aria-labelledby] ul').first();
    const scrollContainer = messageList.locator('..');
    await expect(messageList.locator('li')).toHaveCount(20);
    await expect.poll(() => scrollContainer.evaluate((element) => element.scrollTop)).toBe(0);

    refreshRequested = true;
    await page.getByRole('button', { name: 'Оновити', exact: true }).click();

    const newMessage = page.locator(`[data-message-id="${newMessageId}"]`);
    await expect(newMessage).toBeAttached();
    await expect(newMessage).toBeInViewport();
    await expect.poll(() => scrollContainer.evaluate((element) => element.scrollTop)).toBe(0);
  });

  // Regressions: https://github.com/echoua/echo/issues/3694, https://github.com/echoua/echo/issues/3780
  test('analysis neo handles a sustained mixed realtime stream without reloading', async ({
    page,
  }) => {
    test.setTimeout(60_000);
    await page.clock.setFixedTime(new Date('2026-07-13T13:00:00Z'));
    const initialPage = createOverflowingInboxResponse();
    const [, template] = initialPage.inbox_items[0];
    const anchorMessage = initialPage.inbox_items.find(([messageId]) => messageId === 105)?.[1];
    if (anchorMessage == null) throw new Error('Analysis anchor fixture message is missing');
    const previewHref = '/test-assets/analysis-realtime-anchor.svg';
    Object.assign(anchorMessage, {
      media: [
        {
          id: 'analysis-realtime-anchor-image',
          contentType: 'image/svg+xml',
          fileName: 'analysis-realtime-anchor.svg',
          sizeBytes: 128,
          href: previewHref,
          transcription: null,
          ocr: null,
          summary: null,
          kmzConversionStatus: null,
          positions: [],
        },
      ],
      images: [previewHref],
    });
    const serverMessages = new Map(initialPage.inbox_items);
    const newMessages = new Map(
      [1000, 1001, 1002, 1003].map(
        (messageId, index) =>
          [
            messageId,
            {
              ...template,
              messageUid: `analysis-realtime-e2e-new-message-${index + 1}`,
              text: `Realtime analysis message ${index + 1}`,
              date: '13.07.2026',
              time: `12:3${5 + index}`,
              timestamp: Date.parse('2026-07-13T09:35:00Z') + index * 1_000,
            },
          ] as const,
      ),
    );
    const updatedMessages = new Map(
      [105, 106, 107].map((messageId) => {
        const message = serverMessages.get(messageId);
        if (message == null) throw new Error(`Analysis fixture message ${messageId} is missing`);
        return [
          messageId,
          { ...message, text: `Updated visible analysis message ${messageId}` },
        ] as const;
      }),
    );
    const realtimeMessageIds = [1000, 105, 9001, 1001, 106, 1002, 110, 1003, 9002, 107];
    let releasedEventCount = 0;
    let deliveredEventCount = 0;
    let lastEventId: string | null = null;
    let messageLookupCount = 0;
    let postEventInboxRequestCount = 0;
    let inboxCountRequestCount = 0;
    const targetedMessageRequests: number[][] = [];
    await setupAnalysisNeoPage(page, { inboxResponse: initialPage });
    await page.route('**/api/rer-importer/get-inbox', async (route) => {
      if (deliveredEventCount > 0) {
        postEventInboxRequestCount += 1;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      await route.fulfill({
        contentType: 'application/json; charset=utf-8',
        body: JSON.stringify({
          ...initialPage,
          inbox_items: Array.from(serverMessages.entries()),
        }),
      });
    });
    await page.route('**/api/rer-importer/get-inbox-count', async (route) => {
      inboxCountRequestCount += 1;
      await route.fulfill({
        contentType: 'application/json; charset=utf-8',
        body: JSON.stringify({
          quantity: serverMessages.size,
          first_element_ts: null,
        }),
      });
    });
    await page.route('**/api/rer-importer/messages-by-id-matching-filters', async (route) => {
      messageLookupCount += 1;
      const body = route.request().postDataJSON() as { message_ids?: number[] };
      const messageIds = body.message_ids ?? [];
      targetedMessageRequests.push(messageIds);
      const messages = messageIds.flatMap((messageId) => {
        const message = serverMessages.get(messageId);
        return message == null ? [] : [[messageId, message]];
      });
      await route.fulfill({
        contentType: 'application/json; charset=utf-8',
        body: JSON.stringify({ messages }),
      });
    });
    await page.route('**/api/event-stream/long-poll', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 250));
      let events: unknown[] = [];
      const messageId =
        deliveredEventCount < releasedEventCount
          ? realtimeMessageIds[deliveredEventCount]
          : undefined;
      if (messageId != null) {
        const newMessage = newMessages.get(messageId);
        const updatedMessage = updatedMessages.get(messageId);
        if (newMessage != null) serverMessages.set(messageId, newMessage);
        if (updatedMessage != null) serverMessages.set(messageId, updatedMessage);
        if (messageId === 110) serverMessages.delete(messageId);
        deliveredEventCount += 1;
        lastEventId = `analysis-realtime-e2e-event-${deliveredEventCount}`;
        events = [
          {
            id: lastEventId,
            event_type: { ETInboxChanged: messageId },
            created_at: Date.now(),
            origin: null,
            intelligence_report: false,
          },
        ];
      }
      await route.fulfill({
        contentType: 'application/json; charset=utf-8',
        body: JSON.stringify({
          events,
          last_event_id: lastEventId,
        }),
      });
    });
    await page.route(`**${previewHref}`, async (route) => {
      await route.fulfill({
        contentType: 'image/svg+xml',
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"><rect width="2" height="2" fill="navy"/></svg>',
      });
    });
    await page.goto('/rer-analysis-neo?search=Analysis');

    const messageList = page.locator('section[aria-labelledby] ul').first();
    await expect(messageList.locator('[data-message-id]')).toHaveCount(20);
    const messageCountStatus = page
      .locator('[role="status"]')
      .filter({ hasText: /^\d+ з \d+$|^— з —$/ })
      .first();
    await expect(messageCountStatus).toHaveText('20 з 20');
    await page.waitForTimeout(400);
    const inboxCountRequestsBeforeEvent = inboxCountRequestCount;
    const anchor = page.locator('[data-message-id="105"]');
    await expect(anchor).toContainText('Analysis narrow fixture message 4');
    await anchor.evaluate((element) => {
      const container = element.closest('ul')?.parentElement;
      if (container == null) throw new Error('Message scroll container is missing');
      container.scrollTop +=
        element.getBoundingClientRect().top - container.getBoundingClientRect().top - 24;
      container.dispatchEvent(new Event('scroll', { bubbles: true }));
    });
    const anchorOffset = () =>
      anchor.evaluate((element) => {
        const container = element.closest('ul')?.parentElement;
        if (container == null) throw new Error('Message scroll container is missing');
        return Math.round(
          element.getBoundingClientRect().top -
            container.getBoundingClientRect().top -
            container.clientTop,
        );
      });
    await anchor.getByRole('button', { name: 'Розгорнути медіа: 1' }).click();
    await anchor.getByRole('button', { name: 'Відкрити зображення' }).click();
    const previewDialog = page.getByRole('dialog', { name: 'Перегляд зображення' });
    await expect(previewDialog).toBeVisible();
    const offsetBefore = await anchorOffset();
    await page.evaluate(() => {
      const observedWindow = window as typeof window & {
        __analysisCountPlaceholderObserver?: MutationObserver;
        __analysisCountPlaceholderSeen?: boolean;
        __analysisRealtimeSkeletonSeen?: boolean;
        __analysisRealtimeSkeletonObserver?: MutationObserver;
      };
      const messageCountStatus = Array.from(document.querySelectorAll('[role="status"]')).find(
        (element) => element.textContent?.trim() === '20 з 20',
      );
      if (messageCountStatus == null) throw new Error('Analysis message count status is missing');
      observedWindow.__analysisCountPlaceholderSeen = false;
      observedWindow.__analysisCountPlaceholderObserver?.disconnect();
      const markCountPlaceholder = () => {
        if (messageCountStatus.textContent?.trim() === '— з —') {
          observedWindow.__analysisCountPlaceholderSeen = true;
        }
      };
      observedWindow.__analysisCountPlaceholderObserver = new MutationObserver(
        markCountPlaceholder,
      );
      observedWindow.__analysisCountPlaceholderObserver.observe(messageCountStatus, {
        characterData: true,
        childList: true,
        subtree: true,
      });
      observedWindow.__analysisRealtimeSkeletonSeen = false;
      observedWindow.__analysisRealtimeSkeletonObserver?.disconnect();
      const markFullCenterSkeleton = () => {
        if (
          document.querySelector('section[aria-label="Центральна секція"][aria-disabled="true"]') !=
          null
        ) {
          observedWindow.__analysisRealtimeSkeletonSeen = true;
        }
      };
      observedWindow.__analysisRealtimeSkeletonObserver = new MutationObserver(
        markFullCenterSkeleton,
      );
      observedWindow.__analysisRealtimeSkeletonObserver.observe(document.body, {
        childList: true,
        subtree: true,
      });
      markFullCenterSkeleton();
    });

    const messageLookupsBeforeEvent = messageLookupCount;
    releasedEventCount = 1;
    await expect.poll(() => deliveredEventCount).toBe(1);
    await expect.poll(() => messageLookupCount).toBe(messageLookupsBeforeEvent + 1);

    const receivedMessage = page.locator('[data-message-id="1000"]');
    await expect(receivedMessage).toContainText('Realtime analysis message 1');
    await expect(messageList.locator('[data-message-id]')).toHaveCount(21);
    await expect.poll(() => inboxCountRequestCount).toBe(inboxCountRequestsBeforeEvent + 2);
    await expect(messageCountStatus).toHaveText('21 з 21');
    await expect(anchor).toContainText('Analysis narrow fixture message 4');
    await expect
      .poll(async () => ({
        anchorOffset: await anchorOffset(),
        countPlaceholderSeen: await page.evaluate(
          () =>
            (
              window as typeof window & {
                __analysisCountPlaceholderSeen?: boolean;
              }
            ).__analysisCountPlaceholderSeen ?? false,
        ),
        fullCenterSkeletonSeen: await page.evaluate(
          () =>
            (
              window as typeof window & {
                __analysisRealtimeSkeletonSeen?: boolean;
              }
            ).__analysisRealtimeSkeletonSeen ?? false,
        ),
        inboxCountRequestCount,
        postEventInboxRequestCount,
        previewOpen: await previewDialog.isVisible(),
        targetedMessageRequests,
      }))
      .toEqual({
        anchorOffset: offsetBefore,
        countPlaceholderSeen: false,
        fullCenterSkeletonSeen: false,
        inboxCountRequestCount: inboxCountRequestsBeforeEvent + 2,
        postEventInboxRequestCount: 0,
        previewOpen: true,
        targetedMessageRequests: [[1000]],
      });

    releasedEventCount = 2;
    await expect.poll(() => deliveredEventCount).toBe(2);
    await expect.poll(() => messageLookupCount).toBe(messageLookupsBeforeEvent + 2);
    await expect(anchor).toContainText('Updated visible analysis message 105');
    await page.waitForTimeout(5_200);
    expect(inboxCountRequestCount).toBe(inboxCountRequestsBeforeEvent + 2);
    await expect(messageCountStatus).toHaveText('21 з 21');

    releasedEventCount = realtimeMessageIds.length;
    await expect.poll(() => deliveredEventCount).toBe(realtimeMessageIds.length);
    await expect.poll(() => messageLookupCount).toBe(messageLookupsBeforeEvent + 10);
    await expect(page.locator('[data-message-id="1001"]')).toContainText(
      'Realtime analysis message 2',
    );
    await expect(page.locator('[data-message-id="1002"]')).toContainText(
      'Realtime analysis message 3',
    );
    await expect(page.locator('[data-message-id="1003"]')).toContainText(
      'Realtime analysis message 4',
    );
    await expect(page.locator('[data-message-id="106"]')).toContainText(
      'Updated visible analysis message 106',
    );
    await expect(page.locator('[data-message-id="107"]')).toContainText(
      'Updated visible analysis message 107',
    );
    await expect(page.locator('[data-message-id="110"]')).toHaveCount(0);
    await expect(page.locator('[data-message-id="9001"]')).toHaveCount(0);
    await expect(page.locator('[data-message-id="9002"]')).toHaveCount(0);
    await expect(messageList.locator('[data-message-id]')).toHaveCount(23);
    await expect(messageCountStatus).toHaveText('23 з 23', { timeout: 10_000 });
    await expect
      .poll(() => inboxCountRequestCount, { timeout: 10_000 })
      .toBe(inboxCountRequestsBeforeEvent + 6);
    await page.waitForTimeout(5_200);
    expect(inboxCountRequestCount).toBe(inboxCountRequestsBeforeEvent + 6);
    expect(targetedMessageRequests).toEqual(realtimeMessageIds.map((messageId) => [messageId]));
    await expect
      .poll(async () => ({
        anchorOffset: await anchorOffset(),
        countPlaceholderSeen: await page.evaluate(
          () =>
            (
              window as typeof window & {
                __analysisCountPlaceholderSeen?: boolean;
              }
            ).__analysisCountPlaceholderSeen ?? false,
        ),
        fullCenterSkeletonSeen: await page.evaluate(
          () =>
            (
              window as typeof window & {
                __analysisRealtimeSkeletonSeen?: boolean;
              }
            ).__analysisRealtimeSkeletonSeen ?? false,
        ),
        postEventInboxRequestCount,
        previewOpen: await previewDialog.isVisible(),
      }))
      .toEqual({
        anchorOffset: offsetBefore,
        countPlaceholderSeen: false,
        fullCenterSkeletonSeen: false,
        postEventInboxRequestCount: 0,
        previewOpen: true,
      });
    await page.evaluate(() => {
      (
        window as typeof window & {
          __analysisCountPlaceholderObserver?: MutationObserver;
          __analysisRealtimeSkeletonObserver?: MutationObserver;
        }
      ).__analysisCountPlaceholderObserver?.disconnect();
      (
        window as typeof window & {
          __analysisRealtimeSkeletonObserver?: MutationObserver;
        }
      ).__analysisRealtimeSkeletonObserver?.disconnect();
    });
  });

  // Regression: https://github.com/echoua/echo/issues/3694
  test('@regression analysis neo ignores repeated realtime events rejected by its filters', async ({
    page,
  }) => {
    const initialPage = createLoadedInboxResponse();
    const eventMessageIds = [9001, 9002, 9003, 9004, 9005];
    const targetedMessageRequests: number[][] = [];
    let releaseInboxChangedEvents = false;
    let deliveredEventCount = 0;
    let inboxRequestCount = 0;
    let inboxCountRequestCount = 0;

    await setupAnalysisNeoPage(page, { inboxResponse: initialPage });
    await page.route('**/api/rer-importer/get-inbox', async (route) => {
      inboxRequestCount += 1;
      await route.fulfill({
        contentType: 'application/json; charset=utf-8',
        body: JSON.stringify(initialPage),
      });
    });
    await page.route('**/api/rer-importer/get-inbox-count', async (route) => {
      inboxCountRequestCount += 1;
      await route.fulfill({
        contentType: 'application/json; charset=utf-8',
        body: JSON.stringify({ quantity: initialPage.inbox_items.length, first_element_ts: null }),
      });
    });
    await page.route('**/api/rer-importer/messages-by-id-matching-filters', async (route) => {
      const body = route.request().postDataJSON() as { message_ids?: number[] };
      targetedMessageRequests.push(body.message_ids ?? []);
      await route.fulfill({
        contentType: 'application/json; charset=utf-8',
        body: JSON.stringify({ messages: [] }),
      });
    });
    await page.route('**/api/event-stream/long-poll', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 550));
      const messageId = releaseInboxChangedEvents
        ? eventMessageIds[deliveredEventCount]
        : undefined;
      const eventId = messageId == null ? null : `analysis-prod-storm-${deliveredEventCount + 1}`;
      if (messageId != null) deliveredEventCount += 1;
      await route.fulfill({
        contentType: 'application/json; charset=utf-8',
        body: JSON.stringify({
          events:
            messageId == null
              ? []
              : [
                  {
                    id: eventId,
                    event_type: { ETInboxChanged: messageId },
                    created_at: Date.now(),
                    origin: null,
                    intelligence_report: false,
                  },
                ],
          last_event_id: eventId,
        }),
      });
    });
    await page.goto('/rer-analysis-neo?search=needle');

    await expect(page.locator('[data-message-id="101"]')).toContainText(
      'Analysis summary fixture message',
    );
    await expect.poll(() => inboxCountRequestCount).toBeGreaterThan(0);
    await page.waitForTimeout(400);
    const inboxRequestsBeforeEvents = inboxRequestCount;
    const inboxCountRequestsBeforeEvents = inboxCountRequestCount;

    releaseInboxChangedEvents = true;
    await expect.poll(() => deliveredEventCount).toBe(eventMessageIds.length);
    await expect.poll(() => targetedMessageRequests.length).toBe(eventMessageIds.length);
    await page.waitForTimeout(400);

    expect(targetedMessageRequests).toEqual(eventMessageIds.map((messageId) => [messageId]));
    expect(inboxRequestCount).toBe(inboxRequestsBeforeEvents);
    expect(inboxCountRequestCount).toBe(inboxCountRequestsBeforeEvents);
    await expect
      .poll(() => inboxCountRequestCount, { timeout: 10_000 })
      .toBe(inboxCountRequestsBeforeEvents + 2);
    await page.waitForTimeout(400);
    expect(inboxCountRequestCount).toBe(inboxCountRequestsBeforeEvents + 2);
    await expect(page.locator('[data-message-id]')).toHaveCount(initialPage.inbox_items.length);
  });

  test('analysis neo keeps the compact panel toggle available during initial loading', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 375, height: 844 });
    await setupAnalysisNeoPage(page, {
      inboxDelayMs: 2000,
      inboxResponse: createLoadedInboxResponse(),
    });
    await page.goto('/rer-analysis-neo');

    await expect(page.getByRole('region', { name: 'Центральна секція' })).toBeVisible();
    const expandButton = page.getByRole('button', { name: 'Розгорнути праву панель' });
    await expect(expandButton).toBeVisible();
    await expandButton.click();

    const collapseButton = page.getByRole('button', { name: 'Закрити праву панель' });
    await expect(collapseButton).toBeVisible();
    await collapseButton.click();
    await expect(page.getByRole('button', { name: 'Розгорнути праву панель' })).toBeVisible();
  });

  test('analysis neo keeps the narrow right-panel header fixed', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 844 });
    await setupAnalysisNeoPage(page, { inboxResponse: createLoadedInboxResponse() });
    await page.goto('/rer-analysis-neo');

    const expandButton = page.getByRole('button', { name: 'Розгорнути праву панель' });
    await expandButton.click();

    const panel = page.locator('[data-analysis-right-panel]');
    const firstTab = panel.getByRole('tab').first();
    const collapseButton = page.getByRole('button', { name: 'Закрити праву панель' });
    const body = panel.locator('[data-analysis-sidebar-scroll-body]');
    await expect(panel).toBeVisible();
    await expect(collapseButton).toBeVisible();

    const metrics = await Promise.all([
      firstTab.boundingBox(),
      collapseButton.boundingBox(),
      panel.boundingBox(),
      body.evaluate((element) => {
        const style = getComputedStyle(element);
        return {
          height: element.clientHeight,
          overflowY: style.overflowY,
          overflowX: style.overflowX,
          scrollHeight: element.scrollHeight,
        };
      }),
    ]);
    expect(metrics[0]).not.toBeNull();
    expect(metrics[1]).not.toBeNull();
    expect(metrics[2]).not.toBeNull();
    expect(metrics[1]!.y + metrics[1]!.height).toBeLessThanOrEqual(metrics[0]!.y);
    expect(metrics[2]!.height).toBeGreaterThan(0);
    expect(metrics[3]).toEqual({
      height: expect.any(Number),
      overflowY: 'auto',
      overflowX: 'hidden',
      scrollHeight: expect.any(Number),
    });

    const closeButtonY = metrics[1]!.y;
    await body.evaluate((element) => {
      element.scrollTop = 100;
    });
    await expect
      .poll(async () => (await collapseButton.boundingBox())?.y)
      .toBeCloseTo(closeButtonY, 0);

    await collapseButton.click();
    await expect(page.getByRole('button', { name: 'Розгорнути праву панель' })).toBeVisible();
  });

  test('analysis neo expands phone map search and date controls without overflow', async ({
    page,
  }) => {
    for (const width of [375, 320]) {
      await page.setViewportSize({ width, height: 844 });
      await setupAnalysisNeoPage(page, { inboxResponse: createLoadedInboxResponse() });
      await page.goto('/rer-analysis-neo');
      await page.getByRole('tab', { name: 'Мапа' }).click();

      const map = page.locator('#analysis-map');
      const searchControl = map.locator('.narrow-map-search-control');
      const dateControl = map.locator('.narrow-map-date-control');
      await expect(searchControl).toHaveClass(/narrow-map-control--collapsed/);
      await expect(dateControl).toHaveClass(/narrow-map-control--collapsed/);
      expect(await searchControl.boundingBox()).toMatchObject({ width: 48, height: 48 });
      expect(await dateControl.boundingBox()).toMatchObject({ width: 48, height: 48 });

      await searchControl.getByRole('button', { name: 'Розгорнути пошук на мапі' }).click();
      await expect(searchControl).not.toHaveClass(/narrow-map-control--collapsed/);
      await expect(dateControl).toBeHidden();
      const expandedSearchBox = await searchControl.boundingBox();
      expect(expandedSearchBox).not.toBeNull();
      expect(expandedSearchBox!.x).toBeGreaterThanOrEqual(0);
      expect(expandedSearchBox!.x + expandedSearchBox!.width).toBeLessThanOrEqual(width);

      await map.dispatchEvent('click');
      await expect(searchControl).toHaveClass(/narrow-map-control--collapsed/);
      await expect(dateControl).toHaveClass(/narrow-map-control--collapsed/);

      await dateControl.getByRole('button', { name: 'Розгорнути діапазон дат на мапі' }).click();
      await expect(dateControl).not.toHaveClass(/narrow-map-control--collapsed/);
      await expect(searchControl).toBeHidden();
      const expandedDateBox = await dateControl.boundingBox();
      expect(expandedDateBox).not.toBeNull();
      expect(expandedDateBox!.x).toBeGreaterThanOrEqual(0);
      expect(expandedDateBox!.x + expandedDateBox!.width).toBeLessThanOrEqual(width);

      await map.dispatchEvent('click');
      await expect(searchControl).toHaveClass(/narrow-map-control--collapsed/);
      await expect(dateControl).toHaveClass(/narrow-map-control--collapsed/);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
        width,
      );
    }
  });

  test('analysis neo synchronizes map controls across viewport transitions', async ({ page }) => {
    await page.setViewportSize({ width: 900, height: 844 });
    await setupAnalysisNeoPage(page, { inboxResponse: createLoadedInboxResponse() });
    await page.goto('/rer-analysis-neo');
    await page.getByRole('tab', { name: 'Мапа' }).click();

    const map = page.locator('#analysis-map');
    const searchControl = map.locator('.narrow-map-search-control');
    const dateControl = map.locator('.narrow-map-date-control');
    await expect(searchControl).not.toHaveClass(/narrow-map-control--collapsed/);
    await expect(dateControl).not.toHaveClass(/narrow-map-control--collapsed/);

    await page.setViewportSize({ width: 375, height: 844 });
    await expect(searchControl).toHaveClass(/narrow-map-control--collapsed/);
    await expect(dateControl).toHaveClass(/narrow-map-control--collapsed/);
    expect(await searchControl.boundingBox()).toMatchObject({ width: 48, height: 48 });
    expect(await dateControl.boundingBox()).toMatchObject({ width: 48, height: 48 });

    await page.setViewportSize({ width: 900, height: 844 });
    await expect(searchControl).not.toHaveClass(/narrow-map-control--collapsed/);
    await expect(dateControl).not.toHaveClass(/narrow-map-control--collapsed/);

    await page.setViewportSize({ width: 375, height: 844 });
    await expect(searchControl).toHaveClass(/narrow-map-control--collapsed/);
    await expect(dateControl).toHaveClass(/narrow-map-control--collapsed/);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      375,
    );
  });

  test('analysis neo updates summary page-size controls across phone resize', async ({ page }) => {
    await page.setViewportSize({ width: 844, height: 844 });
    await setupAnalysisNeoPage(page, { inboxResponse: createLoadedInboxResponse() });
    await page.goto('/rer-analysis-neo');
    await page.getByRole('tab', { name: 'Зведена таблиця' }).click();

    const rowsPerPageSelect = page.getByText('Рядків на сторінці:', { exact: true });
    await expect(rowsPerPageSelect).toBeVisible();

    await page.setViewportSize({ width: 390, height: 844 });
    await expect(rowsPerPageSelect).toBeHidden();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      390,
    );

    await page.setViewportSize({ width: 844, height: 844 });
    await expect(rowsPerPageSelect).toBeVisible();
  });
});
