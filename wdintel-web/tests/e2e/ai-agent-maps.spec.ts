import { expect, test, type Page } from '@playwright/test';
import type { AiAgentMapDocument, AiAgentMapSummary } from '../../src/Bindings';
import { createEmptyInboxResponse, installAnalysisNeoApiMocks } from './analysis-neo.fixtures';

const conversationId = '11111111-1111-4111-8111-111111111111';
const requestId = '22222222-2222-4222-8222-222222222222';
const main: AiAgentMapSummary = {
  id: '33333333-3333-4333-8333-333333333333',
  requestId,
  title: 'Головна мапа',
  isMain: true,
  totalCount: 3,
  validCount: 2,
  invalidCount: 1,
  warnings: ['Рядок 2: Некоректна координата Y'],
};
const sub = {
  ...main,
  id: '44444444-4444-4444-8444-444444444444',
  title: 'Підмапа',
  isMain: false,
  totalCount: 1,
  validCount: 1,
  invalidCount: 0,
  warnings: [],
};
const empty = {
  ...main,
  id: '55555555-5555-4555-8555-555555555555',
  title: 'Неповні координати',
  isMain: false,
  validCount: 0,
  totalCount: 1,
  invalidCount: 1,
};
const source = { messageId: 77, messageIdentifier: 'map-source' };
function document(summary: AiAgentMapSummary): AiAgentMapDocument {
  const valid = {
    sidc: summary.id === sub.id ? '10062000009999990000' : '10062000001209020000',
    name: `${summary.title}: Подія А`,
    observationDatetime: '2026-09-28T11:20:00',
    platformType: 'CAPDOC',
    coordinateSystem: 'msk2000',
    originalX: '52-15227',
    originalY: '6548669',
    x: '5215227',
    y: '6548669',
    latitude: 47.068994,
    longitude: 33.639175,
    comments: ['Вантаж А & Б'],
    sources: [source],
    warnings: [],
  };
  const invalid = {
    ...valid,
    name: 'Некоректний запис',
    originalY: '654866',
    y: 'INVALID',
    latitude: null,
    longitude: null,
    warnings: main.warnings,
  };
  return {
    ...summary,
    records:
      summary.id === main.id
        ? [valid, { ...valid, name: 'Спільна координата: Подія Б' }, invalid]
        : summary.validCount
          ? [valid]
          : [invalid],
  };
}
async function installMaps(page: Page, longHistory = false) {
  await installAnalysisNeoApiMocks(page);
  const conversation = {
    id: conversationId,
    title: 'Мапи відповіді',
    aiEngineId: 'engine',
    createdAt: 1,
    updatedAt: 1,
  };
  const state = { delayMain: false, fail: false, retainedOnly: false, loads: [] as string[] };
  const references = `Події [мапа](echo-map:${main.id}).\n\nГрупа [мапа](echo-map:${sub.id}).\n\nНеповні [мапа](echo-map:${empty.id}).`;
  const paragraphs = Array.from({ length: 16 }, (_, index) => `Подія ${index + 1}.`).join('\n\n');
  const content = longHistory ? `${paragraphs}\n\n${references}\n\n${paragraphs}` : references;
  await page.route('**/api/ai-agent/configuration', (route) =>
    route.fulfill({
      json: {
        featureEnabled: true,
        defaultAiEngineId: 'engine',
        providers: [{ id: 'engine', name: 'Gemma', modelName: 'gemma' }],
      },
    }),
  );
  await page.route('**/api/ai-agent/conversations/list', (route) =>
    route.fulfill({ json: { items: [conversation] } }),
  );
  await page.route('**/api/ai-agent/conversations/get', (route) =>
    route.fulfill({
      json: {
        ...conversation,
        id: route.request().postDataJSON().id,
        messages:
          route.request().postDataJSON().id === conversationId
            ? [
                {
                  requestId,
                  requestState: state.retainedOnly ? 'cancelled' : 'completed',
                  role: 'assistant',
                  createdAt: 1,
                  content: state.retainedOnly ? '' : content,
                  citations: [],
                  maps: state.retainedOnly ? [sub] : [main, sub, empty],
                },
              ]
            : [],
      },
    }),
  );
  await page.route('**/api/ai-agent/maps/get', async (route) => {
    const body = route.request().postDataJSON();
    expect(body.requestId).toBe(requestId);
    state.loads.push(body.mapId);
    if (state.delayMain && body.mapId === main.id)
      await new Promise((resolve) => setTimeout(resolve, 800));
    if (state.fail) return route.fulfill({ status: 403, body: 'Джерело мапи недоступне' });
    const summary = [main, sub, empty].find((item) => item.id === body.mapId);
    return summary ? route.fulfill({ json: document(summary) }) : route.fulfill({ status: 404 });
  });
  for (const format of ['csv', 'kmz'])
    await page.route(`**/api/ai-agent/maps/${format}`, (route) => {
      expect(route.request().postDataJSON()).toEqual({ requestId, mapId: main.id });
      return route.fulfill({
        contentType:
          format === 'csv' ? 'text/csv; charset=utf-8' : 'application/vnd.google-earth.kmz',
        body: `${format} download`,
      });
    });
  await page.route('**/api/rer-importer/messages-by-id-with-metadata', (route) =>
    route.fulfill({
      json: {
        ...createEmptyInboxResponse(),
        inbox_items: [
          [
            77,
            {
              message_uid: 'map-source',
              text: 'Повний текст джерела мапи',
              date: '2025-09-28',
              time: '11:20',
              media: [],
              group_master_key: 'group',
            },
          ],
        ],
        signal_groups: [{ master_key: 'group', name: 'Джерело А' }],
      },
    }),
  );
  await page.goto(`/?conversation=${conversationId}`);
  await expect(page.locator('ai-agent-chat .ai-map-chip')).toHaveCount(3, { timeout: 20000 });
  await expect(page.locator('ai-agent-chat .ai-map-preview')).toHaveCount(1);
  return state;
}

test('@regression #3064 map chips replace documents, preserve drafts, reload, and download', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const state = await installMaps(page, true);
  const chat = page.locator('ai-agent-chat');
  const mainChip = chat.locator('.ai-map-chip').filter({ hasText: 'мапа' }).first();
  await expect(chat.locator('.ai-map-chip-image').first()).toHaveCSS('width', '24px');
  await expect(chat.locator('.ai-map-chip-image').first()).toHaveCSS('height', '24px');
  await expect(chat.locator('.ai-map-preview')).toHaveCSS('width', '144px');
  await expect(chat.locator('.ai-map-preview-image')).toHaveCSS('height', '96px');
  await expect(chat.locator('.ai-map-preview-count')).toHaveText('2');
  const draft = chat.getByRole('textbox', { name: 'Повідомлення' });
  await draft.fill('Чернетка збережеться');
  const scroll = chat.getByTestId('ai-agent-chat-messages');
  await scroll.evaluate((element) => {
    element.scrollTop = 200;
  });
  await mainChip.focus();
  const scrollBefore = await scroll.evaluate((element) => element.scrollTop);
  expect(scrollBefore).toBeGreaterThan(0);
  await page.keyboard.press('Enter');
  const panel = page.getByRole('region', { name: 'Мапа відповіді' });
  await expect(panel.getByRole('heading', { name: main.title, exact: true })).toBeVisible();
  await expect(panel.getByTestId('ai-map-canvas')).toBeVisible();
  await expect(panel.getByRole('combobox')).toHaveCount(0);
  await expect(panel.locator('.leaflet-marker-icon').first()).toHaveCSS('width', '20px');
  await expect(panel.locator('.leaflet-marker-icon').first()).toHaveCSS('height', '20px');
  await expect
    .poll(() =>
      panel
        .locator('.leaflet-marker-icon')
        .first()
        .evaluate(
          (element) =>
            element instanceof HTMLImageElement && element.complete && element.naturalWidth > 0,
        ),
    )
    .toBe(true);
  await expect(draft).toHaveValue('Чернетка збережеться');
  expect(await scroll.evaluate((element) => element.scrollTop)).toBe(scrollBefore);
  const chatBox = await chat.getByTestId('ai-agent-chat-pane').boundingBox();
  const mapBox = await panel.boundingBox();
  expect(Math.abs(chatBox!.width - mapBox!.width)).toBeLessThan(3);
  await panel.locator('.leaflet-marker-icon').first().focus();
  await page.keyboard.press('Enter');
  const details = panel.getByTestId('ai-map-record-details');
  await expect(details).toContainText('2026-09-28T11:20:00');
  await expect(details).toContainText('Вантаж А & Б');
  await expect(details.getByRole('link', { name: /Джерело А/ })).toBeVisible();
  const stageBox = await panel.getByTestId('ai-map-stage').boundingBox();
  const detailsBox = await details.boundingBox();
  expect(detailsBox!.y).toBeGreaterThan(stageBox!.y);
  expect(detailsBox!.y + detailsBox!.height).toBeLessThan(stageBox!.y + stageBox!.height);
  await panel.getByRole('button', { name: 'Закрити картку запису' }).click();
  await expect(details).toHaveCount(0);
  await panel.getByRole('button', { name: 'Наступна координата', exact: true }).click();
  await expect(details).toContainText('Спільна координата: Подія Б');
  await panel.getByRole('button', { name: 'Наступна координата', exact: true }).click();
  await expect(details).toContainText('Некоректний запис');
  await panel.getByRole('button', { name: 'Наступна координата', exact: true }).click();
  await expect(details).toContainText('Головна мапа: Подія А');
  await panel.getByRole('button', { name: 'Попередня координата', exact: true }).click();
  await expect(details).toContainText('Некоректний запис');
  await panel.getByRole('button', { name: 'Закрити картку запису' }).click();
  await panel.getByRole('button', { name: 'OpenStreetMap', exact: true }).click();
  await expect(panel.getByRole('button', { name: 'OpenStreetMap', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await panel.getByText('Попередження координат (1)', { exact: true }).click();
  await panel.getByRole('button', { name: '3. Некоректний запис', exact: true }).click();
  await expect(details).toContainText('654866');
  await panel.getByRole('button', { name: 'Закрити картку запису' }).click();
  for (const format of ['CSV', 'KMZ']) {
    await panel.getByRole('button', { name: 'Завантажити мапу' }).click();
    const downloaded = page.waitForEvent('download');
    await page.getByRole('menuitem', { name: format, exact: true }).click();
    expect((await downloaded).suggestedFilename()).toBe(`map-${main.id}.${format.toLowerCase()}`);
  }
  await page.keyboard.press('Escape');
  await expect(panel).toHaveCount(0);
  await expect(mainChip).toBeFocused();
  state.delayMain = true;
  await mainChip.click();
  await chat.locator('.ai-map-chip').nth(1).click();
  await expect(panel.getByRole('heading', { name: sub.title, exact: true })).toBeVisible();
  await expect(panel.locator('.leaflet-marker-icon')).toHaveAttribute(
    'src',
    '/img/google_earth_icons/10061000001211020000.png',
  );
  await page.waitForTimeout(1000);
  await expect(panel.getByRole('heading', { name: sub.title, exact: true })).toBeVisible();
  await panel.getByRole('button', { name: 'Закрити мапу' }).click();
  await expect(draft).toHaveValue('Чернетка збережеться');
  await chat.locator('.ai-map-preview').click();
  await expect(panel.getByRole('heading', { name: main.title, exact: true })).toBeVisible();
  await page.reload();
  await expect(chat.locator('.ai-map-preview')).toHaveCount(1);
  await expect(panel).toHaveCount(0);
  await chat.locator('.ai-map-preview').click();
  await expect(panel).toBeVisible();
  await page.evaluate(() => {
    history.pushState({}, '', '/?conversation=66666666-6666-4666-8666-666666666666');
    window.dispatchEvent(new PopStateEvent('popstate'));
  });
  await expect(panel).toHaveCount(0);
  await expect(chat.locator('.ai-map-chip')).toHaveCount(0);
  state.retainedOnly = true;
  await page.goto(`/?conversation=${conversationId}`);
  await expect(chat.locator('.ai-map-chip')).toHaveCount(1);
  await expect(chat.locator('.ai-map-preview')).toHaveCount(0);
  await chat.locator('.ai-map-chip').click();
  await expect(panel.getByRole('heading', { name: sub.title, exact: true })).toBeVisible();
});

test('@regression #3064 Echo breakpoint switches map panel to a full height drawer with CSV-only invalid rows', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1024, height: 900 });
  const state = await installMaps(page);
  const chat = page.locator('ai-agent-chat');
  await chat.locator('.ai-map-preview').click();
  const panel = page.getByRole('region', { name: 'Мапа відповіді' });
  await expect(panel).toBeVisible();
  expect(await panel.evaluate((element) => element.parentElement?.tagName)).toBe('ASIDE');
  await panel.getByRole('button', { name: 'Закрити мапу' }).click();
  await page.setViewportSize({ width: 1023, height: 900 });
  await chat.locator('.ai-map-chip').nth(2).click();
  await expect(panel).toContainText('KMZ недоступний');
  let rect = await panel.boundingBox();
  expect(rect!.width).toBe(1023);
  expect(rect!.height).toBe(900);
  await panel.getByRole('button', { name: 'Завантажити мапу' }).click();
  await expect(page.getByRole('menuitem', { name: 'KMZ', exact: true })).toHaveAttribute(
    'aria-disabled',
    'true',
  );
  await page.keyboard.press('Escape');
  await expect(panel).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(panel).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  await chat.locator('.ai-map-preview').click();
  await expect(panel).toBeVisible();
  rect = await panel.boundingBox();
  expect(rect!.width).toBe(390);
  expect(rect!.height).toBe(844);
  await panel.getByRole('button', { name: 'Закрити мапу' }).click();
  await page.setViewportSize({ width: 320, height: 640 });
  await chat.locator('.ai-map-preview').click();
  await expect(panel).toBeVisible();
  await expect(panel.getByRole('combobox')).toHaveCount(0);
  await panel.locator('.leaflet-marker-icon').last().click();
  const details = panel.getByTestId('ai-map-record-details');
  await expect(details).toBeVisible();
  const stage = await panel.getByTestId('ai-map-stage').boundingBox();
  const card = await details.boundingBox();
  expect(card!.x).toBeGreaterThanOrEqual(stage!.x);
  expect(card!.x + card!.width).toBeLessThanOrEqual(stage!.x + stage!.width);
  const layer = await panel
    .getByRole('button', { name: 'OpenStreetMap', exact: true })
    .boundingBox();
  expect(card!.y + card!.height).toBeLessThan(layer!.y);
  await panel.getByRole('button', { name: 'Закрити мапу' }).click();
  state.fail = true;
  await chat.locator('.ai-map-preview').click();
  await expect(panel).toContainText('Мапа недоступна');
  await expect(
    page.getByRole('alert').filter({ hasText: 'Не вдалося завантажити мапу' }),
  ).toBeVisible();
});
