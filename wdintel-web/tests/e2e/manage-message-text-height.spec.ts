import { expect, test } from '@playwright/test';

import {
  openCreateMessageDrawer,
  openCreateReportDrawer,
  openEditMessageDrawer,
  openEditReportDrawer,
} from './image-editor-drawer.fixtures';

for (const viewport of [
  { width: 1600, height: 900 },
  { width: 390, height: 844 },
]) {
  test.describe(`editor text height at ${viewport.width}px`, () => {
    test.use({ viewport });

    for (const mode of [
      'duty-create',
      'analysis-create',
      'message-edit',
      'report-create',
      'report-edit',
    ]) {
      test(`#3894 ${mode} toggles text height without changing the draft @regression`, async ({
        page,
      }) => {
        if (mode === 'analysis-create') await page.setViewportSize({ width: 1600, height: 900 });
        if (mode === 'duty-create') await openCreateMessageDrawer(page, 'duty');
        else if (mode === 'analysis-create') await openCreateMessageDrawer(page, 'analysis');
        else if (mode === 'message-edit') await openEditMessageDrawer(page);
        else if (mode === 'report-create') await openCreateReportDrawer(page);
        else await openEditReportDrawer(page);
        await page.setViewportSize(viewport);

        const label = mode.startsWith('report') ? 'Текст розвіддонесення' : 'Текст повідомлення';
        const editor = page.locator('[data-manage-message-presentation]');
        const input = editor.getByRole('textbox', { name: label, exact: true });
        const original = mode.startsWith('report')
          ? editor.getByRole('textbox', { name: 'Текст оригінального повідомлення', exact: true })
          : null;
        if (mode === 'report-create') {
          await expect(original!).toHaveValue('Copied E2E source message');
        }
        const originalText = original ? await original.inputValue() : null;
        const originalHeight = original
          ? await original.evaluate((element) => element.getBoundingClientRect().height)
          : null;
        const text = 'Перший рядок чернетки\nДругий рядок чернетки';
        await input.fill(text);
        const initialHeight = await input.evaluate(
          (element) => element.getBoundingClientRect().height,
        );
        let submissions = 0;
        page.on('request', (request) => {
          const pathname = new URL(request.url()).pathname;
          if (
            request.method() === 'POST' &&
            (pathname === '/api/1.1/submit-direct' ||
              /^\/api\/1\.1\/message\/\d+\/edit$/.test(pathname))
          ) {
            submissions += 1;
          }
        });

        const expand = editor.getByRole('button', {
          name: `Збільшити поле «${label}»`,
          exact: true,
        });
        await expand.scrollIntoViewIfNeeded();
        const fieldBounds = await input.evaluate((element) =>
          element.closest('.MuiFormControl-root')!.getBoundingClientRect().toJSON(),
        );
        const buttonBounds = await expand.boundingBox();
        const originalBounds = original
          ? await original.evaluate((element) =>
              element.closest('.MuiFormControl-root')!.getBoundingClientRect().toJSON(),
            )
          : fieldBounds;
        expect(buttonBounds!.y).toBeGreaterThanOrEqual(fieldBounds.bottom);
        expect(buttonBounds!.x + buttonBounds!.width / 2).toBeCloseTo(
          (originalBounds.x + fieldBounds.right) / 2,
          0,
        );
        expect(buttonBounds!.width).toBeLessThanOrEqual(24);
        await expand.click();
        await expect
          .poll(() => input.evaluate((element) => element.getBoundingClientRect().height))
          .toBeCloseTo(initialHeight * 2, 0);
        await expect(input).toHaveValue(text);
        if (original) {
          await expect
            .poll(() => original.evaluate((element) => element.getBoundingClientRect().height))
            .toBeCloseTo(originalHeight! * 2, 0);
          await expect(original).toHaveValue(originalText!);
        }
        const collapse = editor.getByRole('button', {
          name: `Зменшити поле «${label}»`,
          exact: true,
        });
        await expect(collapse).toHaveAttribute('aria-expanded', 'true');
        await collapse.focus();
        await collapse.press('Enter');
        await expect
          .poll(() => input.evaluate((element) => element.getBoundingClientRect().height))
          .toBeCloseTo(initialHeight, 0);
        await expect(input).toHaveValue(text);
        if (original) {
          await expect
            .poll(() => original.evaluate((element) => element.getBoundingClientRect().height))
            .toBeCloseTo(originalHeight!, 0);
        }
        expect(submissions).toBe(0);
      });
    }
  });
}
