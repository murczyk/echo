import { expect, test, type Locator, type Route } from '@playwright/test';
import type { InboxMessagesRspRaw } from '../../src/ts/react/services/api/inbox-messages';
import { minimalInboxMessage } from '../../src/ts/react/routes/rer-duty-neo/inbox-message-mocks';
import { installRerDutyShortStateMocks } from './rer-duty-short-state.fixtures';

const PARENT_ID = 40;
const REPORT_ID = 501;

function reportSummary(text: string) {
  return {
    id: REPORT_ID,
    isAccessible: true,
    isDeleted: false,
    text,
    attachmentsCount: 0,
    timestamp: null,
    date: null,
    time: null,
    isTimeNull: null,
    groupName: null,
    groupMasterKey: null,
    coords: null,
    mediaFileNames: [],
  };
}

function scrollerOffset(card: Locator) {
  return card.evaluate(
    (element) =>
      element.getBoundingClientRect().top -
      element.closest('[data-duty-feed-scroller]')!.getBoundingClientRect().top,
  );
}

test('editing a report conclusion keeps every Duty feed in place @regression', async ({ page }) => {
  let conclusion = 'Планування вогневого ураження позицій';
  const latestPageRequests: unknown[] = [];
  const message = (id: number) =>
    minimalInboxMessage({
      text: `Intercept ${id} ${'History content '.repeat(32)}`,
      createdAt: 1_720_000_000_000 + id * 1_000,
      timestamp: 1_720_000_000_000 + id * 1_000,
      groupMasterKey: 'group-1',
      intelligenceReports: id === PARENT_ID ? [reportSummary(conclusion)] : [],
    });
  const report = () =>
    minimalInboxMessage({
      text: conclusion,
      fullBody: conclusion,
      groupMasterKey: null,
      createdAt: 1_720_000_000_000 + PARENT_ID * 1_000 + 500,
      parentMessages: [{ ...reportSummary(''), id: PARENT_ID, groupMasterKey: 'group-1' }],
    });
  const response = (ids: number[]): InboxMessagesRspRaw => ({
    inbox_items: ids.map((id) => [id, message(id) as never]),
    callsigns: [],
    signal_profiles: {},
    signal_groups: [],
    freq_pelengs_summary: null,
    page_limit: 20,
  });
  await page.setViewportSize({ width: 1600, height: 1000 });
  await installRerDutyShortStateMocks(page, {
    shortState: {
      waterfalls: ['mf-0', 'mf-1'].map((id) => [id, { groupsSelected: ['group-1'] }]),
    },
    userSettingsResponse: {
      tagsLayout: 'compact',
      disableAutoScroll: false,
      minimalReportWindowEnabled: true,
    } as never,
    inboxCountResponseForRequest: () => ({ quantity: 0, first_element_ts: null }),
    inboxResponseForRequest: (body) => {
      const request = body as { before_id_noninclusive?: number; since_id_noninclusive?: number };
      if (request.before_id_noninclusive != null || request.since_id_noninclusive != null)
        return response([]);
      latestPageRequests.push(body);
      return response(Array.from({ length: 40 }, (_, i) => i + 21));
    },
  });
  const messagesById = async (route: Route) => {
    const ids: number[] = route.request().postDataJSON().message_ids;
    await route.fulfill({
      json: {
        messages: ids.map((id) => [id, id === REPORT_ID ? report() : message(id)]),
      },
    });
  };
  await page.route('**/api/rer-importer/messages-by-id', messagesById);
  await page.route('**/api/rer-importer/messages-by-id-matching-filters', messagesById);
  const edits: unknown[] = [];
  await page.route(`**/api/1.1/message/${REPORT_ID}/edit`, async (route) => {
    const payload = route.request().postDataJSON();
    edits.push(payload);
    conclusion = payload.full_body;
    await route.fulfill({ json: { signal_message_id: REPORT_ID } });
  });

  await page.goto('/rer-duty-neo?state-short=short-1');
  const columns = page.locator('[data-duty-feed-column]');
  const source = columns.nth(0);
  const other = columns.nth(1);
  await expect(source.locator('[data-duty-message-id="60"]')).toBeInViewport();
  await expect(other.locator('[data-duty-message-id="60"]')).toBeInViewport();
  for (const column of [source, other]) {
    await column.locator(`[data-duty-message-id="${PARENT_ID}"]`).evaluate((card) => {
      card.scrollIntoView({ block: 'center' });
      card
        .closest('[data-duty-feed-scroller]')!
        .dispatchEvent(new Event('scroll', { bubbles: true }));
    });
  }
  const sourceCard = source.locator(`[data-duty-message-id="${PARENT_ID}"]`);
  const otherCard = other.locator(`[data-duty-message-id="${PARENT_ID}"]`);
  await expect(sourceCard).toBeInViewport();
  await expect(otherCard).toBeInViewport();
  await expect(source.locator('[data-duty-message-id="60"]')).not.toBeInViewport();

  await sourceCard.getByRole('button', { name: 'Редагувати розвіддонесення' }).click();
  const panel = page.locator('[data-manage-message-presentation="minimal"]');
  const body = panel.getByRole('textbox', { name: 'Текст розвіддонесення' });
  await expect(body).toHaveValue(conclusion);
  const sourceBefore = await scrollerOffset(sourceCard);
  const otherBefore = await scrollerOffset(otherCard);
  const reloadsBefore = latestPageRequests.length;

  await body.fill('Планування вогневого ураження позицій СОУ');
  await panel.getByRole('button', { name: 'Зберегти', exact: true }).click();

  await expect(panel).toHaveCount(0);
  expect(edits).toMatchObject([{ full_body: 'Планування вогневого ураження позицій СОУ' }]);
  for (const card of [sourceCard, otherCard]) {
    await expect(card).toContainText('Планування вогневого ураження позицій СОУ');
  }
  await expect(page.locator('[data-message-feed-skeleton][role="status"]')).toHaveCount(0);
  await expect(sourceCard).toBeInViewport();
  await expect(otherCard).toBeInViewport();
  expect(Math.abs((await scrollerOffset(sourceCard)) - sourceBefore)).toBeLessThanOrEqual(1);
  expect(Math.abs((await scrollerOffset(otherCard)) - otherBefore)).toBeLessThanOrEqual(1);
  expect(latestPageRequests).toHaveLength(reloadsBefore);
});
