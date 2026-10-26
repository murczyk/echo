import { expect, test, type Locator, type Page, type Route } from '@playwright/test';
import type { UserDutySettings } from '../../src/ts/react/services/api/user-settings';
import { installAnalysisNeoApiMocks } from './analysis-neo.fixtures';
import { emptyNetworksListResponse, emptyUnitsListResponse } from './fixture-responses';
import {
  buildMessageCardMediaPreviewInboxResponse,
  installMessageCardMediaPreviewAssetRoutes,
  type MessageCardMediaPreviewHost,
} from './message-card-media-preview.fixtures';
import { installRerDutyShortStateMocks } from './rer-duty-short-state.fixtures';

const EXPECTED_TILE_SIZES = { compact: 72, large: 144 } as const;
const COMPACT_SETTINGS: UserDutySettings = {
  messageSortBy: 'interception',
  messageTextPreviewLines: 20,
  tagsLayout: 'compact',
  disableAutoScroll: false,
  analysisMapInSidebar: false,
  dutyAudioTranscriptionCollapsed: false,
  analysisAudioTranscriptionCollapsed: false,
  showAnalysisCallsignAddForm: false,
  showClassicDuty: false,
  showClassicAnalysis: false,
  dutyCollapseMediaPreviews: false,
  largeMediaPreviews: false,
  mediaSummaryEnabled: true,
  messageAutoParseEnabled: false,
  aiPositionHighlightsEnabled: false,
};

async function openAttachmentHost(
  page: Page,
  host: MessageCardMediaPreviewHost,
  settings: Omit<UserDutySettings, 'largeMediaPreviews'> & { largeMediaPreviews?: boolean },
  coordinateResponse?: (route: Route) => Promise<void>,
  messageText?: string,
) {
  await page.addInitScript(() => localStorage.setItem('echo-theme-mode', 'dark'));
  const inboxResponse = buildMessageCardMediaPreviewInboxResponse({
    withCompleteCoordinateError: coordinateResponse != null,
    messageText,
  });
  await installMessageCardMediaPreviewAssetRoutes(page);
  if (host === 'analysis') await installAnalysisNeoApiMocks(page, { inboxResponse });
  else await installRerDutyShortStateMocks(page, { inboxResponse });
  let currentSettings = settings;
  await page.route('**/api/sigint/units', (route) =>
    route.fulfill({ json: emptyUnitsListResponse() }),
  );
  await page.route('**/api/sigint/network-list', (route) =>
    route.fulfill({ json: emptyNetworksListResponse() }),
  );
  await page.route('**/api/user/settings', async (route) => {
    if (route.request().method() === 'PUT') currentSettings = route.request().postDataJSON();
    await route.fulfill({ json: currentSettings });
  });
  if (coordinateResponse) {
    await page.route(
      '**/api/messenger/media/e2e-coordinate-error/summary/coordinates',
      coordinateResponse,
    );
  }
  await page.goto(host === 'analysis' ? '/rer-analysis-neo' : '/rer-duty-neo');
  await waitForAttachmentHost(page, host);
  const card = page.locator('.message-card-root').first();
  await expect(card).toBeVisible();
  return {
    card,
    updateSettings: async (nextSettings: UserDutySettings) => {
      currentSettings = nextSettings;
      await page.evaluate((detail) => {
        window.dispatchEvent(new CustomEvent('user-settings-updated', { detail }));
      }, nextSettings);
    },
  };
}

async function waitForAttachmentHost(page: Page, host: MessageCardMediaPreviewHost) {
  const width = page.viewportSize()!.width;
  if (width > 768) {
    await expect(
      page.getByRole('button', {
        name: host === 'analysis' ? 'analysis-tester' : 'operator',
        exact: true,
      }),
    ).toBeVisible();
  }
  if (host === 'analysis' && width <= 768) await page.keyboard.press('Escape');
  if (host === 'duty') {
    await expect(page.locator('[data-duty-feed-column]').first()).toHaveCSS(
      'flex-basis',
      width < 1024 ? '100%' : 'auto',
    );
  }
}

async function expectSquare(tile: Locator, mode: keyof typeof EXPECTED_TILE_SIZES) {
  await expect(tile).toBeVisible();
  const size = `${EXPECTED_TILE_SIZES[mode]}px`;
  await expect(tile).toHaveCSS('width', size);
  await expect(tile).toHaveCSS('height', size);
}

async function expectMediaTiles(card: Locator, mode: keyof typeof EXPECTED_TILE_SIZES) {
  const shells = card.locator('.message-card-thumbnail-shell');
  await expect(shells).toHaveCount(4);
  for (const shell of await shells.all()) {
    await expectSquare(shell, mode);
    await expectSquare(shell.locator('.message-card-thumbnail-control'), mode);
    await expect(shell.locator('[data-message-card-attachment-download]')).toBeVisible();
  }
  await expect(card.getByRole('button', { name: 'Відкрити зображення' })).toHaveCount(2);
  await expect(card.getByRole('button', { name: 'Відкрити відео' })).toHaveCount(2);
}

async function expectCoordinateTile(card: Locator, mode: keyof typeof EXPECTED_TILE_SIZES) {
  const tile = card.locator('[data-coordinate-preview-tile]');
  await tile.scrollIntoViewIfNeeded();
  await expectSquare(card.locator('[data-coordinate-preview-root]'), mode);
  await expectSquare(tile, mode);
  await expectSquare(tile.getByRole('button'), mode);
  await expect(tile.locator('[data-coordinate-preview-count]')).toHaveText('1');
}

// Regression: https://github.com/echoua/echo/issues/3324
for (const host of ['analysis', 'duty'] as const) {
  test.describe(`ECHO-3324 ${host} attachment display @regression`, () => {
    test('prepares coordinate maps before they enter the feed viewport without loading distant maps', async ({
      page,
    }) => {
      await page.setViewportSize({ width: 1920, height: 600 });
      await page.route(/^https:\/\/(server|services)\.arcgisonline\.com\//, (route) =>
        route.fulfill({
          contentType: 'image/svg+xml',
          body: '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect width="256" height="256" fill="#557755"/></svg>',
        }),
      );
      let lookups = 0;
      const settings = {
        ...COMPACT_SETTINGS,
        dutyCollapseMediaPreviews: true,
        disableAutoScroll: true,
        messageTextPreviewLines: null,
      };
      const { card, updateSettings } = await openAttachmentHost(
        page,
        host,
        settings,
        async (route) => {
          lookups += 1;
          await route.fulfill({
            json: {
              coordinates: [
                {
                  title: 'Координати документа',
                  description: null,
                  plannedMeans: null,
                  coordinateSystem: 'wgs84',
                  value: '50.45044, 30.52355',
                },
              ],
            },
          });
        },
        Array.from({ length: 120 }, () => 'Текст перед вкладеннями').join('\n'),
      );
      await expect(card.locator('[data-coordinate-preview-root]')).toHaveCount(0);
      const scroller = page.locator('[data-message-feed-scroller]').first();
      await scroller.evaluate((element) => {
        element.scrollTop = 0;
      });
      await updateSettings({ ...settings, dutyCollapseMediaPreviews: false });
      const coordinate = card.locator('[data-coordinate-preview-root]');
      await expect(coordinate).toBeAttached();
      const distanceToViewport = () =>
        coordinate.evaluate((element) => {
          const viewport = element.closest('[data-message-feed-scroller]')!;
          return element.getBoundingClientRect().top - viewport.getBoundingClientRect().bottom;
        });
      await expect.poll(distanceToViewport).toBeGreaterThan(1500);
      expect(lookups).toBe(0);
      await coordinate.evaluate((element) => {
        const viewport = element.closest('[data-message-feed-scroller]')!;
        viewport.scrollTop +=
          element.getBoundingClientRect().top - viewport.getBoundingClientRect().bottom - 500;
      });
      await expect.poll(distanceToViewport).toBeGreaterThan(300);
      await expect.poll(() => lookups).toBe(1);
      await expect(coordinate.locator('.leaflet-tile-loaded').first()).toBeAttached();
      await expect.poll(distanceToViewport).toBeGreaterThan(300);
      await coordinate.scrollIntoViewIfNeeded();
      await expect(coordinate.locator('.leaflet-tile-loaded').first()).toBeVisible();
    });

    test('keeps legacy settings compact and applies same-page display changes', async ({
      page,
    }) => {
      const { largeMediaPreviews: _largeMediaPreviews, ...legacySettings } = COMPACT_SETTINGS;
      const { card, updateSettings } = await openAttachmentHost(page, host, legacySettings);
      await expectMediaTiles(card, 'compact');
      await expectCoordinateTile(card, 'compact');

      await updateSettings({ ...COMPACT_SETTINGS, largeMediaPreviews: true });
      await expectMediaTiles(card, 'large');
      await expectCoordinateTile(card, 'large');

      await updateSettings(COMPACT_SETTINGS);
      await expectMediaTiles(card, 'compact');
      await expectCoordinateTile(card, 'compact');
    });

    test('reloads persisted large previews and wraps them at mobile and desktop widths', async ({
      page,
    }, testInfo) => {
      await page.setViewportSize({ width: 1512, height: 1100 });
      const { card } = await openAttachmentHost(page, host, {
        ...COMPACT_SETTINGS,
        largeMediaPreviews: true,
      });
      await expectMediaTiles(card, 'large');
      await page.reload();

      for (const width of [1512, 1920, 2560, 3440, 1280, 768, 390]) {
        await page.setViewportSize({ width, height: 1100 });
        await waitForAttachmentHost(page, host);
        await expectMediaTiles(card, 'large');
        await expectCoordinateTile(card, 'large');
        if (host === 'duty' && width >= 1920) {
          const shells = card.locator('.message-card-thumbnail-shell');
          const first = await shells.first().boundingBox();
          const fourth = await shells.nth(3).boundingBox();
          expect(fourth!.y).toBe(first!.y);
        }
        await expect(
          card.getByRole('link', { name: 'Завантажити аудіо: e2e-audio.wav' }),
        ).toBeVisible();
        await expect
          .poll(() =>
            page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
          )
          .toBe(true);
        if (width === 390) {
          const shells = await card.locator('.message-card-thumbnail-shell').all();
          const first = await shells[0].boundingBox();
          const last = await shells[shells.length - 1].boundingBox();
          expect(last!.y).toBeGreaterThan(first!.y);
          await expect
            .poll(() => card.evaluate((element) => element.scrollWidth <= element.clientWidth))
            .toBe(true);
        }
        await card.screenshot({ path: testInfo.outputPath(`${host}-large-${width}.png`) });
      }
    });

    test('keeps collapsed categories unmounted and reveals compact tiles despite a stale large flag', async ({
      page,
    }) => {
      const { card } = await openAttachmentHost(page, host, {
        ...COMPACT_SETTINGS,
        dutyCollapseMediaPreviews: true,
        largeMediaPreviews: true,
      });
      const media = card.locator('[data-attachment-kind="media"]');
      const coordinates = card.locator('[data-attachment-kind="coordinates"]');
      const audio = card.locator('[data-attachment-kind="audio"]');
      await expect(media).toHaveAttribute('aria-expanded', 'false');
      await expect(card.locator('.message-card-thumbnail-shell')).toHaveCount(0);
      await expect(card.locator('[data-coordinate-preview-root]')).toHaveCount(0);
      await expect(card.locator('.message-card-audio-row')).toHaveCount(0);
      await expect(card.locator('video, audio, .leaflet-container')).toHaveCount(0);

      await media.click();
      await expectMediaTiles(card, 'compact');
      await expect(card.locator('[data-coordinate-preview-root]')).toHaveCount(0);

      await coordinates.click();
      await expect(media).toHaveAttribute('aria-expanded', 'false');
      await expect(card.locator('.message-card-thumbnail-shell')).toHaveCount(0);
      await expectCoordinateTile(card, 'compact');

      await audio.click();
      await expect(coordinates).toHaveAttribute('aria-expanded', 'false');
      await expect(card.locator('[data-coordinate-preview-root]')).toHaveCount(0);
      await expect(card.locator('.message-card-audio-row')).toBeVisible();
      await audio.click();
      await expect(card.locator('.message-card-audio-row')).toHaveCount(0);
    });

    test('keeps loading and failed coordinate previews large and retryable', async ({ page }) => {
      let release!: () => void;
      const loading = new Promise<void>((resolve) => {
        release = resolve;
      });
      let requests = 0;
      const { card } = await openAttachmentHost(
        page,
        host,
        { ...COMPACT_SETTINGS, largeMediaPreviews: true },
        async (route) => {
          requests += 1;
          if (requests === 1) {
            await loading;
            await route.fulfill({ status: 500, body: 'Coordinate lookup failed' });
          } else {
            await route.fulfill({
              json: {
                coordinates: [
                  {
                    title: 'E2E coordinate',
                    description: 'Recovered coordinate',
                    plannedMeans: null,
                    coordinateSystem: 'wgs84',
                    value: '50.45044, 30.52355',
                  },
                ],
              },
            });
          }
        },
      );
      const coordinateRoot = card.locator('[data-coordinate-preview-root]');
      try {
        await expectSquare(coordinateRoot, 'large');
        await expect(coordinateRoot.locator('[data-coordinate-preview-tile]')).toHaveCount(0);
      } finally {
        release();
      }
      const failureTile = card.locator('[data-coordinate-preview-retry-tile]');
      await expectSquare(failureTile, 'large');
      await failureTile.getByRole('button', { name: 'Повторити завантаження координат' }).click();
      await expectCoordinateTile(card, 'large');
      await expect(failureTile).toHaveCount(0);
    });
  });
}
