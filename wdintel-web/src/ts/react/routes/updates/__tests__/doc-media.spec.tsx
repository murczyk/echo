/** @vitest-environment happy-dom */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it } from 'vitest';

import { MarkdownBody } from '../components/MarkdownBody';

it('#3938 renders release media through the authenticated endpoint and preserves seeking fragments', async () => {
  const container = document.createElement('div');
  const root = createRoot(container);
  await act(async () =>
    root.render(
      <MarkdownBody
        releaseId="2026-10-29"
        markdown={
          '{{ video(id="media/ланцюжки.mp4?version=2#t=10") }}\n\n![Screenshot](media/picture.png)\n\n![External](https://example.com/picture.png)'
        }
      />,
    ),
  );
  expect(container.querySelector('video')?.getAttribute('src')).toBe(
    '/doc-media/docs/releases/2026-10-29/media/%D0%BB%D0%B0%D0%BD%D1%86%D1%8E%D0%B6%D0%BA%D0%B8.mp4?version=2#t=10',
  );
  expect(
    Array.from(container.querySelectorAll('img'), (image) => image.getAttribute('src')),
  ).toEqual([
    '/doc-media/docs/releases/2026-10-29/media/picture.png',
    'https://example.com/picture.png',
  ]);
  await act(async () => root.unmount());
});
