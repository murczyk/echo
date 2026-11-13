/** @vitest-environment happy-dom */
import { act, Profiler } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';

import { UpdatesPage } from '..';
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

it('#3938 never commits previous release media under a newly selected release', async () => {
  const container = document.createElement('div');
  const root = createRoot(container);
  const committedMediaUrls: string[] = [];
  let completeRelease: (response: Response) => void;
  const pendingRelease = new Promise<Response>((resolve) => {
    completeRelease = resolve;
  });
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = String(input);
    if (url.endsWith('/index.json')) {
      return new Response(
        JSON.stringify([{ release_id: '2026-10-29' }, { release_id: '2026-10-18' }]),
      );
    }
    if (url.endsWith('/2026-10-29/release.md')) {
      return new Response('# 2026-10-29\n\n{{ video(id="media/ланцюжки.mp4") }}');
    }
    return pendingRelease;
  });
  const videoUrl =
    '/doc-media/docs/releases/2026-10-29/media/%D0%BB%D0%B0%D0%BD%D1%86%D1%8E%D0%B6%D0%BA%D0%B8.mp4';
  const screenshotUrl = '/doc-media/docs/releases/2026-10-18/media/screenshot1.png';
  const selectRelease = (releaseId: string) => {
    Array.from(container.querySelectorAll('button'))
      .find((button) => button.textContent === releaseId)!
      .click();
  };

  try {
    await act(async () =>
      root.render(
        <Profiler
          id="updates"
          onRender={() => {
            for (const media of container.querySelectorAll('video, img')) {
              committedMediaUrls.push(media.getAttribute('src')!);
            }
          }}
        >
          <UpdatesPage />
        </Profiler>,
      ),
    );
    expect(container.querySelector('video')?.getAttribute('src')).toBe(videoUrl);

    await act(async () => selectRelease('2026-10-29'));
    expect(container.querySelector('video')?.getAttribute('src')).toBe(videoUrl);
    expect(fetch).toHaveBeenCalledTimes(2);

    await act(async () => selectRelease('2026-10-18'));
    expect(container.querySelector('video')).toBeNull();
    expect(container.querySelector('[role="progressbar"]')).not.toBeNull();
    expect(committedMediaUrls).not.toContain(videoUrl.replace('2026-10-29', '2026-10-18'));

    await act(async () =>
      completeRelease(new Response('# 2026-10-18\n\n![Screenshot](media/screenshot1.png)')),
    );
    expect(container.querySelector('img')?.getAttribute('src')).toBe(screenshotUrl);

    await act(async () => selectRelease('2026-10-18'));
    expect(container.querySelector('img')?.getAttribute('src')).toBe(screenshotUrl);
    expect(fetch).toHaveBeenCalledTimes(3);
  } finally {
    await act(async () => root.unmount());
    fetch.mockRestore();
  }
});
