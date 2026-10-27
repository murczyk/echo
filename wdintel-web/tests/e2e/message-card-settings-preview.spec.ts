import { expect, test } from '@playwright/test';
import { installAnalysisNeoApiMocks } from './analysis-neo.fixtures';

for (const section of ['duty', 'analysis'] as const) {
  test(`#3324 ${section} card settings preview follows every display preference @regression`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: 1920, height: 1100 });
    await page.addInitScript(() => {
      if (!localStorage.getItem('echo-theme-mode')) localStorage.setItem('echo-theme-mode', 'dark');
    });
    await installAnalysisNeoApiMocks(page);
    await page.route('**/api/sigint/zones/list', (route) => route.fulfill({ json: [] }));
    let settings = {
      tagsLayout: 'compact',
      messageTextPreviewLines: 'twenty',
      disableAutoScroll: false,
      analysisMapInSidebar: false,
      dutyAudioTranscriptionCollapsed: false,
      analysisAudioTranscriptionCollapsed: false,
      showAnalysisCallsignAddForm: false,
      showClassicDuty: false,
      showClassicAnalysis: false,
      dutyCollapseMediaPreviews: false,
      largeMediaPreviews: false,
      mediaSummaryEnabled: false,
      messageSortBy: 'interception',
      messageAutoParseEnabled: false,
      aiPositionHighlightsEnabled: false,
    };
    await page.route('**/api/user/settings', async (route) => {
      if (route.request().method() === 'PUT') settings = route.request().postDataJSON();
      await route.fulfill({ json: settings });
    });
    await page.goto(`/settings-neo?section=${section}`);
    const tagsLabel = page.getByText('Відображення тегів:', { exact: true });
    const attachmentsLabel = page.getByText('Вкладення:', { exact: true });
    await expect(tagsLabel).toBeVisible();
    const tagStyle = await tagsLabel.evaluate((element) => {
      const style = getComputedStyle(element);
      return { fontSize: style.fontSize, color: style.color };
    });
    await expect(attachmentsLabel).toHaveCSS('font-size', tagStyle.fontSize);
    await expect(attachmentsLabel).toHaveCSS('color', tagStyle.color);
    const gapBelowLabel = (element: Element) =>
      element.nextElementSibling!.getBoundingClientRect().top -
      element.getBoundingClientRect().bottom;
    expect(await attachmentsLabel.evaluate(gapBelowLabel)).toBe(
      await tagsLabel.evaluate(gapBelowLabel),
    );
    const summaryHint = page.getByText(/^Відображати блок стислого опису/);
    await expect(page.getByText(/^Розмір попереднього перегляду зображень/)).toHaveCSS(
      'color',
      await summaryHint.evaluate((element) => getComputedStyle(element).color),
    );
    const preview = page.getByRole('region', {
      name: 'Попередній перегляд картки повідомлення',
      exact: true,
    });
    await expect(preview).toHaveText('');
    const textSize = page.getByRole('group', { name: 'Розмір тексту картки', exact: true });
    await expect(
      textSize.getByRole('button', { name: 'Стандартний', exact: true }),
    ).toHaveAttribute('aria-pressed', 'true');
    const textLine = preview
      .locator('[data-message-text-preview-limit] .settings-message-card-preview__line')
      .first();
    const compactHeight = (await textLine.boundingBox())!.height;
    await textSize.getByRole('button', { name: 'Збільшений', exact: true }).click();
    await expect
      .poll(async () => (await textLine.boundingBox())!.height)
      .toBeGreaterThanOrEqual(compactHeight * 1.5);
    await preview.screenshot({
      path: testInfo.outputPath(`${section}-1920-large-text-preview.png`),
    });
    await expect.poll(() => (settings as Record<string, unknown>).largeMessageCardText).toBe(true);
    await textSize.getByRole('button', { name: 'Стандартний', exact: true }).click();
    await expect.poll(async () => (await textLine.boundingBox())!.height).toBe(compactHeight);
    await expect(preview.locator('.message-card-root > .message-card-divider')).toBeVisible();
    const tile = preview.locator('.message-card-thumbnail-shell').first();
    await expect(tile).toHaveCSS('width', '72px');
    await page.getByRole('button', { name: 'Збільшені', exact: true }).click();
    await expect(tile).toHaveCSS('width', '144px');
    await expect(tile).not.toHaveCSS('transition-duration', '0s');
    await page.getByRole('button', { name: 'Згорнуті', exact: true }).click();
    await expect(tile).toHaveCount(0);
    await page.getByRole('button', { name: 'Компактні', exact: true }).click();
    await expect(tile).toHaveCSS('width', '72px');
    await page.getByRole('button', { name: 'Без тегів', exact: true }).click();
    await expect(preview.locator('[data-tags-mock]')).toHaveCount(0);
    await page.getByRole('button', { name: 'Повний', exact: true }).click();
    await expect(preview.locator('[data-preview-tag]')).toHaveCount(8);
    await page.getByRole('button', { name: 'Щільний', exact: true }).click();
    await expect(preview.locator('[data-preview-tag]')).toHaveCount(3);
    await page.getByRole('checkbox', { name: /Стислий опис файлів/ }).check();
    await expect(preview.locator('[data-media-summary-mock]')).toBeVisible();
    await page.getByRole('checkbox', { name: /Показувати ШІ-позиції/ }).check();
    await expect(preview.locator('[data-ai-position-preview]')).toBeVisible();
    await page.getByRole('button', { name: '40 рядків', exact: true }).click();
    await expect(preview.locator('[data-message-text-preview-limit]')).toHaveAttribute(
      'data-message-text-preview-limit',
      '40',
    );
    await page.getByRole('button', { name: 'Без скорочення', exact: true }).click();
    await expect(preview.locator('[data-message-text-preview-limit]')).toHaveAttribute(
      'data-message-text-preview-limit',
      'off',
    );
    await expect(preview).toHaveText('');
    for (const width of [1920, 390]) {
      await page.setViewportSize({ width, height: 1100 });
      expect(await attachmentsLabel.evaluate(gapBelowLabel)).toBe(
        await tagsLabel.evaluate(gapBelowLabel),
      );
      await preview.scrollIntoViewIfNeeded();
      await expect
        .poll(() => preview.evaluate((element) => element.scrollWidth <= element.clientWidth))
        .toBe(true);
      await preview.screenshot({ path: testInfo.outputPath(`${section}-${width}-preview.png`) });
    }
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await textSize.getByRole('button', { name: 'Збільшений', exact: true }).click();
    await expect(textLine).toHaveCSS('transition-duration', '0s');
    await preview.screenshot({
      path: testInfo.outputPath(`${section}-390-large-text-preview.png`),
    });
    await page.getByRole('button', { name: 'Збільшені', exact: true }).click();
    await expect(tile).toHaveCSS('width', '144px');
    await expect(tile).toHaveCSS('transition-duration', '0s');
    await expect
      .poll(() => settings.largeMediaPreviews && settings.aiPositionHighlightsEnabled)
      .toBe(true);
    await page.evaluate(() => localStorage.setItem('echo-theme-mode', 'light'));
    await page.reload();
    await expect(tile).toHaveCSS('width', '144px');
    await preview.scrollIntoViewIfNeeded();
    await preview.screenshot({ path: testInfo.outputPath(`${section}-390-light-preview.png`) });
  });
}
