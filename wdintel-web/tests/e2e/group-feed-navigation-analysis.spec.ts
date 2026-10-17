import { expect, test, type Page } from '@playwright/test';

import type { InboxMessage } from '../../src/Bindings';
import type { InboxMessagesRspRaw } from '../../src/ts/react/services/api/inbox-messages';
import { minimalInboxMessage } from '../../src/ts/react/routes/rer-duty-neo/inbox-message-mocks';
import { installAnalysisNeoApiMocks } from './analysis-neo.fixtures';

const groups = [
  { masterKey: 'group-a', name: 'Group Alpha', unreadCount: 2, colorKey: 'blue' },
  { masterKey: 'group-b', name: 'Group Beta', unreadCount: 3, colorKey: 'deep_purple' },
];

function message(id: number, groupMasterKey: string, text: string): InboxMessage {
  return minimalInboxMessage({
    messageUid: `analysis-group-feed-${id}`,
    text,
    timestamp: 1_720_000_000_000 + id * 1_000,
    createdAt: 1_720_000_000_000 + id * 1_000,
    groupMasterKey,
  });
}

function inboxResponse(selectedGroups: string[] | null): InboxMessagesRspRaw {
  const selected = selectedGroups ?? groups.map(({ masterKey }) => masterKey);
  const inboxItems = [
    selected.includes('group-a') ? [101, message(101, 'group-a', 'Analysis Alpha message')] : null,
    selected.includes('group-b') ? [201, message(201, 'group-b', 'Analysis Beta message')] : null,
  ].filter((item): item is [number, InboxMessage] => item !== null);
  return {
    inbox_items: inboxItems as InboxMessagesRspRaw['inbox_items'],
    callsigns: [],
    signal_profiles: {},
    signal_groups: [],
    freq_pelengs_summary: null,
    page_limit: 20,
  };
}

async function installGroupNavigationMocks(
  page: Page,
  options: {
    beforeInboxFulfill?: (request: { selected_groups?: string[] | null }) => Promise<void>;
  } = {},
) {
  await installAnalysisNeoApiMocks(page, {
    signalGroups: groups.map(({ masterKey }) => masterKey),
    inboxResponse: inboxResponse(null),
  });
  const inboxRequests: Array<{ selected_groups?: string[] | null }> = [];
  await page.route('**/api/rer-importer/get-inbox', async (route) => {
    const request = route.request().postDataJSON() as { selected_groups?: string[] | null };
    inboxRequests.push(request);
    await options.beforeInboxFulfill?.(request);
    return route.fulfill({ json: inboxResponse(request.selected_groups ?? null) });
  });
  await page.route('**/api/rer-importer/get-inbox-count', (route) => {
    const request = route.request().postDataJSON() as { selected_groups?: string[] | null };
    return route.fulfill({
      json: {
        quantity: inboxResponse(request.selected_groups ?? null).inbox_items.length,
        first_element_ts: null,
      },
    });
  });
  let stateRequestCount = 0;
  await page.route('**/api/rer-importer/group-feed-state', (route) => {
    stateRequestCount += 1;
    return route.fulfill({
      json: {
        groups: groups.map((group, index) => ({
          master_key: group.masterKey,
          name: group.name,
          color_key: group.colorKey,
          ignore_operativny: false,
          unread_count: group.unreadCount,
          oldest_unread_message_ref: null,
          last_activity_at: 1_720_000_100_000 - index,
          latest_cursor: null,
        })),
      },
    });
  });
  return { inboxRequests, getStateRequestCount: () => stateRequestCount };
}

test.describe('Analysis group feed navigation', () => {
  test('separates the map from the tab bar with the content spacing', async ({ page }) => {
    await page.setViewportSize({ width: 1234, height: 877 });
    await installGroupNavigationMocks(page);
    await page.goto('/rer-analysis-neo');

    await page.getByRole('tab', { name: 'Мапа', exact: true }).click();

    await expect(page.getByRole('tabpanel', { name: 'Мапа' })).toHaveCSS('padding-top', '8px');
  });

  test('keeps group navigation visible beside contextual filters', async ({ page }) => {
    await page.setViewportSize({ width: 1234, height: 877 });
    await installGroupNavigationMocks(page);
    await page.goto('/rer-analysis-neo?groups=group-a');

    const groupNavigation = page.getByRole('complementary', { name: 'Навігація груп' });
    await expect(groupNavigation).toBeVisible();
    const selectedGroup = groupNavigation.locator('[data-group-list-item][data-selected="true"]');
    const selectedVisual = await selectedGroup.evaluate((element) => {
      const style = getComputedStyle(element);
      const markerStyle = getComputedStyle(element, '::before');
      const primaryProbe = document.createElement('span');
      primaryProbe.style.color = 'var(--echo-color-primary)';
      element.append(primaryProbe);
      const primaryColor = getComputedStyle(primaryProbe).color;
      primaryProbe.remove();
      return {
        backgroundColor: style.backgroundColor,
        borderColor: style.borderColor,
        markerBackgroundColor: markerStyle.backgroundColor,
        markerHeight: markerStyle.height,
        markerWidth: markerStyle.width,
        primaryColor,
      };
    });
    expect(selectedVisual.borderColor).toBe('rgba(0, 0, 0, 0)');
    expect(selectedVisual.backgroundColor).not.toBe(selectedVisual.primaryColor);
    expect(selectedVisual.markerBackgroundColor).toBe(selectedVisual.primaryColor);
    expect(selectedVisual.markerWidth).toBe('3px');
    expect(selectedVisual.markerHeight).toBe('24px');
    await expect(groupNavigation).toHaveCSS('border-right-width', '1px');
    await expect(groupNavigation).toHaveCSS('border-right-style', 'solid');
    expect((await groupNavigation.boundingBox())?.width).toBeLessThan(400);
    const workspaceBox = await page.locator('[data-analysis-workspace]').boundingBox();
    expect((await groupNavigation.boundingBox())?.height).toBe(workspaceBox?.height);
    await expect(groupNavigation.locator('[data-analysis-filters-scroll-container]')).toHaveCount(
      0,
    );
    const groupAvatars = groupNavigation.locator(
      '[data-group-list-item]:not([aria-label^="Всі групи"]) [data-group-avatar]',
    );
    await expect(groupAvatars).toHaveCount(2);
    expect(
      await groupAvatars.nth(0).evaluate((avatar) => getComputedStyle(avatar).backgroundColor),
    ).not.toBe(
      await groupAvatars.nth(1).evaluate((avatar) => getComputedStyle(avatar).backgroundColor),
    );

    const filterToggle = page.locator('[data-analysis-filter-toggle]');
    await expect(filterToggle).toHaveAttribute('aria-label', 'Фільтри, активних розділів: 1');
    await filterToggle.click();

    const filterPanel = page.locator('[data-analysis-filter-panel]:visible');
    await expect(filterPanel).toBeVisible();
    await expect(page.locator('[data-analysis-filter-transition]')).toHaveCSS('width', '336px');
    const groupNavigationBackground = await groupNavigation.evaluate((element) => {
      let current: Element | null = element;
      while (current !== null) {
        const backgroundColor = getComputedStyle(current).backgroundColor;
        if (backgroundColor !== 'rgba(0, 0, 0, 0)' && backgroundColor !== 'transparent') {
          return backgroundColor;
        }
        current = current.parentElement;
      }
      return getComputedStyle(document.body).backgroundColor;
    });
    await expect(filterPanel).toHaveCSS('background-color', groupNavigationBackground);
    await expect(filterPanel.getByRole('button', { name: 'Закрити фільтри' })).toHaveCount(0);
    await expect(filterPanel.getByText(/^Для:/)).toHaveCount(0);
    await expect(filterPanel.locator('[data-section-id="Групи"]')).toBeVisible();
    const groupNavigationBox = await groupNavigation.boundingBox();
    const filterPanelBox = await filterPanel.boundingBox();
    const toolbarDividerBox = await page.locator('[data-analysis-group-divider]').boundingBox();
    const counterBox = await filterPanel.getByRole('status').boundingBox();
    const messagesScrollerBox = await page
      .locator('[data-analysis-message-scroller]')
      .boundingBox();
    expect(filterPanelBox?.x).toBeGreaterThanOrEqual((groupNavigationBox?.x ?? 0) + 200);
    expect(
      Math.abs(
        (toolbarDividerBox?.x ?? 0) - ((filterPanelBox?.x ?? 0) + (filterPanelBox?.width ?? 0)),
      ),
    ).toBeLessThanOrEqual(1);
    expect((counterBox?.y ?? 0) - (filterPanelBox?.y ?? 0)).toBeGreaterThanOrEqual(12);
    expect((filterPanelBox?.x ?? 0) + (filterPanelBox?.width ?? 0)).toBeLessThanOrEqual(
      messagesScrollerBox?.x ?? 0,
    );
    expect(filterPanelBox?.width).toBeLessThanOrEqual(336);
    await expect(filterPanel).toHaveCSS('box-shadow', 'none');

    await page
      .locator('[data-analysis-group-list]:visible')
      .getByRole('button', { name: /Group Beta, 3 непрочитаних/ })
      .click();
    await expect(filterPanel.locator('[data-section-id="Групи"]')).toHaveCount(0);

    await filterToggle.click();
    await expect(filterPanel).toHaveCount(0);
    await expect(filterToggle).toHaveAttribute('aria-expanded', 'false');
    await filterToggle.click();
    await expect(filterPanel).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(filterPanel).toHaveCount(0);
    await expect(filterToggle).toBeFocused();

    for (const tabName of ['Мапа', 'Зведена таблиця']) {
      await page.getByRole('tab', { name: tabName, exact: true }).click();
      await expect(filterToggle).toBeVisible();
    }
  });

  test('animates the desktop filters with the workspace panel motion', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.setViewportSize({ width: 1234, height: 877 });
    await installGroupNavigationMocks(page);
    await page.goto('/rer-analysis-neo');

    const filterToggle = page.locator('[data-analysis-filter-toggle]');
    await filterToggle.click();

    const filterTransition = page.locator('[data-analysis-filter-transition]');
    const filterPanel = page.locator('[data-analysis-filter-panel]:visible');
    await expect(filterPanel).toBeVisible();
    await expect(filterTransition).toHaveCSS('transition-duration', '0.18s');
    await expect(filterTransition).toHaveCSS(
      'transition-timing-function',
      'cubic-bezier(0.2, 0, 0, 1)',
    );

    await filterToggle.click();
    await expect(filterPanel).toBeVisible();
    await expect(filterPanel).toHaveCount(0);
  });

  test('removes the desktop filter motion when reduced motion is preferred', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.setViewportSize({ width: 1234, height: 877 });
    await installGroupNavigationMocks(page);
    await page.goto('/rer-analysis-neo');

    await page.locator('[data-analysis-filter-toggle]').click();

    await expect(page.locator('[data-analysis-filter-transition]')).toHaveCSS(
      'transition-duration',
      '0s',
    );
  });

  test('resolves the selected group name while both side panels are closed', async ({ page }) => {
    await page.setViewportSize({ width: 1500, height: 900 });
    const mocks = await installGroupNavigationMocks(page);
    await page.goto('/rer-analysis-neo?leftPanelOpen=false&rightPanelOpen=false&group=group-b');

    await expect(page.locator('[data-analysis-group-list]')).toHaveCount(0);
    await expect(page.locator('[data-analysis-current-group] [data-group-name]')).toHaveText(
      'Group Beta',
    );
    await expect.poll(mocks.getStateRequestCount).toBe(1);
    await page.waitForTimeout(400);
    expect(mocks.getStateRequestCount()).toBe(1);
  });

  test('keeps URL scope separate from aggregate filters and prefills create', async ({ page }) => {
    await page.setViewportSize({ width: 1500, height: 900 });
    const mocks = await installGroupNavigationMocks(page);
    await page.goto('/rer-analysis-neo?groups=group-a&groups=group-b');

    const groupList = page.locator('[data-analysis-group-list]:visible').first();
    await expect(groupList).toBeVisible();
    await groupList.getByRole('button', { name: /Group Beta, 3 непрочитаних/ }).click();
    await expect(page).toHaveURL(/(?:\?|&)group=group-b(?:&|$)/);
    await expect(page.getByText('Analysis Beta message')).toBeVisible();
    await expect(page.getByText('Analysis Alpha message')).toHaveCount(0);
    await expect(page.locator('[data-section-id="Групи"]')).toHaveCount(0);
    const currentGroup = page.locator('[data-analysis-current-group]');
    await expect(currentGroup.locator('[data-group-name]')).toHaveText('Group Beta');
    await expect(currentGroup).toHaveCSS('width', '180px');
    await expect(currentGroup.locator('[data-group-name]')).toHaveCSS('text-overflow', 'ellipsis');
    await expect(page.locator('[data-group-island]')).toHaveCount(0);
    await expect(currentGroup.locator('button')).toHaveCount(0);
    await expect(currentGroup.locator('[data-group-avatar]')).toHaveCSS('width', '36px');
    await expect(currentGroup.locator('[data-group-name]')).toHaveCSS('font-size', '16px');
    const groupDivider = page.locator('[data-analysis-group-divider]');
    await expect(groupDivider).toHaveCSS('width', '1px');
    await expect(groupDivider).toHaveCSS('height', '24px');
    expect(
      await currentGroup.evaluate((element) => {
        const tabbar = document.querySelector('[role="tablist"]');
        return tabbar != null && Boolean(element.compareDocumentPosition(tabbar) & 4);
      }),
    ).toBe(true);

    for (const tabName of ['Мапа', 'Зведена таблиця']) {
      await page.getByRole('tab', { name: tabName, exact: true }).click();
      await expect(currentGroup.locator('[data-group-name]')).toHaveText('Group Beta');
    }
    await page.getByRole('tab', { name: 'Повідомлення', exact: true }).click();

    const groupTitleFontSize = await page
      .locator('#analysis-groups-title')
      .evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize));
    const pageTitleFontSize = await page
      .getByRole('heading', { name: 'Аналіз', exact: true })
      .evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize));
    expect(groupTitleFontSize).toBeLessThan(pageTitleFontSize);

    await page.getByRole('button', { name: 'Додати повідомлення' }).click();
    await expect(page.getByRole('button', { name: 'Закрити ліву панель' })).toHaveCount(0);
    await expect(page.getByRole('combobox', { name: /Група/ })).toHaveValue('group-b');
    await expect(page).toHaveURL(/(?:\?|&)group=group-b(?:&|$)/);

    await page.reload();
    await expect(page).toHaveURL(/(?:\?|&)group=group-b(?:&|$)/);
    await expect(page.locator('[data-analysis-current-group] [data-group-name]')).toHaveText(
      'Group Beta',
    );
    await expect(page.getByText('Analysis Beta message')).toBeVisible();

    await page
      .locator('[data-analysis-group-list]:visible')
      .first()
      .getByRole('button', { name: /Всі групи, 5 непрочитаних/ })
      .click();
    await expect(page).not.toHaveURL(/(?:\?|&)group=/);
    await page.locator('[data-analysis-filter-toggle]').click();
    await expect(
      page.locator('[data-analysis-filter-panel]:visible [data-section-id="Групи"]'),
    ).toBeVisible();
    expect(
      mocks.inboxRequests.some(
        (request) =>
          JSON.stringify(request.selected_groups) === JSON.stringify(['group-a', 'group-b']),
      ),
    ).toBe(true);
    expect(mocks.getStateRequestCount()).toBeGreaterThan(0);
  });

  test('hides the previous group messages while the selected group loads', async ({ page }) => {
    await page.setViewportSize({ width: 1500, height: 900 });
    let releaseGroupBeta!: () => void;
    const groupBetaReady = new Promise<void>((resolve) => {
      releaseGroupBeta = resolve;
    });
    await installGroupNavigationMocks(page, {
      beforeInboxFulfill: async (request) => {
        if (request.selected_groups?.length === 1 && request.selected_groups[0] === 'group-b') {
          await groupBetaReady;
        }
      },
    });
    await page.goto('/rer-analysis-neo?group=group-a');
    await expect(page.getByText('Analysis Alpha message')).toBeVisible();

    await page
      .locator('[data-analysis-group-list]:visible')
      .first()
      .getByRole('button', { name: /Group Beta, 3 непрочитаних/ })
      .click();

    await expect(page.locator('[data-analysis-current-group] [data-group-name]')).toHaveText(
      'Group Beta',
    );
    await expect(page.getByText('Analysis Alpha message')).toBeHidden();
    await expect(page.locator('[data-message-feed-skeleton="refresh"]')).toBeVisible();

    releaseGroupBeta();
    await expect(page.getByText('Analysis Beta message')).toBeVisible();
    await expect(page.locator('[data-message-feed-skeleton="refresh"]')).toHaveCount(0);
  });

  test('keeps the counter stable while reload is disabled during group navigation', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1500, height: 900 });
    const mocks = await installGroupNavigationMocks(page, {
      beforeInboxFulfill: async (request) => {
        if (request.selected_groups?.length === 1 && request.selected_groups[0] === 'group-b') {
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
      },
    });
    await page.route('**/api/rer-importer/get-inbox-count', async (route) => {
      const request = route.request().postDataJSON() as { selected_groups?: string[] | null };
      const selectedGroups = request.selected_groups ?? null;
      await route.fulfill({
        json: {
          quantity: selectedGroups?.length === 1 ? (selectedGroups[0] === 'group-b' ? 3 : 1) : 2,
          first_element_ts: null,
        },
      });
    });

    await page.goto('/rer-analysis-neo?group=group-a');
    const counter = page.getByRole('button', {
      name: 'Перейти до першої або останньої сторінки',
    });
    const reload = page.getByRole('button', { name: 'Оновити' });
    await expect(counter).toHaveText('1-1 з 1');
    await expect(reload).toBeEnabled();

    await page.evaluate(() => {
      const observedWindow = window as typeof window & {
        __analysisHeaderTimeline?: Array<{
          at: number;
          counter: string | null;
          counterColor: string | null;
          reloadDisabled: boolean | null;
          reloadVisual: string | null;
        }>;
        __analysisHeaderObserver?: MutationObserver;
      };
      observedWindow.__analysisHeaderTimeline = [];
      let previous = '';
      const sample = () => {
        const counterElement = document.querySelector(
          '[aria-label="Перейти до першої або останньої сторінки"]',
        );
        const reloadElement = document.querySelector<HTMLButtonElement>(
          'button[aria-label="Оновити"]',
        );
        const reloadStyle = reloadElement ? getComputedStyle(reloadElement) : null;
        const next = {
          at: Math.round(performance.now()),
          counter: counterElement?.textContent?.trim() ?? null,
          counterColor: counterElement ? getComputedStyle(counterElement).color : null,
          reloadDisabled: reloadElement?.disabled ?? null,
          reloadVisual: reloadStyle
            ? JSON.stringify({
                backgroundColor: reloadStyle.backgroundColor,
                borderColor: reloadStyle.borderColor,
                color: reloadStyle.color,
                opacity: reloadStyle.opacity,
              })
            : null,
        };
        const serialized = JSON.stringify([next.counter, next.reloadDisabled]);
        if (serialized === previous) return;
        previous = serialized;
        observedWindow.__analysisHeaderTimeline?.push(next);
      };
      observedWindow.__analysisHeaderObserver = new MutationObserver(sample);
      observedWindow.__analysisHeaderObserver.observe(document.body, {
        attributes: true,
        characterData: true,
        childList: true,
        subtree: true,
      });
      sample();
    });

    await page
      .locator('[data-analysis-group-list]:visible')
      .first()
      .getByRole('button', { name: /Group Beta, 3 непрочитаних/ })
      .click();
    await expect(page.getByText('Analysis Beta message')).toBeVisible();
    await expect(counter).toHaveText('1-3 з 3');
    await page.waitForTimeout(200);

    const domTimeline = await page.evaluate(() => {
      const observedWindow = window as typeof window & {
        __analysisHeaderObserver?: MutationObserver;
        __analysisHeaderTimeline?: Array<{
          at: number;
          counter: string | null;
          counterColor: string | null;
          reloadDisabled: boolean | null;
          reloadVisual: string | null;
        }>;
      };
      observedWindow.__analysisHeaderObserver?.disconnect();
      return (
        (
          window as typeof window & {
            __analysisHeaderTimeline?: Array<{
              at: number;
              counter: string | null;
              counterColor: string | null;
              reloadDisabled: boolean | null;
              reloadVisual: string | null;
            }>;
          }
        ).__analysisHeaderTimeline ?? []
      );
    });
    expect(
      domTimeline.map(({ counter: counterText, reloadDisabled }) => ({
        counter: counterText,
        reloadDisabled,
      })),
    ).toEqual([
      { counter: '1-1 з 1', reloadDisabled: false },
      { counter: '1-1 з 1', reloadDisabled: true },
      { counter: '1-3 з 3', reloadDisabled: false },
    ]);
    expect(domTimeline[0]?.counterColor).not.toBe(domTimeline[1]?.counterColor);
    expect(domTimeline[2]?.counterColor).toBe(domTimeline[0]?.counterColor);
    expect(new Set(domTimeline.map(({ reloadVisual }) => reloadVisual)).size).toBe(2);
    expect(
      mocks.inboxRequests.filter(
        (request) =>
          request.selected_groups?.length === 1 && request.selected_groups[0] === 'group-b',
      ),
    ).toHaveLength(1);
  });

  test('opens the mobile list over the feed and preserves its scroll position', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 760 });
    await installGroupNavigationMocks(page);
    await page.goto('/rer-analysis-neo');
    await expect(page.locator('[data-analysis-group-list]')).toHaveCount(0);
    await expect(page.locator('[data-analysis-current-group]')).toHaveCSS('width', '128px');
    const scroller = page.locator('[data-analysis-message-scroller]');
    await scroller.evaluate((element) => {
      element.scrollTop = 23;
    });
    const before = await scroller.evaluate((element) => element.scrollTop);

    await page.getByRole('button', { name: 'Розгорнути ліву панель' }).click();
    await expect(page.locator('[data-analysis-group-list]')).toBeVisible();
    await expect.poll(() => scroller.evaluate((element) => element.scrollTop)).toBe(before);
  });

  test('opens separate mobile drawers for groups and filters', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 760 });
    await installGroupNavigationMocks(page);
    await page.goto('/rer-analysis-neo?leftPanelOpen=false&group=group-b');

    await page.locator('[data-analysis-filter-toggle]').click();
    const filterPanel = page.locator('[data-analysis-filter-panel]:visible');
    await expect(filterPanel).toBeVisible();
    await expect(page.getByText('Для: Group Beta', { exact: true })).toBeVisible();
    await expect(page.locator('[data-analysis-group-list]')).toHaveCount(0);

    await page.getByRole('button', { name: 'Закрити фільтри' }).click();
    await page.getByRole('button', { name: 'Розгорнути ліву панель' }).click();
    await expect(page.locator('[data-analysis-group-list]')).toBeVisible();
    await expect(page.locator('[data-analysis-filter-panel]')).toHaveCount(0);
  });

  for (const newestFirst of [true, false]) {
    test(`opens the oldest unread message with newestFirst=${newestFirst}`, async ({ page }) => {
      await page.setViewportSize({ width: 1500, height: 900 });
      await installGroupNavigationMocks(page);
      await page.route('**/api/rer-importer/group-feed-state', (route) =>
        route.fulfill({
          json: {
            groups: groups.map((group, index) => ({
              master_key: group.masterKey,
              name: group.name,
              ignore_operativny: false,
              unread_count: group.unreadCount,
              oldest_unread_message_ref:
                group.masterKey === 'group-b' ? 'analysis-group-feed-201' : null,
              last_activity_at: 1_720_000_100_000 - index,
              latest_cursor: null,
            })),
          },
        }),
      );
      await page.goto('/rer-analysis-neo');
      if (!newestFirst) {
        await page.getByRole('checkbox', { name: 'спочатку нові' }).click();
      }

      await page
        .locator('[data-analysis-group-list]:visible')
        .first()
        .getByRole('button', { name: /Group Beta, 3 непрочитаних/ })
        .click();

      const target = page.locator('[data-message-id="201"]');
      await expect(target).toBeVisible();
      await expect(target).toHaveAttribute('data-message-feed-highlighted', 'true');
    });
  }
});
