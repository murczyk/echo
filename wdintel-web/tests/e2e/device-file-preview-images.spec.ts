import { expect, test } from '@playwright/test';
import { localFilePreviewBackend } from './device-file-preview-backend';
import { ensureDeviceFilePreviewFixture, openDeviceFilePreview } from './device-file-preview.ui';

for (const extension of ['png', 'jpg', 'gif', 'webp', 'bmp', 'svg']) {
  test(`@regression decodes actual ${extension} as an image and zooms`, async ({ page }) => {
    const backend = await localFilePreviewBackend();
    try {
      const { pane } = await openDeviceFilePreview(page, backend, `image-${extension}`);
      const image = pane.locator('[data-image-preview-image]');
      await expect(image).toBeVisible();
      await expect
        .poll(() => image.evaluate((node: HTMLImageElement) => node.naturalWidth))
        .toBeGreaterThan(0);
      await image.dblclick({ force: true });
      await expect(image).toHaveAttribute('data-image-preview-zoom', '200');
      await expect(pane.getByRole('button', { name: 'Скачати файл', exact: true })).toBeEnabled();
    } finally {
      await backend.dispose();
    }
  });
}

for (const id of ['mime-only-image', 'conflicting-image-name', 'image-jpeg']) {
  test(`@regression uses actual metadata ${id}`, async ({ page }) => {
    const backend = await localFilePreviewBackend();
    try {
      const { pane } = await openDeviceFilePreview(page, backend, id);
      await expect
        .poll(() =>
          pane
            .locator('[data-image-preview-image]')
            .evaluate((node: HTMLImageElement) => node.naturalWidth),
        )
        .toBeGreaterThan(0);
    } finally {
      await backend.dispose();
    }
  });
}

test('@regression SVG scripts and external resources remain inert in img', async ({ page }) => {
  const backend = await localFilePreviewBackend();
  const external: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('example.test')) external.push(request.url());
  });
  try {
    await ensureDeviceFilePreviewFixture(backend, 'svg-script-inert');
    const { pane } = await openDeviceFilePreview(page, backend, 'svg-script-inert');
    await expect(pane.locator('[data-image-preview-image]')).toBeVisible();
    await expect
      .poll(() => pane.locator('img').evaluate((node: HTMLImageElement) => node.naturalWidth))
      .toBeGreaterThan(0);
    expect(
      await page.evaluate(
        () => (window as unknown as { fixtureScriptRan?: boolean }).fixtureScriptRan,
      ),
    ).not.toBe(true);
    expect(external).toEqual([]);
    await expect(pane.locator('object, embed, iframe, script')).toHaveCount(0);
  } finally {
    await backend.dispose();
  }
});
