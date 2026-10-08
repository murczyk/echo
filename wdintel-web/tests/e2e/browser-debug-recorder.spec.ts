import { readFile } from 'node:fs/promises';

import { expect, test, type Page } from '@playwright/test';

import { installRerDutyShortStateMocks } from './rer-duty-short-state.fixtures';

const STORAGE_KEY = 'echo-browser-debug-recorder-v1';
const RAW_ID = '991234';
const SECRETS = {
  query: 'ECHO_SECRET_SENTINEL query-secret',
  hash: 'ECHO_SECRET_SENTINEL hash-secret',
  header: 'ECHO_SECRET_SENTINEL header-secret',
  body: 'ECHO_SECRET_SENTINEL body-secret',
  dom: 'ECHO_SECRET_SENTINEL dom-secret',
  input: 'ECHO_SECRET_SENTINEL input-secret',
  console: 'ECHO_SECRET_SENTINEL console-secret',
  localStorage: 'ECHO_SECRET_SENTINEL local-storage-secret',
  sessionStorage: 'ECHO_SECRET_SENTINEL session-storage-secret',
} as const;

type StoredRecording = {
  state: string;
  recordingId: string;
  startedAt: number;
  deadlineAt: number;
};

type TimelineEvent = {
  seq: number;
  kind: string;
  source: string;
  route: string;
  details?: Record<string, unknown>;
};

async function installLiveDutyMocks(page: Page): Promise<void> {
  await installRerDutyShortStateMocks(page);
  await page.route('**/api-public/server-info', (route) =>
    route.fulfill({
      json: {
        mode: 'live',
        public_host: 'echo.localhost',
        grafana_address: 'https://echo.localhost/grafana',
        feature_delta: true,
        feature_analysis_map: true,
        feature_strict_networks: false,
        feature_my_admin_groups_edit: false,
        version: 'e2e-live',
      },
    }),
  );
}

async function activateRecorder(page: Page): Promise<void> {
  const activator = page.getByRole('button', { name: 'Останні зміни' });
  await expect(activator).toBeVisible();
  for (let press = 0; press < 8; press += 1) await activator.click();
}

async function storedRecording(page: Page): Promise<StoredRecording | null> {
  return page.evaluate((key) => {
    const value = sessionStorage.getItem(key);
    return value ? (JSON.parse(value) as StoredRecording) : null;
  }, STORAGE_KEY);
}

function parseTimeline(markdown: string): TimelineEvent[] {
  const block = markdown.match(/```jsonl\n([\s\S]*?)\n```/);
  expect(block?.[1]).toBeTruthy();
  return block![1]!
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as TimelineEvent);
}

function eventIndex(events: TimelineEvent[], predicate: (event: TimelineEvent) => boolean): number {
  const index = events.findIndex(predicate);
  expect(index).toBeGreaterThanOrEqual(0);
  return index;
}

test('user records and exports safe browser diagnostics in Live mode @regression #3709', async ({
  page,
  context,
}) => {
  test.setTimeout(60_000);
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.addInitScript(
    ({ localStorageSecret, sessionStorageSecret }) => {
      localStorage.setItem('unrelated-debug-secret', localStorageSecret);
      sessionStorage.setItem('unrelated-debug-secret', sessionStorageSecret);
    },
    {
      localStorageSecret: SECRETS.localStorage,
      sessionStorageSecret: SECRETS.sessionStorage,
    },
  );
  await installLiveDutyMocks(page);
  await page.route(`**/api/debug-recorder-success/${RAW_ID}**`, (route) =>
    route.fulfill({ status: 200, json: { ok: true } }),
  );
  await page.route('**/api/debug-recorder-failure/**', (route) =>
    route.fulfill({ status: 503, body: 'Unavailable' }),
  );
  await page.route('**/api/debug-recorder-slow/**', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 3_100));
    await route.fulfill({ status: 200, json: { ok: true } });
  });

  const initialPath = `/rer-duty-neo?state-short=short-1&diagnostic=${encodeURIComponent(SECRETS.query)}#${encodeURIComponent(SECRETS.hash)}`;
  await page.goto(initialPath);
  await expect(page.locator('app-navbar header')).toBeVisible();
  const navbarRow = page.locator('.app-navbar-row');
  await expect
    .poll(() =>
      navbarRow.evaluate(
        (element) => getComputedStyle(element).gridTemplateColumns.trim().split(/\s+/).length,
      ),
    )
    .toBe(3);
  await activateRecorder(page);
  await expect
    .poll(() =>
      navbarRow.evaluate(
        (element) => getComputedStyle(element).gridTemplateColumns.trim().split(/\s+/).length,
      ),
    )
    .toBe(4);

  const panel = page.locator('[data-debug-recorder-root]');
  const beforeReload = await storedRecording(page);
  expect(beforeReload).toMatchObject({ state: 'recording' });
  expect(pageErrors).toEqual([]);
  expect(
    await page.evaluate(() => document.getElementById('echo-debug-recorder-root')?.outerHTML),
  ).toContain('data-debug-recorder-host');
  await expect(panel).toHaveCount(1);
  await expect(panel).toContainText('Запис');
  await expect(panel).toContainText('00:00');

  await page.evaluate(
    async ({ secrets, rawId }) => {
      const input = document.createElement('input');
      input.dataset.testid = 'debug-safe-input';
      input.value = secrets.input;
      document.body.append(input);

      const button = document.createElement('button');
      button.dataset.testid = 'debug-safe-button';
      button.textContent = secrets.dom;
      document.body.append(button);
      button.click();

      const scroller = document.createElement('div');
      scroller.style.cssText = 'height:180px;overflow:auto';
      const content = document.createElement('div');
      content.style.height = '2000px';
      scroller.append(content);
      document.body.append(scroller);
      scroller.scrollTop = 900;
      scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
      await new Promise(requestAnimationFrame);
      input.focus();

      history.pushState(
        {},
        '',
        `${location.pathname}?diagnostic=${encodeURIComponent(secrets.query)}#${encodeURIComponent(secrets.hash)}`,
      );
      await Promise.resolve();
      await fetch(
        `/api/debug-recorder-success/${rawId}?secret=${encodeURIComponent(secrets.query)}`,
        {
          method: 'POST',
          headers: { 'x-debug-secret': secrets.header },
          body: JSON.stringify({ secret: secrets.body }),
        },
      );
      await fetch('/api/debug-recorder-failure/992345');
      await Promise.all([
        fetch('/api/debug-recorder-slow/993456'),
        fetch('/api/debug-recorder-slow/993456'),
      ]);
      console.error({ secret: secrets.console });

      for (let transition = 0; transition < 4; transition += 1) {
        if (transition % 2 === 0) {
          const skeleton = document.createElement('div');
          skeleton.dataset.debugSkeleton = '';
          document.body.append(skeleton);
        } else {
          document.querySelector('[data-debug-skeleton]')?.remove();
        }
        await new Promise((resolve) => setTimeout(resolve, 30));
      }

      const replacementHost = document.createElement('div');
      document.body.append(replacementHost);
      for (let replacement = 0; replacement < 3; replacement += 1) {
        const custom = document.createElement('debug-recorder-probe');
        for (let child = 0; child < 55; child += 1) custom.append(document.createElement('span'));
        replacementHost.replaceChildren(custom);
        await new Promise(requestAnimationFrame);
      }
    },
    { secrets: SECRETS, rawId: RAW_ID },
  );

  await page.waitForTimeout(400);
  await page.reload();
  const afterReload = await storedRecording(page);
  expect(afterReload?.recordingId).toBe(beforeReload?.recordingId);
  expect(afterReload?.startedAt).toBe(beforeReload?.startedAt);
  expect(afterReload?.deadlineAt).toBe(beforeReload?.deadlineAt);
  expect(pageErrors).toEqual([]);
  await expect(page.locator('[data-debug-recorder-root]')).toContainText('Запис');

  const secondPage = await context.newPage();
  await installLiveDutyMocks(secondPage);
  await secondPage.goto('/rer-duty-neo');
  await expect(secondPage.locator('[data-debug-recorder-root]')).toHaveCount(0);
  expect(await storedRecording(secondPage)).toBeNull();
  await secondPage.close();

  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Завершити' }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/^echo-debug-\d{8}-\d{6}\.md$/);
  const downloadPath = await download.path();
  expect(downloadPath).not.toBeNull();
  const report = await readFile(downloadPath!, 'utf8');

  expect(report).toContain('# Echo browser debug report');
  expect(report).toContain('`Live`');
  expect(report).toContain('## Anomaly summary');
  expect(report).toContain('## Timeline');
  expect(report).toContain('## Capture status');
  expect(report).not.toContain('ECHO_SECRET_SENTINEL');
  expect(report).not.toContain(RAW_ID);
  expect(report).not.toContain(page.url());
  for (const secret of Object.values(SECRETS)) expect(report).not.toContain(secret);

  const events = parseTimeline(report);
  const navigationIndex = eventIndex(events, (event) => event.kind === 'navigation.push');
  const requestStartIndex = eventIndex(
    events,
    (event) => event.kind === 'http.started' && event.route.includes('debug-recorder-success'),
  );
  const requestEndIndex = eventIndex(
    events,
    (event) => event.kind === 'http.completed' && event.route.includes('debug-recorder-success'),
  );
  const failureIndex = eventIndex(
    events,
    (event) =>
      event.kind === 'http.completed' &&
      event.route.includes('debug-recorder-failure') &&
      event.details?.outcome === 'http-error',
  );
  const errorIndex = eventIndex(events, (event) => event.kind === 'console.error');
  const scrollIndex = eventIndex(events, (event) => event.kind === 'scroll.sample');
  const loadingIndex = eventIndex(events, (event) => event.kind === 'skeleton.visibility');
  const dutyIndex = eventIndex(
    events,
    (event) => event.source === 'duty' && event.kind.startsWith('duty.'),
  );
  const reloadIndex = eventIndex(events, (event) => event.kind === 'navigation.reload');
  expect(navigationIndex).toBeLessThan(requestStartIndex);
  expect(requestStartIndex).toBeLessThan(requestEndIndex);
  expect(requestEndIndex).toBeLessThan(failureIndex);
  expect(failureIndex).toBeLessThan(errorIndex);
  expect(scrollIndex).toBeLessThan(loadingIndex);
  expect(dutyIndex).toBeLessThan(reloadIndex);
  expect(events.some((event) => event.kind === 'dom.replacement')).toBe(true);
  expect(events.some((event) => event.kind === 'dom.custom-elements')).toBe(true);
  expect(events.some((event) => event.kind === 'anomaly.http-duplicate')).toBe(true);
  expect(events.some((event) => event.kind === 'anomaly.http-slow')).toBe(true);
  expect(events.some((event) => event.kind === 'anomaly.scroll-jump')).toBe(true);
  expect(events.some((event) => event.kind === 'anomaly.skeleton-flicker')).toBe(true);
  expect(events.some((event) => event.kind === 'anomaly.dom-replacement-storm')).toBe(true);
  expect(events.some((event) => event.kind === 'anomaly.navigation-reload')).toBe(true);

  await expect(page.locator('[data-debug-recorder-root]')).toHaveCount(0);
  expect(await storedRecording(page)).toBeNull();
  expect(
    await page.evaluate(() => ({
      local: localStorage.getItem('unrelated-debug-secret'),
      session: sessionStorage.getItem('unrelated-debug-secret'),
    })),
  ).toEqual({ local: SECRETS.localStorage, session: SECRETS.sessionStorage });

  await activateRecorder(page);
  await expect(page.locator('[data-debug-recorder-root]')).toHaveCount(1);
  const cleared = await page.evaluate((key) => {
    window.dispatchEvent(new Event('echo:api-unauthorized'));
    return sessionStorage.getItem(key);
  }, STORAGE_KEY);
  expect(cleared).toBeNull();
  await expect(page.locator('[data-debug-recorder-root]')).toHaveCount(0);
});
