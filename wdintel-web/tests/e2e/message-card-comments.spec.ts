import { expect, test } from '@playwright/test';
import { installAnalysisNeoApiMocks } from './analysis-neo.fixtures';
import { buildMessageCardMediaPreviewInboxResponse } from './message-card-media-preview.fixtures';
import { installRerDutyShortStateMocks } from './rer-duty-short-state.fixtures';

test.use({ hasTouch: true });

for (const host of ['duty', 'analysis'] as const) {
  for (const { label, comment, deleted } of [
    { label: 'matching linked comment', comment: '50 обрБпС', deleted: false },
    {
      label: 'long matching linked comment on touch',
      comment: Array.from({ length: 12 }, (_, index) => `Рядок коментаря ${index + 1}`).join('\n'),
      deleted: false,
    },
    { label: 'different comment', comment: 'Важлива примітка', deleted: false },
    { label: 'deleted linked comment', comment: '50 обрБпС', deleted: true },
  ]) {
    test(`#3894 ${host} displays ${label} without losing comment content @regression`, async ({
      page,
    }) => {
      const matching = label !== 'different comment';
      if (host === 'duty' && label.includes('touch')) {
        await page.setViewportSize({ width: 390, height: 844 });
      }
      const inboxResponse = buildMessageCardMediaPreviewInboxResponse();
      Object.assign(inboxResponse.inbox_items[0]![1], {
        text: 'Приклад повідомлення',
        media: [],
        images: [],
        text_marked: null,
        no_headers_body: { body: 'Приклад повідомлення', start: 0, end: 20 },
        extended_form: comment,
        message_comments: [],
        intelligence_reports: [
          {
            id: 501,
            isAccessible: true,
            isDeleted: deleted,
            text: matching ? comment : '50 обрБпС',
            attachmentsCount: 0,
            timestamp: null,
            groupName: null,
            groupMasterKey: null,
          },
        ],
      });
      if (host === 'duty') await installRerDutyShortStateMocks(page, { inboxResponse });
      else await installAnalysisNeoApiMocks(page, { inboxResponse });
      await page.goto(`/rer-${host === 'duty' ? 'duty' : 'analysis'}-neo`);
      await expect(page.getByText(comment, { exact: true })).toHaveCount(1);
      await expect(page.getByRole('button', { name: 'Редагувати розвіддонесення' })).toHaveCount(
        deleted ? 0 : 1,
      );
      await expect(page.getByRole('img', { name: 'Коментар', exact: true })).toHaveCount(
        !deleted && matching ? 0 : 1,
      );
      if (label.includes('touch')) {
        const dimensions = await page.getByText(comment, { exact: true }).evaluate((element) => ({
          height: element.clientHeight,
          fullHeight: element.scrollHeight,
        }));
        expect(dimensions.height).toBe(dimensions.fullHeight);
      }
    });
  }
}
