import { expect, test } from '@playwright/test';

import { buildDocxHtmlDocument } from '../../src/ts/react/routes/shared/message-card/docx/build-docx-html-document';

// Regression: https://github.com/echoua/echo/issues/3560
test('@regression widens a content-heavy landscape DOCX document without nested scrolling', async ({
  page,
}) => {
  const content = Array.from({ length: 80 }, (_, index) => `<p>Landscape row ${index}</p>`).join(
    '',
  );
  const srcDoc = buildDocxHtmlDocument(
    content,
    { widthTwips: 16838, heightTwips: 11906 },
    100,
    'light',
  );

  await page.setContent(
    '<iframe title="DOCX preview" style="width: 1280px; height: 900px"></iframe>',
  );
  const iframe = page.locator('iframe');
  await iframe.evaluate((element, html) => {
    (element as HTMLIFrameElement).srcdoc = html;
  }, srcDoc);
  const pageBox = await iframe
    .contentFrame()
    .locator('.docx-preview-page')
    .evaluate((element) => ({
      width: element.getBoundingClientRect().width,
      height: element.getBoundingClientRect().height,
      scrollHeight: element.scrollHeight,
    }));

  expect(pageBox.width).toBeGreaterThan(860);
  expect(pageBox.height).toBeGreaterThanOrEqual(pageBox.scrollHeight);
});
